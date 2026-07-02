# colmap-api

REST API wrapping [COLMAP](https://colmap.github.io/) for camera pose estimation. Accepts images from browser clients and returns camera rotation and translation via WebSocket.

## Architecture

```
Browser (p5.js sketch)
  │  drop images → POST /colmap-api/jobs (multipart)
  │  connect → WS /colmap-api/jobs/:id/ws (progress stream)
  │  receive → { cameras, poses }
  ▼
Express API (Node.js)  ←── Caddy reverse proxy (HTTPS/WSS)
  │
  ▼
Job queue (one at a time)
  │
  ▼
COLMAP CLI (CPU, headless)
  feature_extractor → exhaustive_matcher → mapper
  → parse cameras.bin + images.bin → JSON poses
```

## Server setup

Requires Ubuntu 22.04 / 24.04, Node.js 20+, and COLMAP. Clone the repo, then run `setup.sh` on a fresh droplet to install dependencies:

```bash
git clone https://github.com/davidchatting/colmap-api.git
cd colmap-api
bash setup.sh
npm install
node server.js
```

A swap file is recommended on low-RAM servers (COLMAP uses ~1 GB virtual memory during feature extraction):

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Caddy reverse proxy

Caddy sits in front of the Node process and forwards matching requests to it. Two directives match the `/colmap-api` prefix but handle it differently:

- `handle_path /colmap-api*` — matches the prefix, then **strips it** before forwarding. A request for `/colmap-api/jobs` arrives at the backend as `/jobs`.
- `handle /colmap-api*` — matches the prefix, but forwards the request **unchanged**. A request for `/colmap-api/jobs` arrives at the backend as `/colmap-api/jobs`.

Every route in `server.js` is defined with the `/colmap-api` prefix baked in (e.g. `app.post('/colmap-api/jobs', ...)`), so the prefix needs to survive the proxy hop. Use `handle`, not `handle_path`:

```
your-domain.com {
    handle /colmap-api* {
        reverse_proxy 127.0.0.1:3001
    }
}
```

Then reload Caddy: `systemctl reload caddy`.

## API

### `GET /colmap-api/health`

Returns `{ "status": "ok" }`. Use to verify the server is reachable.

---

### `POST /colmap-api/jobs`

Upload images for reconstruction. Returns a job ID immediately; processing happens asynchronously.

```
Content-Type: multipart/form-data
Body: images[]  — JPEG/PNG files, minimum 2
```

Optional tuning fields (all numeric):

| Field | Default | Description |
|---|---|---|
| `maxImageSize` | 1000 | Resize images larger than this (px) before extraction |
| `maxNumFeatures` | 4096 | Max SIFT features extracted per image |
| `matchMaxRatio` | 0.8 | Lowe's ratio test threshold (raise toward 0.95 for low-overlap images) |
| `initMinNumInliers` | 30 | Min inlier matches to select initial image pair (COLMAP default: 100) |
| `minNumInliers` | 15 | Min inlier matches to register each subsequent image |

```json
{ "jobId": "uuid" }
```

---

### `GET /colmap-api/jobs/:id`

Poll job status and result.

```json
{
  "id": "uuid",
  "status": "queued | running | done | error",
  "progress": { "stage": "Matching features", "log": "..." },
  "result": { "cameras": {}, "poses": [] },
  "error": null
}
```

---

### `WS /colmap-api/jobs/:id/ws`

Stream progress updates for a job. Connect immediately after `POST /colmap-api/jobs`.

Receives JSON messages:

```json
{ "type": "status | update", "job": { ... } }
```

Final message has `status: "done"` with `result.poses` or `status: "error"` with `error` string.

## Browser client

`public/client.js` is an ES module you can import from any page on the same origin or via dynamic import from a different origin (CORS is enabled).

```js
import { submitPoseJob } from 'https://your-domain.com/colmap-api/client.js'

const imgs = document.querySelectorAll('.scene-image')
const { cameras, poses } = await submitPoseJob(imgs, {
  apiBase: 'https://your-domain.com/colmap-api',
  onProgress: ({ stage }) => console.log(stage),
})
```

Each pose:

```js
{
  name: 'image_0001.jpg',
  rotation: { qw, qx, qy, qz },  // world-to-camera quaternion
  translation: { tx, ty, tz },    // world-to-camera translation
  cameraId: 1
}
```

Image elements can be same-origin `<img>` tags or elements with `src` set to a data URL (e.g. from a file drop). Cross-origin images require `crossOrigin="anonymous"` on the element and CORS headers on the image server.

## p5.js sketch

`p5-sketch/` contains a ready-to-use p5.js sketch:

- Drop 2+ images onto the canvas
- Press **Space** to submit to COLMAP
- Progress streams live via WebSocket
- Camera poses displayed on canvas when done

Copy the three files (`index.html`, `sketch.js`, `style.css`) into the [p5.js editor](https://editor.p5js.org) or access the hosted version at https://davidchatting.com/colmap-api/p5-sketch/index.html. Update `API_BASE` in `sketch.js` to point to your server.

## Test page

A minimal browser test page is available at https://davidchatting.com/colmap-api/ — pick images with the file picker, click Run COLMAP, and watch the pipeline stages stream in.

## Notes

- Jobs process one at a time; subsequent jobs queue automatically
- Job files (images + COLMAP database) are deleted after 1 hour
- COLMAP runs CPU-only (`--SiftExtraction.use_gpu 0`) — no GPU required
- Qt platform set to `offscreen` (`QT_QPA_PLATFORM=offscreen`) for headless operation
- For reliable reconstruction, images need ~60–80% overlap and clearly different viewpoints
- 512 MB RAM + 2 GB swap supports ~5–15 images per job
