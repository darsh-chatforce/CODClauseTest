#!/usr/bin/env node
// =============================================================================
// Operation Nightfall — headless verification harness
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Screenshots prove a frame renders. They do not prove the game PLAYS. This
// harness serves the production build, boots it in headless Chrome over CDP,
// and drives the real input state through `window.__FPS__` (headless Chrome
// cannot enter pointer lock, so look is injected into the same accumulator the
// real mousemove handler writes). Every assertion reads the live simulation.
//
// The assertions are the M1 acceptance bar, in particular the three things the
// generation pipeline got wrong twice:
//   * the arena is FULLY ENCLOSED          (ray audit, 1360 samples, 0 leaks)
//   * the viewmodel never dominates the frame (exact rasterised coverage < 15%)
//   * enemies NEVER fire while moving      (continuous in-engine invariant audit
//                                           plus sampled state/speed pairs)
//
// USAGE
//   npm run build && node tools/smoke.mjs [--headful] [--keep]
//
// EXIT CODE: 0 = every assertion passed. 1 = a failure, a page error, or a
// console error.
// =============================================================================

import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'shots');
const HEADFUL = process.argv.includes('--headful');
const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };

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

// ---------------------------------------------------------------- assertions

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------- static server

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

// ------------------------------------------------------- M4: the co-op server
//
// The multiplayer assertions boot the REAL server as a child process and drive
// two REAL browser clients against it. Nothing here mocks a socket: if the
// protocol, the tick loop or the interpolation is wrong, these fail.

/**
 * A port the OS says is free.
 *
 * Asking beats guessing. The server's own default is 8787, and hardcoding that
 * here would make the suite fail for anybody who happens to have `npm run dev`
 * running in another terminal — a test that fails because the developer is
 * developing is a test nobody trusts.
 */
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

/** GET /health until it answers, or give up. Readiness is OBSERVED, never slept. */
async function waitForHealth(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Start `server/index.ts` on `port`, through the project's own tsx. */
function startCoopServer(port) {
  const cli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [cli, path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, NF_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}

/**
 * ONE BROWSER PROCESS PER CO-OP CLIENT — not two tabs in the suite's browser.
 *
 * Two tabs in one Chrome share a pointer lock and a foreground. The second
 * tab's `startMission()` took the lock, the first tab's `pointerlockchange`
 * fired with a null lock element, and `Game` did precisely what it does when a
 * real player alt-tabs mid-firefight: it PAUSED. The backgrounded tab also had
 * its `requestAnimationFrame` throttled, so its net loop stopped sending input
 * entirely. Both are correct behaviours being provoked by the harness rather
 * than by the game, and neither is what two people on two machines experience.
 *
 * It also keeps the co-op clients' console and error streams out of the
 * single-player page's, so the hygiene assertions below still mean what they
 * meant at M3.
 */
function launchCoopClient(executablePath, index) {
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
      // throttled towards 1 Hz and the client stops playing while we watch it.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1024,640',
      `--window-position=${index * 1044},0`,
    ],
    defaultViewport: { width: 1024, height: 640, deviceScaleFactor: 1 },
  });
}

/**
 * Per-frame planar deltas of a remote avatar, and the shape of the
 * distribution — the whole interpolation assertion is one read of this.
 *
 * A client that SNAPPED to each snapshot instead of interpolating would, at
 * 15 Hz snapshots against ~60 fps rendering, hold still for three frames and
 * then jump on the fourth: `frozen` near 0.75 and `ratio` (max/mean) near 4.
 * A client that interpolates spreads the same distance evenly.
 */
function motionStats(samples) {
  const d = [];
  for (let i = 1; i < samples.length; i++) {
    d.push(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z));
  }
  if (d.length < 20) return null;
  const total = d.reduce((a, b) => a + b, 0);
  const mean = total / d.length;
  const max = Math.max(...d);
  const frozen = d.filter((v) => v < mean * 0.1).length / d.length;
  return { frames: d.length, total, mean, max, ratio: max / mean, frozen };
}

