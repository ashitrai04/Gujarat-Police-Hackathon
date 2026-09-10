/// <reference lib="webworker" />
/**
 * Live ANPR on the frames a camera panel is already playing.
 *
 * Runs off the main thread so the map and the video stay smooth. Three models,
 * the same two-stage approach the batch pipeline uses:
 *
 *   1. vehicles     YOLO11n, 640px, NMS inside the graph
 *   2. plates       the pipeline's own yolo-v9-t-384 detector, run on each
 *                   vehicle cut from the FULL-resolution frame — a plate that
 *                   is 60px wide in a 1920px frame is 20px after the frame is
 *                   shrunk to 640, and nothing reads 20px
 *   3. characters   cct-xs-v2 on the plate cut from the full-resolution frame
 *
 * Preprocessing reproduces what each model was trained with (letterbox with
 * grey 114 padding and 0..1 RGB for the YOLOs; a plain 128×64 stretch and raw
 * 0..255 RGB for the recogniser), verified against the Python libraries.
 *
 * A tracker carries each vehicle across frames, and every plate read of that
 * vehicle is added to its evidence — which is what turns a 35%-exact single
 * read into a plate that settles.
 */
import * as ort from 'onnxruntime-web/webgpu';
import type { Box, FrameResult, FromWorker, LiveTrack, ToWorker, VehicleClass } from './protocol';
import { SLOTS, decodePlate, toLogProbs } from './grammar';

