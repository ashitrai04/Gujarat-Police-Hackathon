# Sentinel — CCTV Command Center

GIS-first control room for the Gujarat Police Innovation Hackathon 2026.
A Mapbox map is the interface: browse the live camera estate, filter by
department, build a video wall, and (once the ANPR pipeline is connected)
trace vehicles and act on watchlist alerts.

React 18 · TypeScript · Vite · Mapbox GL v3 · Tailwind v4 · Zustand · TanStack Query

---

## Quick start

```bash
npm install
cp .env.example .env      # add your Mapbox token
npm run dev               # http://localhost:5173
```

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `VITE_MAPBOX_TOKEN` | **yes** | Mapbox GL access token (`pk.…`) |
| `VITE_ANPR_API_URL` | no | ANPR pipeline base URL. Blank ⇒ UI reports "ANPR offline" |
| `VITE_SENTINEL_HOST` | no | Override the camera registry proxy path |
| `VITE_STREAM_BASE` | no | Override the video proxy path |

`.env` is git-ignored. Never commit a token.

---

## Data sources — all real

**Cameras** come from the live host, not a fixture: `GET /api/cameras` returns
30 cameras with resolution, fps, bitrate, bits-per-pixel and RTSP / WebRTC /
HLS URLs. There is no mock layer in this codebase.

The host supplies no geography, so `src/api/registry.ts` maps each camera to a
real Gujarat junction — keyed on the **location prefix**, not the numeric id.
That matters: the host has already renumbered its cameras once (inserting one
shifted every later id by +1). The prefix travels with the footage; the id does
not.

**Boundaries** are the 2011 census districts from
[udit-001/india-maps-data](https://github.com/udit-001/india-maps-data).
**Reference POIs** are OpenStreetMap via Overpass. **Map icons** are
[Maki](https://labs.mapbox.com/maki-icons/) (CC0).

---

## The proxy — why it exists

The feed host cannot be called directly from a browser. Three upstream defects:

1. `/live/*` sends `Access-Control-Allow-Origin: *` **twice**; browsers reject
   `'*, *'`.
2. `live.sentinelgujarat.in` 301-redirects to `live.corp8.cloud` and that
   redirect carries no CORS headers.
3. The stream session rides on a cookie flagged `Secure; SameSite=None;
   Partitioned`, which will not stick over a plain-HTTP hop. Without it the
   variant playlist answers `401 authentication error` and every tile is black.

Both proxies normalise all three:

| Environment | Proxy | Defined in |
|---|---|---|
| dev | `/sentinel/*` | `vite.config.ts` |
| production | `/api/sentinel/*` | `api/sentinel/[...path].ts` (Vercel Edge) |

---

## Deploying to Vercel

1. Import the repo. Framework preset **Vite** is detected from `vercel.json`.
2. Add `VITE_MAPBOX_TOKEN` under Settings → Environment Variables.
3. Deploy. The Edge function at `/api/sentinel/*` is picked up automatically.

> **Bandwidth warning.** HLS segments are proxied through the Edge function, so
> every second of video counts against Vercel bandwidth. Several tiles at 1080p
> will consume a free-tier allowance quickly. For sustained use, put the proxy
> on your own host or ask the feed operator to fix the duplicate CORS header so
> the browser can talk to it directly.

---

## Video wall

- **Auto — fill** (default) shapes the grid to the feed count and the window.
- Fixed **1 / 4 / 9 / 16** layouts paginate; unused positions become
  "+ Add camera" slots so every tile stays the same size.
- Drag the dock's top edge to resize; ⤢ opens a full-screen grid with its own
  nav bar.

Each tile falls back the way the host's own player does:

```
live HLS  →  VOD HLS  →  progressive MP4 seeked to slot_offset
```

The live gateway caps concurrent sessions, so with many tiles most would
otherwise sit on "Connecting…". Progressive has no cap. Tiles are labelled
**LIVE** (real-time) or **SYNCED** (progressive, positioned at wall-clock).

Byte-range support varies by container: `/stream/2` answers `206`, `/stream/14`
answers `200`. Seeking is skipped where ranges are unsupported, otherwise the
player would pull gigabytes before showing a frame.

---

## ANPR pipeline

Detections, routes, watchlist and alerts come from a separate model service
(`src/api/anpr.ts`). Set `VITE_ANPR_API_URL` to enable. Expected endpoints:

```
GET  /detections?plate&cameraId&from&to&limit
GET  /route?plate
GET  /watchlist        POST /watchlist   PATCH /watchlist/:id   DELETE /watchlist/:id
GET  /alerts           POST /alerts/:id/ack
WS   /alerts/stream
POST /analyze          { cameraId, streamUrl }
```

Until it is configured the UI shows **ANPR offline** and renders empty states.
Nothing is fabricated.

### Measured notes for whoever builds the pipeline

- Run ANPR on **tiled crops at native resolution**. A whole 1080p frame
  downscaled to a 384px detector leaves a plate ~10px wide.
- Use PaddleOCR `TextRecognition` on the **tight** plate box. The full
  detect+recognise pipeline re-runs text detection per crop: 5589 ms → 58 ms.
- Add **multi-frame character voting** per tracked vehicle. Single-frame reads
  land around 60–75% exact-match.
- Camera **geometry** predicts plate yield far better than bitrate. One camera
  graded "good" on bits-per-pixel returned zero plates; a "poor" one returned
  13. The ANPR grade in the UI is advisory for that reason.

---

## Project structure

```
api/sentinel/      Vercel Edge proxy (production)
src/api/           registry (real cameras), anpr adapter, types
src/app/           shell, command bar, rails, store
src/map/           Mapbox init, layer managers, Maki icons
src/features/      cameras · videowall · tracking · alerts · events · health
public/geo/        district + POI GeoJSON
```

## Licence / attribution

Map © Mapbox, © OpenStreetMap contributors. Boundaries via
udit-001/india-maps-data. Icons: Maki (CC0). Camera feeds are the property of
the hackathon organisers.
