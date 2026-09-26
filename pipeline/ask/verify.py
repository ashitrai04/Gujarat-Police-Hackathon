"""
The shortlist, checked by a model that can be asked to justify itself.

Retrieval is tuned for recall and will happily rank a frame that merely looks
like the query. That is fine as a candidate generator and useless as an answer:
an officer shown ten frames of which four are wrong learns to distrust all ten.

So the top of the ranking is handed to a vision-language model one frame at a
time, with a yes/no question and a demand for one sentence of reason. Frames it
rejects are dropped. The sentence is kept and shown, because this application's
existing design already refuses to present conclusions without the evidence
behind them — a plate is shown beside its crop so it can be checked by eye, and
a retrieved frame should be no different.

Qwen2.5-VL 3B, local, through Ollama. Small enough to sit in 6 GB of VRAM
alongside nothing else, which is the real constraint on a laptop, and the same
model the parser uses so only one is ever resident.

Cost scales with questions asked, not with footage recorded: twenty frames per
query, never the whole index. That is what makes verification affordable at all.
"""
from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request

OLLAMA = 'http://127.0.0.1:11434'
MODEL = 'qwen2.5vl:3b'
# Temperature 0 is not enough on its own: Ollama seeds each request randomly,
# and a 3B model at temperature 0 still picks different tokens where two are
# near-tied. The same prompt was producing different query plans between runs
# - once with a place filter and once without, which changed 59 candidate
# frames into 3535. A search box that answers the same question differently on
# different days is not one an investigator can rely on, so the seed is fixed.
SEED = 7

# Ollama's default context is 4096 tokens. The instruction prompt below is
# about 980 tokens and the reply is allowed 400, and somewhere under that
# pressure the server stops returning an error and starts returning a
# well-formed 200 whose body is an empty skeleton - model "", done false,
# content "". Nothing raises; json.loads sees "" and the caller quietly falls
# back to the rule parser, so a query loses its place filter and returns 3535
# frames instead of 59. It presents as bad search quality, not as a failure.
NUM_CTX = 8192

SYSTEM = """You check whether a CCTV frame matches what an operator asked for.

Answer with ONLY a JSON object:
{"match": true or false, "reason": "one short sentence"}

Rules:
- Judge only what is visible. Do not guess at what happened before or after.
- "match": false if you cannot see the thing asked for clearly.
- The image is a traffic camera still, often low quality. Small, blurry or
  distant subjects are normal; say what you can actually see.
- "reason": one sentence, under 20 words, describing the evidence. If it does
  not match, say what is there instead.
- Never mention race, religion, caste or ethnicity. Describe clothing colour,
  vehicles and behaviour only."""


def _b64(path: str) -> str:
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode()


def check(thumb: str, question: str, timeout: int = 120) -> dict:
    """One frame, one question. Returns {match, reason, ok}.

    `ok` is False when the model could not be reached or gave nothing usable.
    A failed check is not a rejection: dropping frames because the verifier
    broke would silently shrink results and look like poor retrieval.
    """
    body = json.dumps({
        'model': MODEL,
        'format': 'json',
        'stream': False,
        'keep_alive': '15m',
        'options': {'temperature': 0, 'seed': SEED, 'num_ctx': NUM_CTX,
                    'num_predict': 120},
        'messages': [
            {'role': 'system', 'content': SYSTEM},
            {'role': 'user',
             'content': f'Does this frame show: {question}?',
             'images': [_b64(thumb)]},
        ],
    }).encode()
    req = urllib.request.Request(f'{OLLAMA}/api/chat', data=body,
                                headers={'content-type': 'application/json'})
    try:
        from . import embed as _embed
        _embed.release()
    except Exception:                    # noqa: BLE001
        pass
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
        content = d.get('message', {}).get('content') or ''
        if not d.get('done') or not content:
            raise ValueError('aborted response from the verifier')
        obj = json.loads(content)
        m = obj.get('match')
        if isinstance(m, str):
            m = m.strip().lower() in ('true', 'yes', '1')
        reason = str(obj.get('reason', '')).strip()
        reason = re.sub(r'\s+', ' ', reason)[:200]
        return {'match': bool(m), 'reason': reason, 'ok': True}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError,
            KeyError, TypeError, ValueError, OSError) as e:
        return {'match': None, 'reason': f'verifier unavailable ({type(e).__name__})',
                'ok': False}


def verify_all(results: list[dict], question: str, limit: int = 20) -> dict:
    """Verify the top `limit` results in place; leave the rest untouched.

    Ordering is preserved rather than re-sorted by the verifier's opinion. The
    model gives a boolean, not a calibrated score, so sorting on it would
    invent a precision the answer does not have; confirmed frames are marked and
    the retrieval order stands.
    """
    checked = 0
    confirmed = 0
    failures = 0
    for r in results[:limit]:
        v = check(r['thumb'], question)
        r['verified'] = v['match']
        r['reason'] = v['reason']
        checked += 1
        if not v['ok']:
            failures += 1
        elif v['match']:
            confirmed += 1
    return {'checked': checked, 'confirmed': confirmed, 'failures': failures}
