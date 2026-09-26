"""
HTTP front for the prompt search, so the web app can call it.

    python -m ask.serve --port 8077

    GET  /health
    POST /ask       {"prompt": "...", "k": 10, "verify": true}
    GET  /thumb/<file>

Deliberately a separate process from the web tier rather than an endpoint in
the Vercel app. The models need a GPU and several gigabytes of resident memory,
which an edge function has neither of, and this service holds them loaded
between requests — a cold start that loads SigLIP takes 20 seconds, which is
the difference between a usable search box and an unusable one.

The safe shape is that it is never exposed: the browser reaches it over the
LAN, or through the pattern the rest of this project uses, where the origin
talks to the worker.

When it IS exposed — a tunnel, so a hosted page can reach the machine holding
the models — set ASK_TOKEN and every request must carry it. Be clear about
what that buys: the page is a browser, so whatever it sends is visible to
anyone using the page. The token stops drive-by scanners finding an open
endpoint; it does not stop someone who has the link. That is the honest
ceiling for a service a browser must call directly, and the reason the answer
for a real deployment is a server-side proxy with a real session, not a
shared string.
"""
from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import os
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import search as search_mod

HERE = os.path.dirname(os.path.abspath(__file__))

_lock = threading.Lock()   # one GPU; serialise the model work
_state: dict = {}

# Optional shared secret. Unset (the default) keeps the service open, which is
# correct on a laptop that nothing outside can route to.
TOKEN = os.environ.get('ASK_TOKEN', '').strip()


def authorised(handler: BaseHTTPRequestHandler) -> bool:
    if not TOKEN:
        return True
    sent = (handler.headers.get('x-ask-token') or '').strip()
    if not sent:
        # Images are loaded by <img>, which cannot carry a header, so the
        # thumbnail route accepts the token in the query string instead.
        q = urllib.parse.urlparse(handler.path).query
        sent = (urllib.parse.parse_qs(q).get('t') or [''])[0].strip()
    return hmac.compare_digest(sent, TOKEN)


def _json(handler: BaseHTTPRequestHandler, code: int, obj) -> None:
    body = json.dumps(obj).encode()
    handler.send_response(code)
    handler.send_header('content-type', 'application/json')
    handler.send_header('content-length', str(len(body)))
    handler.send_header('access-control-allow-origin', '*')
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        print(f'  {self.address_string()} {fmt % a}')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-headers', 'content-type, x-ask-token')
        self.send_header('access-control-allow-methods', 'POST, GET, OPTIONS')
        self.send_header('access-control-max-age', '86400')
        self.end_headers()

    def do_GET(self):
        if not authorised(self):
            return _json(self, 401, {'error': 'x-ask-token required'})
        if self.path.startswith('/health'):
            idx = _state.get('index')
            return _json(self, 200, {
                'ok': True,
                'frames': len(idx) if idx else 0,
                'model': idx.meta.get('model') if idx else None,
                'dim': idx.dim if idx else None,
                'parser_up': __import__('ask.parse', fromlist=['x']).ollama_up(),
            })
        m = re.match(r'^/thumb/([A-Za-z0-9_.\-]+)(?:\?.*)?$', self.path)
        if m:
            # Name-only match, no path separators: a thumbnail route that
            # accepts a path is a directory traversal waiting to happen.
            p = os.path.join(_state['index'].thumbs, m.group(1))
            if not os.path.isfile(p):
                return _json(self, 404, {'error': 'no such thumbnail'})
            data = open(p, 'rb').read()
            self.send_response(200)
            self.send_header('content-type', mimetypes.guess_type(p)[0] or 'image/jpeg')
            self.send_header('content-length', str(len(data)))
            self.send_header('cache-control', 'public, max-age=86400')
            self.send_header('access-control-allow-origin', '*')
            self.end_headers()
            self.wfile.write(data)
            return
        return _json(self, 404, {'error': 'not found'})

    def do_POST(self):
        if not authorised(self):
            return _json(self, 401, {'error': 'x-ask-token required'})
        if not self.path.startswith('/ask'):
            return _json(self, 404, {'error': 'not found'})
        try:
            n = int(self.headers.get('content-length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return _json(self, 400, {'error': 'bad json'})

        prompt = str(req.get('prompt') or '').strip()
        if not prompt:
            return _json(self, 400, {'error': 'prompt is required'})

        from .ask import run
        with _lock:
            r = run(prompt, _state['path'], int(req.get('k') or 10),
                    bool(req.get('verify')), int(req.get('verify_limit') or 10),
                    bool(req.get('no_model')), dim=_state.get('dim'),
                    do_ground=req.get('ground', True))
        # The browser cannot read a local path; hand back a URL it can fetch.
        for res in r.get('results', []):
            res['thumb_url'] = f'/thumb/{os.path.basename(res["thumb"])}'
            res.pop('thumb', None)
        return _json(self, 200, r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', default=os.path.join(HERE, '_index'))
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8077)
    ap.add_argument('--dim', type=int, default=None)
    args = ap.parse_args()

    _state['path'] = args.index
    _state['dim'] = args.dim
    _state['index'] = search_mod.Index(args.index, dim=args.dim)

    # Load the embedder now rather than on the first query: a 20-second first
    # search looks like a broken feature.
    from . import embed
    embed.load()

    print(f'index   {len(_state["index"])} frames, dim {_state["index"].dim}')
    print(f'auth    {"ASK_TOKEN set" if TOKEN else "OPEN - do not expose this port"}')
    print(f'serving http://{args.host}:{args.port}   POST /ask')
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