const post = (m: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

const MODELS = {
  vehicle: 'models/vehicle-yolo11n-640.onnx',
  plate: 'models/plate-yolov9t-384.onnx',
  ocr: 'models/ocr-cct-xs-v2.onnx',
};

/** COCO classes worth a plate. Pedestrians and animals are not traffic. */
const VEHICLE: Record<number, VehicleClass> = { 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' };
/** The batch pipeline's own threshold (CONFIG det_conf), so both agree on what counts. */
const VEHICLE_CONF = 0.35;
const PLATE_CONF = 0.3;
/** Narrower than this, a vehicle's plate is too few pixels to read. */
const MIN_VEHICLE_W = 90;
/** Plate reads per frame, largest vehicles first — keeps a busy junction at speed. */
const MAX_PLATES_PER_FRAME = 5;
/*
 * Calibrated on this estate's 50 labelled sightings. Every correct read came
 * from a plate at least 79px wide in the camera frame; below ~70px the reads
 * are noise. Correct reads sit at a median confidence of 0.91 and wrong ones
 * at 0.76: a 0.80 gate kept 18 of the 19 correct reads and dropped most of the
 * wrong ones. A single read under 0.60 is not evidence and is not averaged in.
 */
const MIN_PLATE_W = 70;
const SHOW_CONF = 0.8;
const ACCEPT_READ_CONF = 0.6;
/** One vehicle, two classes: overlap beyond this is the same object. */
const SAME_OBJECT_IOU = 0.7;
/** Frames between re-checks of a plate that has settled, and of one too small. */
const RECHECK_SETTLED = 6;
const RETRY_SMALL = 2;

let sessions: { vehicle: ort.InferenceSession; plate: ort.InferenceSession; ocr: ort.InferenceSession } | null = null;

/* ── Loading ─────────────────────────────────────────────────────── */

async function fetchWithProgress(urls: string[]): Promise<ArrayBuffer[]> {
  const heads = await Promise.all(urls.map((u) => fetch(u)));
  heads.forEach((r, i) => { if (!r.ok) throw new Error(`${urls[i]}: HTTP ${r.status}`); });
  // Behind compression, content-length is the compressed size while the stream
  // yields decompressed bytes, so a total from it would be wrong. Report none.
  const encoded = heads.some((r) => r.headers.get('content-encoding'));
  const total = encoded ? 0 : heads.reduce((n, r) => n + Number(r.headers.get('content-length') || 0), 0);
  let loaded = 0;
  return Promise.all(heads.map(async (res) => {
    const reader = res.body!.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      post({ type: 'progress', loaded, total: total ? Math.max(total, loaded) : 0 });
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
  }));
}

async function init(base: string) {
  ort.env.wasm.wasmPaths = `${base}ort/`;
  // Threaded WebAssembly needs cross-origin isolation, which this site does not
  // enable; one thread is the honest configuration rather than a failed one.
  ort.env.wasm.numThreads = 1;

  const [veh, plate, ocr] = await fetchWithProgress(
    [MODELS.vehicle, MODELS.plate, MODELS.ocr].map((m) => base + m),
  );

  // GPU where the browser offers it; otherwise the same models on the CPU.
  const hasGpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const attempt = async (eps: string[]) => ({
    vehicle: await ort.InferenceSession.create(veh, { executionProviders: eps }),
    plate: await ort.InferenceSession.create(plate, { executionProviders: eps }),
    ocr: await ort.InferenceSession.create(ocr, { executionProviders: eps }),
  });
  let backend: 'webgpu' | 'wasm' = 'wasm';
  let gpuError = '';
  if (hasGpu) {
    try {
      sessions = await attempt(['webgpu', 'wasm']);
      backend = 'webgpu';
    } catch (e) {
      sessions = null;
      gpuError = e instanceof Error ? e.message : String(e);
    }
  }
  if (!sessions) {
    try {
      sessions = await attempt(['wasm']);
    } catch (e) {
      // Report the first failure too: the CPU attempt's own message is often
      // just "the previous initialisation failed", which says nothing.
      const cpu = e instanceof Error ? e.message : String(e);
      throw new Error(gpuError ? `GPU: ${gpuError} | CPU: ${cpu}` : cpu);
    }
  }
  post({ type: 'ready', backend });
}

/* ── Pixels ──────────────────────────────────────────────────────── */

const canvases = new Map<string, OffscreenCanvasRenderingContext2D>();
function ctx2d(key: string, w: number, h: number) {
  let c = canvases.get(key);
  if (!c || c.canvas.width !== w || c.canvas.height !== h) {
    c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    canvases.set(key, c);
  }
  return c;
}

interface Letterbox { tensor: ort.Tensor; r: number; padX: number; padY: number }

/**
 * Letterbox a region of the frame into a square model input, the way
 * Ultralytics and open-image-models both do it: scale to fit, centre, pad with
 * grey 114, RGB scaled to 0..1, channels first.
 */
function letterbox(src: ImageBitmap, region: Box, size: number): Letterbox {
  const [sx, sy, ex, ey] = region;
  const sw = ex - sx;
  const sh = ey - sy;
  const r = Math.min(size / sw, size / sh);
  const nw = Math.round(sw * r);
  const nh = Math.round(sh * r);
  const padX = (size - nw) / 2;
  const padY = (size - nh) / 2;
  const c = ctx2d(`lb${size}`, size, size);
  c.fillStyle = 'rgb(114,114,114)';
  c.fillRect(0, 0, size, size);
  c.imageSmoothingQuality = 'medium';
  c.drawImage(src, sx, sy, sw, sh, Math.round(padX - 0.1), Math.round(padY - 0.1), nw, nh);
  const px = c.getImageData(0, 0, size, size).data;
  const plane = size * size;
  const f = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    f[i] = px[i * 4] / 255;
    f[plane + i] = px[i * 4 + 1] / 255;
    f[2 * plane + i] = px[i * 4 + 2] / 255;
  }
  return { tensor: new ort.Tensor('float32', f, [1, 3, size, size]), r, padX, padY };
}

/** The recogniser's input: a 128×64 stretch, raw 0..255 RGB, channels last. */
function ocrInput(src: ImageBitmap, b: Box): ort.Tensor {
  const c = ctx2d('ocr', 128, 64);
  c.imageSmoothingQuality = 'medium';
  c.drawImage(src, b[0], b[1], b[2] - b[0], b[3] - b[1], 0, 0, 128, 64);
  const px = c.getImageData(0, 0, 128, 64).data;
  const u = new Uint8Array(128 * 64 * 3);
  for (let i = 0, j = 0; i < px.length; i += 4) {
    u[j++] = px[i]; u[j++] = px[i + 1]; u[j++] = px[i + 2];
  }
  return new ort.Tensor('uint8', u, [1, 64, 128, 3]);
}

const clampBox = (b: Box, w: number, h: number): Box => [
  Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])),
  Math.min(w, Math.ceil(b[2])), Math.min(h, Math.ceil(b[3])),
];

/* ── Tracking ────────────────────────────────────────────────────── */

interface Track {
  id: number;
  box: Box;
  cls: Map<VehicleClass, number>;
  score: number;
  lastSeen: number;
  evidence: Float32Array | null;
  reads: number;
  plateBox: Box | null;
  plateSmall: boolean;
  history: string[];
  /** Plate read held steady — see `settle`. */
  settled: boolean;
  /** Inference frame at which this vehicle's plate was last looked at. */
  lastPlateTick: number;
}

