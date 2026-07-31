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
