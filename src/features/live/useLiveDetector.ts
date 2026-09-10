import { useEffect, useRef, useState } from 'react';
import type { FrameResult, FromWorker } from './protocol';

/**
 * One detection engine for the whole app.
 *
 * The models are ~21 MB and take a few seconds to compile, so the worker is
 * created once, on first use, and kept: switching from one camera to another
 * costs a tracker reset, not a reload. Only one view feeds it at a time — two
 * panels interleaving frames would stitch two cameras' vehicles into one set
 * of tracks.
 */
type Engine =
  | { status: 'idle' }
  | { status: 'loading'; loaded: number; total: number }
  | { status: 'ready'; backend: 'webgpu' | 'wasm' }
  | { status: 'error'; message: string };

let worker: Worker | null = null;
let engine: Engine = { status: 'idle' };
const listeners = new Set<(e: Engine) => void>();
let owner: ((m: FromWorker) => void) | null = null;

function setEngine(e: Engine) {
  engine = e;
  listeners.forEach((l) => l(e));
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    if (m.type === 'progress') setEngine({ status: 'loading', loaded: m.loaded, total: m.total });
    else if (m.type === 'ready') setEngine({ status: 'ready', backend: m.backend });
    else if (engine.status !== 'ready' && m.type === 'error') setEngine({ status: 'error', message: m.message });
    owner?.(m);
  };
  worker.onerror = (ev) => setEngine({ status: 'error', message: ev.message || 'Detector failed to start' });
  setEngine({ status: 'loading', loaded: 0, total: 0 });
  worker.postMessage({ type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href });
  return worker;
}

/** At most this often — enough to follow traffic without monopolising the GPU. */
const MIN_INTERVAL_MS = 110;

export interface LiveDetector {
  engine: Engine;
  result: FrameResult | null;
  /** Frames analysed per second, measured. */
  fps: number;
  /** The last per-frame failure, if frames are currently failing. */
  frameError: string | null;
}

export function useLiveDetector(
  video: HTMLVideoElement | null,
  enabled: boolean,
  /** Changing this (a different camera) clears the tracks. */
  streamKey: string,
): LiveDetector {
  const [eng, setEng] = useState<Engine>(engine);
  const [result, setResult] = useState<FrameResult | null>(null);
  const [fps, setFps] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const stamps = useRef<number[]>([]);

  useEffect(() => {
    listeners.add(setEng);
    return () => { listeners.delete(setEng); };
  }, []);

  useEffect(() => {
    if (enabled) ensureWorker();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !video || eng.status !== 'ready' || !worker) return;
    const w = worker;
    w.postMessage({ type: 'reset' });
    stamps.current = [];
    let stopped = false;
    let busy = false;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pump = async () => {
      if (stopped) return;
      // Nothing to analyse while the video is not actually showing frames,
      // and no reason to spend the GPU on a tab nobody is looking at.
      if (busy || document.hidden || video.paused || video.readyState < 2 || !video.videoWidth) {
        timer = setTimeout(pump, 200);
        return;
      }
      const wait = MIN_INTERVAL_MS - (performance.now() - last);
      if (wait > 0) { timer = setTimeout(pump, wait); return; }
      last = performance.now();
      busy = true;
      try {
        const bitmap = await createImageBitmap(video);
        if (stopped) { bitmap.close(); return; }
        w.postMessage({ type: 'frame', bitmap }, [bitmap]);
      } catch {
        busy = false;
        timer = setTimeout(pump, 500);
      }
    };

    owner = (m) => {
      if (m.type === 'result') {
        busy = false;
        setFrameError(null);
        setResult(m.result);
        const now = performance.now();
        stamps.current = [...stamps.current.filter((t) => now - t < 3000), now];
        setFps(stamps.current.length / 3);
        timer = setTimeout(pump, 0);
      } else if (m.type === 'error') {
        busy = false;
        setFrameError(m.message);
        timer = setTimeout(pump, 1000);
      }
    };
    pump();

    return () => {
      stopped = true;
      clearTimeout(timer);
      owner = null;
      setResult(null);
      setFps(0);
    };
  }, [enabled, video, eng.status, streamKey]);

  return { engine: eng, result, fps, frameError };
}

/*
 * Dev-only parity check: run one still image through a fresh worker so its
 * output can be compared with the Python reference on the same image. A
 * mismatch in channel order, scaling or padding would not crash anything — it
 * would quietly cost accuracy while still drawing plausible boxes.
 */
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__liveParity = async (url: string) => {
    const w = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
    const next = (want: string) => new Promise<FromWorker>((res) => {
      const h = (ev: MessageEvent<FromWorker>) => {
        if (ev.data.type === want || ev.data.type === 'error') { w.removeEventListener('message', h); res(ev.data); }
      };
      w.addEventListener('message', h);
    });
    const ready = next('ready');
    w.postMessage({ type: 'init', base: new URL(import.meta.env.BASE_URL, location.href).href });
    const r = await ready;
    if (r.type === 'error') { w.terminate(); return r; }
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    // Several passes of one image, as a stationary vehicle would give.
    let out: FromWorker | null = null;
    for (let i = 0; i < 4; i++) {
      const copy = await createImageBitmap(bitmap);
      const p = next('result');
      w.postMessage({ type: 'frame', bitmap: copy }, [copy]);
      out = await p;
    }
    w.terminate();
    return { backend: (r as { backend: string }).backend, out };
  };
}
