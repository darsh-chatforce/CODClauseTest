#!/usr/bin/env node
// =============================================================================
// Operation Nightfall — fast visual/perf probe
// =============================================================================
//
// The full smoke suite is ~4 minutes because it PLAYS the game. That is correct
// for verification and useless for tuning a fog density, so this is the tight
// loop: boot the production build, compose a handful of named frames, and print
// the measurements a look pass actually needs (frame luminance, viewmodel
// coverage, ADS optic alignment, frame cost with post-processing on and off).
//
//   npm run build && node tools/look.mjs [name ...]
//
// It asserts nothing. `tools/smoke.mjs` is still the gate.
// =============================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'shots', 'look');
const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.CHROME_PATH,
].filter(Boolean).find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { server, port } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.argv.includes('--headful') ? false : 'new',
    // VSYNC OFF. Every configuration pins to exactly 16.67 ms with vsync on,
    // which proves "it holds 60" and tells you nothing about how much headroom
    // is left — and headroom is the whole question for an optional AO pass.
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
      '--disable-gpu-vsync', '--disable-frame-rate-limit',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
    defaultViewport: VIEWPORT,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
  });

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
    await page.evaluate(() => { window.__FPS__.start(); window.__FPS__.invulnerable(true); });
    await wait(900);

    const shot = async (name) => {
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      console.log(`  shots/look/${name}.png`);
    };

    // WHICH GPU IS THIS? Headless Chrome may fall back to SwiftShader, and a
    // frame-cost number measured on a software rasteriser is not a frame-cost
    // number. Always print what actually drew the frame.
    const gpu = await page.evaluate(() => {
      const gl = document.getElementById('game-canvas').getContext('webgl2');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    console.log(`renderer          ${gpu}`);

    const lum = await page.evaluate(() => window.__FPS__.frameStats());
    console.log(`frame luminance   mean ${lum.mean.toFixed(3)}  white ${(lum.bright * 100).toFixed(1)}%  black ${(lum.dark * 100).toFixed(1)}%`);

    const snap = await page.evaluate(() => window.__FPS__.state());
    console.log(`carbine           ${JSON.stringify(snap.carbine)}`);
    console.log(`postfx            ${JSON.stringify(snap.postfx)}`);
    console.log(`audio             ${JSON.stringify(snap.audio)}`);

    await shot('spawn');

    // Same viewpoint, post-processing off — otherwise the two luminance numbers
    // are measurements of two different pictures and cannot be compared.
    await page.evaluate(() => window.__FPS__.postfx(false));
    await wait(400);
    const lumOffSame = await page.evaluate(() => window.__FPS__.frameStats());
    console.log(`postfx OFF lum    mean ${lumOffSame.mean.toFixed(3)}  white ${(lumOffSame.bright * 100).toFixed(1)}%  black ${(lumOffSame.dark * 100).toFixed(1)}%   [same view]`);
    await shot('spawn-postfx-off');
    await page.evaluate(() => window.__FPS__.postfx(true));
    await wait(400);

    // ---- viewmodel + ADS ---------------------------------------------------
    const hip = await page.evaluate(() => window.__FPS__.coverage());
    await page.evaluate(() => window.__FPS__.key('ads', true));
    await wait(700);
    const ads = await page.evaluate(() => window.__FPS__.coverage());
    const optic = await page.evaluate(() => window.__FPS__.optic());
    console.log(`viewmodel         hip ${(hip * 100).toFixed(2)}%  ads ${(ads * 100).toFixed(2)}%  (budget 15%)`);
    console.log(`ADS optic (NDC)   x ${optic.x.toFixed(5)}  y ${optic.y.toFixed(5)}  ` +
      `→ ${(Math.abs(optic.x) * VIEWPORT.width / 2).toFixed(2)} px, ${(Math.abs(optic.y) * VIEWPORT.height / 2).toFixed(2)} px from centre`);
    await shot('ads');
    await page.evaluate(() => window.__FPS__.key('ads', false));
    await wait(400);

    // ---- enemy close-up ----------------------------------------------------
    await page.evaluate(() => {
      const st = window.__FPS__.state();
      const e = st.enemies.find((x) => x.alive && x.y < 0.5);
      if (e) window.__FPS__.teleport(e.x + 7, e.z + 7);
    });
    for (let i = 0; i < 50; i++) {
      const st = await page.evaluate(() => window.__FPS__.state());
      const s = st.enemies.find((e) => e.alive && (e.state === 'aim' || e.state === 'fire'));
      if (s) {
        await page.evaluate((id) => {
          const st2 = window.__FPS__.state();
          const e = st2.enemies.find((x) => x.id === id);
          if (!e) return;
          window.__FPS__.teleport(e.x - Math.sin(e.yaw) * 3.4, e.z - Math.cos(e.yaw) * 3.4);
        }, s.id);
        await wait(140);
        const st3 = await page.evaluate(() => window.__FPS__.state());
        const e = st3.enemies.find((x) => x.id === s.id);
        const dx = e.x - st3.player.x, dz = e.z - st3.player.z;
        const h = Math.hypot(dx, dz);
        await page.evaluate(([y, p]) => window.__FPS__.aim(y, p), [
          Math.atan2(-dx, -dz),
          Math.atan2(e.y + 1.35 - (st3.player.y + st3.player.eyeHeight), h),
        ]);
        await wait(220);
        await shot('enemy');
        break;
      }
      await wait(200);
    }

    // ---- frame cost: off / on / on+ao --------------------------------------
    const measure = async (label) => {
      await page.evaluate(() => window.__FPS__.resetFrameCost());
      await wait(2600);
      const c = await page.evaluate(() => window.__FPS__.frameCost());
      console.log(`frame cost ${label.padEnd(14)} mean ${c.meanMs.toFixed(2)} ms  p95 ${c.p95Ms.toFixed(2)} ms  ${c.fps.toFixed(1)} fps  (n=${c.samples})`);
      return c;
    };
    await measure('off');
    await page.evaluate(() => window.__FPS__.postfx(true));
    await measure('full');
    await page.evaluate(() => window.__FPS__.postfxParts({ smaa: false }));
    await measure('no SMAA');
    await page.evaluate(() => window.__FPS__.postfxParts({ bloom: false }));
    await measure('no bloom/SMAA');
    await page.evaluate(() => window.__FPS__.postfxParts({ bloom: true, smaa: true }));
    await page.evaluate(() => window.__FPS__.ao(true));
    await measure('full+AO');
    await shot('ao');
    await page.evaluate(() => window.__FPS__.ao(false));

    console.log(errors.length ? `\nCONSOLE:\n  ${errors.slice(0, 8).join('\n  ')}` : '\nconsole clean');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
