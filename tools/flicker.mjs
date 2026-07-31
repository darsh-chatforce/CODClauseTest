#!/usr/bin/env node
// =============================================================================
// Operation Nightfall — flicker probe
// =============================================================================
//
// "The background mountains flicker" is a report about MOTION, and a screenshot
// cannot show motion. So this parks the camera dead still on the berm, captures
// N frames, and measures how much the pixels change between consecutive frames.
//
// A static camera over a static scene should produce a near-zero inter-frame
// difference. Anything else is the flicker, and the size of the number says how
// bad it is. Running it with post-processing ON and OFF turns "it flickers" into
// "it flickers on exactly one of the two render paths", which is a diagnosis
// rather than a symptom.
//
//   npm run build && node tools/flicker.mjs
// =============================================================================

import { createServer } from 'node:http';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'shots', 'flicker');
const FRAMES = 10;
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };
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

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const { server, port } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
    defaultViewport: VIEWPORT,
  });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__FPS__?.ready === true, { timeout: 20000 });
    await page.evaluate(() => {
      window.__FPS__.start();
      window.__FPS__.invulnerable(true);
      // NOT killAll(): clearing the compound WINS the mission, and the end
      // screen is a large static DOM panel sitting right over the middle of the
      // frame. The first version of this probe did exactly that and measured the
      // stability of a menu, which is why it reported a reassuring 0.00%.
    });
    await wait(700);
    // Stand on the northern terrace and look OVER the wall at the berm, so the
    // frame is terrain and sky and essentially nothing else.
    await page.evaluate(() => {
      window.__FPS__.teleport(-12, -13.5);
      window.__FPS__.aim(Math.PI * 0.86, 0.14);
    });
    await wait(900);

    // A STATIC camera showed zero inter-frame difference on both paths, which
    // rules out temporal instability at rest and points at something that only
    // appears under MOTION — z-fighting, shadow acne and texture aliasing all
    // behave exactly that way. So the camera is swept in equal, tiny yaw steps
    // and the metric becomes the SECOND temporal difference: under a smooth pan
    // the image changes smoothly, so |I(t+1) - 2I(t) + I(t-1)| stays small.
    // Anything that flips between two states frame to frame spikes it.
    const YAW0 = Math.PI * 0.86;
    const STEP = 0.010; // rad per frame — a real look-around rate, not a crawl
    for (const mode of ['on', 'off']) {
      await page.evaluate((m) => window.__FPS__.postfx(m === 'on'), mode);
      await wait(600);
      for (let i = 0; i < FRAMES; i++) {
        await page.evaluate(([yaw]) => {
          window.__FPS__.teleport(-12, -13.5);
          window.__FPS__.aim(yaw, 0.14);
        }, [YAW0 + i * STEP]);
        await wait(110);
        await page.screenshot({ path: path.join(OUT, `${mode}_${String(i).padStart(2, '0')}.png`) });
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const script = `
import glob, numpy as np
from PIL import Image
for mode in ['on', 'off']:
    files = sorted(glob.glob('${OUT}/%s_*.png' % mode))
    ims = [np.asarray(Image.open(f).convert('RGB'), dtype=np.float32) for f in files]
    H = ims[0].shape[0]
    # The berm/sky band: the upper 45% of the frame, which at this pose is
    # horizon and terrain with no HUD in it.
    for name, band in [('TERRAIN', slice(int(H*0.10), int(H*0.46))),
                       ('compound (control)', slice(int(H*0.62), int(H*0.88)))]:
        d1 = [np.abs(ims[i+1][band] - ims[i][band]).mean() for i in range(len(ims)-1)]
        d2f = [ims[i+2][band] - 2*ims[i+1][band] + ims[i][band] for i in range(len(ims)-2)]
        d2 = [np.abs(x).mean() for x in d2f]
        # Speckle: pixels whose SECOND difference is large -- i.e. that flipped
        # rather than moved. Smooth panning cannot produce these.
        spk = [ (np.abs(x).max(axis=2) > 24).mean() for x in d2f ]
        print('postfx %-3s  %-18s  1st-diff %6.3f  2nd-diff %6.3f  speckle(>24/255) %5.2f%%'
              % (mode, name, float(np.mean(d1)), float(np.mean(d2)), 100*float(np.mean(spk))))
    k = int(np.argmax([np.abs(ims[i+2]-2*ims[i+1]+ims[i]).mean() for i in range(len(ims)-2)]))
    d = np.abs(ims[k+2] - 2*ims[k+1] + ims[k])
    Image.fromarray(np.clip(d*8, 0, 255).astype(np.uint8)).save('${OUT}/speckle_%s.png' % mode)
`;
  const r = spawnSync(PY, ['-c', script], { encoding: 'utf8' });
  console.log(r.stdout || r.stderr);
  console.log(`diff images: shots/flicker/diff_on.png, shots/flicker/diff_off.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