// --------------------------------------------------------------------- main

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const { server, port } = await serveDist();
  const base = `http://127.0.0.1:${port}/`;

  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) {
    console.error('No Chrome found. Set CHROME_PATH.');
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: HEADFUL ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
    defaultViewport: VIEWPORT,
  });

  const pageErrors = [];
  const consoleErrors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const t = m.text();
      // three.js emits a benign warning-free boot on WebGL; capture everything
      // and let the assertion decide.
      consoleErrors.push(`${m.type()}: ${t}`);
    }
  });

  const shot = async (name) => {
    const file = path.join(SHOTS, name);
    await page.screenshot({ path: file });
    return file;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => page.evaluate(() => window.__FPS__.state());

  try {
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
    await wait(600);

    console.log('\n== BOOT ==');
    check('page boots with no uncaught exceptions', pageErrors.length === 0, pageErrors.join(' | '));
    check(
      'WebGL context is alive',
      await page.evaluate(() => {
        const c = document.getElementById('game-canvas');
        return !!(c.getContext('webgl2') || c.getContext('webgl'));
      }),
    );

    // ---- structural audits (run before play) ------------------------------
    console.log('\n== WORLD ==');
    const enclosure = await page.evaluate(() => window.__FPS__.enclosure());
    check(
      'arena is fully enclosed (no wall gaps)',
      enclosure.leaks.length === 0,
      `${enclosure.samples} rays cast, ${enclosure.leaks.length} escaped`,
    );
    const boot = await state();
    check('nav graph built on both storeys', boot.nav.nodes > 60, `${boot.nav.nodes} waypoints`);

    // ---- M2: assets --------------------------------------------------------
    // M1 had zero asset files, so "did it load?" was not a question that could be
    // asked. M2 ships ~30, and a silently-missing asset renders as the fallback —
    // which is precisely how the pipeline shipped a cyan cube where a player
    // model should have been. Every load is recorded and every failure is red.
    console.log('\n== ASSETS ==');
    check(
      'every asset loaded (zero failures)',
      boot.assets.failed.length === 0,
      `${boot.assets.loaded}/${boot.assets.requested} in ${boot.assets.ms} ms` +
        (boot.assets.failed.length ? ` — FAILED: ${boot.assets.failed.join(', ')}` : ''),
    );
    check(
      'sky is the photographic HDRI, not the procedural fallback',
      boot.assets.skySource === 'hdri',
      boot.assets.skySource,
    );
    check(
      'all six soldier animation clips resolved by name',
      ['idle', 'walk', 'run', 'aim', 'fire', 'death'].every((c) =>
        boot.assets.soldierClips.includes(c),
      ),
      boot.assets.soldierClips.join(', '),
    );
    check(
      'generated props actually placed in the level',
      boot.arena.propsPlaced >= 30,
      `${boot.arena.propsPlaced} props fitted to their colliders`,
    );

    // ---- M3: the generated carbine ----------------------------------------
    // M2 generated this weapon and deliberately did not ship it, because the ADS
    // alignment is GEOMETRIC and a generated mesh arrives with its optic
    // wherever the generator put it. These assert that the fit actually
    // happened, rather than that the game silently fell back to the placeholder
    // rifle — which would look almost identical in a screenshot and would mean
    // the milestone's headline deliverable was not in the build.
    check(
      'generated carbine is fitted (not the placeholder fallback)',
      boot.carbine.fitted === true,
      `${boot.carbine.vertices} verts, ${boot.carbine.lengthMetres} m overall`,
    );
    check(
      'carbine optic sits on the ADS axis in model space',
      Math.abs(boot.carbine.opticX) < 1e-6 && Math.abs(boot.carbine.opticY - 0.093) < 1e-6,
      `optic local (${boot.carbine.opticX.toFixed(6)}, ${boot.carbine.opticY.toFixed(6)}), SIGHT_HEIGHT 0.093`,
    );
    check(
      'magazine split out of the single generated mesh (reload keeps its mag swap)',
      boot.carbine.magazineTriangles > 100,
      `${boot.carbine.magazineTriangles} triangles moved to their own object`,
    );

    // ---- M3: post-processing + audio come up -------------------------------
    check('post-processing is on by default', boot.postfx.enabled === true);
    check(
      'ambient occlusion is OFF by default (it does not hold 60 fps — see DECISIONS §29)',
      boot.postfx.ao === false,
    );
    // "Audio does not throw" is the assertion that matters: an AudioContext can
    // fail for autoplay policy, for a missing device, or for a browser without
    // the constructor, and none of those may take the game down with them.
    const audioInit = await page.evaluate(() => {
      try {
        return { threw: false, ...window.__FPS__.initAudio() };
      } catch (e) {
        return { threw: true, ready: false, error: String(e) };
      }
    });
    check(
      'audio initialisation does not throw',
      audioInit.threw === false,
      audioInit.threw ? audioInit.error : 'no exception',
    );
    check(
      'audio graph came up',
      audioInit.ready === true,
      audioInit.ready ? 'AudioContext + master/limiter/buses live' : `not ready: ${audioInit.error}`,
    );

    // ---- start ------------------------------------------------------------
    console.log('\n== MISSION START ==');
    await page.evaluate(() => window.__FPS__.start());
    // FRAME COMPOSITION + MECHANICS BLOCK: invulnerable.
    //
    // Everything from here to the end of hit registration measures MECHANICS —
    // movement, jump arc, fire rate, spread, reload arithmetic, ADS optics,
    // viewmodel coverage, hit registration — none of which is about surviving a
    // firefight. Letting the player be shot during it corrupts the measurements
    // (a dying player's damage vignette floods every screenshot crimson, and a
    // DEAD player stops the fire-rate clock entirely, which silently swallowed
    // seven of eight rounds). The enemies' ability to kill has its own assertion
    // in the doctrine block below, which runs fully vulnerable.
    await page.evaluate(() => window.__FPS__.invulnerable(true));
    await wait(500);
    let s = await state();
    check('phase → playing', s.phase === 'playing', s.phase);
    check('6 hostiles spawned', s.hostilesAlive === 6, String(s.hostilesAlive));
    check('player spawns on the ground', near(s.player.y, 0, 0.05), `y=${s.player.y.toFixed(3)}`);
    check('ammo starts 30 / 120', s.weapon.mag === 30 && s.weapon.reserve === 120);
    // ---- M2: the exposure gate --------------------------------------------
    // M1's worst bug was a level that rendered BLACK (an 11° sun casting a 31 m
    // shadow across a 40 m arena), and the only thing that caught it was a human
    // opening a PNG. M2 adds an HDRI, a tone-mapping exposure and two IBL
    // intensities — four more ways to produce a technically-correct, visually
    // unusable frame, none of which throw. So the presented frame is measured.
    const lum = await page.evaluate(() => window.__FPS__.frameStats());
    check(
      'frame is not too dark to play',
      lum.mean > 0.06,
      `mean luminance ${lum.mean.toFixed(3)}`,
    );
    check(
      'frame is not blown out',
      lum.mean < 0.62 && lum.bright < 0.12,
      `mean ${lum.mean.toFixed(3)}, ${(lum.bright * 100).toFixed(1)}% clipped white`,
    );
    check(
      'frame is not mostly crushed to black',
      lum.dark < 0.2,
      `${(lum.dark * 100).toFixed(1)}% of pixels below 2% luminance`,
    );
    const spawnShot = await shot('01_spawn.png');

    // ---- movement ---------------------------------------------------------
    console.log('\n== MOVEMENT ==');
    const before = await state();
    await page.evaluate(() => window.__FPS__.key('forward', true));
    await wait(900);
    const walking = await state();
    await page.evaluate(() => window.__FPS__.key('sprint', true));
    await wait(700);
    const sprinting = await state();
    await page.evaluate(() => {
      window.__FPS__.key('forward', false);
      window.__FPS__.key('sprint', false);
    });
    await wait(220);
    const stopped = await state();

    const travelled = Math.hypot(
      walking.player.x - before.player.x,
      walking.player.z - before.player.z,
    );
    check('WASD moves the player', travelled > 2.5, `${travelled.toFixed(2)} m in 0.9 s`);

    // W MUST MOVE THE PLAYER THE WAY THEY ARE LOOKING.
    //
    // The assertion above measures a DISTANCE, and a distance has no sign — so
    // it passed for the entire life of M1 while `W` drove the player backwards
    // along their own look vector. Strafing was unaffected, which is why nobody
    // caught it from the numbers: a half-inverted controller reads as bad mouse
    // settings, not as a bug, and it took a human actually playing the build.
    //
    // The lesson is the project's own thesis turned on itself: an assertion that
    // cannot fail for the defect you have is not coverage. This one projects the
    // displacement onto the forward vector and demands a POSITIVE dot product,
    // so the inversion is now a red test.
    const fwdX = -Math.sin(before.player.yaw);
    const fwdZ = -Math.cos(before.player.yaw);
    const dot =
      (walking.player.x - before.player.x) * fwdX +
      (walking.player.z - before.player.z) * fwdZ;
    check(
      'W moves TOWARD the look direction (not away from it)',
      dot > 2.5,
      `displacement·forward = ${dot.toFixed(2)} m (travelled ${travelled.toFixed(2)} m)`,
    );

    // And the strafe axis is not mirrored either, checked the same way.
    await page.evaluate(() => window.__FPS__.key('right', true));
    await wait(600);
    const strafed = await state();
    await page.evaluate(() => window.__FPS__.key('right', false));
    await wait(250);
    const rightX = Math.cos(strafed.player.yaw);
    const rightZ = -Math.sin(strafed.player.yaw);
    const strafeDot =
      (strafed.player.x - stopped.player.x) * rightX +
      (strafed.player.z - stopped.player.z) * rightZ;
    check(
      'D strafes RIGHT of the look direction',
      strafeDot > 1.5,
      `displacement·right = ${strafeDot.toFixed(2)} m`,
    );

    check(
      'walk speed ≈ 5.1 m/s',
      near(walking.player.speed, 5.1, 0.45),
      `${walking.player.speed.toFixed(2)} m/s`,
    );
    check(
      'sprint speed ≈ 7.3 m/s and sprint flag set',
      sprinting.player.sprinting && near(sprinting.player.speed, 7.3, 0.5),
      `${sprinting.player.speed.toFixed(2)} m/s`,
    );
    check(
      'snappy stop: < 0.4 m/s within 220 ms of release',
      stopped.player.speed < 0.4,
      `${stopped.player.speed.toFixed(3)} m/s`,
    );
    // Compare the RESTING fov (fovBase), not the instantaneous one: an incoming
    // damage kick is additive and would otherwise mask the sprint widen.
    check(
      'sprint widens FOV',
      sprinting.camera.fovBase > walking.camera.fovBase + 2,
      `${walking.camera.fovBase.toFixed(1)}° → ${sprinting.camera.fovBase.toFixed(1)}°`,
    );

    // ---- jump -------------------------------------------------------------
    console.log('\n== JUMP ==');
    const groundY = (await state()).player.y;
    await page.evaluate(() => window.__FPS__.key('jump', true));
    let peak = groundY;
    let leftGround = false;
    for (let i = 0; i < 22; i++) {
      await wait(40);
      const j = await state();
      peak = Math.max(peak, j.player.y);
      if (!j.player.grounded) leftGround = true;
    }
    await page.evaluate(() => window.__FPS__.key('jump', false));
    await wait(700);
    const landed = await state();
    check('jump leaves the ground', leftGround);
    check('jump apex ≥ 0.7 m', peak - groundY >= 0.7, `${(peak - groundY).toFixed(2)} m`);
    check('player lands again', landed.player.grounded && near(landed.player.y, groundY, 0.12));

    // ---- weapon: fire / spread / reload -----------------------------------
    console.log('\n== WEAPON ==');
    const beforeBurst = await state();
    // Hold the trigger — a sustained burst is what bloom is for.
    await page.evaluate(() => window.__FPS__.key('fire', true));
    await wait(520);
    const afterFire = await state();
    await page.evaluate(() => window.__FPS__.key('fire', false));
    const spent = beforeBurst.weapon.mag - afterFire.weapon.mag;
    check('holding the trigger fires automatically', spent >= 4, `${spent} rounds in 0.52 s`);
    check(
      'spread blooms while firing',
      afterFire.weapon.spread > beforeBurst.weapon.spread + 0.3,
      `${beforeBurst.weapon.spread.toFixed(2)}° → ${afterFire.weapon.spread.toFixed(2)}°`,
    );
    await wait(1600);
    check(
      'spread recovers after the trigger is released',
      (await state()).weapon.spread < 0.5,
      `${(await state()).weapon.spread.toFixed(2)}°`,
    );

    await page.evaluate(() => window.__FPS__.tap('reload'));
    await wait(300);
    const midReload = await state();
    check('reload starts and reports progress', midReload.weapon.reloading);
    await wait(2400);
    const afterReload = await state();
    check(
      'reload refills the magazine from reserve',
      afterReload.weapon.mag === 30 && afterReload.weapon.reserve === 120 - spent,
      `${afterReload.weapon.mag} / ${afterReload.weapon.reserve} (expected 30 / ${120 - spent})`,
    );

    // ---- ADS --------------------------------------------------------------
    console.log('\n== ADS ==');
    const hipFov = (await state()).camera.fov;
    const hipCoverage = await page.evaluate(() => window.__FPS__.coverage());
    await page.evaluate(() => window.__FPS__.key('ads', true));
    await wait(450);
    const ads = await state();
    const adsCoverage = await page.evaluate(() => window.__FPS__.coverage());
    check('ADS pulls the FOV in', ads.camera.fov < hipFov - 15, `${hipFov.toFixed(1)}° → ${ads.camera.fov.toFixed(1)}°`);
    check('ADS tightens the cone', ads.weapon.spread < 0.15, `${ads.weapon.spread.toFixed(3)}°`);

    // ---- M3: THE ADS ALIGNMENT, MEASURED ----------------------------------
    //
    // DECISIONS §2.5 has claimed since M1 that the ADS alignment is geometric
    // rather than eyeballed. Until M3 that claim rested on the PLACEHOLDER rifle
    // having been built with its optic at SIGHT_HEIGHT by hand — true, but
    // circular. With a generated mesh in the slot the claim needs evidence, so
    // the optic's optical axis is projected through the real viewmodel camera in
    // the real settled ADS pose and must land on the crosshair.
    //
    // This is the assertion that fails if anyone ever "fixes" a misaligned sight
    // by nudging the pose until it looks right — which is the exact move the
    // whole file exists to prevent.
    //
    // MEASURE THE SETTLED POSE. The claim is about where the ADS pose PUTS the
    // optic, and the pose is an exponentially-damped blend (`poseTau` 75 ms) with
    // additive sway and bob layered on top. At the 450 ms above it is still ~0.3%
    // short of its target, which put the optic 3.3 px off centre and failed this
    // check the first time it ran. The residual is real and correct — a sight
    // that snapped instantly would feel wrong — so the fix is to let the filter
    // finish rather than to widen the tolerance to cover a transient. Six more
    // time constants leaves under a millionth of the travel.
    await wait(600);
    const optic = await page.evaluate(() => window.__FPS__.optic());
    const opticPx = Math.hypot(
      (optic.x * VIEWPORT.width) / 2,
      (optic.y * VIEWPORT.height) / 2,
    );
    check(
      'ADS puts the optic ON the crosshair (geometric, not eyeballed)',
      opticPx < 2.0,
      `optic lands ${opticPx.toFixed(2)} px from screen centre (NDC ${optic.x.toFixed(5)}, ${optic.y.toFixed(5)})`,
    );
    // ---- M3: THE APERTURE IS OPEN ------------------------------------------
    // The player asked to be able to look through the scope. Tripo cannot model
    // a hole (DECISIONS §36 — two generations, both measured solid by
    // `assetgen/aperture.py`), so the optic is authored and the aperture is the
    // ABSENCE of geometry. That is exactly the kind of claim that rots silently,
    // so it is raycast rather than eyeballed: down the sight line, in the real
    // ADS pose, with the reticle excluded.
    const sight = await page.evaluate(() => window.__FPS__.opticClear());
    check(
      'the optic aperture is open (you can see through the sight)',
      sight.clear === true,
      sight.clear ? 'sight line clear' : `blocked by ${sight.blockedBy} at ${sight.distance.toFixed(3)} m`,
    );
    const adsShot = await shot('03_ads.png');
    await page.evaluate(() => window.__FPS__.key('ads', false));
    await wait(350);

    console.log('\n== VIEWMODEL BUDGET ==');
    check(
      'hip viewmodel covers < 15% of the frame',
      hipCoverage < 0.15,
      `${(hipCoverage * 100).toFixed(2)}%`,
    );
    check(
      'ADS viewmodel covers < 15% of the frame',
      adsCoverage < 0.15,
      `${(adsCoverage * 100).toFixed(2)}%`,
    );
    check(
      'viewmodel is actually on screen (not culled away)',
      hipCoverage > 0.005,
      `${(hipCoverage * 100).toFixed(2)}%`,
    );

    // ---- shots register on enemies ----------------------------------------
    console.log('\n== HIT REGISTRATION ==');
    const pre = await state();
    // Prefer a ground-floor hostile: firing up at the elevated deck can be
    // legitimately blocked by its railing, which would make this a cover test
    // rather than a hit-registration test.
    const targetId = (pre.enemies.find((e) => e.alive && e.y < 0.5) ??
      pre.enemies.find((e) => e.alive)).id;
    // Aim is recomputed from LIVE positions immediately before every round —
    // the target is a moving AI, so a stale aim would test nothing.
    const aimAndFire = (id) =>
      page.evaluate((eid) => {
        const st = window.__FPS__.state();
        const e = st.enemies.find((x) => x.id === eid);
        if (!e) return;
        const dx = e.x - st.player.x;
        const dz = e.z - st.player.z;
        const horiz = Math.hypot(dx, dz);
        const dy = e.y + 1.15 - (st.player.y + st.player.eyeHeight);
        window.__FPS__.aim(Math.atan2(-dx, -dz), Math.atan2(dy, horiz));
        window.__FPS__.fire(1);
      }, id);

    // RE-ESTABLISH THE ENGAGEMENT BEFORE EVERY ROUND.
    //
    // The first version teleported ONCE and then fired eight rounds over ~1.4 s
    // at a hostile free to move at 3.5 m/s — five metres of travel, easily
    // enough to walk behind a crate. That made the assertion RACY: it passed or
    // failed depending on where the AI wandered, which is a cover test wearing a
    // hit-registration test's name.
    //
    // Closing the range before each round keeps what the assertion actually
    // claims — a real round, through the real collision world, against a real
    // moving AI with real capsule/sphere hit volumes — while removing the one
    // variable that has nothing to do with hit registration. The player is
    // placed 5 m from the target on the side facing the arena centre, so the
    // teleport itself cannot end up inside the perimeter wall.
    // Pick a stand-off position that the ENGINE says is clear, rather than
    // assuming one. Eight bearings at 5 m, first one with real line of sight to
    // the target's chest wins. Without this the harness sometimes parked itself
    // behind the central bunker and the assertion became a coin flip about
    // cover — a hit-registration test must not be able to fail for a reason that
    // has nothing to do with hit registration.
    const closeIn = (id) =>
      page.evaluate((eid) => {
        const e = window.__FPS__.state().enemies.find((x) => x.id === eid);
        if (!e) return false;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          window.__FPS__.teleport(e.x + Math.cos(a) * 5, e.z + Math.sin(a) * 5);
          if (window.__FPS__.los(eid)) return true;
        }
        return false;
      }, id);

    // THE PLAYER MUST SURVIVE LONG ENOUGH TO SHOOT.
    //
    // This sequence parks the player 5 m from a hostile eight times running,
    // which is a reliable way to get killed. And death is not a soft failure
    // here: `rifle.update()` only runs while `phase === 'playing'`, so once the
    // mission ends the fire cooldown stops ticking and `canFire` never becomes
    // true again — SEVEN of the eight rounds were silently never fired, which is
    // why the assertion read "1 rounds fired" in every run and flipped on
    // whether that single round connected.
    //
    // M1 added `invulnerable()` for exactly this class of problem (it was
    // introduced because the player kept dying mid-screenshot-composition). Used
    // for the same reason: this assertion is about hit registration, not about
    // surviving a firefight, and the enemies' ability to kill has its own
    // assertion further down.
    await page.evaluate(() => window.__FPS__.invulnerable(true));
    await closeIn(targetId);
    await wait(200);
    const beforeState = await state();
    const beforeShots = beforeState.weapon.shotsHit;
    const beforeFired = beforeState.weapon.shotsFired;
    // Fire until the target is DOWN or the budget is spent. 26 damage a round
    // against 100 health means four clean hits kill it, and emptying the
    // remaining rounds into a corpse proves nothing — the previous version
    // asserted "all 8 fired" and then failed because the assertion had done its
    // job in four.
    let roundsAttempted = 0;
    for (let i = 0; i < 8; i++) {
      const live = (await state()).enemies.find((e) => e.id === targetId);
      if (!live || !live.alive) break;
      await closeIn(targetId);
      await wait(90);
      await aimAndFire(targetId);
      roundsAttempted++;
      await wait(120);
    }
    await wait(400);
    const afterShots = await state();
    const target = afterShots.enemies.find((e) => e.id === targetId);
    check(
      'hitscan registers on an enemy',
      afterShots.weapon.shotsHit > beforeShots,
      `${afterShots.weapon.shotsFired - beforeFired} rounds fired, ` +
        `${afterShots.weapon.shotsHit - beforeShots} registered`,
    );
    check(
      'enemy takes damage',
      target.health < 100 || !target.alive,
      `hp=${target.health.toFixed(0)} alive=${target.alive}`,
    );
    // Every round attempted must ACTUALLY have left the barrel. Without this the
    // hit-rate above can be computed over a denominator of one and still pass,
    // which is how the silent no-fire above hid for four runs.
    // Every round the harness ASKED for must actually have left the barrel.
    // Without this the hit rate can be computed over a denominator of one and
    // still pass — which is exactly how a silent no-fire (the player had died,
    // and the fire cooldown only ticks while the mission is running) hid for
    // four consecutive runs behind a green assertion.
    check(
      'every attempted round actually fired',
      afterShots.weapon.shotsFired - beforeFired >= roundsAttempted,
      `${afterShots.weapon.shotsFired - beforeFired} of ${roundsAttempted} left the barrel`,
    );
    await page.evaluate(() => window.__FPS__.invulnerable(false));

    // ---- AI doctrine ------------------------------------------------------
    console.log('\n== AI DOCTRINE (never fire while moving) ==');
    const STATIONARY = new Set(['halt', 'aim', 'fire']);
    const MOVING = new Set(['patrol', 'advance', 'reposition']);
    const seenStates = new Set();
    let sampleViolations = 0;
    let worstSample = 0;
    let engineViolations = 0;
    let combatShot = null;
    let tookDamage = false;
    let died = false;

    // Fresh mission so the window starts from full health and 6 hostiles.
    await page.evaluate(() => window.__FPS__.restart());
    await wait(400);

    // ~24 s of real play: strafe and sweep the view so the AI has to advance,
    // halt, aim, burst and reposition. Sampled at 200 ms.
    for (let i = 0; i < 120; i++) {
      if (i % 15 === 0) {
        await page.evaluate((n) => {
          window.__FPS__.key('left', n % 2 === 0);
          window.__FPS__.key('right', n % 2 === 1);
        }, i / 15);
      }
      await page.evaluate(() => window.__FPS__.look(7, 0));
      await wait(200);
      const snap = await state();
      engineViolations = Math.max(engineViolations, snap.aiViolations);
      if (snap.player.health < 100) tookDamage = true;
      for (const e of snap.enemies) {
        seenStates.add(e.state);
        if (STATIONARY.has(e.state) && e.speed > 0.05) {
          sampleViolations++;
          worstSample = Math.max(worstSample, e.speed);
        }
      }
      if (!combatShot && snap.enemies.some((e) => e.state === 'fire' || e.state === 'aim')) {
        combatShot = await shot('02_combat.png');
      }
      if (snap.phase !== 'playing') {
        // Dying (or winning) mid-window is fine — note it and redeploy so the
        // doctrine sampling keeps going.
        died ||= snap.phase === 'lost';
        await page.evaluate(() => window.__FPS__.restart());
        await wait(300);
      }
    }
    await page.evaluate(() => {
      window.__FPS__.key('left', false);
      window.__FPS__.key('right', false);
    });
    const combat = await state();
    engineViolations = Math.max(engineViolations, combat.aiViolations);

    check(
      'enemies actually engage (aim + fire states reached)',
      seenStates.has('aim') && seenStates.has('fire'),
      `states seen: ${[...seenStates].sort().join(', ')}`,
    );
    check(
      'enemies actually navigate (advance/reposition reached)',
      [...seenStates].some((st) => MOVING.has(st)),
      `states seen: ${[...seenStates].sort().join(', ')}`,
    );
    check(
      'in-engine audit: zero frames with a planted state at speed',
      engineViolations === 0,
      `violations=${engineViolations} worst=${combat.aiWorstSpeedWhileFiring.toFixed(4)} m/s`,
    );
    check(
      'sampled audit: zero halt/aim/fire samples above 0.05 m/s',
      sampleViolations === 0,
      `samples over threshold=${sampleViolations} worst=${worstSample.toFixed(4)} m/s`,
    );
    check('enemies damage the player', tookDamage, died ? 'player was killed at least once' : 'health dropped');
    if (!combatShot) combatShot = await shot('02_combat.png');

    // ---- rigged enemy, close, mid-animation -------------------------------
    // The M2 deliverable is a soldier that ANIMATES, and a 25 m combat frame
    // cannot show that. This closes to ~4 m on a hostile that is actually in a
    // planted combat state, so the frame shows the aim pose, the lit visor
    // telegraph and the model's own material and silhouette at a distance where
    // all three can be judged.
    // Fresh mission + invulnerable: the doctrine block above deliberately leaves
    // the player near death, and the HUD's damage vignette floods the frame
    // crimson below 60% health — which would make this shot a picture of the
    // vignette rather than of the soldier.
    await page.evaluate(() => window.__FPS__.restart());
    await wait(400);
    await page.evaluate(() => window.__FPS__.invulnerable(true));
    let closeupTaken = false;
    let closeupShot = null;
    for (let attempt = 0; attempt < 60 && !closeupTaken; attempt++) {
      const snap = await state();
      // Hold out for a soldier in a PLANTED combat state: that is the pose the
      // milestone is about (weapon up, visor telegraph lit, facing the player).
      // Only settle for any live hostile once the budget is nearly spent.
      const subject =
        snap.enemies.find((e) => e.alive && (e.state === 'aim' || e.state === 'fire')) ??
        (attempt > 45 ? snap.enemies.find((e) => e.alive) : null);
      if (!subject) {
        // Park near a hostile so somebody engages, then keep looking.
        if (attempt % 12 === 0) {
          await page.evaluate(() => {
            const st = window.__FPS__.state();
            const e = st.enemies.find((x) => x.alive && x.y < 0.5);
            if (e) window.__FPS__.teleport(e.x + 7, e.z + 7);
          });
        }
        await wait(200);
        continue;
      }
      await page.evaluate((id) => {
        const st = window.__FPS__.state();
        const e = st.enemies.find((x) => x.id === id);
        if (!e) return;
        // Stand off along the soldier's own facing so the frame sees its FRONT —
        // the visor telegraph and the weapon pose are both front-facing cues.
        const fx = -Math.sin(e.yaw);
        const fz = -Math.cos(e.yaw);
        window.__FPS__.teleport(e.x + fx * 4.2, e.z + fz * 4.2);
      }, subject.id);
      await wait(120);
      const after = await state();
      const e = after.enemies.find((x) => x.id === subject.id);
      if (!e) continue;
      const dx = e.x - after.player.x;
      const dz = e.z - after.player.z;
      const horiz = Math.hypot(dx, dz);
      if (horiz > 8) continue;
      await page.evaluate(
        ([yaw, pitch]) => window.__FPS__.aim(yaw, pitch),
        [
          Math.atan2(-dx, -dz),
          Math.atan2(e.y + 1.05 - (after.player.y + after.player.eyeHeight), horiz),
        ],
      );
      await wait(220);
      closeupShot = await shot('07_enemy_closeup.png');
      closeupTaken = true;
    }
    check('rigged enemy close-up captured', closeupTaken, 'shots/07_enemy_closeup.png');
    await page.evaluate(() => window.__FPS__.invulnerable(false));

    // ---- third-person inspect --------------------------------------------
    console.log('\n== INSPECT (T) ==');
    // From here on the harness is composing frames, not fighting: make the
    // player invulnerable so a live firefight cannot end the mission mid-capture.
    await page.evaluate(() => {
      window.__FPS__.restart();
      window.__FPS__.invulnerable(true);
    });
    await wait(500);
    // Stand in the open so the inspect shot frames the body, not a wall.
    await page.evaluate(() => window.__FPS__.teleport(-4.5, 11.5));
    await wait(250);
    await page.evaluate(() => window.__FPS__.inspect(true));
    await wait(1400);
    const inspecting = await state();
    check('T enters third-person inspect', inspecting.inspect === true);
    const inspectShot = await shot('04_thirdperson.png');
    await page.evaluate(() => window.__FPS__.inspect(false));
    await wait(300);
    check('T returns to first person', (await state()).inspect === false);

    // ---- arena overview + terrace ----------------------------------------
    console.log('\n== ARENA ==');
    await page.evaluate(() => window.__FPS__.overview(true));
    await wait(500);
    const topShot = await shot('05_arena_topdown.png');
    await page.evaluate(() => window.__FPS__.overview(false));
    // Stand on the upper deck to show the second elevation + stairs.
    await page.evaluate(() => {
      // On the NW deck, looking south across the compound: shows the second
      // elevation, the railing, the staircase and the cover field in one frame.
      window.__FPS__.teleport(-12, -13.5);
      window.__FPS__.aim(Math.PI * 0.86, -0.2);
    });
    await wait(700);
    const terraceState = await state();
    check(
      'upper terrace is standable at 3 m',
      terraceState.player.y > 2.5,
      `y=${terraceState.player.y.toFixed(2)}`,
    );
    const terraceShot = await shot('06_terrace_elevation.png');

    // ---- win / restart ----------------------------------------------------
    console.log('\n== LOOP ==');
    await page.evaluate(() => window.__FPS__.killAll());
    await wait(600);
    const won = await state();
    check('clearing all hostiles wins', won.phase === 'won', won.phase);
    check(
      'end screen is shown with stats',
      await page.evaluate(() => !document.getElementById('screen-end').classList.contains('hidden')),
    );
    await page.evaluate(() => window.__FPS__.restart());
    await wait(500);
    const restarted = await state();
    check(
      'restart resets the mission',
      restarted.phase === 'playing' &&
        restarted.hostilesAlive === 6 &&
        restarted.player.health === 100 &&
        restarted.weapon.mag === 30,
      `${restarted.phase} hostiles=${restarted.hostilesAlive} hp=${restarted.player.health}`,
    );

    // ---- M3: both render paths, and what they cost ------------------------
    //
    // The settings screen can turn post-processing off, which means the game has
    // TWO render paths and a suite that only ever exercises one of them is
    // testing half the build. Both must produce a readable frame, and the
    // difference between them must be a look change rather than a different
    // exposure — the tone map lives in two places now (three's, and the
    // composer's final pass), and the whole reason the ACES code is copied
    // verbatim is so those two agree.
    console.log('\n== RENDER PATHS + FRAME COST ==');
    await page.evaluate(() => {
      window.__FPS__.restart();
      window.__FPS__.invulnerable(true);
      window.__FPS__.postfx(true);
    });
    await wait(700);
    const lumOn = await page.evaluate(() => window.__FPS__.frameStats());
    await page.evaluate(() => window.__FPS__.resetFrameCost());
    await wait(2400);
    const costOn = await page.evaluate(() => window.__FPS__.frameCost());

    await page.evaluate(() => window.__FPS__.postfx(false));
    await wait(700);
    const lumOff = await page.evaluate(() => window.__FPS__.frameStats());
    await page.evaluate(() => window.__FPS__.resetFrameCost());
    await wait(2400);
    const costOff = await page.evaluate(() => window.__FPS__.frameCost());
    await page.evaluate(() => window.__FPS__.postfx(true));
    await wait(400);

    check(
      'postfx ON renders a readable frame',
      lumOn.mean > 0.06 && lumOn.mean < 0.62 && lumOn.bright < 0.12 && lumOn.dark < 0.2,
      `mean ${lumOn.mean.toFixed(3)}, ${(lumOn.bright * 100).toFixed(1)}% white, ${(lumOn.dark * 100).toFixed(1)}% black`,
    );
    check(
      'postfx OFF renders a readable frame',
      lumOff.mean > 0.06 && lumOff.mean < 0.62 && lumOff.bright < 0.12 && lumOff.dark < 0.2,
      `mean ${lumOff.mean.toFixed(3)}, ${(lumOff.bright * 100).toFixed(1)}% white, ${(lumOff.dark * 100).toFixed(1)}% black`,
    );
    check(
      'the two render paths agree on exposure (postfx is a look, not a relight)',
      Math.abs(lumOn.mean - lumOff.mean) < 0.09,
      `on ${lumOn.mean.toFixed(3)} vs off ${lumOff.mean.toFixed(3)} — Δ${Math.abs(lumOn.mean - lumOff.mean).toFixed(3)}`,
    );
    // A FLOOR, not a target. The measured cost on the development machine (Apple
    // M4, ANGLE/Metal) is 16.67 ms with post-processing on — vsync-capped, i.e.
    // a locked 60 — and that number is recorded in DECISIONS §29. Asserting 60
    // here would make the suite a benchmark of whatever machine runs it, which
    // is how a useful gate turns into a flaky one; 33 ms catches a real
    // regression (a stage rebuilt every frame, a shader falling back to
    // software) without failing on a slower box.
    check(
      'post-processing holds a playable frame rate',
      costOn.meanMs < 33,
      `postfx ON ${costOn.meanMs.toFixed(2)} ms (${costOn.fps.toFixed(1)} fps) vs OFF ` +
        `${costOff.meanMs.toFixed(2)} ms (${costOff.fps.toFixed(1)} fps)`,
    );

    // ---- M3: a COLD boot on the no-post-processing path -------------------
    //
    // Toggling post-processing off mid-session proves the direct render path
    // draws. It does NOT prove the game comes up on it, because by then the
    // composer has already been constructed and its render targets allocated.
    // The low-end entry point is `?postfx=0`, and it deserves its own page load.
    console.log('\n== COLD BOOT, POST-PROCESSING OFF ==');
    const coldErrors = [];
    const cold = await browser.newPage();
    cold.on('pageerror', (e) => coldErrors.push(String(e)));
    cold.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') coldErrors.push(`${m.type()}: ${m.text()}`);
    });
    await cold.setViewport(VIEWPORT);
    await cold.goto(`${base}?postfx=0`, { waitUntil: 'load', timeout: 30000 });
    await cold.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
    await cold.evaluate(() => {
      window.__FPS__.start();
      window.__FPS__.invulnerable(true);
    });
    await wait(900);
    const coldState = await cold.evaluate(() => window.__FPS__.state());
    const coldLum = await cold.evaluate(() => window.__FPS__.frameStats());
    check(
      'boots with ?postfx=0 into the direct render path',
      coldState.phase === 'playing' && coldState.postfx.enabled === false,
      `phase=${coldState.phase} postfx.enabled=${coldState.postfx.enabled}`,
    );
    check(
      'cold no-postfx boot renders a readable frame',
      coldLum.mean > 0.06 && coldLum.mean < 0.62 && coldLum.dark < 0.2,
      `mean ${coldLum.mean.toFixed(3)}, ${(coldLum.dark * 100).toFixed(1)}% black`,
    );
    check('cold no-postfx boot is clean', coldErrors.length === 0, coldErrors.slice(0, 2).join(' | '));
    await cold.close();

    // =======================================================================
    // M4 — CO-OP, TWO REAL CLIENTS AGAINST THE REAL SERVER
    // =======================================================================
    //
    // Nothing here mocks a socket, stubs a snapshot or reaches into the room.
    // The suite starts `server/index.ts` as a child process on a port the OS
    // says is free, boots two production builds in two headless browsers, and
    // has them host and join a room by code. Every assertion below reads what a
    // client can actually see — the DRAWN avatar transform, the local enemy
    // roster, the rendered kill feed — so a protocol change, a broken tick loop
    // or a regressed interpolator fails here rather than in someone's session.
    //
    // The M3 single-player assertions above ran with the server ABSENT and are
    // untouched: `src/net/` stays removable, and this block is the proof that
    // the co-op path works, not a licence for the offline game to depend on it.
    console.log('\n== M4: CO-OP (two clients, one room) ==');
    const nfPort = await freePort();
    const wsUrl = `ws://127.0.0.1:${nfPort}`;
    const coop = startCoopServer(nfPort);
    let clientA = null;
    let clientB = null;
    try {
      const health = await waitForHealth(nfPort);
      check(
        'co-op server comes up and answers /health',
        !!health && health.ok === true,
        health ? `${health.snapshotHz} Hz snapshots` : coop.log.join(' ').slice(0, 200),
      );

      if (health) {
        clientA = await launchCoopClient(executablePath, 0);
        clientB = await launchCoopClient(executablePath, 1);

        const coopErrors = [];
        const bootCoop = async (browserN, label) => {
          const pg = (await browserN.pages())[0] ?? (await browserN.newPage());
          pg.on('pageerror', (e) => coopErrors.push(`${label}: ${e}`));
          pg.on('console', (m) => {
            if (m.type() === 'error') coopErrors.push(`${label} console: ${m.text()}`);
          });
          await pg.setViewport({ width: 1024, height: 640, deviceScaleFactor: 1 });
          await pg.goto(base, { waitUntil: 'load', timeout: 30000 });
          await pg.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
          await pg.evaluate(() => {
            window.__FPS__.audioMuted(true);
            window.__FPS__.start();
            window.__FPS__.invulnerable(true);
          });
          return pg;
        };
        const pageA = await bootCoop(clientA, 'client A');
        const pageB = await bootCoop(clientB, 'client B');

        // Join, and WAIT ON THE SERVER'S ANSWER rather than on a timer.
        const join = async (pg, room, name) => {
          await pg.evaluate(
            ({ r, n, u }) => window.__FPS__.coopJoin(r, n, u),
            { r: room, n: name, u: wsUrl },
          );
          await pg.waitForFunction(
            () => ['connected', 'error'].includes(window.__FPS__.coop().status),
            { timeout: 15000, polling: 100 },
          );
          return pg.evaluate(() => window.__FPS__.coop());
        };
        const coopOf = (pg) => pg.evaluate(() => window.__FPS__.coop());
        const stateOf = (pg) => pg.evaluate(() => window.__FPS__.state());
        const remotesOf = (pg) => pg.evaluate(() => window.__FPS__.remotes());
        const feedOf = (pg) => pg.evaluate(() => window.__FPS__.killFeed());
        // Point the player down the longest bearing the COLLISION WORLD allows
        // and confirm it, rather than assuming "hold W" is a straight line from
        // a spawn tile that happens to face a wall.
        const faceOpenGround = (pg) =>
          pg.evaluate(() => {
            const st = window.__FPS__.state();
            let bestYaw = st.player.yaw;
            let bestClear = -1;
            for (let k = 0; k < 16; k++) {
              const yaw = (k / 16) * Math.PI * 2;
              window.__FPS__.teleport(
                st.player.x - Math.sin(yaw) * 7,
                st.player.z - Math.cos(yaw) * 7,
              );
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
        const walk = async (pg, ms) => {
          await pg.evaluate(() => window.__FPS__.key('forward', true));
          await wait(ms);
          await pg.evaluate(() => window.__FPS__.key('forward', false));
        };

        const a = await join(pageA, null, 'ALPHA');
        check(
          'host creates a room and gets a readable four-character code',
          a.status === 'connected' && /^[ABCDEFGHJKLMNPQRTUVWXYZ234789]{4}$/.test(a.room ?? ''),
          `${a.status} room=${a.room} ${a.error ?? ''}`,
        );
        const b = await join(pageB, a.room, 'BRAVO');
        check(
          'second client joins that room by code',
          b.status === 'connected' && b.room === a.room,
          `${b.status} room=${b.room} ${b.error ?? ''}`,
        );
        await wait(1300);
        const seenA = await coopOf(pageA);
        const seenB = await coopOf(pageB);
        check(
          'both clients see two soldiers in the compound',
          seenA.players === 2 && seenB.players === 2 &&
            seenA.remotes === 1 && seenB.remotes === 1,
          `A: ${seenA.players} players / ${seenA.remotes} avatars, ` +
            `B: ${seenB.players} players / ${seenB.remotes} avatars`,
        );

        // ---- (a) mutual movement visibility, and (e) interpolation --------
        //
        // One straight run does both: B watches A's avatar every frame while A
        // covers ~6 m, which is simultaneously "did the movement arrive" and
        // "how did it arrive".
        await faceOpenGround(pageA);
        await wait(500);
        const aBefore = (await remotesOf(pageB))[0];
        const aSelfBefore = (await stateOf(pageA)).player;
        const sampling = pageB.evaluate(
          (dur) =>
            new Promise((resolve) => {
              const out = [];
              const t0 = performance.now();
              const step = () => {
                const now = performance.now();
                // The DRAWN transform, not the newest packet: the assertion is
                // about what the eye sees, and reading the wire back would only
                // prove the packets arrived at 15 Hz, which was never in doubt.
                const r = window.__FPS__.remotes()[0];
                if (r) out.push({ t: now - t0, x: r.x, z: r.z });
                if (now - t0 < dur) requestAnimationFrame(step);
                else resolve(out);
              };
              requestAnimationFrame(step);
            }),
          1600,
        );
        await walk(pageA, 1500);
        const samples = await sampling;
        await wait(400);
        const aAfter = (await remotesOf(pageB))[0];
        const aSelfAfter = (await stateOf(pageA)).player;
        const aSelfMoved = Math.hypot(
          aSelfAfter.x - aSelfBefore.x,
          aSelfAfter.z - aSelfBefore.z,
        );
        const aSeenMoved = aBefore && aAfter
          ? Math.hypot(aAfter.x - aBefore.x, aAfter.z - aBefore.z)
          : 0;
        check(
          'A moves and B sees A\'s avatar move',
          aSelfMoved > 1 && aSeenMoved > 1,
          `A covered ${aSelfMoved.toFixed(2)} m, B saw ${aSeenMoved.toFixed(2)} m`,
        );
        check(
          'B\'s copy of A ends up where A actually is',
          aSelfMoved > 1 && Math.abs(aSeenMoved - aSelfMoved) < 1.2,
          `Δ${Math.abs(aSeenMoved - aSelfMoved).toFixed(2)} m`,
        );

        const ms = motionStats(samples);
        // 15 Hz snapshots against ~60 fps: a client that stepped rather than
        // interpolated would freeze for three frames in four (0.75) and jump
        // ~4x the mean on the fourth. Measured on the development machine:
        // ratio 2.23-2.53, frozen 12.5-15.6% across four runs. The bounds sit
        // between the two, so they cannot pass a stepping client and do not
        // fail a healthy one.
        check(
          'remote avatar interpolates instead of stepping between snapshots',
          !!ms && ms.ratio < 3.4,
          ms
            ? `worst frame ${ms.ratio.toFixed(2)}x the mean over ${ms.frames} frames ` +
              `(a stepping client reads ~4x)`
            : 'not enough samples',
        );
        check(
          'remote avatar is never frozen waiting for the next snapshot',
          !!ms && ms.frozen < 0.4,
          ms
            ? `${(ms.frozen * 100).toFixed(1)}% of frames stationary during a ` +
              `${ms.total.toFixed(2)} m run (a stepping client reads ~75%)`
            : 'not enough samples',
        );

        // The reverse direction is not symmetry theatre: the host and the
        // joiner take different paths through `joinCoop`, and only one of them
        // allocated the room.
        await faceOpenGround(pageB);
        await wait(500);
        const bBefore = (await remotesOf(pageA))[0];
        const bSelfBefore = (await stateOf(pageB)).player;
        await walk(pageB, 1500);
        await wait(400);
        const bAfter = (await remotesOf(pageA))[0];
        const bSelfAfter = (await stateOf(pageB)).player;
        const bSelfMoved = Math.hypot(
          bSelfAfter.x - bSelfBefore.x,
          bSelfAfter.z - bSelfBefore.z,
        );
        const bSeenMoved = bBefore && bAfter
          ? Math.hypot(bAfter.x - bBefore.x, bAfter.z - bBefore.z)
          : 0;
        check(
          'B moves and A sees B\'s avatar move',
          bSelfMoved > 1 && bSeenMoved > 1,
          `B covered ${bSelfMoved.toFixed(2)} m, A saw ${bSeenMoved.toFixed(2)} m`,
        );

        // ---- (b) shared enemy state + (c) the cross-client kill feed -------
        //
        // A fires real rounds. The SERVER decides what they hit, against its own
        // authoritative enemy positions — `killAll()` would be useless here,
        // because a locally-killed enemy is resurrected by the next snapshot.
        const closeIn = (pg, idx) =>
          pg.evaluate((i) => {
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
        const aimAndFire = (pg, idx) =>
          pg.evaluate(async (i) => {
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
        for (let idx = 0; idx < 6 && killedIdx < 0; idx++) {
          for (let n = 0; n < 10; n++) {
            const st = await stateOf(pageA);
            if (st.phase !== 'playing') break;
            if (!st.enemies[idx] || !st.enemies[idx].alive) break;
            await closeIn(pageA, idx);
            await wait(90);
            await aimAndFire(pageA, idx);
            rounds++;
            await wait(140);
          }
          const st = await stateOf(pageA);
          if (st.enemies[idx] && !st.enemies[idx].alive) killedIdx = idx;
        }
        await wait(800);
        const killA = await stateOf(pageA);
        const killB = await stateOf(pageB);
        check(
          'a client\'s round is validated by the server and kills a hostile',
          killedIdx >= 0,
          `${rounds} rounds fired, hostile index ${killedIdx}`,
        );
        // THE ONE THAT MATTERS: the same soldier is on the ground for the
        // player who never fired at it. Compared by ROSTER INDEX rather than by
        // id, because ids come from a module counter each process runs
        // independently — matching on them would be testing the counter.
        check(
          'a hostile killed by A is dead for B as well',
          killedIdx >= 0 && !!killB.enemies[killedIdx] && killB.enemies[killedIdx].alive === false,
          killedIdx >= 0
            ? `B's hostile ${killedIdx} alive=${killB.enemies[killedIdx]?.alive}`
            : 'nothing was killed',
        );
        check(
          'both clients agree on how many hostiles are left',
          killA.hostilesAlive === killB.hostilesAlive && killA.hostilesAlive < 6,
          `A ${killA.hostilesAlive}, B ${killB.hostilesAlive}`,
        );
        const feedA = await feedOf(pageA);
        const feedB = await feedOf(pageB);
        check(
          'A\'s kill reaches B\'s feed, attributed to A',
          feedB.some((r) => r.includes('ALPHA') && r.includes('HOSTILE')),
          JSON.stringify(feedB),
        );
        // The other half of the same bug: the feed was written for one player
        // and hard coded the actor as YOU, so before this every client rendered
        // every teammate's kill as its own.
        check(
          'the shooter\'s own feed still says YOU, not its callsign',
          feedA.some((r) => r.includes('YOU')) && !feedA.some((r) => r.includes('ALPHA')),
          JSON.stringify(feedA),
        );

        // ---- (d) disconnect despawn ---------------------------------------
        const beforeLeave = await coopOf(pageB);
        await pageA.evaluate(() => window.__FPS__.coopLeave());
        await wait(1800);
        const afterLeave = await coopOf(pageB);
        const ghosts = await remotesOf(pageB);
        check(
          'A leaves and A\'s avatar despawns for B',
          beforeLeave.remotes === 1 && afterLeave.remotes === 0 && ghosts.length === 0,
          `B's teammate count ${beforeLeave.remotes} → ${afterLeave.remotes}`,
        );
        check(
          'B is still connected and playing after A left',
          afterLeave.status === 'connected' && (await stateOf(pageB)).phase === 'playing',
          afterLeave.status,
        );
        check(
          'neither co-op client logged an uncaught exception',
          coopErrors.length === 0,
          coopErrors.slice(0, 3).join(' | '),
        );
      }
    } finally {
      if (clientA) await clientA.close();
      if (clientB) await clientB.close();
      coop.child.kill('SIGTERM');
    }

    // ---- console hygiene --------------------------------------------------
    console.log('\n== HYGIENE ==');
    check('no uncaught page exceptions during play', pageErrors.length === 0, pageErrors.join(' | '));
    check(
      'no console errors/warnings',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );

    console.log('\nScreenshots:');
    for (const f of [spawnShot, combatShot, adsShot, inspectShot, topShot, terraceShot, closeupShot]) {
      if (!f) continue;
      console.log(`  ${f}`);
    }
  } finally {
    if (!process.argv.includes('--keep')) await browser.close();
    server.close();
  }

  console.log(
    `\n${results.length - failed}/${results.length} assertions passed.` +
      (failed ? `  ${failed} FAILED.` : '  ALL GREEN.'),
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
