#!/usr/bin/env node
// =============================================================================
// Operation Nightfall — two-client co-op driver
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// `tools/smoke.mjs` is a ~4-minute run. Iterating a multiplayer flow inside it
// means paying four minutes to learn that a room code was lowercase. This is the
// same rig — REAL server child process, REAL production build, TWO real headless
// Chrome clients in one room — reduced to the co-op path alone, ~30 s an
// iteration.
//
// It measures rather than asserts: every number the smoke suite's co-op
// assertions are calibrated against is PRINTED here first, so the bounds in
// `smoke.mjs` are observed values with headroom rather than guesses.
//
// USAGE
//   npm run build && node tools/mp_driver.mjs [--headful]
//
// EXIT CODE: 0 if the co-op flow completed end to end, 1 if it broke.
// =============================================================================

import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HEADFUL = process.argv.includes('--headful');
const VIEWPORT = { width: 1024, height: 640, deviceScaleFactor: 1 };

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.CHROME_PATH,
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function serveDist() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/index.html missing — run `npm run build` first.');
    process.exit(2);
  }
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createSocketServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await wait(200);
  }
  return null;
}

function startCoopServer(port) {
  const cli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [cli, path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, NF_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d).trimEnd()));
  child.stderr.on('data', (d) => log.push(String(d).trimEnd()));
  return { child, log };
}

// ------------------------------------------------------------- page helpers

/**
 * ONE BROWSER PROCESS PER PLAYER — not two tabs.
 *
 * Two tabs in one Chrome share a pointer lock and a foreground: the moment the
 * second tab called `startMission()` it took the lock, the first tab's
 * `pointerlockchange` fired with a null lock element, and `Game` did exactly
 * what it does when a real player alt-tabs mid-firefight — it PAUSED. The
 * backgrounded tab also had its `requestAnimationFrame` throttled, so its net
 * loop stopped sending input. Both are correct behaviours being provoked by the
 * harness rather than by the game, and neither is what two people on two
 * machines would experience. A separate browser per client is the arrangement
 * that actually matches the thing under test.
 */
async function launchClient(executablePath, label) {
  return puppeteer.launch({
    executablePath,
    headless: HEADFUL ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      // A headless window is never "visible", so without these the renderer is
      // throttled to ~1 Hz and the client simply stops playing.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--window-position=${label === 'A' ? 0 : VIEWPORT.width + 20},0`,
    ],
    defaultViewport: VIEWPORT,
  });
}

