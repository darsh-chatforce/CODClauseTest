#!/usr/bin/env node
// =============================================================================
// Operation Nightfall — difficulty measurement
// =============================================================================
//
// THE PROBLEM WITH "TUNE THE DIFFICULTY"
// --------------------------------------
// The brief asks for a mission that is losable but winnable — roughly 60-70% for
// a competent player. That is a statement about a DISTRIBUTION, and there is no
// way to read a distribution off a screenshot, off a playthrough, or off the
// numbers in `config.ts`. The author of a shooter is also the worst possible
// measuring instrument for its difficulty: they know where the hostiles spawn.
//
// So the win rate is MEASURED, by running a scripted competent player through
// the real mission N times and counting.
//
// WHAT "COMPETENT" MEANS HERE, precisely — because the number is only as
// meaningful as the bot:
//   · aims at the nearest hostile it has REAL line of sight to (the engine's own
//     `hasLineOfSight`, not a guess),
//   · turns at a bounded rate (4.5 rad/s) rather than snapping — an instant-aim
//     bot measures the game's difficulty against an aimbot, which is a different
//     game,
//   · carries a persistent aim ERROR of ~1.4° that it resamples several times a
//     second, so it misses the way a person misses,
//   · waits ~220 ms after acquiring a target before firing (reaction time),
//   · strafes continuously, because standing still against this AI is not
//     competent play,
//   · reloads at 4 rounds rather than at 0,
//   · does NOT use cover, does not pre-fire, does not know where anyone spawns.
//
// That is deliberately a competent player and not an excellent one. An excellent
// player uses the terrace and the bunker; this bot walks into the open and wins
// on aim alone, which makes it a reasonable floor for "competent".
//
// The bot runs INSIDE the page on requestAnimationFrame. Driving it over CDP was
// tried first and measures the harness's round-trip latency as if it were the
// player's reaction time.
//
//   node tools/balance.mjs [runs]
// =============================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const RUNS = Number(process.argv[2] ?? 20);
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };

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

// ---------------------------------------------------------------- the bot
// Injected into the page. Returns a promise that settles with the mission result.
const BOT = /* js */ `
window.__runMission = function (timeoutMs) {
  return new Promise((resolve) => {
    const F = window.__FPS__;
    F.restart();
    // Post-processing off during measurement: this is a gameplay experiment and
    // the composer has nothing to do with how hard the mission is, so it is not
    // paid for 20 times over.
    F.postfx(false);
    F.audioMuted(true);

    const TURN = 4.5;         // rad/s — bounded, not a snap
    const ERR = 0.024;        // ~1.4 deg of persistent aim error
    const REACT = 0.22;       // s before firing at a newly acquired target
    const RELOAD_AT = 4;

    let yaw = F.state().player.yaw;
    let pitch = 0;
    let errYaw = 0, errPitch = 0, errTimer = 0;
    let acquire = 0;
    let strafeTimer = 0, strafeDir = 1;
    let lastTarget = -1;
    let last = performance.now();
    const t0 = last;

    const rand = () => Math.random() * 2 - 1;

    const finish = (result, st) => {
      F.key('fire', false); F.key('left', false); F.key('right', false); F.key('forward', false);
      resolve({
        result,
        kills: st.kills,
        time: st.missionTime,
        health: st.player.health,
        accuracy: st.weapon.shotsFired ? st.weapon.shotsHit / st.weapon.shotsFired : 0,
        shotsFired: st.weapon.shotsFired,
      });
    };

    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const st = F.state();

      if (st.phase === 'won') return finish('won', st);
      if (st.phase === 'lost') return finish('lost', st);
      if (now - t0 > timeoutMs) return finish('timeout', st);

      // ---- resample the aim error --------------------------------------
      errTimer -= dt;
      if (errTimer <= 0) { errTimer = 0.28; errYaw = rand() * ERR; errPitch = rand() * ERR * 0.6; }

      // ---- strafe --------------------------------------------------------
      strafeTimer -= dt;
      if (strafeTimer <= 0) {
        strafeTimer = 0.7 + Math.random() * 0.7;
        strafeDir = -strafeDir;
        F.key('left', strafeDir < 0);
        F.key('right', strafeDir > 0);
      }

      // ---- reload --------------------------------------------------------
      if (!st.weapon.reloading && st.weapon.mag <= RELOAD_AT && st.weapon.reserve > 0) {
        F.key('reload', true);
        setTimeout(() => F.key('reload', false), 40);
      }

      // ---- pick a target: nearest ALIVE hostile with real line of sight ---
      const px = st.player.x, pz = st.player.z;
      let best = null, bestD = 1e9;
      for (const e of st.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.x - px, e.z - pz);
        if (d < bestD && F.los(e.id)) { bestD = d; best = e; }
      }
      // Nothing visible: push toward the nearest hostile at all, so the bot
      // clears the compound instead of orbiting a wall.
      let closing = false;
      if (!best) {
        for (const e of st.enemies) {
          if (!e.alive) continue;
          const d = Math.hypot(e.x - px, e.z - pz);
          if (d < bestD) { bestD = d; best = e; }
        }
        closing = true;
        lastTarget = -1;
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
  });
};
`;

