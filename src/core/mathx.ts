/** Small math helpers shared across systems. Frame-rate-independent by default. */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const DEG = Math.PI / 180;

/**
 * Exponential smoothing that is correct under a variable timestep.
 * `tau` is the time constant: after `tau` seconds ~63% of the gap is closed.
 * Using this instead of `lerp(a, b, 0.1)` is why the feel does not change
 * between a 60Hz and a 144Hz display.
 */
export const damp = (current: number, target: number, tau: number, dt: number): number => {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
};

/** Move `current` toward `target` by at most `maxDelta`. */
export const approach = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Rotate `current` toward `target` at `rate` rad/s. */
export const turnToward = (current: number, target: number, rate: number, dt: number): number =>
  current + clamp(angleDelta(current, target), -rate * dt, rate * dt);

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number): number => t * t * t;
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
