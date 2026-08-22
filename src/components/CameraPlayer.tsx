import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { StatusDot } from './ui';
import { STREAM_BASE, fetchCameraState } from '@/api/registry';
import type { Camera } from '@/api/types';

type Phase = 'connecting' | 'live' | 'replay' | 'error';

interface CameraState {
  stream_url: string;
  hls_url: string | null;
  hls_live_url: string | null;
  slot_offset: number;
  slot_seconds: number;
  status: string;
}

/**
 * Mirrors the host's own player fallback chain, which matters because the live
 * HLS gateway caps concurrent sessions — with several tiles up, most get
 * refused and would otherwise sit on "Connecting…" forever.
 *
 *   1. live HLS   (real-time, low latency, limited sessions)
 *   2. VOD HLS    (segmented file, when the live gateway is down)
 *   3. progressive MP4 seeked to slot_offset  (always available)
 *
 * Step 3 is the reliable one: the feeds are 12-hour loops and slot_offset says
 * where "now" is, so seeking there gives the same picture as live.
 */
export function CameraPlayer({
  camera,
  className = '',
  showHeader = true,
  startDelayMs = 0,
  preferProgressive = false,
}: {
  camera: Camera;
  className?: string;
  showHeader?: boolean;
  startDelayMs?: number;
  /** Skip live HLS entirely — useful when many tiles share the host. */
  preferProgressive?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (camera.status === 'offline') {
      setPhase('error');
      setMsg('No signal');
      return;
    }

    let hls: Hls | null = null;
    let cancelled = false;
    setPhase('connecting');
    setMsg('');

    const destroyHls = () => {
      hls?.destroy();
      hls = null;
    };

    /* ── 3. Progressive MP4, seeked to the live position ── */
    const startProgressive = async () => {
      if (cancelled || !videoRef.current) return;
      let offset = 0;
      let url = `${STREAM_BASE}/stream/${camera.id}`;
      try {
        const st = (await fetchCameraState(camera.id)) as CameraState;
        if (cancelled) return;
        offset = st.slot_offset ?? 0;
        if (st.stream_url) url = `${STREAM_BASE}${st.stream_url}`;
      } catch {
        /* fall through with offset 0 — still shows the feed */
      }
      // Only seek if the server honours byte ranges. Some containers (mkv/avi)
      // answer 200 and stream from byte 0 — seeking hours in would mean pulling
      // gigabytes before a single frame appears, so play from the start instead.
      let canSeek = false;
      try {
        const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } });
        canSeek = probe.status === 206;
      } catch {
        canSeek = false;
      }
      if (cancelled) return;

      const el = videoRef.current;
      if (!el || cancelled) return;
      el.src = url;
      const seek = () => {
        try {
          if (canSeek && offset > 0) el.currentTime = offset;
        } catch {
          /* seeking before metadata; the browser will clamp */
        }
        el.play().catch(() => {});
      };
      el.addEventListener('loadedmetadata', seek, { once: true });
      el.onerror = () => {
        setPhase('error');
        setMsg('Stream unavailable');
      };
      el.load();
      setPhase('replay');
    };

    /* ── 1 & 2. HLS ── */
    const startHls = (url: string, live: boolean) => {
      if (cancelled || !videoRef.current) return;
      destroyHls();
      hls = new Hls(
        live
          ? {
              liveSyncDurationCount: 2,
              liveMaxLatencyDurationCount: 6,
              liveDurationInfinity: true,
              lowLatencyMode: true,
              maxBufferLength: 8,
              maxMaxBufferLength: 20,
            }
          : { maxBufferLength: 30, backBufferLength: 30, lowLatencyMode: false },
      );
      hls.loadSource(url);
      hls.attachMedia(videoRef.current);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoRef.current?.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // A refused live session is not recoverable by retrying — drop straight
        // to progressive rather than spinning.
        destroyHls();
        void startProgressive();
      });
    };

    const begin = () => {
      if (cancelled) return;
      const liveUrl = camera.streamUrl;
      if (!preferProgressive && liveUrl.includes('.m3u8') && Hls.isSupported()) {
        startHls(liveUrl, true);
      } else {
        void startProgressive();
      }
    };

    const timer = setTimeout(begin, startDelayMs);

    const onPlaying = () =>
      setPhase((p) => (p === 'replay' ? 'replay' : 'live'));
    const onCanPlay = onPlaying;
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onCanPlay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onCanPlay);
      destroyHls();
      v.removeAttribute('src');
      v.load();
    };
  }, [camera.id, camera.streamUrl, camera.status, startDelayMs, preferProgressive]);

  const showOverlay = phase === 'connecting' || phase === 'error';

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
          {phase === 'connecting' && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
              style={{ borderTopColor: 'var(--signal)', borderRightColor: 'var(--signal)' }}
            />
          )}
          <span className="text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
            {phase === 'connecting' ? 'Connecting…' : msg || 'No signal'}
          </span>
        </div>
      )}

      {showHeader && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-black/80 to-transparent px-2 py-1.5">
          <StatusDot status={camera.status} />
          <span className="truncate text-[10.5px] font-medium" style={{ color: '#E7ECF3' }}>
            {camera.name}
          </span>
          {(phase === 'live' || phase === 'replay') && (
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
