"""
End to end: a sentence in, ranked moments out.

    python -m ask.ask "two riders without helmets at Majevadi Gate"
    python -m ask.ask "crowd blocking the carriageway" --verify
    python -m ask.ask "three people on one motorcycle" -k 5 --json

Four stages, and the CLI prints what each one did, because a search that
returns nothing should say which stage emptied it. "No results" is a bug
report with no information in it; "the class filter left 0 of 3634 frames" is
one you can act on.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import parse as parser_mod
from . import search as search_mod


def run(prompt: str, index_path: str, k: int, do_verify: bool,
        verify_limit: int, no_model: bool, dim: int | None = None,
        do_ground: bool = True) -> dict:
    t0 = time.time()
    plan = parser_mod.parse(prompt, use_model=not no_model)
    t_parse = time.time() - t0

    if plan.get('refused'):
        return {'prompt': prompt, 'plan': plan, 'refused': plan['refused'],
                'results': [], 'timing': {'parse_s': round(t_parse, 2)}}

    idx = search_mod.Index(index_path, dim=dim)
    t1 = time.time()
    out = idx.search(plan, k=k)
    t_search = time.time() - t1

    # Grounding before verification: it is cheaper, and its box counts go into
    # the question the verifier is asked, which is a better question than the
    # caption alone.
    grd = None
    t_ground = 0.0
    attrs = plan.get('attributes') or []
    if do_ground and attrs and out['results']:
        from . import ground as ground_mod
        t_g = time.time()
        try:
            grd = ground_mod.apply(out['results'], attrs, plan.get('classes'),
                                   limit=max(k, verify_limit))
        except Exception as e:                       # noqa: BLE001
            grd = {'ran': False, 'error': f'{type(e).__name__}: {e}'}
        t_ground = time.time() - t_g

    ver = None
    t_verify = 0.0
    if do_verify and out['results']:
        from . import verify as verify_mod
        question = plan.get('free_text') or prompt
        # Attribute phrases are exactly what retrieval is worst at and what the
        # verifier is best at, so they are put back into the question here even
        # though the caption deliberately left them out.
        if attrs:
            question = f'{question} ({", ".join(attrs)})'
        t2 = time.time()
        ver = verify_mod.verify_all(out['results'], question, limit=verify_limit)
        t_verify = time.time() - t2

    return {
        'prompt': prompt,
        'plan': plan,
        'applied': out['applied'],
        'notes': out['notes'],
        'n_indexed': len(idx),
        'n_candidates': out['n_candidates'],
        'ranked_by': out['ranked_by'],
        'dim': out.get('dim'),
        'grounding': grd,
        'verification': ver,
        'results': out['results'],
        'timing': {'parse_s': round(t_parse, 2), 'search_s': round(t_search, 3),
                   'ground_s': round(t_ground, 2), 'verify_s': round(t_verify, 2)},
    }


def show(r: dict) -> None:
    print(f'\n> {r["prompt"]}')
    if r.get('refused'):
        print(f'\n  REFUSED — {r["refused"]}')
        return

    p = r['plan']
    bits = []
    if p.get('free_text'):
        bits.append(f'caption="{p["free_text"]}"')
    for key in ('classes', 'counts', 'places', 'cameras', 'attributes', 'event', 'hours', 'plate'):
        if p.get(key):
            bits.append(f'{key}={json.dumps(p[key])}')
    print(f'  plan     [{p.get("parser", "?")}]  ' + '  '.join(bits))
    if p.get('parser_note'):
        print(f'  DEGRADED {p["parser_note"]}')
    if r['applied']:
        print(f'  filter   {json.dumps(r["applied"])}'
              f'  -> {r["n_candidates"]} of {r["n_indexed"]} frames')
    else:
        print(f'  filter   none  -> all {r["n_indexed"]} frames')
    print(f'  ranked   {r["ranked_by"]}')
    for n in r['notes']:
        print(f'  note     {n}')
    g = r.get('grounding')
    if g and g.get('ran'):
        print(f'  grounded {g["passed"]}/{g["checked"]} pass  '
              f'classes={json.dumps(g["classes"])}')
    elif g and g.get('error'):
        print(f'  grounded failed: {g["error"]}')
    v = r.get('verification')
    if v:
        extra = f', {v["failures"]} verifier failures' if v['failures'] else ''
        print(f'  verified {v["confirmed"]}/{v["checked"]} confirmed{extra}')
    t = r['timing']
    print(f'  timing   parse {t["parse_s"]}s  search {t["search_s"]}s'
          + (f'  ground {t["ground_s"]}s' if t.get('ground_s') else '')
          + (f'  verify {t["verify_s"]}s' if t.get('verify_s') else ''))

    if not r['results']:
        print('\n  no frames matched')
        return
    print()
    for i, res in enumerate(r['results'], 1):
        mark = '  '
        if res.get('verified') is True:
            mark = ' Y'
        elif res.get('verified') is False:
            mark = ' n'
        if res.get('grounded') is True:
            mark = mark[0] + 'G' if mark[1] == ' ' else mark
        counts = ' '.join(f'{k[:3]}={v}' for k, v in res['counts'].items()) or '-'
        print(f'{mark} {i:2d}. {res["score"]:+.4f}  {res["camera_id"]:7s} '
              f't={res["t_s"]:7.2f}s  {counts:28s} {os.path.basename(res["thumb"])}')
        if res.get('grounding'):
            print(f'          ground: {res["grounding"]}')
        if res.get('reason'):
            print(f'          {res["reason"]}')


def main() -> None:
    ap = argparse.ArgumentParser(description='Natural-language search over indexed footage.')
    ap.add_argument('prompt', nargs='+')
    ap.add_argument('--index', default=search_mod.DEFAULT_INDEX)
    ap.add_argument('-k', type=int, default=10)
    ap.add_argument('--verify', action='store_true', help='run the VLM check on the top results')
    ap.add_argument('--verify-limit', type=int, default=10)
    ap.add_argument('--no-model', action='store_true', help='rule-based parser only')
    ap.add_argument('--no-ground', action='store_true', help='skip open-vocab grounding')
    ap.add_argument('--dim', type=int, default=None,
                    help='narrow the embedding to this width (to measure the cost)')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    prompt = ' '.join(args.prompt)
    if not os.path.exists(os.path.join(args.index, 'vectors.npy')):
        sys.exit(f'no index at {args.index} — run:  python -m ask.index <videos>')

    r = run(prompt, args.index, args.k, args.verify, args.verify_limit,
            args.no_model, dim=args.dim, do_ground=not args.no_ground)
    if args.json:
        print(json.dumps(r, indent=2))
    else:
        show(r)


if __name__ == '__main__':
    main()
