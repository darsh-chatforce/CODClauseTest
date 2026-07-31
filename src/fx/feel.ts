import * as THREE from 'three';
import { FEEL } from '../config';
import { clamp } from '../core/mathx';

/**
 * Game feel primitives: trauma-based shake, hitstop, additive FOV kick.
 *
 * Rules baked in here:
 *  - Shake is `trauma²` with a hard cap, so a rifle shot barely moves the frame
 *    and taking a burst snaps hard, and stacked events can never fling the view.
 *  - Hitstop scales the GAMEPLAY delta only. The render loop keeps drawing (a
 *    frozen frame you cannot see is not hitstop, it is a hitch), and camera,
 *    shake and HUD keep running on the real delta so feedback stays live.
 *  - Everything is time-constant based, so it behaves identically at any
 *    refresh rate.
 */

/** Deterministic value noise in [-1, 1]. */
function noise(t: number, seed: number): number {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export class ShakeRig {
  private trauma = 0;
  private time = 0;
  readonly offset = new THREE.Vector3();
  roll = 0;

  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  reset(): void {
    this.trauma = 0;
    this.offset.set(0, 0, 0);
    this.roll = 0;
  }

  /** Real delta, always — shake must not freeze during hitstop. */
  update(dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - FEEL.traumaDecay * dt);
    if (this.trauma <= 0) {
      this.offset.set(0, 0, 0);
      this.roll = 0;
      return;
    }
    const s = this.trauma * this.trauma;
    const f = this.time * 34;
    this.offset.set(
      FEEL.shakeMaxOffset * s * noise(f, 1),
      FEEL.shakeMaxOffset * s * noise(f, 2),
      FEEL.shakeMaxOffset * s * 0.4 * noise(f, 3),
    );
    this.roll = FEEL.shakeMaxRoll * s * noise(f, 4);
  }
}

export class Hitstop {
  private remaining = 0;
  scale = 1;

  trigger(durationMs: number, scale = FEEL.hitstopScale): void {
    this.remaining = Math.max(this.remaining, durationMs / 1000);
    this.scale = scale;
  }

  /** Advance with the REAL delta; returns the gameplay time scale. */
  update(dt: number): number {
    if (this.remaining > 0) {
      this.remaining -= dt;
      if (this.remaining <= 0) this.scale = 1;
    }
    return this.scale;
  }

  reset(): void {
    this.remaining = 0;
    this.scale = 1;
  }
}

/** Additive FOV offset in degrees, decaying exponentially toward zero. */
export class FovKick {
  private value = 0;

  punch(degrees: number): void {
    this.value = clamp(this.value + degrees, -12, 12);
  }

  update(dt: number): number {
    if (Math.abs(this.value) > 0.001) {
      this.value *= Math.exp(-dt / FEEL.fovKickTau);
      if (Math.abs(this.value) < 0.001) this.value = 0;
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}