let tracks: Track[] = [];
let nextId = 1;
let tick = 0;
/** Inference frames a vehicle may go unseen before its track is dropped. */
const TRACK_TTL = 6;

function iou(a: Box, b: Box) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}

/**
 * Same vehicle as last time? Overlap is the main test; at a few inference
 * frames a second a fast car can move clear of its old box, so a nearby
 * centre with a similar size also counts.
 */
function affinity(t: Box, d: Box) {
  const o = iou(t, d);
  if (o >= 0.2) return o;
  const tw = t[2] - t[0], th = t[3] - t[1], dw = d[2] - d[0], dh = d[3] - d[1];
  const ratio = (dw * dh) / Math.max(1, tw * th);
  if (ratio < 0.55 || ratio > 1.8) return 0;
  const dist = Math.hypot((t[0] + t[2] - d[0] - d[2]) / 2, (t[1] + t[3] - d[1] - d[3]) / 2);
  return dist < 0.6 * Math.max(tw, th) ? 0.19 * (1 - dist / (0.6 * Math.max(tw, th))) : 0;
}

function assign(dets: { box: Box; cls: VehicleClass; score: number }[]): Track[] {
  tick++;
  const pairs: [number, number, number][] = [];
  tracks.forEach((t, ti) => dets.forEach((d, di) => {
    const a = affinity(t.box, d.box);
    if (a > 0) pairs.push([a, ti, di]);
  }));
  pairs.sort((x, y) => y[0] - x[0]);
  const usedT = new Set<number>();
  const usedD = new Set<number>();
  const seen: Track[] = [];
  for (const [, ti, di] of pairs) {
    if (usedT.has(ti) || usedD.has(di)) continue;
    usedT.add(ti); usedD.add(di);
    const t = tracks[ti];
    const d = dets[di];
    t.box = d.box;
    t.score = d.score;
    t.lastSeen = tick;
    t.cls.set(d.cls, (t.cls.get(d.cls) ?? 0) + d.score);
    seen.push(t);
  }
  dets.forEach((d, di) => {
    if (usedD.has(di)) return;
    const t: Track = {
      id: nextId++, box: d.box, cls: new Map([[d.cls, d.score]]), score: d.score,
      lastSeen: tick, evidence: null, reads: 0, plateBox: null, plateSmall: false, history: [],
      settled: false, lastPlateTick: -Infinity,
    };
    tracks.push(t);
    seen.push(t);
  });
  tracks = tracks.filter((t) => tick - t.lastSeen <= TRACK_TTL);
  return seen;
}

/* ── One frame ───────────────────────────────────────────────────── */

