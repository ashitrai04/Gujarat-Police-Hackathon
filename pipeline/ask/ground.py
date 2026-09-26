"""
Open-vocabulary grounding: find the thing the prompt named, as a box.

The embedding stage scores a whole frame against a whole caption, which is the
wrong granularity for half of what an operator types. "A rider without a
helmet" is not a property of a scene; it is a property of one head in it. A
frame containing nine helmeted riders and one bare one scores about the same as
a frame of ten helmeted riders, because almost all of the picture is identical.

So when the parser finds an attribute phrase, the shortlist gets a second pass
from YOLO-World, which takes its class list as text at inference time. Phrases
the system has never been trained on become classes on the spot, which is what
makes new violation types possible without collecting a dataset first.

Two honest limits, both measured rather than assumed in evaluate.py:

  - Negation is not a detectable class. "Without a helmet" cannot be asked for
    directly; what works is detecting `helmet` and `human head` and comparing
    counts per rider. That is arithmetic on top of detection, not detection.
  - Open-vocabulary recall on 480p-ish CCTV at distance is poor. A specialist
    model fine-tuned on helmets will beat this, which is exactly why the plan
    keeps one as a separate stage rather than treating YOLO-World as the answer.
"""
from __future__ import annotations

import re

WEIGHTS = 'yolov8s-worldv2.pt'

_model = None

# Attribute phrases mapped to the classes that actually settle them. The value
# is (classes to detect, how to decide). Negations become a comparison between
# two counts rather than a class of their own.
RECIPES: dict[str, dict] = {
    'without helmet': {
        'classes': ['helmet', 'human head', 'motorcycle'],
        'rule': 'fewer_than', 'a': 'helmet', 'b': 'human head',
        'needs': 'motorcycle',
    },
    'with helmet': {
        'classes': ['helmet', 'motorcycle'],
        'rule': 'at_least_one', 'a': 'helmet', 'needs': 'motorcycle',
    },
    'triple riding': {
        'classes': ['person', 'motorcycle'],
        'rule': 'count_at_least', 'a': 'person', 'n': 3, 'needs': 'motorcycle',
    },
}

COLOURS = {'red', 'white', 'black', 'blue', 'yellow', 'green', 'silver',
           'orange', 'grey', 'gray'}
VEHICLES = {'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'van',
            'autorickshaw', 'rickshaw'}


def load():
    """YOLO-World small, ~25 MB. Loaded lazily — most queries never need it."""
    global _model
    if _model is None:
        from ultralytics import YOLOWorld
        _model = YOLOWorld(WEIGHTS)
    return _model


def plan_for(attributes: list[str], classes: list[str] | None) -> dict | None:
    """Turn attribute phrases into something detectable, or None.

    Returns {'classes': [...], 'checks': [...]}: the text classes to give the
    detector, and the rules that decide whether a frame qualifies.
    """
    if not attributes:
        return None
    want: list[str] = []
    checks: list[dict] = []

    for raw in attributes:
        a = raw.lower().strip()
        if a in RECIPES:
            r = RECIPES[a]
            want += r['classes']
            checks.append({**r, 'phrase': a})
            continue
        # "red" on its own means nothing to a detector; paired with the class
        # the parser already found it becomes "a red car", which YOLO-World can
        # be asked for directly.
        words = set(re.split(r'[^a-z]+', a))
        colour = next((c for c in words if c in COLOURS), None)
        vehicle = next((c for c in words if c in VEHICLES), None)
        if colour and not vehicle:
            vehicle = next((c for c in (classes or []) if c in VEHICLES), None)
        if colour and vehicle:
            phrase = f'{colour} {vehicle}'
            want.append(phrase)
            checks.append({'rule': 'at_least_one', 'a': phrase, 'phrase': a})
        elif a not in ('wrong side',):
            # Anything else goes to the detector verbatim. It may find nothing;
            # that is reported rather than hidden.
            want.append(a)
            checks.append({'rule': 'at_least_one', 'a': a, 'phrase': a})

    want = list(dict.fromkeys(w for w in want if w))
    return {'classes': want, 'checks': checks} if want else None


def detect(image_path: str, classes: list[str], conf: float = 0.05) -> dict:
    """Counts per requested class on one frame.

    The confidence floor is deliberately low. Open-vocabulary detectors score
    unfamiliar phrases far below the 0.25 default even when the box is right,
    and a default threshold silently returns nothing — which reads as "the
    feature does not work" rather than "the threshold was wrong".
    """
    m = load()
    m.set_classes(classes)
    r = m.predict(image_path, conf=conf, verbose=False)[0]
    counts: dict[str, int] = {c: 0 for c in classes}
    boxes: list[list] = []
    for b in r.boxes:
        name = classes[int(b.cls.item())] if int(b.cls.item()) < len(classes) else '?'
        counts[name] = counts.get(name, 0) + 1
        x1, y1, x2, y2 = (round(float(x)) for x in b.xyxy[0].tolist())
        boxes.append([name, round(float(b.conf.item()), 3), x1, y1, x2, y2])
    return {'counts': counts, 'boxes': boxes}


def judge(counts: dict[str, int], checks: list[dict]) -> tuple[bool, str]:
    """Apply the rules. Returns (passes, why)."""
    reasons = []
    ok_all = True
    for c in checks:
        need = c.get('needs')
        if need and counts.get(need, 0) < 1:
            ok_all = False
            reasons.append(f'no {need} found')
            continue
        rule = c['rule']
        if rule == 'at_least_one':
            ok = counts.get(c['a'], 0) >= 1
            reasons.append(f'{c["a"]}x{counts.get(c["a"], 0)}')
        elif rule == 'count_at_least':
            ok = counts.get(c['a'], 0) >= c['n']
            reasons.append(f'{c["a"]}x{counts.get(c["a"], 0)} (need {c["n"]})')
        elif rule == 'fewer_than':
            a, b = counts.get(c['a'], 0), counts.get(c['b'], 0)
            ok = a < b
            reasons.append(f'{c["a"]}x{a} vs {c["b"]}x{b}')
        else:
            ok = True
        ok_all = ok_all and ok
    return ok_all, '; '.join(reasons)


def apply(results: list[dict], attributes: list[str],
          classes: list[str] | None, limit: int = 20) -> dict:
    """Annotate the top results with grounding evidence; never drop them.

    Marking rather than filtering, because open-vocabulary recall here is not
    good enough to justify hiding a frame on its say-so. The operator sees the
    box counts and decides; the alternative is a confident empty result list.
    """
    plan = plan_for(attributes, classes)
    if not plan:
        return {'ran': False}
    passed = 0
    for r in results[:limit]:
        d = detect(r['thumb'], plan['classes'])
        ok, why = judge(d['counts'], plan['checks'])
        r['grounded'] = ok
        r['grounding'] = why
        r['ground_boxes'] = d['boxes'][:12]
        passed += bool(ok)
    return {'ran': True, 'classes': plan['classes'],
            'checked': min(limit, len(results)), 'passed': passed}
