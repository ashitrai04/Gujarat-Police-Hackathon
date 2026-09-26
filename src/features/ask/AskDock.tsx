import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Eye, Send, ShieldAlert, Sparkles, X,
} from 'lucide-react';
import {
  ask, askHealth, thumbUrl, ASK_CONNECTED,
  type AskResponse, type AskResult,
} from '@/api/ask';
import { Spinner } from '@/components/ui';
import { useStore } from '@/app/store';
import './AskDock.css';

/**
 * The estate, asked in plain language, from a corner of the screen.
 *
 * It sits where a console's assistant belongs — out of the way until wanted,
 * never occupying a panel slot that an operator is using for something else.
 * A trace, the watchlist and a camera's detail are all things you work *in*;
 * a question is something you ask *while* working, so it opens over the top and
 * closes again without disturbing what is underneath.
 *
 * It keeps a conversation rather than a single result list, because the way
 * this actually gets used is narrowing: ask broadly, look, ask again with a
 * place or a count added. Throwing the previous answer away each time would
 * make that loop cost a retype.
 *
 * Every answer carries the frame, the counts a detector found, and — when the
 * vision model was asked — a sentence saying what it saw. The same rule the
 * rest of this console follows: never show a conclusion without the evidence
 * that produced it.
 */

const SUGGESTIONS = [
  'a busy road junction full of traffic',
  'an autorickshaw',
  'a truck loaded with sacks',
  'traffic at Majevadi Gate',
  'a toll plaza with booths',
  'three people on one motorcycle',
];

/* Below this the retrieval is reaching: the index holds nothing close to the
   question and is ranking its least-bad options. Measured on this estate —
   good answers sat at 0.13–0.16 and a query for something absent from the
   footage entirely topped out at 0.105. */
const WEAK_SCORE = 0.11;

interface Turn {
  id: number;
  prompt: string;
  state: 'thinking' | 'done' | 'error';
  res?: AskResponse;
  error?: string;
}

let nextId = 1;

export function AskDock() {
  const open = useStore((s) => s.askOpen);
  const setOpen = useStore((s) => s.setAskOpen);
  const panelOpen = useStore((s) => s.panel.kind !== 'none');
  const dockOpen = useStore((s) => s.dockOpen);
  // The dock is resizable, so its real height lives in the store. Reading the
  // --dock-h token instead put the button on top of a video tile whenever an
  // operator had dragged the wall taller than the token's default.
  const dockH = useStore((s) => s.dockH);
  const wallFullscreen = useStore((s) => s.wallFullscreen);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [verify, setVerify] = useState(false);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof askHealth>>>(null);
  const busy = turns.some((t) => t.state === 'thinking');

  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && health === null) void askHealth().then(setHealth);
    if (open) setTimeout(() => box.current?.focus(), 80);
  }, [open, health]);

  // Keep the newest answer in view as it arrives.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Escape closes it, the way every other overlay in this console behaves.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    const id = nextId++;
    setTurns((t) => [...t, { id, prompt: clean, state: 'thinking' }]);
    setPrompt('');
    try {
      const res = await ask(clean, { k: 8, verify });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: 'done', res } : x)));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: 'error', error } : x)));
    }
  }

  /* Bottom-right, floating over whatever is there.
     Fitting it into the gap above the video wall was tried and is worse: an
     operator who has dragged the wall tall leaves a 200px slot, and the
     assistant arrives pre-squashed. It is an overlay, so it overlays — and
     only while it is open, which is the moment nobody is watching that
     corner tile. The right panel is still avoided, because that one IS being
     read at the same time as the question is asked. */
  const right = panelOpen ? 'calc(var(--panel-w) + 18px)' : '18px';
  const maxH = 'calc(100vh - var(--bar-h) - 52px)';
  // The closed button stays clear of the dock handle.
  const fabBottom = dockOpen ? `${dockH + 16}px` : '84px';

  // The full-screen wall is its own screen with its own nav. An assistant
  // floating over it would cover a feed and belong to neither.
  if (wallFullscreen) return null;

  if (!open) {
    return (
      <button
        data-tour="ask"
        className="ask-fab"
        style={{ bottom: fabBottom, right }}
        onClick={() => setOpen(true)}
        aria-label="Ask the estate"
        title="Ask the estate"
      >
        <span className="ask-fab-glow" aria-hidden />
        <Sparkles size={19} />
        <span className="ask-fab-label">Ask the estate</span>
      </button>
    );
  }

  return (
    <section
      className="ask-dock"
      style={{ bottom: '18px', right, maxHeight: `min(640px, ${maxH})` }}
      data-tour="ask-dock"
    >
      <header className="ask-head">
        <span className="ask-head-icon" aria-hidden><Sparkles size={14} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="ask-title">Ask the estate</h2>
          <p className="ask-sub">
            {health
              ? `${health.frames.toLocaleString()} frames · ${health.parser_up ? 'local model' : 'rules only'}`
              : ASK_CONNECTED ? 'connecting…' : 'offline'}
          </p>
        </div>
        <button className="ask-icon-btn" onClick={() => setOpen(false)} aria-label="Close">
          <X size={15} />
        </button>
      </header>

      <div className="ask-stream" ref={scroller}>
        {!ASK_CONNECTED && (
          <div className="ask-offline">
            <p>
              <b>The search service is not reachable from here.</b> It holds several
              gigabytes of models and needs a GPU, so it runs beside the inference
              worker rather than on the web tier — a deployment cannot reach it.
            </p>
            <p>
              Open the console on the machine running the service
              (<code>http://localhost:5173</code>) and this box comes alive. To point a
              deployment at one, set <code>VITE_ASK_API_URL</code> and rebuild.
            </p>
          </div>
        )}

        {ASK_CONNECTED && turns.length === 0 && (
          <div className="ask-welcome">
            <p className="ask-welcome-lead">
              Describe what you are looking for and I will find the moments that match
              across the camera estate.
            </p>
            <div className="ask-chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ask-chip" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t) => (
          <div key={t.id} className="ask-turn">
            <p className="ask-you">{t.prompt}</p>

            {t.state === 'thinking' && (
              <p className="ask-thinking"><Spinner size={12} /> searching the index…</p>
            )}
            {t.state === 'error' && <p className="ask-error">{t.error}</p>}
            {t.state === 'done' && t.res && <Answer res={t.res} />}
          </div>
        ))}
      </div>

      <form
        className="ask-composer"
        onSubmit={(e) => { e.preventDefault(); void send(prompt); }}
      >
        <input
          ref={box}
          data-tour="ask-prompt"
          name="ask"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={ASK_CONNECTED ? 'describe the incident…' : 'search service not connected'}
          disabled={!ASK_CONNECTED}
          title={ASK_CONNECTED ? undefined : 'Runs only where the search service is reachable'}
          className="ask-input"
        />
        <button
          type="button"
          className={`ask-verify${verify ? ' on' : ''}`}
          disabled={!ASK_CONNECTED}
          onClick={() => setVerify((v) => !v)}
          title="Check each result with the vision model — slower, far fewer false hits"
          aria-pressed={verify}
        >
          <Eye size={13} />
        </button>
        <button
          type="submit"
          data-tour="ask-go"
          className="ask-send"
          disabled={busy || !prompt.trim() || !ASK_CONNECTED}
          aria-label="Search"
        >
          {busy ? <Spinner size={12} /> : <Send size={14} />}
        </button>
      </form>
    </section>
  );
}

