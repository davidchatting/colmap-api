// colmap pose estimator
// David Chatting - davidchatting.com

p5.disableFriendlyErrors = true;

const API_BASE = 'https://api.davidchatting.com/colmap-api';

let droppedImages = [];
let imageByName   = {};
let poses         = null;
let cameras       = null;
let camPositions  = [];
let submitPoseJob = null;

let orbitX = -0.4, orbitY = 0.3;
let dragging = false, lastMX, lastMY;

// HTML overlay elements
let elThumbs, elDropHint, elStatus, elOrbitHint;

import('../client.js')
  .then(mod => { submitPoseJob = mod.submitPoseJob })
  .catch(err => { setStatus('API client failed to load: ' + err.message) });

// ── p5 lifecycle ──────────────────────────────────────────────────────────────

function setup() {
  let canvas = createCanvas(windowWidth, windowHeight, WEBGL);
  canvas.drop(onFileDropped);

  elThumbs    = document.getElementById('thumbs');
  elDropHint  = document.getElementById('drop-hint');
  elStatus    = document.getElementById('status');
  elOrbitHint = document.getElementById('orbit-hint');
}

function draw() {
  background(18);

  if (camPositions.length > 0) {
    push();
    ambientLight(255);
    rotateX(orbitX);
    rotateY(orbitY);
    drawScene();
    pop();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function setStatus(msg) {
  if (elStatus) elStatus.textContent = msg;
}

// ── File drop ─────────────────────────────────────────────────────────────────

function onFileDropped(file) {
  if (!file.type.startsWith('image')) return;

  const img = document.createElement('img');
  img.src = file.data;
  img.alt = file.name;

  const el = createImg(file.data, '');
  el.style('visibility', 'hidden');
  el.style('position', 'absolute');

  droppedImages.push({ img, el, name: file.name });
  poses = null; cameras = null; camPositions = []; imageByName = {};

  // Update thumbnail strip
  elDropHint.style.display = 'none';
  elThumbs.appendChild(img);

  setStatus(`${droppedImages.length} image(s) — press SPACE to run COLMAP`);
  if (elOrbitHint) elOrbitHint.style.display = 'none';
}

function keyPressed() {
  if (key === ' ' && droppedImages.length >= 2) runColmap();
}

// ── COLMAP job ────────────────────────────────────────────────────────────────

async function runColmap() {
  if (!submitPoseJob) { setStatus('API client not loaded yet'); return; }
  setStatus('Starting…');
  poses = null; cameras = null; camPositions = []; imageByName = {};

  try {
    const domImgs = droppedImages.map(d => d.el.elt);
    const result  = await submitPoseJob(domImgs, {
      apiBase:    API_BASE,
      onProgress: ({ stage }) => { if (stage) setStatus(stage) },
    });
    poses        = result.poses;
    cameras      = result.cameras;
    camPositions = poses.map(poseToWorldPos);

    imageByName = {};
    for (const d of droppedImages) {
      imageByName[d.name.split('/').pop().toLowerCase()] = loadImage(d.img.src);
    }

    setStatus(`Done — ${poses.length} pose(s) estimated`);
    if (elOrbitHint) elOrbitHint.style.display = 'inline';
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
}

// ── Mouse orbit ───────────────────────────────────────────────────────────────

function mousePressed() {
  dragging = true; lastMX = mouseX; lastMY = mouseY;
}
function mouseDragged() {
  if (!dragging) return;
  orbitY += (mouseX - lastMX) * 0.008;
  orbitX += (mouseY - lastMY) * 0.008;
  lastMX = mouseX; lastMY = mouseY;
}
function mouseReleased() { dragging = false; }

// ── 3D scene ──────────────────────────────────────────────────────────────────

function drawScene() {
  const cx     = average(camPositions.map(p => p.x));
  const cy     = average(camPositions.map(p => p.y));
  const cz     = average(camPositions.map(p => p.z));
  const spread = maxSpread(camPositions, cx, cy, cz) || 1;
  const s      = 120 / spread;

  translate(-cx * s, -cy * s, -cz * s);
  scale(s);

  drawAxes(12 / s);

  stroke(50, 70, 180);
  strokeWeight(0.8 / s);
  noFill();
  for (let i = 0; i < camPositions.length - 1; i++) {
    const a = camPositions[i], b = camPositions[i + 1];
    line(a.x, a.y, a.z, b.x, b.y, b.z);
  }

  const nearD = spread * 0.04;
  const farD  = spread * 1.5;

  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    const cam  = cameras[pose.cameraId];
    if (!cam) continue;
    const corners = frustumCorners(pose, cam, nearD, farD);
    const img = imageByName[pose.name.split('/').pop().toLowerCase()] || null;
    drawFrustum(camPositions[i], corners, img, s);
  }
}

function drawFrustum(apex, corners, img, s) {
  const n = corners.near;
  const f = corners.far;

  if (img) {
    fill(255, 255, 255, 102);
    noStroke();
    textureMode(NORMAL);
    texture(img);
    beginShape();
    vertex(f[0].x, f[0].y, f[0].z, 0, 0);
    vertex(f[1].x, f[1].y, f[1].z, 1, 0);
    vertex(f[2].x, f[2].y, f[2].z, 1, 1);
    vertex(f[3].x, f[3].y, f[3].z, 0, 1);
    endShape(CLOSE);
  }

  noFill();
  stroke(180, 200, 255);
  strokeWeight(0.5 / s);
  drawRect(n);
  drawRect(f);
  for (let i = 0; i < 4; i++) {
    line(apex.x, apex.y, apex.z, f[i].x, f[i].y, f[i].z);
  }
}

function drawRect(pts) {
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    line(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

function drawAxes(size) {
  strokeWeight(1.5);
  stroke(220, 60, 60);  line(0,0,0, size,0,0);
  stroke(60, 220, 60);  line(0,0,0, 0,size,0);
  stroke(60, 60, 220);  line(0,0,0, 0,0,size);
}

// ── Frustum math ──────────────────────────────────────────────────────────────

function frustumCorners(pose, cam, nearD, farD) {
  const R   = quatToRotMatrix(pose.rotation);
  const pos = poseToWorldPos(pose);

  let fx, fy, cx, cy;
  if (cam.model === 'SIMPLE_PINHOLE') {
    [fx, cx, cy] = cam.params; fy = fx;
  } else {
    [fx, fy, cx, cy] = cam.params;
  }
  const W = cam.width, H = cam.height;

  function corners(d) {
    return [
      camToWorld([(0 - cx) / fx * d, (0 - cy) / fy * d, d], R, pos),
      camToWorld([(W - cx) / fx * d, (0 - cy) / fy * d, d], R, pos),
      camToWorld([(W - cx) / fx * d, (H - cy) / fy * d, d], R, pos),
      camToWorld([(0 - cx) / fx * d, (H - cy) / fy * d, d], R, pos),
    ];
  }

  return { near: corners(nearD), far: corners(farD) };
}

function camToWorld([px, py, pz], R, pos) {
  return {
    x: R[0]*px + R[3]*py + R[6]*pz + pos.x,
    y: R[1]*px + R[4]*py + R[7]*pz + pos.y,
    z: R[2]*px + R[5]*py + R[8]*pz + pos.z,
  };
}

// ── Pose math ─────────────────────────────────────────────────────────────────

function poseToWorldPos(pose) {
  const R = quatToRotMatrix(pose.rotation);
  const t = pose.translation;
  return {
    x: -(R[0]*t.tx + R[3]*t.ty + R[6]*t.tz),
    y: -(R[1]*t.tx + R[4]*t.ty + R[7]*t.tz),
    z: -(R[2]*t.tx + R[5]*t.ty + R[8]*t.tz),
  };
}

function quatToRotMatrix({ qw, qx, qy, qz }) {
  return [
    1-2*(qy*qy+qz*qz),  2*(qx*qy-qw*qz),    2*(qx*qz+qw*qy),
    2*(qx*qy+qw*qz),    1-2*(qx*qx+qz*qz),  2*(qy*qz-qw*qx),
    2*(qx*qz-qw*qy),    2*(qy*qz+qw*qx),    1-2*(qx*qx+qy*qy),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function average(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function maxSpread(pts, cx, cy, cz) {
  return pts.reduce((m, p) =>
    Math.max(m, Math.sqrt((p.x-cx)**2 + (p.y-cy)**2 + (p.z-cz)**2)), 0);
}