async function main() {
  const { server, port } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
    defaultViewport: VIEWPORT,
  });
  const page = await browser.newPage();
  const results = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
    await page.evaluate(BOT);
    await wait(400);

    for (let i = 0; i < RUNS; i++) {
      const r = await page.evaluate(() => window.__runMission(120000));
      results.push(r);
      console.log(
        `  run ${String(i + 1).padStart(2)}  ${r.result.padEnd(7)} ` +
        `kills ${r.kills}/6  ${r.time.toFixed(1).padStart(5)}s  hp ${String(Math.round(r.health)).padStart(3)}  ` +
        `acc ${(r.accuracy * 100).toFixed(1)}%  (${r.shotsFired} rounds)`,
      );
      await wait(150);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const won = results.filter((r) => r.result === 'won');
  const lost = results.filter((r) => r.result === 'lost');
  const timeout = results.filter((r) => r.result === 'timeout');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rate = won.length / results.length;

  // A WIN RATE WITHOUT A SAMPLE SIZE IS A NUMBER YOU TUNE AGAINST UNTIL IT
  // READS CORRECTLY, which is fitting to noise. At n = 32 the standard error on
  // a proportion near 0.5 is ~8.8 points and the 95% interval is ~35 points
  // wide — wider than the 10-point band this build was asked to hit. So the
  // interval is printed next to the rate, every time, and the tool says outright
  // when the sample cannot resolve the band.
  const n = results.length;
  const se = Math.sqrt((rate * (1 - rate)) / Math.max(1, n));
  const lo = Math.max(0, rate - 1.96 * se);
  const hi = Math.min(1, rate + 1.96 * se);

  console.log(`\n  runs           ${n}`);
  console.log(`  WIN RATE       ${(rate * 100).toFixed(1)}%  95% CI [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]` +
    `   (${won.length} won, ${lost.length} lost, ${timeout.length} timed out)`);
  console.log(`  mean kills     ${mean(results.map((r) => r.kills)).toFixed(2)} / 6`);
  console.log(`  mean accuracy  ${(mean(results.map((r) => r.accuracy)) * 100).toFixed(1)}%`);
  console.log(`  win time       ${mean(won.map((r) => r.time)).toFixed(1)} s`);
  console.log(`  hp on a win    ${mean(won.map((r) => r.health)).toFixed(0)} / 100`);
  console.log(`  kills on loss  ${mean(lost.map((r) => r.kills)).toFixed(2)} / 6`);
  const band = rate >= 0.6 && rate <= 0.7;
  const resolvable = 1.96 * se <= 0.05; // half the band's width
  console.log(`\n  target band 60-70%: ${band ? 'IN BAND' : 'OUT OF BAND'} (point estimate)`);
  if (!resolvable) {
    const need = Math.ceil((rate * (1 - rate)) / Math.pow(0.05 / 1.96, 2));
    console.log(`  NOTE: n=${n} CANNOT resolve a 10-point band — the 95% interval is ` +
      `${((hi - lo) * 100).toFixed(0)} points wide. ~${need} runs would be needed.`);
    console.log('  Treat the point estimate as indicative, not as a pass/fail.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
