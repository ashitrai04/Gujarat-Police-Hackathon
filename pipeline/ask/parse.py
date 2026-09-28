"""
The prompt, turned into a query plan.

A sentence an operator types mixes constraints that want completely different
machinery: a time window is SQL, a plate is an index lookup, a count is a
detector, "waterlogged road" is an embedding. Sending the whole sentence to any
one of them wastes the parts it cannot use — so the sentence is split first and
each part routed to the thing that is good at it.

The model is Qwen2.5-VL 3B running locally through Ollama. Local for two
reasons: this is the component that would otherwise see every question an
officer asks, and a police deployment will eventually require the system to run
with no outbound network at all. It is the same model used for verification, so
one 3.2 GB download serves both stages and only one model is resident.

The output is a fixed JSON shape, never SQL. A model that emits SQL against a
police database is a model with an injection surface; a model that fills in
seven known fields has none.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request

# Both are overridable, because the same code runs on very different
# hardware. A 6 GB laptop card takes the 3B model; a 40 GB A100 takes a far
# better one, and the only thing that should have to change between them is an
# environment variable. OLLAMA_HOST likewise, so the language model can live on
# another machine entirely.
OLLAMA = os.environ.get('OLLAMA_HOST', 'http://127.0.0.1:11434').rstrip('/')
MODEL = os.environ.get('ASK_VLM_MODEL', 'qwen2.5vl:3b')
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

# Vehicle and person classes the index actually counts. The parser is told the
# vocabulary so it cannot invent a class the database has no column for.
CLASSES = ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck']
EVENTS = ['wrong_way', 'stopped', 'loitering', 'crowding', 'sudden_stop']

# Attribute phrases are free text, passed on to the grounding stage. These are
# the ones the system is built to handle; anything else still reaches the
# open-vocabulary detector, which may or may not find it.
KNOWN_ATTRS = ['without helmet', 'with helmet', 'triple riding', 'wrong side',
               'red', 'white', 'black', 'blue', 'yellow', 'green', 'silver']

# Searching surveillance footage by a protected characteristic is a different
# act from searching it by a vehicle or a behaviour, and this is the point in
# the system where that line is drawn. The refusal is in the parser rather than
# the UI so it cannot be bypassed by calling the API directly.
REFUSE = re.compile(
    r'\b(muslim|hindu|sikh|christian|jain|buddhist|dalit|caste|brahmin|'
    r'religio\w*|ethnic\w*|tribal|race|racial|'
    r'burqa|hijab|niqab|turban|skullcap|kufi|tilak|'
    r'dark[- ]skinn?ed|fair[- ]skinn?ed|light[- ]skinn?ed|complexion|'
    r'bangladeshi|rohingya|migrant|foreigner|outsider)\b', re.I)

SYSTEM = """You convert a police operator's incident description into a JSON query plan.

Reply with ONLY a JSON object, no prose, using exactly these keys:

{
  "free_text": string or null,
  "cameras": array of strings or null,
  "places": array of strings or null,
  "hours": [start_hour, end_hour] or null,
  "classes": array of strings or null,
  "counts": object or null,
  "riders": object or null,
  "plate": string or null,
  "attributes": array of strings or null,
  "event": string or null
}

Rules:
- free_text: the visual scene described, as a short caption for image search.
  Strip out times, place names, camera names and plate numbers - those are
  handled separately. Null only if the query is purely structured (a plate
  lookup, or a bare count).
- cameras: only if a camera id like "cam08" is named explicitly.
- places: place or district names mentioned, e.g. ["Junagadh"], ["Adalaj"].
- hours: 24-hour integers if a time of day is given. "after 8pm" -> [20, 23].
  "at night" -> [20, 5]. "morning" -> [6, 11]. Null if no time is given.
- classes: object types that MUST be in the frame. Only from this list:
  person, bicycle, car, motorcycle, bus, truck.
- counts: ONLY when the query states an actual number - "three people" ->
  {"person": {"min": 3}}, "two riders" -> {"person": {"min": 2}}. Vague words
  like "busy", "crowded", "full of traffic", "a lot of" are NOT numbers: leave
  counts null and let the image search judge them. Never invent a number.
- riders: how many people are ON ONE two-wheeler, when the query asks that -
  "three on a bike" / "three people on one motorcycle" / "triple riding" ->
  {"min": 3}. This is different from counts: counts is people anywhere in the
  frame, riders is people sharing one machine. When the query means riders, set
  riders and leave counts null.
- classes: only types the query actually names. "busy junction" names no type,
  so classes is null. Listing every vehicle type for a vague query excludes
  every frame that happens to lack one of them.
- plate: an Indian registration if one appears, uppercase, no spaces.
- attributes: short attribute phrases such as "without helmet", "triple riding",
  "red", "wrong side". These get a separate detection pass.
- event: one of wrong_way, stopped, loitering, crowding, sudden_stop, if the
  query describes that behaviour. Otherwise null.

Examples:

"two riders without helmets near Majevadi Gate after 8pm"
{"free_text":"motorcycle riders on a road","cameras":null,"places":["Majevadi Gate"],"hours":[20,23],"classes":["motorcycle","person"],"counts":{"person":{"min":2}},"plate":null,"attributes":["without helmet"],"event":null}

