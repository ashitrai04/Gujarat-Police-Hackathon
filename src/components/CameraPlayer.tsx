import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { StatusDot } from './ui';
import type { Camera } from '@/api/types';
import { ARCHIVE_DATE, fallbackUrl, loadFallbackIndex } from '@/api/fallback';

type Phase = 'connecting' | 'live' | 'replay' | 'error' | 'waiting' | 'archive';

/** Backoff between reconnect attempts, in ms. Caps so a dead feed stays cheap. */
const RETRY_MS = [6000, 12000, 25000, 45000, 60000];

/**
 * HLS is the only route a browser can take.
 *
 * The grid's other two endpoints are raw media on a bare public IP: RTSP on
 * :8554 and WHEP on :8889. No CDN can proxy them, and WHEP is plain HTTP,
 * which an HTTPS page will not load at all. They belong to the inference
 * pipeline, not the dashboard. The progressive MP4 the old host offered is
 * gone — there is no file to seek any more.
 *
 * Each playlist is a VOD manifest of roughly 4300 ten-second segments — about
 * twelve hours on a loop — and hls.js would otherwise start at segment zero,
 * which is the middle of the night. Playback is positioned at the current
 * wall-clock offset inside that loop, so a tile opens on daylight and matches
 * what the other tiles are showing.
 */
export function CameraPlayer({
  camera,
  className = '',
  showHeader = true,
  startDelayMs = 0,
  route,
}: {
  camera: Camera;
  className?: string;
  showHeader?: boolean;
  startDelayMs?: number;
  /**
   * What the health probe found. `null` means the feed is not serving, so the
   * tile waits rather than hammering it; when the probe later reports a route,
   * this prop changes and playback starts by itself.
   */
  route?: 'hls' | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [msg, setMsg] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (camera.status === 'offline') {
      setPhase('error');
      setMsg('No signal');
      return;
    }
    // Probe says nothing is serving. Sit quiet — `route` flipping to a real
    // value re-runs this effect and the tile recovers on its own.
    if (route === null) {
      setPhase('waiting');
      setMsg('Waiting for stream');
      return;
    }

    let hls: Hls | null = null;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setPhase('connecting');
    setMsg('');

    const destroyHls = () => {
      hls?.destroy();
      hls = null;
    };

    /** Show the failure, then try again on a widening backoff. */
    const fail = (message: string) => {
      if (cancelled) return;
      setPhase('error');
      setMsg(message);
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      retry = setTimeout(() => !cancelled && setAttempt((n) => n + 1), wait);
    };

    /* ── HLS. `archive` marks the recorded fallback, which must never be
           presented as live — see the badge in the header below. ── */
    const startHls = (url: string, archive = false) => {
      if (cancelled || !videoRef.current) return;
      destroyHls();
      hls = new Hls({
        maxBufferLength: 20,
        backBufferLength: 20,
        lowLatencyMode: false,
        // Segments are AES-128 encrypted and the key is fetched through the
        // same proxy as the playlist, so it must be allowed to carry cookies.
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });

      hls.loadSource(url);
      hls.attachMedia(videoRef.current);

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        const el = videoRef.current;
        if (!el || cancelled) return;
        // A VOD manifest of ~12 hours would otherwise open at segment zero,
        // which is the middle of the night. Land on the current wall-clock
        // position within the loop so every tile shows the same moment.
        const total = data.levels?.[0]?.details?.totalduration
          ?? hls?.levels?.[0]?.details?.totalduration
          ?? 0;
        // Only the live grid's ~12-hour loop needs positioning at wall clock.
        // An archived clip is a couple of minutes long and starts at zero.
        if (!archive && total > 600) {
          try {
            el.currentTime = (Date.now() / 1000) % total;
          } catch {
            /* the browser clamps if the seek lands outside the buffer */
          }
        }
        if (archive) {
          el.loop = true;
          setPhase('archive');
        }
        el.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // Network hiccups on a live grid are expected; hls.js can recover from
        // those in place. Only a hard media failure needs a full restart.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls?.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          return;
        }
        destroyHls();
        // The live feed is gone. If this camera has an archived clip, play it
        // rather than showing a dead tile — but only ever labelled as archive.
        const alt = archive ? null : fallbackUrl(camera.id);
        if (alt) {
          startHls(alt, true);
          return;
        }
        fail('Stream unavailable');
      });
    };

    const begin = () => {
      if (cancelled) return;
      // Knowing which cameras have an archive up front means a failing tile
      // switches immediately instead of waiting on a fetch at the worst moment.
      void loadFallbackIndex();
      if (!Hls.isSupported()) {
        // Safari plays HLS natively and has no MSE for hls.js to attach to.
        const el = videoRef.current;
        if (!el) return;
        el.src = camera.streamUrl;
        el.onerror = () => fail('Stream unavailable');
        el.play().catch(() => {});
        return;
      }
      startHls(camera.streamUrl);
    };

    const timer = setTimeout(begin, startDelayMs);

    // A recorded tile that starts playing must NOT relabel itself as live.
    const onPlaying = () => setPhase((p) => (p === 'archive' ? 'archive' : 'live'));
    const onCanPlay = onPlaying;
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onCanPlay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onCanPlay);
      destroyHls();
      v.removeAttribute('src');
      v.load();
    };
  }, [camera.id, camera.streamUrl, camera.status, startDelayMs, route, attempt]);

  const showOverlay = phase === 'connecting' || phase === 'error' || phase === 'waiting';

  return (
    <div
      className={`relative overflow-hidden rounded-[6px] ${className}`}
      style={{ background: '#05090F', border: '1px solid var(--line)' }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        preload="auto"
        className="h-full w-full object-cover"
      />

      {showOverlay && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          {(phase === 'connecting' || phase === 'waiting') && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
              style={{ borderTopColor: 'var(--signal)', borderRightColor: 'var(--signal)' }}
            />
          )}
          <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
            {phase === 'connecting' ? 'Connecting…' : msg || 'No signal'}
          </span>
          {phase === 'error' && (
            <span className="text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              retrying…
            </span>
          )}
        </div>
      )}

      {showHeader && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-black/80 to-transparent px-2 py-1.5">
          <StatusDot status={camera.status} />
          <span className="truncate text-[10.5px] font-medium" style={{ color: '#E7ECF3' }}>
            {camera.name}
          </span>
          {phase === 'archive' ? (
            /* Deliberately the loudest label on the tile. Recorded footage
               shown in a control room must never be mistaken for live. */
            <span
              className="mono ml-auto flex shrink-0 items-center gap-1 rounded-[3px] px-1.5 py-[1px] text-[9px] font-bold"
              style={{ background: '#F5A524', color: '#1A1206' }}
              title={`Live feed unavailable — playing recorded footage captured ${ARCHIVE_DATE}. This is NOT a live view.`}
            >
              RECORDED · {ARCHIVE_DATE}
            </span>
          ) : (phase === 'live' || phase === 'replay') && (
            <span
              className="mono ml-auto flex shrink-0 items-center gap-1 text-[9px]"
              style={{ color: phase === 'live' ? '#F87171' : 'var(--text-dim)' }}
              title={
                phase === 'live'
                  ? 'Real-time HLS'
                  : 'Live gateway busy — playing the feed at the current wall-clock position'
              }
            >
              <span
                className={phase === 'live' ? 'anim-blink inline-block h-[6px] w-[6px] rounded-full' : 'inline-block h-[6px] w-[6px] rounded-full'}
                style={{ background: phase === 'live' ? '#F87171' : 'var(--text-mute)' }}
              />
              {phase === 'live' ? 'LIVE' : 'SYNCED'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
