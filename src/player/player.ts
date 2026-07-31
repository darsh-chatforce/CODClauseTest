import * as THREE from 'three';
import { LOOK, PLAYER } from '../config';
import { clamp, damp } from '../core/mathx';
import type { Input } from '../input/input';
import type { CollisionWorld } from '../world/collision';

/**
 * First-person character controller.
 *
 * Design notes (the difference between "it moves" and "it feels good"):
 *  - Acceleration/deceleration are *rates*, applied against a target velocity —
 *    not a lerp factor — so behaviour is identical at 60 and 144 Hz.
 *  - Deceleration (48 m/s²) is deliberately close to acceleration (62 m/s²):
 *    ~0.15 s from full sprint to a dead stop. That is the "snappy stop".
 *  - Air control is a *fraction* of ground authority, so a jump commits you to
 *    a trajectory but does not make you a helpless projectile.
 *  - Coyote time (110 ms) and jump buffering (130 ms) are invisible and are the
 *    reason jumping off a stair edge never eats an input.
 *  - Recoil is NOT stored here. The weapon owns a separate additive view offset
 *    and folds a retained fraction back into `pitch`, so the player's own aim
 *    and the gun's kick never fight over one variable.
 */

export interface PlayerDamageEvent {
  amount: number;
  /** World position the damage came from (for the directional indicator). */
  from: THREE.Vector3;
}

export class Player {
  /** Feet position. The camera sits `eyeHeight` above this. */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  grounded = true;
  crouching = false;
  sprinting = false;
  ads = false;
  dead = false;

  health: number = PLAYER.maxHealth;

  /** Current interpolated stance height (collision + eye). */
  private stance = 1; // 1 = standing, 0 = crouched
  private coyoteMs = 0;
  private jumpBufferMs = 0;
  private lastGroundedY = 0;

  /** Set for one frame after a landing, carrying the impact speed. */
  landedImpact = 0;
  /** Set for one frame when a jump actually launched. */
  jumped = false;

  onDamage: ((e: PlayerDamageEvent) => void) | null = null;
  onDeath: (() => void) | null = null;

  constructor(private readonly collision: CollisionWorld) {}

  reset(spawn: THREE.Vector3, yaw: number): void {
    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = PLAYER.maxHealth;
    this.dead = false;
    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;
    this.ads = false;
    this.stance = 1;
    this.coyoteMs = 0;
    this.jumpBufferMs = 0;
    this.landedImpact = 0;
    this.jumped = false;
  }

  get height(): number {
    return PLAYER.heightCrouched + (PLAYER.height - PLAYER.heightCrouched) * this.stance;
  }

  get eyeHeight(): number {
    return PLAYER.eyeHeightCrouched + (PLAYER.eyeHeight - PLAYER.eyeHeightCrouched) * this.stance;
  }

  get eyePosition(): THREE.Vector3 {
    return _eye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Horizontal speed, m/s. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Forward unit vector on the XZ plane. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  // ------------------------------------------------------------------ look

  applyLook(dx: number, dy: number): void {
    const sens = LOOK.sensitivity * (this.ads ? LOOK.adsSensitivityScale : 1);
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch - dy * sens, LOOK.pitchMin, LOOK.pitchMax);
  }

  // ---------------------------------------------------------------- update