async function analyse(bitmap: ImageBitmap): Promise<FrameResult> {
  const s = sessions!;
  const W = bitmap.width;
  const H = bitmap.height;
  const t0 = performance.now();

  // 1. Vehicles.
  const lb = letterbox(bitmap, [0, 0, W, H], 640);
  const vOut = (await s.vehicle.run({ [s.vehicle.inputNames[0]]: lb.tensor }))[s.vehicle.outputNames[0]];
  const v = vOut.data as Float32Array; // 300 × [x1 y1 x2 y2 score cls]
  const dets: { box: Box; cls: VehicleClass; score: number }[] = [];
  for (let i = 0; i < v.length; i += 6) {
    const score = v[i + 4];
    const cls = VEHICLE[Math.round(v[i + 5])];
    if (score < VEHICLE_CONF || !cls) continue;
    dets.push({
      cls, score,
      box: clampBox([
        (v[i] - lb.padX) / lb.r, (v[i + 1] - lb.padY) / lb.r,
        (v[i + 2] - lb.padX) / lb.r, (v[i + 3] - lb.padY) / lb.r,
      ], W, H),
    });
  }
  // The exported model suppresses overlaps only within a class, so one car
  // can come back as a car and a truck. Keep the likelier label.
  dets.sort((a, b) => b.score - a.score);
  const kept: typeof dets = [];
  for (const d of dets) if (!kept.some((k) => iou(k.box, d.box) > SAME_OBJECT_IOU)) kept.push(d);
  const seen = assign(kept);
  const t1 = performance.now();

  // 2 + 3. Plates, read from full-resolution pixels. The budget goes where an
  // answer is still missing: a vehicle whose plate has settled is only
  // re-checked every few frames, and a plate too small to read is retried
  // every other frame, since a vehicle that is approaching keeps growing.
  const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
  const due = (t: Track) =>
    t.settled ? tick - t.lastPlateTick >= RECHECK_SETTLED
    : t.plateSmall ? tick - t.lastPlateTick >= RETRY_SMALL
    : true;
  const candidates = seen
    .filter((t) => t.box[2] - t.box[0] >= MIN_VEHICLE_W && due(t))
    .sort((a, b) => Number(a.settled) - Number(b.settled) || area(b.box) - area(a.box))
    .slice(0, MAX_PLATES_PER_FRAME);

  for (const t of candidates) {
    t.lastPlateTick = tick;
    const [x1, y1, x2, y2] = t.box;
    const mx = (x2 - x1) * 0.04;
    const my = (y2 - y1) * 0.04;
    const region = clampBox([x1 - mx, y1 - my, x2 + mx, y2 + my], W, H);
    const plb = letterbox(bitmap, region, 384);
    const pOut = (await s.plate.run({ [s.plate.inputNames[0]]: plb.tensor }))[s.plate.outputNames[0]];
    const p = pOut.data as Float32Array; // N × [batch x1 y1 x2 y2 cls score]
    let best = -1;
    for (let i = 0; i < p.length; i += 7) {
      if (p[i + 6] >= PLATE_CONF && (best < 0 || p[i + 6] > p[best + 6])) best = i;
    }
    if (best < 0) continue;
    const pb = clampBox([
      region[0] + (p[best + 1] - plb.padX) / plb.r, region[1] + (p[best + 2] - plb.padY) / plb.r,
      region[0] + (p[best + 3] - plb.padX) / plb.r, region[1] + (p[best + 4] - plb.padY) / plb.r,
    ], W, H);
    if (pb[2] - pb[0] < 8 || pb[3] - pb[1] < 4) continue;
    t.plateBox = pb;
    // Too few pixels to hold characters: mark the plate, read nothing.
    if (pb[2] - pb[0] < MIN_PLATE_W) { t.plateSmall = true; continue; }
    t.plateSmall = false;

    const oOut = await s.ocr.run({ [s.ocr.inputNames[0]]: ocrInput(bitmap, pb) });
    const probs = oOut[s.ocr.outputNames.includes('plate') ? 'plate' : s.ocr.outputNames[0]].data as Float32Array;
    const lp = toLogProbs(probs.subarray(0, SLOTS * 37));
    if (decodePlate(lp).confidence < ACCEPT_READ_CONF) continue;

    // A confident plate detection is better evidence than a marginal one.
    const w = Math.min(1, Math.max(0.35, p[best + 6] / 0.7));
    if (!t.evidence) t.evidence = new Float32Array(lp.length);
    for (let i = 0; i < lp.length; i++) t.evidence[i] += lp[i] * w;
    t.reads += w;
    const now = decodePlate(t.evidence, t.reads);
    t.history = [...t.history.slice(-3), now.text];
    t.settled = t.reads >= 3 && now.confidence >= SHOW_CONF
      && t.history.length >= 2 && t.history[t.history.length - 1] === t.history[t.history.length - 2];
  }
  const t2 = performance.now();

  const out: LiveTrack[] = seen.map((t) => {
    const cls = [...t.cls.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let plate: LiveTrack['plate'] = null;
    if (t.plateBox) {
      const read = t.evidence ? decodePlate(t.evidence, t.reads) : null;
      const confident = !!read && read.confidence >= SHOW_CONF;
      plate = {
        box: t.plateBox,
        text: confident ? read!.text : null,
        note: confident ? null : t.plateSmall && !read ? 'too small' : 'reading',
        reads: Math.round(t.reads),
        confidence: read?.confidence ?? 0,
        stable: confident && t.settled,
      };
    }
    return { id: t.id, box: t.box, cls, score: t.score, plate };
  });

  return { frame: { w: W, h: H }, tracks: out, timings: { vehicles: t1 - t0, plates: t2 - t1, total: t2 - t0 } };
}

/* ── Messages ────────────────────────────────────────────────────── */

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await init(m.base);
    } else if (m.type === 'reset') {
      tracks = [];
      tick = 0;
    } else if (m.type === 'frame') {
      if (!sessions) { m.bitmap.close(); return; }
      const result = await analyse(m.bitmap);
      m.bitmap.close();
      post({ type: 'result', result });
    }
  } catch (err) {
    if (m.type === 'frame') m.bitmap.close();
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
