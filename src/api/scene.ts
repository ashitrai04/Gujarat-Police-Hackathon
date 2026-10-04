import { db } from './db';

/**
 * Scene events — crowd counts, and fire and accident screening.
 *
 * Read straight from `public.events` (migration 0007), the same way detections
 * are read from `public.detections`: the GPU worker writes, the control room
 * reads, and there is no service in between to keep alive.
 *
 * The reason this is a separate module from detections.ts, rather than another
 * query beside it, is `method`. A detection is a detection; a scene event is
 * one of two quite different things wearing the same shape, and the UI has to
 * be able to tell them apart:
 *
 *   detector   crowd counting. YOLO found people and counted them. The number
 *              is a measurement and can be shown as one.
 *   zero-shot  fire and accident. An image/text model scored the frame against
 *              positive and negative descriptions, and `score` is the margin
 *              between them — a similarity, not a probability. It means "worth
 *              a look", never "there is a fire", and anything that presents it
 *              as a confirmed finding is lying to an officer.
 *
 * With no database configured every call returns empty. Nothing here invents
 * an event.
 */

export type SceneKind = 'crowd' | 'fire' | 'accident';
export type SceneMethod = 'detector' | 'zero-shot';
export type SceneSeverity = 'review' | 'low' | 'medium' | 'high';

export interface SceneEvent {
  id: string;
  cameraId: string;
  kind: SceneKind;
  method: SceneMethod;
  /** Zero-shot only: the positive/negative margin. Not a probability. */
  score: number | null;
  severity: SceneSeverity;
  /** Crowd only; null means "not applicable", not "nobody there". */
  peoplePeak: number | null;
  peopleMean: number | null;
  framesHit: number;
  framesSeen: number;
  snapshotUrl: string | null;
  note: string | null;
  seenAt: string;
}

interface SceneRow {
  id: string;
  camera_id: string;
  kind: SceneKind;
  method: SceneMethod;
  score: number | null;
  severity: SceneSeverity;
  people_peak: number | null;
  people_mean: number | null;
  frames_hit: number | null;
  frames_seen: number | null;
  snapshot_url: string | null;
  note: string | null;
  seen_at: string;
}

const SELECT =
  'id,camera_id,kind,method,score,severity,people_peak,people_mean,' +
  'frames_hit,frames_seen,snapshot_url,note,seen_at';

function toScene(r: SceneRow): SceneEvent {
  return {
    id: r.id,
    cameraId: r.camera_id,
    kind: r.kind,
    method: r.method,
    score: r.score,
    severity: r.severity,
    peoplePeak: r.people_peak,
    peopleMean: r.people_mean,
    framesHit: r.frames_hit ?? 1,
    framesSeen: r.frames_seen ?? 1,
    snapshotUrl: r.snapshot_url,
    note: r.note,
    seenAt: r.seen_at,
  };
}

export interface SceneQuery {
  cameraId?: string;
  kinds?: SceneKind[];
  /** Only rows at or above this severity, in the order review < low < … */
  minSeverity?: SceneSeverity;
  from?: string;
  to?: string;
  limit?: number;
}

const RANK: Record<SceneSeverity, number> = {
  review: 0, low: 1, medium: 2, high: 3,
};

export async function listSceneEvents(q: SceneQuery = {}): Promise<SceneEvent[]> {
  if (!db) return [];
  let query = db.from('events').select(SELECT).order('seen_at', { ascending: false });

  if (q.cameraId) query = query.eq('camera_id', q.cameraId);
  if (q.kinds?.length) query = query.in('kind', q.kinds);
  if (q.from) query = query.gte('seen_at', q.from);
  if (q.to) query = query.lte('seen_at', q.to);

  const { data, error } = await query.limit(q.limit ?? 200);
  if (error) throw new Error(error.message);

  const rows = (data as unknown as SceneRow[]).map(toScene);
  // Filtered here rather than in SQL because severity is a label, not an
  // ordered type: Postgres would compare it alphabetically, which puts
  // 'high' below 'low' and 'review' above both.
  if (!q.minSeverity) return rows;
  const floor = RANK[q.minSeverity];
  return rows.filter((e) => RANK[e.severity] >= floor);
}

/**
 * The crowd count over time for one camera, oldest first.
 *
 * A single count says very little — eighty people means one thing outside a
 * stadium and another on a flyover. What an operator can act on is the shape:
 * whether it is building, and how this hour compares with the same camera
 * earlier. That is why the worker stores every pass rather than only the
 * exceedances, and why this returns a series rather than a latest value.
 */
export async function crowdSeries(
  cameraId: string,
  hours = 6,
): Promise<{ at: string; people: number }[]> {
  if (!db) return [];
  const from = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await db
    .from('events')
    .select('people_peak,seen_at')
    .eq('camera_id', cameraId)
    .eq('kind', 'crowd')
    .gte('seen_at', from)
    .order('seen_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data as unknown as { people_peak: number | null; seen_at: string }[])
    .filter((r) => r.people_peak !== null)
    .map((r) => ({ at: r.seen_at, people: r.people_peak as number }));
}