  update(dt: number, input: Input, canAct: boolean): void {
    this.landedImpact = 0;
    this.jumped = false;
    if (this.dead) {
      this.integrateDead(dt);
      return;
    }

    // ---- stance -----------------------------------------------------------
    const wantsCrouch = canAct && input.isDown('crouch');
    if (!wantsCrouch && this.crouching) {
      // Only stand if there is headroom.
      const standHead = this.position.y + PLAYER.height;
      const blocked = !this.collision.isClear(
        this.position.x,
        this.position.z,
        PLAYER.radius * 0.95,
        this.position.y + PLAYER.heightCrouched,
        standHead - (this.position.y + PLAYER.heightCrouched),
      );
      this.crouching = blocked;
    } else {
      this.crouching = wantsCrouch;
    }
    const stanceTarget = this.crouching ? 0 : 1;
    const stanceStep = (PLAYER.crouchLerpSpeed / (PLAYER.height - PLAYER.heightCrouched)) * dt;
    this.stance = this.stance < stanceTarget
      ? Math.min(stanceTarget, this.stance + stanceStep)
      : Math.max(stanceTarget, this.stance - stanceStep);

    // ---- wish direction ---------------------------------------------------
    let ix = 0;
    let iz = 0;
    if (canAct) {
      if (input.isDown('forward')) iz -= 1;
      if (input.isDown('back')) iz += 1;
      if (input.isDown('left')) ix -= 1;
      if (input.isDown('right')) ix += 1;
    }
    const inputMag = Math.hypot(ix, iz);
    if (inputMag > 1) {
      ix /= inputMag;
      iz /= inputMag;
    }

    // Sprint requires committing forward, and is mutually exclusive with ADS.
    this.sprinting =
      canAct &&
      input.isDown('sprint') &&
      iz < -0.3 &&
      !this.crouching &&
      !this.ads &&
      inputMag > 0.1;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Camera-space (ix = right, iz = BACK) -> world.
    //
    // The basis is stated explicitly rather than inlined as four sign-juggled
    // terms, because it was wrong: the original expression negated the iz terms
    // and W drove the player BACKWARDS along their own look vector. Strafing was
    // correct, which is why it survived — a half-inverted controller feels like
    // bad mouse settings rather than like a bug.
    //
    //   forward = (-sin yaw, 0, -cos yaw)        (the project-wide convention,
    //                                             see `forward()` above)
    //   right   = cross(forward, up)
    //           = ( cos yaw, 0, -sin yaw)
    //
    // W means iz = -1, i.e. a forward amount of -iz.
    const fwdAmount = -iz;
    const wishX = ix * cos + fwdAmount * -sin;
    const wishZ = ix * -sin + fwdAmount * -cos;

    const targetSpeed = this.crouching
      ? PLAYER.crouchSpeed
      : this.sprinting
        ? PLAYER.sprintSpeed
        : this.ads
          ? PLAYER.adsSpeed
          : PLAYER.walkSpeed;

    // ---- horizontal acceleration -----------------------------------------
    const wishing = inputMag > 0.01;
    const accel = this.grounded ? PLAYER.groundAccel : PLAYER.groundAccel * PLAYER.airControl;
    const decel = this.grounded ? PLAYER.groundDecel : PLAYER.airAccel;

    const targetVX = wishX * targetSpeed;
    const targetVZ = wishZ * targetSpeed;
    const rate = wishing ? accel : decel;

    this.velocity.x = moveToward(this.velocity.x, wishing ? targetVX : 0, rate * dt);
    this.velocity.z = moveToward(this.velocity.z, wishing ? targetVZ : 0, rate * dt);

    // Clamp horizontal speed so diagonal input cannot exceed the intended max.
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const cap = Math.max(targetSpeed, this.grounded ? targetSpeed : hSpeed);
    if (hSpeed > cap && hSpeed > 1e-5) {
      this.velocity.x *= cap / hSpeed;
      this.velocity.z *= cap / hSpeed;
    }

    // ---- jump -------------------------------------------------------------
    if (canAct && input.wasPressed('jump')) this.jumpBufferMs = PLAYER.jumpBufferMs;
    this.jumpBufferMs = Math.max(0, this.jumpBufferMs - dt * 1000);
    this.coyoteMs = this.grounded ? PLAYER.coyoteTimeMs : Math.max(0, this.coyoteMs - dt * 1000);

    if (this.jumpBufferMs > 0 && this.coyoteMs > 0) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.grounded = false;
      this.jumpBufferMs = 0;
      this.coyoteMs = 0;
      this.jumped = true;
    }

    // ---- integrate + collide ---------------------------------------------
    this.velocity.y -= PLAYER.gravity * dt;

    const feetBefore = this.position.y;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.collision.resolveHorizontal(
      this.position,
      PLAYER.radius,
      this.height,
      feetBefore,
      PLAYER.stepHeight,
    );

    this.position.y += this.velocity.y * dt;

    const ground = this.collision.groundHeight(
      this.position.x,
      this.position.z,
      PLAYER.radius,
      Math.max(this.position.y, feetBefore),
      this.velocity.y > 0 ? 0 : PLAYER.stepHeight,
    );

    if (ground > -Infinity && this.position.y <= ground + 1e-3) {
      if (!this.grounded) {
        this.landedImpact = Math.abs(this.velocity.y);
      }
      this.position.y = ground;
      this.velocity.y = 0;
      this.grounded = true;
      this.lastGroundedY = ground;
    } else {
      this.grounded = false;
    }

    // Safety net: never fall out of the world.
    if (this.position.y < -8) {
      this.position.y = this.lastGroundedY + 0.5;
      this.velocity.set(0, 0, 0);
    }
  }

  private integrateDead(dt: number): void {
    this.velocity.x = damp(this.velocity.x, 0, 0.15, dt);
    this.velocity.z = damp(this.velocity.z, 0, 0.15, dt);
    this.velocity.y -= PLAYER.gravity * dt;
    this.position.addScaledVector(this.velocity, dt);
    const ground = this.collision.groundHeight(
      this.position.x,
      this.position.z,
      PLAYER.radius,
      this.position.y,
      PLAYER.stepHeight,
    );
    if (ground > -Infinity && this.position.y < ground) {
      this.position.y = ground;
      this.velocity.y = 0;
    }
  }

  // ---------------------------------------------------------------- damage

  takeDamage(amount: number, from: THREE.Vector3): void {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    this.onDamage?.({ amount, from: from.clone() });
    if (this.health <= 0) {
      this.dead = true;
      this.onDeath?.();
    }
  }
}

const _eye = new THREE.Vector3();

function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
