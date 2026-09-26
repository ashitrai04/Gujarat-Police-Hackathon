"""
Image and text into one searchable space.

SigLIP 2 rather than CLIP: its sigmoid loss was trained to score each
image-text pair independently, which is what ranking one query against a
hundred thousand frames actually asks for. CLIP's softmax contrastive loss
optimises "which of these N captions" — a different question that happens to
transfer.

384px input, not 224. CCTV is full of small distant figures, and at 224 a
motorcyclist forty metres out is a smudge. The cost is real (about 3x the
patches) and it is paid once, at index time.

Embeddings are stored at full width as float16 and truncated at query time.
Truncating a prefix is only free if the model was trained to make prefixes
valid embeddings, and rather than take that on trust the index keeps both
options open so evaluate.py can measure what a narrower vector actually costs
in retrieval quality. Storage, not GPU time, is what limits how much history an
index can hold, so the answer decides the production width.
"""
from __future__ import annotations

import os

import numpy as np

MODEL_ID = 'google/siglip2-base-patch16-384'
# Written by `python -m ask.fp16`; used automatically when present.
LOCAL_FP16 = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'weights', 'siglip2-base-384-fp16')
FULL_DIM = 768
DIM = FULL_DIM     # what the index stores; narrower widths are a query-time slice

_model = None
_proc = None
_device = None


def load():
    """Load once per process. ~380 MB of weights, ~450 MB of VRAM in fp16."""
    global _model, _proc, _device
    if _model is not None:
        return _model, _proc, _device

    import torch
    from transformers import AutoModel, AutoProcessor

    _device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if _device == 'cuda' else torch.float32
    # Prefer a local half-precision copy when one has been made.
    #
    # The published checkpoint is float32, 1.50 GB, and transformers memory-maps
    # the whole file to load it. On a 15 GB laptop already running a 3 GB
    # language model that fails outright - Windows reports "the paging file is
    # too small", which sounds like a broken download and is really two models
    # competing for commit charge. The fp16 copy is 785 MB and the weights go
    # to the GPU as fp16 regardless, so nothing is lost but the memory spike.
    src = LOCAL_FP16 if os.path.isdir(LOCAL_FP16) else MODEL_ID
    _proc = AutoProcessor.from_pretrained(src)
    _model = AutoModel.from_pretrained(src, dtype=dtype).to(_device).eval()
    return _model, _proc, _device


def release() -> None:
    """Hand PyTorch's cached VRAM back to the driver.

    The retrieval model and the local language model share one 6 GB card.
    PyTorch holds freed blocks in its own cache, so from the driver's point of
    view they are still taken, and Ollama - which allocates its KV cache per
    request - starts aborting. It does not report an error when it does: it
    answers 200 with an empty skeleton, which reaches the caller as a parse
    failure and looks like poor search quality.
    """
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:          # noqa: BLE001 - never let a hint break a query
        pass


def _pooled(out):
    """The embedding, whichever shape the library hands back.

    transformers 5 returns a BaseModelOutputWithPooling from
    get_image_features / get_text_features where earlier versions returned the
    tensor directly. `pooler_output` is the attention-pooled vector SigLIP was
    trained to align; last_hidden_state is the per-patch sequence and is not
    interchangeable with it.
    """
    if hasattr(out, 'pooler_output') and out.pooler_output is not None:
        return out.pooler_output
    return out


def _norm(x: np.ndarray) -> np.ndarray:
    """L2-normalise rows, so a dot product is a cosine similarity."""
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.maximum(n, 1e-8)


def embed_images(images, batch: int = 16, dim: int = DIM) -> np.ndarray:
    """PIL images -> (N, dim) float16, L2-normalised.

    Truncation happens BEFORE normalising. Normalising the full 768 and then
    cutting would leave vectors off the unit sphere by a varying amount, and
    cosine scores would no longer be comparable between frames.
    """
    import torch

    model, proc, device = load()
    out = []
    for i in range(0, len(images), batch):
        chunk = images[i:i + batch]
        inputs = proc(images=chunk, return_tensors='pt').to(device)
        if device == 'cuda':
            inputs['pixel_values'] = inputs['pixel_values'].half()
        with torch.no_grad():
            feats = _pooled(model.get_image_features(**inputs))
        out.append(feats.float().cpu().numpy())
    v = np.concatenate(out, axis=0)[:, :dim]
    return _norm(v).astype(np.float16)


def embed_texts(texts: list[str], dim: int = DIM) -> np.ndarray:
    """Query strings -> (N, dim) float16, in the same space as the images.

    SigLIP's text tower needs padding to its trained max length; padding to the
    longest item in the batch instead shifts the embedding and quietly costs
    retrieval accuracy.
    """
    import torch

    model, proc, device = load()
    inputs = proc(
        text=texts, padding='max_length', max_length=64,
        truncation=True, return_tensors='pt',
    ).to(device)
    with torch.no_grad():
        feats = _pooled(model.get_text_features(**inputs))
    v = feats.float().cpu().numpy()[:, :dim]
    return _norm(v).astype(np.float16)


def narrow(v: np.ndarray, dim: int) -> np.ndarray:
    """Slice a stored embedding to `dim` and put it back on the unit sphere.

    Both sides of the comparison must be narrowed the same way; slicing only
    the query would compare a short vector against long ones and the scores
    would be meaningless rather than merely worse.
    """
    if dim >= v.shape[-1]:
        return v
    return _norm(v[..., :dim].astype(np.float32))
