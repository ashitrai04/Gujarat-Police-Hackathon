"""Ask each layer of one capture in turn, and say which one refused.

Run as: _capcheck.py <cam-id> <seconds>
Values come in through argv so this file stays a plain script -- no f-string
wrapping it, so no brace-escaping to get wrong.
"""
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.environ['PIPELINE_DIR'])

CAM = sys.argv[1]
SECONDS = int(sys.argv[2])
HOST = 'https://cctv.corp8.cloud'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

from run_batch import capture, grid_session

key = os.environ.get('SENTINEL_ACCESS_KEY', '')
email = os.environ.get('SENTINEL_ACCESS_EMAIL', '')
print('  key set / email set : %s / %s' % (bool(key), bool(email)))
if not key:
    print('  -> no access key in the environment; nothing else can succeed')
    sys.exit(0)

session = grid_session(HOST)
print('  session cookie      : %s' % ('acquired' if session else 'NONE'))
if not session:
    print('  -> sign-in refused. The key or the email is wrong, or the grid')
    print('     is already holding a session for another address.')
    sys.exit(0)

url = '%s/%s/index.m3u8' % (HOST, CAM)
headers = {'User-Agent': UA, 'Cookie': 'sentinel=' + session}
try:
    with urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=30) as r:
        body = r.read(4096).decode('utf8', 'replace')
    lines = [ln for ln in body.splitlines() if ln.strip()]
    segs = [ln for ln in lines if not ln.startswith('#')]
    print('  playlist            : HTTP %s, %d lines, %d segments'
          % (r.status, len(lines), len(segs)))
    if not segs:
        print('  -> the playlist is valid but lists no segments: the camera is')
        print('     registered and reachable, and is publishing nothing. This')
        print('     is what produces a sub-50KB file and "no video".')
except urllib.error.HTTPError as e:
    detail = e.read(200).decode('utf8', 'replace').strip().replace('\n', ' ')
    print('  playlist            : HTTP %s  %s' % (e.code, detail[:100]))
    print('  -> 401/403: the cookie was not accepted. 404: this camera id is')
    print('     not on the grid. 52x: the feed host itself is down.')
    sys.exit(0)
except Exception as e:
    print('  playlist            : %s: %s' % (type(e).__name__, e))
    sys.exit(0)

print('  ffmpeg              : %s' % os.environ.get('FFMPEG', 'ffmpeg'))
tmp = os.environ.get('SENTINEL_TMP', '/tmp')
os.makedirs(tmp, exist_ok=True)
dest = os.path.join(tmp, 'capcheck.mp4')
if os.path.exists(dest):
    os.remove(dest)

ok = capture(url, SECONDS, dest, session)
size = os.path.getsize(dest) if os.path.exists(dest) else 0
print('  capture             : %s, %.2f MB in %ss'
      % ('ok' if ok else 'FAILED', size / 1e6, SECONDS))
if not ok and 0 < size < 50_000:
    print('  -> ffmpeg connected and wrote %d bytes, under the 50KB floor.' % size)
    print('     The stream is up but idle or stalled, not absent. A longer')
    print('     capture window is worth trying before blaming the pipeline.')
elif not ok and size == 0:
    print('  -> ffmpeg wrote nothing at all. The line above from run_batch')
    print('     carries its stderr, which names the actual refusal.')
if os.path.exists(dest):
    os.remove(dest)
