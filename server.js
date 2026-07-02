const express = require('express')
const multer  = require('multer')
const { WebSocketServer } = require('ws')
const http    = require('http')
const path    = require('path')
const fs      = require('fs')
const os      = require('os')
const { randomUUID } = require('crypto')

const queue         = require('./queue')
const { runPipeline } = require('./colmap')

const PORT     = process.env.PORT || 3001
const JOBS_DIR = path.join(os.tmpdir(), 'colmap-jobs')
const JOB_TTL  = 60 * 60 * 1000 // clean up job dirs after 1 hour

fs.mkdirSync(JOBS_DIR, { recursive: true })

// ── Express ──────────────────────────────────────────────────────────────────

const app = express()

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})

app.use(express.static(path.join(__dirname, 'public')))

// Inject jobId before multer so the storage destination can use it
app.use('/jobs', (req, _res, next) => {
  req.jobId = randomUUID()
  next()
})

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(JOBS_DIR, req.jobId, 'images')
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename(_req, file, cb) {
      cb(null, file.originalname)
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per image
  fileFilter(_req, file, cb) {
    const ok = /\.(jpe?g|png|tiff?|bmp|webp)$/i.test(file.originalname)
    cb(ok ? null : new Error('Unsupported file type'), ok)
  },
})

// GET /health
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// POST /jobs — upload images and queue a reconstruction
app.post('/jobs', upload.array('images'), (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ error: 'No images provided' })
  }
  if (req.files.length < 2) {
    return res.status(400).json({ error: 'At least 2 images are required' })
  }

  const { jobId } = req

  // Optional tuning params from form fields (all numeric)
  const opts = {}
  const fields = ['maxImageSize', 'maxNumFeatures', 'matchMaxRatio', 'initMinNumInliers', 'minNumInliers']
  for (const f of fields) {
    if (req.body[f] !== undefined) opts[f] = Number(req.body[f])
  }

  queue.add(jobId, {
    jobDir:     path.join(JOBS_DIR, jobId),
    imageCount: req.files.length,
    opts,
  })

  res.status(202).json({ jobId })
})

// GET /jobs/:id — poll status / result
app.get('/jobs/:id', (req, res) => {
  const job = queue.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  const { id, status, createdAt, imageCount, progress, result, error } = job
  res.json({ id, status, createdAt, imageCount, progress, result, error })
})

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(app)

// ── WebSocket ─────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const match = req.url.match(/^\/jobs\/([^/]+)\/ws$/)
  if (!match) return socket.destroy()

  const jobId = match[1]
  const job = queue.get(jobId)

  if (!job) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, ws => {
    // Send current state immediately on connect
    ws.send(JSON.stringify({ type: 'status', job: sanitise(job) }))

    const onUpdate = updated => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'update', job: sanitise(updated) }))
      }
    }

    queue.on(`job:${jobId}`, onUpdate)
    ws.on('close', () => queue.off(`job:${jobId}`, onUpdate))
  })
})

function sanitise({ id, status, createdAt, imageCount, progress, result, error }) {
  return { id, status, createdAt, imageCount, progress, result, error }
}

// ── Job runner ────────────────────────────────────────────────────────────────

queue.on('run', async jobId => {
  const job = queue.get(jobId)
  queue.update(jobId, { status: 'running', startedAt: Date.now() })

  try {
    const onProgress = update => queue.update(jobId, { progress: update })
    const result = await runPipeline(job.jobDir, onProgress, job.opts)
    queue.update(jobId, { status: 'done', result, finishedAt: Date.now() })
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err.message)
    queue.update(jobId, { status: 'error', error: err.message, finishedAt: Date.now() })
  } finally {
    queue.complete(jobId)
    // Remove temp files after TTL
    setTimeout(() => {
      fs.rmSync(job.jobDir, { recursive: true, force: true })
    }, JOB_TTL)
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`colmap-api listening on http://localhost:${PORT}`)
})