"GJ03PA8482 in the last 6 hours"
{"free_text":null,"cameras":null,"places":null,"hours":null,"classes":null,"counts":null,"plate":"GJ03PA8482","attributes":null,"event":null}

"three people on one motorcycle"
{"free_text":"three people riding one motorcycle together","cameras":null,"places":null,"hours":null,"classes":["motorcycle"],"counts":null,"riders":{"min":3},"plate":null,"attributes":["triple riding"],"event":null}

"crowd blocking the carriageway"
{"free_text":"a crowd of people blocking a road","cameras":null,"places":null,"hours":null,"classes":["person"],"counts":null,"plate":null,"attributes":null,"event":"crowding"}

"a busy road junction full of traffic"
{"free_text":"a busy road junction full of traffic","cameras":null,"places":null,"hours":null,"classes":null,"counts":null,"plate":null,"attributes":null,"event":null}

"white car parked on the junction at Adalaj toll"
{"free_text":"a white car stopped on a junction","cameras":null,"places":["Adalaj"],"hours":null,"classes":["car"],"counts":null,"plate":null,"attributes":["white"],"event":"stopped"}

"empty road at night"
{"free_text":"an empty road at night with no traffic","cameras":null,"places":null,"hours":[20,5],"classes":null,"counts":null,"plate":null,"attributes":null,"event":null}
"""

EMPTY = {'free_text': None, 'cameras': None, 'places': None, 'hours': None,
         'classes': None, 'counts': None, 'riders': None, 'plate': None,
         'attributes': None, 'event': None}

class OllamaAborted(RuntimeError):
    """The server answered 200 but produced nothing."""


PLATE_RE = re.compile(r'\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{1,4})\b')


def ollama_up() -> bool:
    try:
        urllib.request.urlopen(f'{OLLAMA}/api/tags', timeout=3)
        return True
    except Exception:
        return False


def _chat(prompt: str, timeout: int = 180) -> str:
    body = json.dumps({
        'model': MODEL,
        'format': 'json',
        'stream': False,
        'keep_alive': '15m',
        'options': {'temperature': 0, 'seed': SEED, 'num_ctx': NUM_CTX,
                    'num_predict': 400},
        'messages': [
            {'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': prompt},
        ],
    }).encode()
    req = urllib.request.Request(f'{OLLAMA}/api/chat', data=body,
                                headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    # An aborted generation comes back as HTTP 200 with done=false and every
    # field blank. Letting that fall through to json.loads('') reports it as a
    # decode error, which points at the wrong thing entirely.
    if not d.get('done') or not d.get('message', {}).get('content'):
        raise OllamaAborted(
            f'empty response (done={d.get("done")}); the server dropped the '
            'request, usually GPU memory pressure')
    return d['message']['content']


def clean(raw: dict, prompt: str) -> dict:
    """Keep only what the index can act on.

    A 3B model will occasionally return a class the detector does not have, an
    hour of 25, or a count as a bare integer. Repairing that here is cheaper
    and more reliable than making the prompt longer, and it guarantees the rest
    of the pipeline sees a valid plan whatever the model did.
    """
    q = dict(EMPTY)

    ft = raw.get('free_text')
    q['free_text'] = ft.strip() if isinstance(ft, str) and ft.strip() else None

    for key in ('cameras', 'places', 'attributes'):
        v = raw.get(key)
        if isinstance(v, list):
            vals = [str(x).strip() for x in v if str(x).strip()]
            q[key] = vals or None
        elif isinstance(v, str) and v.strip():
            q[key] = [v.strip()]

    v = raw.get('classes')
    if isinstance(v, str):
        v = [v]
    if isinstance(v, list):
        keep = [c for c in (str(x).lower().strip() for x in v) if c in CLASSES]
        q['classes'] = keep or None

    h = raw.get('hours')
    if isinstance(h, list) and len(h) == 2:
        try:
            a, b = int(h[0]) % 24, int(h[1]) % 24
            q['hours'] = [a, b]
        except (TypeError, ValueError):
            pass

    rd = raw.get('riders')
    if isinstance(rd, dict) and 'min' in rd:
        try:
            q['riders'] = {'min': max(1, int(rd['min']))}
        except (TypeError, ValueError):
            pass
    elif isinstance(rd, int) and rd > 0:
        q['riders'] = {'min': rd}

    c = raw.get('counts')
    if isinstance(c, dict):
        out = {}
        for k, val in c.items():
            k = str(k).lower().strip()
            if k not in CLASSES:
                continue
            if isinstance(val, dict) and 'min' in val:
                try:
                    out[k] = {'min': max(1, int(val['min']))}
                except (TypeError, ValueError):
                    continue
            else:
                try:
                    out[k] = {'min': max(1, int(val))}
                except (TypeError, ValueError):
                    continue
        q['counts'] = out or None

    # A plate is too important to leave to the model: a regex over the raw
    # prompt is exact, and a hallucinated registration is the worst possible
    # failure in this system.
    m = PLATE_RE.search(prompt.upper())
    p = raw.get('plate')
    if m:
        q['plate'] = re.sub(r'\s+', '', m.group(1))
    elif isinstance(p, str) and PLATE_RE.search(p.upper()):
        q['plate'] = re.sub(r'\s+', '', p.upper())

    e = raw.get('event')
    if isinstance(e, str) and e.strip().lower() in EVENTS:
        q['event'] = e.strip().lower()

    return q


def fallback(prompt: str) -> dict:
    """A plan built without the model, for when Ollama is not running.

    Deliberately crude: the whole prompt becomes the caption, numbers become
    counts, class words become class filters. It keeps the feature usable
    rather than returning an error, and the UI says the parser is degraded.
    """
    q = dict(EMPTY)
    q['free_text'] = prompt.strip() or None
    low = prompt.lower()
    # Word boundaries, not substrings. Without them "a busy road junction"
    # matches the class `bus` inside "busy" and the query is silently narrowed
    # to the 658 frames containing a bus.
    found = [c for c in CLASSES if re.search(r'\b' + c + r's?\b', low)]
    plural = {'people': 'person', 'cars': 'car', 'bikes': 'motorcycle',
              'motorcycles': 'motorcycle', 'bikers': 'motorcycle',
              'riders': 'motorcycle', 'trucks': 'truck', 'buses': 'bus'}
    for word, cls in plural.items():
        if word in low and cls not in found:
            found.append(cls)
    q['classes'] = found or None
    words = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6}
    n = None
    m = re.search(r'\b(\d+)\b', low)
    if m:
        n = int(m.group(1))
    else:
        for w, val in words.items():
            if re.search(rf'\b{w}\b', low):
                n = val
                break
    on_one = re.search(r'on (one|a|1|single).{0,20}(bike|motorcycle|scooter|two.?wheeler)', low)         or 'triple riding' in low or 'triple seat' in low
    if n and n <= 20 and on_one:
        q['riders'] = {'min': n}
    elif 'triple' in low and on_one:
        q['riders'] = {'min': 3}
    elif n and n <= 20:
        target = 'person' if ('people' in low or 'person' in low or 'rider' in low) else (found[0] if found else 'person')
        q['counts'] = {target: {'min': n}}
    if 'night' in low:
        q['hours'] = [20, 5]
    m = PLATE_RE.search(prompt.upper())
    if m:
        q['plate'] = re.sub(r'\s+', '', m.group(1))
    for a in KNOWN_ATTRS:
        if a in low:
            q.setdefault('attributes', None)
            q['attributes'] = (q['attributes'] or []) + [a]
    return q


def parse(prompt: str, use_model: bool = True) -> dict:
    """Prompt -> query plan. Never raises; always returns a usable plan."""
    hit = REFUSE.search(prompt)
    if hit:
        return {**EMPTY, 'refused': (
            f'This system does not search by personal or group identity '
            f'("{hit.group(0)}"). Searchable attributes are clothing colour, '
            f'vehicle type and colour, behaviour, and registration number.'
        )}

    why = 'ollama not reachable'
    if use_model and ollama_up():
        # One retry, because the failure this guards against is transient and
        # specific: the GPU is shared with the retrieval model and the verifier,
        # and under memory pressure Ollama drops a request rather than queueing
        # it. Three of fourteen queries in an evaluation run fell back this way
        # — all of them late in the run, after the verifier had been loading and
        # unloading — and a rules-parsed query silently loses its place filter,
        # which turns 59 candidate frames into 3535.
        for attempt in (1, 2, 3):
            # Give the driver back whatever the retrieval model is not using
            # before asking Ollama for memory.
            try:
                from . import embed as _embed
                _embed.release()
            except Exception:            # noqa: BLE001
                pass
            try:
                raw = json.loads(_chat(prompt))
                if isinstance(raw, dict):
                    q = clean(raw, prompt)
                    # A plan with nothing in it is worse than the crude fallback.
                    if any(q[k] is not None for k in
                           ('free_text', 'plate', 'classes', 'counts', 'riders', 'event')):
                        q['parser'] = MODEL
                        return q
                    why = 'model returned an empty plan'
            except OllamaAborted as e:
                why = str(e)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError,
                    KeyError, OSError) as e:
                why = f'{type(e).__name__}: {e}'
            if attempt < 3:
                time.sleep(1.5 * attempt)

    q = fallback(prompt)
    q['parser'] = 'rules'
    # Said out loud. A degraded parse looks like a bad search result, and
    # nothing else in the output distinguishes the two.
    q['parser_note'] = f'local model unavailable ({why}); used the rule parser'
    return q


if __name__ == '__main__':
    import sys
    for p in (sys.argv[1:] or [
        'two riders without helmets near Majevadi Gate after 8pm',
        'GJ 03 PA 8482 in the last 6 hours',
        'crowd blocking the carriageway',
        'three people on one motorcycle',
        'white car parked on the junction at Adalaj toll',
        'empty road at night',
        'truck going the wrong side',
        'find the muslim men near the market',
    ]):
        print(f'\n> {p}')
        print(json.dumps(parse(p), ensure_ascii=False))