async function bootClient(browser, base, label) {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`);
  });
  await page.setViewport(VIEWPORT);
  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
  await page.evaluate(() => {
    window.__FPS__.audioMuted(true);
    window.__FPS__.start();
    window.__FPS__.invulnerable(true);
  });
  return { page, errors };
}

/** A client that has drifted out of `playing` cannot be measured — put it back. */
async function ensurePlaying(page) {
  return page.evaluate(() => {
    const st = window.__FPS__.state();
    if (st.phase === 'paused') window.__FPS__.resume();
    return window.__FPS__.state().phase;
  });
}

/** Join a room and wait for the server to answer, rather than sleeping on it. */
async function join(page, room, name, wsUrl) {
  await page.evaluate(
    ({ r, n, u }) => window.__FPS__.coopJoin(r, n, u),
    { r: room, n: name, u: wsUrl },
  );
  await page.waitForFunction(
    () => {
      const c = window.__FPS__.coop();
      return c.status === 'connected' || c.status === 'error';
    },
    { timeout: 15000, polling: 100 },
  );
  return page.evaluate(() => window.__FPS__.coop());
}

const coop = (page) => page.evaluate(() => window.__FPS__.coop());
const state = (page) => page.evaluate(() => window.__FPS__.state());
const remotes = (page) => page.evaluate(() => window.__FPS__.remotes());
const feed = (page) => page.evaluate(() => window.__FPS__.killFeed());

/** Sample the DRAWN teammate transform once per animation frame. */
const sampleRemote = (page, ms) =>
  page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const step = () => {
          const now = performance.now();
          const r = window.__FPS__.remotes()[0];
          if (r) out.push({ t: now - t0, x: r.x, y: r.y, z: r.z });
          if (now - t0 < dur) requestAnimationFrame(step);
          else resolve(out);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );

/** Per-frame planar deltas, and the shape of their distribution. */
function motionStats(samples) {
  const d = [];
  for (let i = 1; i < samples.length; i++) {
    d.push(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z));
  }
  if (!d.length) return null;
  const total = d.reduce((a, b) => a + b, 0);
  const mean = total / d.length;
  const max = Math.max(...d);
  const sorted = [...d].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  // A snapshot-stepping client draws ~3 frozen frames then one 4x jump at 15 Hz
  // against 60 fps. Both halves of that signature are measured.
  const frozen = d.filter((v) => v < mean * 0.1).length / d.length;
  return { frames: d.length, total, mean, max, p95, ratio: max / mean, frozen };
}

// ----------------------------------------------------------------- movement

async function walk(page, ms) {
  await page.evaluate(() => window.__FPS__.key('forward', true));
  await wait(ms);
  await page.evaluate(() => window.__FPS__.key('forward', false));
}

/**
 * Point the player down the longest clear bearing and confirm it can actually
 * run. Both clients spawn on the same tile facing the same way, so "hold W" is
 * not automatically a straight line for both of them.
 */
async function faceOpenGround(page) {
  return page.evaluate(() => {
    const st = window.__FPS__.state();
    let bestYaw = st.player.yaw;
    let bestClear = -1;
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * Math.PI * 2;
      // Probe by teleporting along the bearing and reading back where the
      // collision world actually allowed the player to stand.
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      window.__FPS__.teleport(st.player.x + dx * 7, st.player.z + dz * 7);
      const probe = window.__FPS__.state();
      const moved = Math.hypot(probe.player.x - st.player.x, probe.player.z - st.player.z);
      if (moved > bestClear) {
        bestClear = moved;
        bestYaw = yaw;
      }
    }
    window.__FPS__.teleport(st.player.x, st.player.z);
    window.__FPS__.aim(bestYaw, 0);
    return { yaw: bestYaw, clear: bestClear };
  });
}

// --------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  const { server, port } = await serveDist();
  const base = `http://127.0.0.1:${port}/`;

  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) {
    console.error('No Chrome found. Set CHROME_PATH.');
    process.exit(2);
  }

  const nfPort = await freePort();
  const wsUrl = `ws://127.0.0.1:${nfPort}`;
  const co = startCoopServer(nfPort);
  const health = await waitForHealth(nfPort);
  console.log(`co-op server /health → ${JSON.stringify(health)}`);
  if (!health) {
    console.error(co.log.join('\n'));
    process.exit(1);
  }

  const browserA = await launchClient(executablePath, 'A');
  const browserB = await launchClient(executablePath, 'B');

  let bad = 0;
  const note = (label, ok, detail = '') => {
    if (!ok) bad++;
    console.log(`  [${ok ? ' ok ' : 'BAD '}] ${label}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const A = await bootClient(browserA, base, 'A');
    const B = await bootClient(browserB, base, 'B');
    console.log(`  phases after boot: A=${await ensurePlaying(A.page)} B=${await ensurePlaying(B.page)}`);

    // ---- join ------------------------------------------------------------
    console.log('\n-- JOIN --');
    const a = await join(A.page, null, 'ALPHA', wsUrl);
    console.log(`  A hosted: ${JSON.stringify(a)}`);
    note('A connected', a.status === 'connected', a.error ?? '');
    const b = await join(B.page, a.room, 'BRAVO', wsUrl);
    console.log(`  B joined: ${JSON.stringify(b)}`);
    note('B connected to A room', b.status === 'connected' && b.room === a.room, b.error ?? '');

    await wait(1200);
    const ac = await coop(A.page);
    const bc = await coop(B.page);
    console.log(`  A sees ${ac.players} players / ${ac.remotes} avatars`);
    console.log(`  B sees ${bc.players} players / ${bc.remotes} avatars`);
    note('A sees B', ac.remotes === 1);
    note('B sees A', bc.remotes === 1);

    // ---- mutual movement visibility --------------------------------------
    console.log('\n-- MUTUAL MOVEMENT --');
    const aFace = await faceOpenGround(A.page);
    console.log(`  A faces yaw=${aFace.yaw.toFixed(2)} clear=${aFace.clear.toFixed(2)} m`);
    await wait(500);
    const beforeAonB = (await remotes(B.page))[0];
    const aStart = (await state(A.page)).player;
    const smooth = (async () => sampleRemote(B.page, 1600))();
    await walk(A.page, 1500);
    const samples = await smooth;
    await wait(400);
    const afterAonB = (await remotes(B.page))[0];
    const aEnd = (await state(A.page)).player;
    const aSelfMoved = Math.hypot(aEnd.x - aStart.x, aEnd.z - aStart.z);
    const aSeenMoved = beforeAonB && afterAonB
      ? Math.hypot(afterAonB.x - beforeAonB.x, afterAonB.z - beforeAonB.z)
      : 0;
    console.log(`  A moved ${aSelfMoved.toFixed(2)} m; B saw its avatar move ${aSeenMoved.toFixed(2)} m`);
    note('A moves and B sees it', aSeenMoved > 1);
    note('B tracks A within a metre', aSelfMoved > 1 && Math.abs(aSeenMoved - aSelfMoved) < 1.2,
      `delta ${Math.abs(aSeenMoved - aSelfMoved).toFixed(2)} m`);

    // ---- interpolation smoothness ----------------------------------------
    console.log('\n-- INTERPOLATION --');
    const ms = motionStats(samples);
    if (!ms) {
      note('smoothness sampled', false, 'no samples');
    } else {
      console.log(
        `  ${ms.frames} frames, travelled ${ms.total.toFixed(2)} m\n` +
        `  mean ${(ms.mean * 1000).toFixed(2)} mm/frame  p95 ${(ms.p95 * 1000).toFixed(2)} mm  ` +
        `max ${(ms.max * 1000).toFixed(2)} mm\n` +
        `  max/mean ${ms.ratio.toFixed(2)}   frozen frames ${(ms.frozen * 100).toFixed(1)}%`,
      );
    }

    // ---- B moves, A sees --------------------------------------------------
    console.log('\n-- REVERSE MOVEMENT --');
    const bFace = await faceOpenGround(B.page);
    console.log(`  B faces yaw=${bFace.yaw.toFixed(2)} clear=${bFace.clear.toFixed(2)} m`);
    await wait(500);
    const beforeBonA = (await remotes(A.page))[0];
    const bStart = (await state(B.page)).player;
    await walk(B.page, 1500);
    await wait(400);
    const afterBonA = (await remotes(A.page))[0];
    const bEnd = (await state(B.page)).player;
    const bSelfMoved = Math.hypot(bEnd.x - bStart.x, bEnd.z - bStart.z);
    const bSeenMoved = beforeBonA && afterBonA
      ? Math.hypot(afterBonA.x - beforeBonA.x, afterBonA.z - beforeBonA.z)
      : 0;
    console.log(`  B moved ${bSelfMoved.toFixed(2)} m; A saw its avatar move ${bSeenMoved.toFixed(2)} m`);
    note('B moves and A sees it', bSeenMoved > 1);

    // ---- shared enemy state + cross-client kill feed ----------------------
    console.log('\n-- SHARED KILL --');
    console.log(`  phases: A=${await ensurePlaying(A.page)} B=${await ensurePlaying(B.page)}`);
    const beforeKillA = await state(A.page);
    const beforeKillB = await state(B.page);
    console.log(`  hostiles before: A=${beforeKillA.hostilesAlive} B=${beforeKillB.hostilesAlive}`);

    const closeIn = (page, idx) =>
      page.evaluate((i) => {
        const st = window.__FPS__.state();
        const e = st.enemies[i];
        if (!e || !e.alive) return false;
        for (let k = 0; k < 12; k++) {
          const ang = (k / 12) * Math.PI * 2;
          window.__FPS__.teleport(e.x + Math.cos(ang) * 5, e.z + Math.sin(ang) * 5);
          if (window.__FPS__.los(e.id)) return true;
        }
        return false;
      }, idx);

    const aimAndFire = (page, idx) =>
      page.evaluate(async (i) => {
        const st = window.__FPS__.state();
        const e = st.enemies[i];
        if (!e) return;
        const dx = e.x - st.player.x;
        const dz = e.z - st.player.z;
        const horiz = Math.hypot(dx, dz);
        const dy = e.y + 1.15 - (st.player.y + st.player.eyeHeight);
        window.__FPS__.aim(Math.atan2(-dx, -dz), Math.atan2(dy, horiz));
        await window.__FPS__.fire(1);
      }, idx);

    let killedIdx = -1;
    let rounds = 0;
    outer: for (let idx = 0; idx < 6 && killedIdx < 0; idx++) {
      for (let shot = 0; shot < 10; shot++) {
        const st = await state(A.page);
        if (st.phase !== 'playing') break outer;
        if (!st.enemies[idx] || !st.enemies[idx].alive) {
          killedIdx = idx;
          break;
        }
        await closeIn(A.page, idx);
        await wait(90);
        await aimAndFire(A.page, idx);
        rounds++;
        await wait(140);
      }
      const st = await state(A.page);
      if (st.enemies[idx] && !st.enemies[idx].alive) killedIdx = idx;
    }
    await wait(700);
    const afterKillA = await state(A.page);
    const afterKillB = await state(B.page);
    console.log(
      `  ${rounds} rounds fired by A; killed index ${killedIdx}; ` +
      `hostiles A=${afterKillA.hostilesAlive} B=${afterKillB.hostilesAlive}; ` +
      `A phase=${afterKillA.phase} hp=${afterKillA.player.health.toFixed(0)}`,
    );
    note('A killed a hostile', killedIdx >= 0);
    if (killedIdx >= 0) {
      note(
        'the same hostile is dead for B',
        afterKillB.enemies[killedIdx] && !afterKillB.enemies[killedIdx].alive,
        `B index ${killedIdx} alive=${afterKillB.enemies[killedIdx]?.alive}`,
      );
    }
    note(
      'both clients agree on the hostile count',
      afterKillA.hostilesAlive === afterKillB.hostilesAlive,
      `${afterKillA.hostilesAlive} vs ${afterKillB.hostilesAlive}`,
    );

    const feedA = await feed(A.page);
    const feedB = await feed(B.page);
    console.log(`  A feed: ${JSON.stringify(feedA)}`);
    console.log(`  B feed: ${JSON.stringify(feedB)}`);
    note("A's kill appears in B's feed", feedB.some((r) => r.includes('ALPHA')));

    // ---- disconnect despawn ----------------------------------------------
    console.log('\n-- DISCONNECT --');
    const beforeLeave = await coop(B.page);
    await A.page.evaluate(() => window.__FPS__.coopLeave());
    await wait(1800);
    const afterLeave = await coop(B.page);
    const leftovers = await remotes(B.page);
    console.log(`  B remotes ${beforeLeave.remotes} → ${afterLeave.remotes} (${JSON.stringify(leftovers)})`);
    note('A despawns for B', afterLeave.remotes === 0 && leftovers.length === 0);
    note('B is still connected after A left', afterLeave.status === 'connected', afterLeave.status);

    // ---- hygiene ----------------------------------------------------------
    const errs = [...A.errors, ...B.errors];
    note('no page errors on either client', errs.length === 0, errs.slice(0, 4).join(' | '));
  } finally {
    await browserA.close();
    await browserB.close();
    co.child.kill('SIGTERM');
    server.close();
    console.log(`\nserver log:\n${co.log.join('\n')}`);
  }

  console.log(`\n${bad === 0 ? 'CO-OP FLOW GREEN' : `${bad} PROBLEM(S)`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
