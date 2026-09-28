#!/usr/bin/env bash
#
# Run the prompt-search service so it stays up.
#
#   bash run.sh            # start it, detached, with a watchdog
#   bash run.sh --tunnel   # ... and expose it on a public URL
#   bash run.sh --stop
#   bash run.sh --status
#   bash run.sh --logs
#
# Detached with setsid, not just nohup, because the usual way to start this is
# a cell in a Jupyter notebook. A plain background job is a child of the
# kernel: restart the kernel, or let the notebook idle-cull, and the service
# goes with it. setsid puts it in its own session, so it outlives all of that.
#
# The watchdog exists because the host is shared. Another job can take the
# memory this one wanted and the process dies mid-afternoon with nobody
# watching; a service that a colleague's training run can silently end is not
# one a control room can point at.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SENTINEL_HOME:-$HOME/sentinel}"
PIDFILE="$ROOT/ask.pid"
GUARDPID="$ROOT/guard.pid"
LOG="$ROOT/ask.log"
PORT="${ASK_PORT:-8077}"

[ -f "$ROOT/env.sh" ] || { echo "!! run setup.sh first"; exit 1; }
# shellcheck disable=SC1091
source "$ROOT/env.sh"

status() {
  local up="down"
  curl -sf -m 5 -H "x-ask-token: ${ASK_TOKEN:-}" \
    "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && up="up"
  echo "  service  : $up  (port $PORT)"
  curl -sf -m 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 \
    && echo "  ollama   : up" || echo "  ollama   : down"
  if [ -f "$GUARDPID" ] && kill -0 "$(cat "$GUARDPID")" 2>/dev/null; then
    echo "  watchdog : running (pid $(cat "$GUARDPID"))"
  else
    echo "  watchdog : not running"
  fi
  pgrep -f 'ngrok http' >/dev/null 2>&1 && echo "  tunnel   : running" || echo "  tunnel   : none"
  [ -f "$ROOT/tunnel.url" ] && echo "  url      : $(cat "$ROOT/tunnel.url")"
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --logs)   tail -n "${2:-80}" -f "$LOG"; exit 0 ;;
  --stop)
    echo "==> stopping"
    # The watchdog first, or it will helpfully restart what we just killed.
    [ -f "$GUARDPID" ] && kill "$(cat "$GUARDPID")" 2>/dev/null || true
    rm -f "$GUARDPID"
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
    pkill -f 'ask.serve' 2>/dev/null || true
    pkill -f 'ngrok http' 2>/dev/null || true
    sleep 1
    status
    exit 0 ;;
esac

[ -d "$ROOT/index" ] || { echo "!! no index at $ROOT/index — run build_index.sh"; exit 1; }

if [ -f "$GUARDPID" ] && kill -0 "$(cat "$GUARDPID")" 2>/dev/null; then
  echo "==> already running"
  status
  exit 0
fi

# A token is not optional once the port is reachable by anyone else on the
# network, and on a shared host it is. Generated once and kept.
if [ -z "${ASK_TOKEN:-}" ]; then
  if [ -f "$ROOT/token" ]; then
    ASK_TOKEN="$(cat "$ROOT/token")"
  else
    ASK_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
    echo "$ASK_TOKEN" > "$ROOT/token"
    chmod 600 "$ROOT/token"
  fi
  export ASK_TOKEN
  grep -q '^export ASK_TOKEN=' "$ROOT/env.sh" \
    || echo "export ASK_TOKEN=\"$ASK_TOKEN\"" >> "$ROOT/env.sh"
fi

# ── The watchdog ───────────────────────────────────────────────────────
cat > "$ROOT/guard.sh" <<'GUARD'
#!/usr/bin/env bash
source "$SENTINEL_HOME/env.sh"
source "$VENV/bin/activate"
LOG="$SENTINEL_HOME/ask.log"
PORT="${ASK_PORT:-8077}"
backoff=5
while true; do
  # Ollama is a separate process and dies on its own account; bring it back
  # before the service that depends on it.
  if ! curl -sf -m 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "[guard $(date -Is)] ollama down, restarting" >> "$LOG"
    nohup ollama serve >> "$SENTINEL_HOME/ollama.log" 2>&1 &
    sleep 8
  fi

  echo "[guard $(date -Is)] starting the service" >> "$LOG"
  cd "$PIPELINE_DIR"
  python -u -m ask.serve --index "$SENTINEL_HOME/index" \
        --host 0.0.0.0 --port "$PORT" >> "$LOG" 2>&1 &
  child=$!
  echo "$child" > "$SENTINEL_HOME/ask.pid"
  wait "$child" || true

  echo "[guard $(date -Is)] service exited, restarting in ${backoff}s" >> "$LOG"
  sleep "$backoff"
  # Back off to a minute so a permanently broken config does not spin, but
  # recover quickly from a one-off kill.
  backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
done
GUARD
chmod +x "$ROOT/guard.sh"

echo "==> starting (log: $LOG)"
: > "$LOG"
SENTINEL_HOME="$ROOT" ASK_PORT="$PORT" \
  setsid nohup bash "$ROOT/guard.sh" > /dev/null 2>&1 < /dev/null &
echo $! > "$GUARDPID"

echo -n "    waiting for the models to load"
for _ in $(seq 1 240); do
  if curl -sf -m 5 -H "x-ask-token: $ASK_TOKEN" \
       "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo " ok"; break
  fi
  echo -n "."; sleep 2
done
echo

# ── Optional public URL ────────────────────────────────────────────────
if [ "${1:-}" = "--tunnel" ]; then
  if ! command -v ngrok >/dev/null 2>&1; then
    echo "!! ngrok not installed. Either open $PORT on this host's firewall and"
    echo "   point the web app straight at it, or install ngrok:"
    echo "     curl -sL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C $ROOT"
  else
    DOMAIN="${NGROK_DOMAIN:-}"
    HELP="$(ngrok http --help 2>&1 || true)"
    if [ -n "$DOMAIN" ]; then
      if echo "$HELP" | grep -q -- '--url '; then
        setsid nohup ngrok http "$PORT" --url "https://$DOMAIN" --log stdout \
          > "$ROOT/ngrok.log" 2>&1 < /dev/null &
      else
        setsid nohup ngrok http "$PORT" --domain "$DOMAIN" --log stdout \
          > "$ROOT/ngrok.log" 2>&1 < /dev/null &
      fi
      echo "https://$DOMAIN" > "$ROOT/tunnel.url"
    else
      setsid nohup ngrok http "$PORT" --log stdout \
        > "$ROOT/ngrok.log" 2>&1 < /dev/null &
      sleep 6
      grep -oE 'https://[a-z0-9-]+\.ngrok[a-z.-]*\.app' "$ROOT/ngrok.log" \
        | head -1 > "$ROOT/tunnel.url" || true
      echo "!! no NGROK_DOMAIN: this URL changes on every restart."
    fi
    sleep 2
  fi
fi

echo
status
echo
echo "  token    : $ASK_TOKEN"
echo
echo "  Point the web app at it:"
if [ -f "$ROOT/tunnel.url" ] && [ -s "$ROOT/tunnel.url" ]; then
  echo "    VITE_ASK_API_URL=$(cat "$ROOT/tunnel.url")"
else
  echo "    VITE_ASK_API_URL=http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
fi
echo "    VITE_ASK_TOKEN=$ASK_TOKEN"