/* ── One answer ─────────────────────────────────────────────── */

function Answer({ res }: { res: AskResponse }) {
  const setFocusCamera = useStore((s) => s.setFocusCamera);
  const openPanel = useStore((s) => s.openPanel);

  if (res.refused) {
    return (
      <div className="ask-refused">
        <ShieldAlert size={14} className="shrink-0" />
        <p>{res.refused}</p>
      </div>
    );
  }

  const top = res.results[0]?.score ?? 0;
  const weak = top < WEAK_SCORE;

  return (
    <div className="ask-answer">
      <p className="ask-note">{summarise(res)}</p>

      {res.results.length === 0 && (
        <p className="ask-empty">
          Nothing matched.{' '}
          {res.n_candidates === 0
            ? 'The filters excluded every frame — try dropping a count or a place.'
            : 'No frame in the index is close to that description.'}
        </p>
      )}

      {weak && res.results.length > 0 && (
        <p className="ask-weak">
          Weak match — the closest frame scored {top.toFixed(3)}. The estate may hold
          nothing like this; these are the nearest options, not confirmed hits.
        </p>
      )}

      <div className="ask-grid">
        {res.results.map((r, i) => (
          <Hit
            key={r.id}
            r={r}
            n={i + 1}
            onMap={() => setFocusCamera(r.camera_id)}
            onOpen={() => openPanel({ kind: 'camera', cameraId: r.camera_id })}
          />
        ))}
      </div>
    </div>
  );
}

function Hit({ r, n, onMap, onOpen }: {
  r: AskResult; n: number; onMap: () => void; onOpen: () => void;
}) {
  const counts = Object.entries(r.counts);
  return (
    <figure className="ask-hit">
      <button className="ask-hit-img" onClick={onMap} title="Show this camera on the map">
        <img src={thumbUrl(r.thumb_url)} alt="" loading="lazy" />
        <span className="ask-hit-rank">{n}</span>
        {r.verified === true && <span className="ask-hit-flag ok">confirmed</span>}
        {r.verified === false && <span className="ask-hit-flag no">rejected</span>}
      </button>
      <figcaption>
        <div className="ask-hit-meta">
          <button className="ask-hit-cam" onClick={onOpen} title="Open this camera">
            {r.camera_id}
          </button>
          <span className="ask-hit-t">t+{r.t_s.toFixed(0)}s</span>
          <span className="ask-hit-score">{r.score.toFixed(3)}</span>
        </div>
        {counts.length > 0 && (
          <p className="ask-hit-counts">
            {counts.map(([k, v]) => `${k} ×${v}`).join('  ')}
          </p>
        )}
        {r.reason && <p className="ask-hit-reason">{r.reason}</p>}
        {r.grounding && <p className="ask-hit-ground">{r.grounding}</p>}
      </figcaption>
    </figure>
  );
}

/** What the system did with the question, in one readable line. */
function summarise(res: AskResponse): string {
  const p = res.plan;
  const bits: string[] = [];
  if (p.free_text) bits.push(`looked for “${p.free_text}”`);
  if (p.places?.length) bits.push(`at ${p.places.join(', ')}`);
  if (p.classes?.length) bits.push(`containing ${p.classes.join(' or ')}`);
  if (p.counts) {
    bits.push(Object.entries(p.counts).map(([k, v]) => `${v.min}+ ${k}`).join(', '));
  }
  if (p.riders) bits.push(`${p.riders.min}+ on one two-wheeler`);
  if (p.attributes?.length) bits.push(p.attributes.join(', '));

  const head = bits.length ? bits.join(' · ') : 'searched the whole index';
  const scope = `${res.n_candidates?.toLocaleString()} of ${res.n_indexed?.toLocaleString()} frames`;
  const ver = res.verification
    ? ` · ${res.verification.confirmed}/${res.verification.checked} confirmed by the vision model`
    : '';
  const slow = res.timing.verify_s ? ` · ${res.timing.verify_s.toFixed(1)}s` : '';
  return `${head} — ${scope}${ver}${slow}`;
}
