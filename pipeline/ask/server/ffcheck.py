"""Find out which part of ffmpeg segfaults, and whether we need it at all.

Run as: ffcheck.py <cam-id>

A SIGSEGV with no stderr says nothing about the cause, so each capability the
capture depends on is exercised separately: the binary itself, TLS, the
-headers option, and decoding. The last two steps check whether a pure-Python
HLS fetch plus the OpenCV decoder can do the job without the CLI at all.
"""
import os
import subprocess
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.environ['PIPELINE_DIR'])

CAM = sys.argv[1] if len(sys.argv) > 1 else 'cam08'
HOST = 'https://cctv.corp8.cloud'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
FF = os.environ.get('FFMPEG', 'ffmpeg')
TMP = os.environ.get('SENTINEL_TMP', '/tmp')
os.makedirs(TMP, exist_ok=True)

from run_batch import grid_session  # noqa: E402


def run(label, cmd, timeout=90):
    """Run one ffmpeg invocation and report how it ended, not just whether."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print('  %-26s timed out' % label)
        return None
    rc = r.returncode
    how = ('SIGSEGV' if rc == -11 else 'signal %d' % -rc if rc < 0
           else 'exit %d' % rc)
    err = (r.stderr or '').strip().splitlines()
    note = (' | ' + err[-1][:70]) if err else ''
    print('  %-26s %s%s' % (label, how, note))
    return rc


print('=== the binary ===')
print('  path                       %s' % FF)
run('ffmpeg -version', [FF, '-version'], timeout=30)

protos = ''
try:
    out = subprocess.run([FF, '-hide_banner', '-protocols'],
                         capture_output=True, text=True, timeout=30).stdout
    protos = out
    print('  https protocol             %s'
          % ('present' if '\nhttps' in out or ' https' in out else 'ABSENT'))
except Exception as e:
    print('  protocols                  %s: %s' % (type(e).__name__, e))

session = grid_session(HOST)
if not session:
    print('\n!! no session; cannot test the stream')
    sys.exit(0)
url = '%s/%s/index.m3u8' % (HOST, CAM)
cookie = 'Cookie: sentinel=' + session + '\r\n'

print('\n=== ffmpeg against the stream (5s each) ===')
base = [FF, '-hide_banner', '-loglevel', 'error']
run('bare url, no UA/cookie',
    base + ['-i', url, '-t', '5', '-c', 'copy', '-y', TMP + '/a.mp4'])
run('with -user_agent',
    base + ['-user_agent', UA, '-i', url, '-t', '5', '-c', 'copy', '-y',
            TMP + '/b.mp4'])
run('with -user_agent -headers',
    base + ['-user_agent', UA, '-headers', cookie, '-i', url, '-t', '5',
            '-c', 'copy', '-y', TMP + '/c.mp4'])

print('\n=== the same fetch in Python ===')


def get(u):
    req = urllib.request.Request(
        u, headers={'User-Agent': UA, 'Cookie': 'sentinel=' + session})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


body = get(url).decode('utf8', 'replace')
uris = [ln.strip() for ln in body.splitlines()
        if ln.strip() and not ln.startswith('#')]
if uris and uris[0].endswith('.m3u8'):
    url = urllib.parse.urljoin(url, uris[0])
    print('  master playlist -> variant %s' % uris[0])
    body = get(url).decode('utf8', 'replace')
    uris = [ln.strip() for ln in body.splitlines()
            if ln.strip() and not ln.startswith('#')]

local = TMP + '/py.ts'
got = 0
with open(local, 'wb') as f:
    for u in uris[-4:]:
        try:
            chunk = get(urllib.parse.urljoin(url, u))
        except Exception as e:
            print('  segment %-18s %s: %s' % (u[:18], type(e).__name__, e))
            break
        f.write(chunk)
        got += len(chunk)
print('  %d segments downloaded     %.2f MB' % (min(4, len(uris)), got / 1e6))

if got:
    print('\n=== decoding that local file ===')
    run('ffmpeg on the local .ts',
        base + ['-i', local, '-t', '5', '-c', 'copy', '-y', TMP + '/d.mp4'])
    try:
        import cv2
        cap = cv2.VideoCapture(local)
        ok, frame = cap.read()
        n = 0
        while ok and n < 400:
            n += 1
            ok, _ = cap.read()
        cap.release()
        print('  cv2 decode                 %d frames, first %s'
              % (n, 'x'.join(str(d) for d in frame.shape[:2][::-1])
                 if frame is not None else 'none'))
    except Exception as e:
        print('  cv2 decode                 %s: %s' % (type(e).__name__, e))

for f in ('a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'py.ts'):
    p = os.path.join(TMP, f)
    if os.path.exists(p):
        os.remove(p)

print()
print('  If every ffmpeg line is SIGSEGV but cv2 decoded frames, the binary')
print('  is broken and the Python fetch is the way round it.')
print('  If only the -headers line crashes, that option is the trigger.')
print('  If https is ABSENT, this build cannot read the stream at all.')
