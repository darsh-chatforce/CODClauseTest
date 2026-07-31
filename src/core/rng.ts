/**
 * Deterministic RNG (mulberry32). Every gameplay/effect random draw goes through
 * here so scripted playtests and screenshot baselines are reproducible —
 * `Math.random` is banned in gameplay paths.
 */
export interface Rng {
  (): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform in [-a, a). */
  signed(a: number): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  reseed(seed: number): void;
}

export function createRng(seed = 0x5eed1e): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.range = (min, max) => min + next() * (max - min);
  rng.signed = (a) => (next() * 2 - 1) * a;
  rng.int = (maxExclusive) => Math.floor(next() * maxExclusive);
  rng.pick = (items) => items[Math.floor(next() * items.length)];
  rng.reseed = (newSeed: number) => {
    s = newSeed >>> 0;
  };
  return rng;
}

/** The one shared game RNG. `reseed()` from a test hook for reproducible runs. */
export const rng = createRng();
