#!/usr/bin/env node
// =============================================================================
// Operation Nightfall — recorded run
// =============================================================================
//
// Captures a short real-time clip of the game being PLAYED and assembles it into
// an animated GIF.
//
// It is driven by the same scripted competent player as `tools/balance.mjs`, on
// purpose: a clip hand-steered by the harness shows the frames the author chose,
// which is the screenshot problem with extra steps. This shows the bot fighting
// the mission it was tuned against, so what the clip demonstrates and what the
// win-rate measurement measured are the same thing.
//
// Playback rate is DERIVED from the real capture wall-clock rather than assumed,
// so the GIF runs at the speed the game actually ran. A clip that plays back at
// the wrong rate is a lie about the game's feel, which is the one thing a moving
// image is supposed to convey.
//
//   npm run build && node tools/clip.mjs [frames]
// =============================================================================

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'shots');
const TMP = path.join(ROOT, 'shots', '.clipframes');
const FRAMES = Number(process.argv[2] ?? 90);
const VIEWPORT = { width: 960, height: 540, deviceScaleFactor: 1 };
const PY = '/Users/dshah/Chatforce/babble-games-backend/ec2/venv/bin/python';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.CHROME_PATH,
].filter(Boolean).find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.json': 'application/json',
  '.map': 'application/json',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname === '') file = path.join(DIST, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The bot, trimmed to what a clip needs: it plays, it does not report.
const BOT = /* js */ `
window.__playBot = function () {
  const F = window.__FPS__;
  const TURN = 4.5, ERR = 0.024, REACT = 0.22;
  let yaw = F.state().player.yaw, pitch = 0;
  let errYaw = 0, errPitch = 0, errTimer = 0, acquire = 0;
  let strafeTimer = 0, strafeDir = 1, lastTarget = -1, last = performance.now();
  const rand = () => Math.random() * 2 - 1;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    const st = F.state();
    if (st.phase !== 'playing') { requestAnimationFrame(tick); return; }
    errTimer -= dt;
    if (errTimer <= 0) { errTimer = 0.28; errYaw = rand() * ERR; errPitch = rand() * ERR * 0.6; }
    strafeTimer -= dt;
    if (strafeTimer <= 0) {
      strafeTimer = 0.7 + Math.random() * 0.7; strafeDir = -strafeDir;
      F.key('left', strafeDir < 0); F.key('right', strafeDir > 0);
    }
    if (!st.weapon.reloading && st.weapon.mag <= 4 && st.weapon.reserve > 0) {
      F.key('reload', true); setTimeout(() => F.key('reload', false), 40);
    }
    const px = st.player.x, pz = st.player.z;
    let best = null, bestD = 1e9, closing = false;
    for (const e of st.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - px, e.z - pz);
      if (d < bestD && F.los(e.id)) { bestD = d; best = e; }
    }
    if (!best) {
      for (const e of st.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.x - px, e.z - pz);
        if (d < bestD) { bestD = d; best = e; }
      }
      closing = true; lastTarget = -1;
    }
    if (!best) { requestAnimationFrame(tick); return; }
    if (best.id !== lastTarget) { lastTarget = best.id; acquire = 0; }
    acquire += dt;
    const dx = best.x - px, dz = best.z - pz;
    const horiz = Math.hypot(dx, dz);
    const dy = best.y + 1.15 - (st.player.y + st.player.eyeHeight);
    const wantYaw = Math.atan2(-dx, -dz) + errYaw;
    const wantPitch = Math.atan2(dy, horiz) + errPitch;
    let d = wantYaw - yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = TURN * dt;
    yaw += Math.max(-step, Math.min(step, d));
    pitch += Math.max(-step, Math.min(step, wantPitch - pitch));
    F.aim(yaw, pitch);
    const onTarget = Math.abs(d) < 0.05;
    F.key('forward', closing || bestD > 22);
    F.key('fire', !closing && onTarget && acquire > REACT && !st.weapon.reloading && st.weapon.mag > 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
`;

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const { server, port } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
    defaultViewport: VIEWPORT,
  });
  const page = await browser.newPage();
  let t0 = 0, t1 = 0, captured = 0;
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
    await page.evaluate(BOT);
    // The player is made invulnerable ONLY so a 90-frame window is not spent on
    // an end screen; the enemies fight normally and the AI is untouched.
    await page.evaluate(() => {
      window.__FPS__.start();
      window.__FPS__.invulnerable(true);
      window.__playBot();
    });
    await wait(1200);

    // CDP SCREENCAST, not repeated `page.screenshot()`.
    //
    // The first version used `page.screenshot()` in a loop and managed 2.6 fps —
    // each call is a full round-trip that also stalls the page — so the "clip"
    // was a 35-second slideshow of a 35-second fight. `Page.startScreencast`
    // streams frames off the compositor at close to real time instead.
    const client = await page.createCDPSession();
    const frames = [];
    client.on('Page.screencastFrame', async (f) => {
      frames.push({ data: f.data, t: f.metadata.timestamp });
      try { await client.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closed */ }
    });
    t0 = Date.now();
    await client.send('Page.startScreencast', {
      format: 'jpeg', quality: 85, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
    });
    while (frames.length < FRAMES && Date.now() - t0 < 30000) await wait(50);
    await client.send('Page.stopScreencast');
    t1 = Date.now();
    captured = frames.length;
    for (let i = 0; i < frames.length; i++) {
      await writeFile(path.join(TMP, `f${String(i).padStart(3, '0')}.jpg`), Buffer.from(frames[i].data, 'base64'));
    }
  } finally {
    await browser.close();
    server.close();
  }

  const elapsed = (t1 - t0) / 1000;
  const fps = captured / elapsed;
  console.log(`captured ${captured} frames in ${elapsed.toFixed(1)}s → ${fps.toFixed(1)} fps real-time`);

  // Assemble with Pillow. Frame duration comes from the MEASURED capture rate so
  // the clip plays at the speed the game ran at.
  const out = path.join(SHOTS, 'run.gif');
  // Aim for ~12 fps of playback: fast enough to read as motion, small enough to
  // ship in a repo.
  const STRIDE = Math.max(1, Math.round(fps / 12));
  const script = `
import sys, glob
from PIL import Image
files = sorted(glob.glob(${JSON.stringify(path.join(TMP, '*.jpg'))}))
# Subsample to ~STRIDE-th frame so the GIF is a sane size, and scale the frame
# duration by the same factor so playback stays real-time.
STRIDE = ${STRIDE}
files = files[::STRIDE][:72]   # ~6 s of playback
frames = []
for f in files:
    im = Image.open(f).convert('RGB').resize((480, 270), Image.LANCZOS)
    frames.append(im.quantize(colors=64, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG))
frames[0].save(${JSON.stringify(out)}, save_all=True, append_images=frames[1:],
               duration=${Math.round((1000 / fps) * STRIDE)}, loop=0, optimize=True)
print('frames', len(frames))
`;
  const r = spawnSync(PY, ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('GIF assembly failed:', r.stderr || r.stdout);
    process.exit(1);
  }
  console.log(r.stdout.trim());
  await rm(TMP, { recursive: true, force: true });
  const { size } = await import('node:fs').then((m) => m.promises.stat(out));
  console.log(`${out}  ${(size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
