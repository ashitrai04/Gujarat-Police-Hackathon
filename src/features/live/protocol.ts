/** Messages between the page and the detection worker. */

export type Box = [number, number, number, number]; // x1 y1 x2 y2, frame pixels

export type VehicleClass = 'car' | 'motorcycle' | 'bus' | 'truck';

export interface LivePlate {
  box: Box;
  /**
   * The plate, or null when there is not enough to claim one: the plate is too
   * few pixels wide to read, or the reads so far are not confident. The
   * grammar decoder always produces a valid-looking plate, even from noise, so
   * withholding is the only protection against a fabricated registration.
   */
  text: string | null;
  /** Why there is no text: the plate is too small, or the reads disagree. */
  note: 'too small' | 'reading' | null;
  /** Frames whose reads were averaged into `text`. */
  reads: number;
  /** Mean per-character probability, 0..1. */
  confidence: number;
  /** Several reads, and the decoded plate has stopped changing. */
  stable: boolean;
}

/**
 * A person in the frame.
 *
 * Deliberately not a LiveTrack. A track carries plate state -- the crop, the
 * reads, whether the decode has settled -- and exists so a vehicle can be
 * followed until its registration is legible. None of that applies to a
 * person, and giving people tracks would put them in the queue for plate
 * searches that can never succeed, spending the frame budget that the
 * vehicles need.
 *
 * So people are counted per frame rather than followed. The count answers
 * "how many are in view now", which is what a crowd reading is; it is not an
 * attempt to count individuals over time, which from a single fixed camera
 * this could not do honestly anyway.
 */
export interface LivePerson {
  box: Box;
  score: number;
}

export interface LiveTrack {
  id: number;
  box: Box;
  cls: VehicleClass;
  score: number;
  plate: LivePlate | null;
}

export interface FrameResult {
  frame: { w: number; h: number };
  tracks: LiveTrack[];
  people: LivePerson[];
  timings: { vehicles: number; plates: number; total: number };
}

export type ToWorker =
  | { type: 'init'; base: string }
  | { type: 'frame'; bitmap: ImageBitmap }
  | { type: 'reset' };

export type FromWorker =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  | { type: 'result'; result: FrameResult }
  | { type: 'error'; message: string };
