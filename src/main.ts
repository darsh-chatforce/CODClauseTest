import './hud/hud.css';
import { Game } from './game';
import type { Action } from './input/input';

/**
 * Entry point + the automation surface.
 *
 * `window.__FPS__` is the seam that `tools/smoke.mjs` drives: it dispatches the
 * same input state the real handlers write (headless Chrome cannot enter pointer
 * lock, so look is injected rather than faked) and reads the same live state the
 * game runs on. Assertions therefore test the actual simulation, not a mock.
 */

const canvas = document.getElementById('game-canvas');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#game-canvas missing');

const game = new Game(canvas);

export interface TestApi {
  readonly ready: true;
  state(): unknown;
  start(): void;
  restart(): void;
  pause(): void;
  resume(): void;
  /** Hold or release a bound action (same state the keyboard writes). */
  key(action: Action, down: boolean): void;
  /** Press and release across one frame boundary. */
  tap(action: Action): void;
  /** Inject mouse-look in pixels. */
  look(dx: number, dy: number): void;
  /** Force N discrete shots, respecting the fire interval. */
  fire(count?: number): Promise<void>;
  /** Exact rasterised viewmodel screen coverage, 0..1. */
  coverage(): number;
  /** Luminance distribution of the next presented frame — the exposure gate. */
  frameStats(): Promise<{ mean: number; dark: number; bright: number; ok: boolean }>;
  enclosure(): { samples: number; leaks: Array<{ x: number; z: number; angle: number }> };
  teleport(x: number, z: number): void;
  /** Unobstructed line from the player's eye to a hostile's chest? */
  los(enemyId: number): boolean;
  aim(yaw: number, pitch: number): void;
  damagePlayer(n: number): void;
  killAll(): void;
  /** Top-down authoring camera (arena layout screenshots). */
  overview(on: boolean): void;
  /** Third-person inspect camera, set explicitly rather than toggled. */
  inspect(on: boolean): void;
  /** Debug: ignore incoming damage (screenshot composition, level walking). */
  invulnerable(on: boolean): void;

  // ---- M3 ----------------------------------------------------------------
  /** Post-processing on/off — the same path the settings toggle drives. */
  postfx(on: boolean): void;
  /** Ambient occlusion on/off. Built lazily; measure before shipping it on. */
  ao(on: boolean): void;
  /** Toggle individual postfx stages — used to attribute the frame cost. */
  postfxParts(parts: { bloom?: boolean; smaa?: boolean }): void;
  /** Bring the audio graph up without a user gesture, and report the result. */
  initAudio(): { ready: boolean; error: string | null };
  audioMuted(muted: boolean): void;
  /** Optic position in NDC — must be (0,0) in a settled ADS pose. */
  optic(): { x: number; y: number };
  /** Raycast down the sight line: is the optic's aperture actually open? */
  opticClear(): { clear: boolean; blockedBy: string | null; distance: number };
  /** Rolling frame-time statistics over the last 120 frames. */
  frameCost(): { meanMs: number; p95Ms: number; fps: number; samples: number };
  resetFrameCost(): void;
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const api: TestApi = {
  ready: true,
  state: () => game.snapshot(),
  start: () => game.startMission(),
  restart: () => game.startMission(),
  pause: () => game.pause(),
  resume: () => game.resume(),
  key: (action, down) => game.testInput().injectAction(action, down),
  tap: (action) => {
    const input = game.testInput();
    input.injectAction(action, true);
    requestAnimationFrame(() => requestAnimationFrame(() => input.injectAction(action, false)));
  },
  look: (dx, dy) => game.testInput().injectLook(dx, dy),
  fire: async (count = 1) => {
    for (let i = 0; i < count; i++) {
      game.forceFire();
      // Fire interval is 83 ms; give the cooldown time to clear between rounds.
      await nextFrame();
      await nextFrame();
      await nextFrame();
      await nextFrame();
      await nextFrame();
      await nextFrame();
    }
  },
  coverage: () => game.measureViewmodelCoverage(),
  frameStats: () => game.requestFrameStats(),
  enclosure: () => game.auditEnclosure(),
  teleport: (x, z) => game.teleport(x, z),
  los: (id) => game.hasLosTo(id),
  aim: (yaw, pitch) => game.setPlayerAim(yaw, pitch),
  damagePlayer: (n) => game.damagePlayer(n),
  killAll: () => game.killAllEnemies(),
  overview: (on) => game.setOverview(on),
  inspect: (on) => game.setInspect(on),
  invulnerable: (on) => game.setInvulnerable(on),
  postfx: (on) => game.setPostFx(on),
  ao: (on) => game.setAo(on),
  postfxParts: (parts) => game.setPostFxParts(parts),
  initAudio: () => game.initAudio(),
  audioMuted: (muted) => game.setAudioMuted(muted),
  optic: () => game.opticNdc(),
  opticClear: () => game.opticClear(),
  frameCost: () => game.frameCost(),
  resetFrameCost: () => game.resetFrameCost(),
};

declare global {
  interface Window {
    __FPS__: TestApi;
  }
}

/**
 * The automation surface is published ONLY after every asset has resolved.
 *
 * `tools/smoke.mjs` waits on `window.__FPS__.ready`, so making that wait also
 * mean "assets are in" removes an entire class of flake: a screenshot taken
 * before the textures arrive is indistinguishable from a build with no textures,
 * and a coverage measurement taken before the viewmodel's maps load is simply
 * wrong. Loading failures do NOT block publication — they are reported on the
 * snapshot and asserted there, because a build that hangs forever is worse than
 * one that reports what is missing.
 */
game
  .init()
  .then((report) => {
    if (report.failed.length) {
      console.error(
        `[boot] ${report.failed.length}/${report.requested} assets failed to load`,
      );
    }
    window.__FPS__ = api;
  })
  .catch((err) => {
    // Publish anyway: a harness that can read the failed state is worth more
    // than one that times out with no information.
    console.error('[boot] init failed', err);
    window.__FPS__ = api;
  });
