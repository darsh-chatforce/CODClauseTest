import * as THREE from 'three';
import { ENEMY, LAYER } from '../config';
import { clamp, DEG, damp, turnToward } from '../core/mathx';
import { rng } from '../core/rng';
import type { HitTarget } from '../weapons/rifle';
import type { CollisionWorld } from '../world/collision';
import { rayCapsule } from '../world/collision';
import { RiggedSoldier } from '../player/soldier';
import { buildWorldCarbine } from '../weapons/carbine';
import { markBloom } from '../fx/postfx';
import type { Assets } from '../world/assets';
import type { NavGraph } from './navgraph';

/** Slightly shorter than the player's 0.86 m carbine so it sits convincingly in
 *  a 1.8 m soldier's hands at the rig's pistol-grip aim pose. */
const ENEMY_CARBINE_LENGTH = 0.78;

/**
 * Enemy soldier.
 *
 * DOCTRINE (explicit design constraint, and the thing the graybox is built to
 * prove): a soldier NEVER fires while moving. The cycle is
 *
 *     move → halt → aim (400 ms telegraph) → fire burst → reposition
 *
 * `MOVING_STATES` and `FIRING_STATES` are disjoint by construction, velocity is
 * hard-zeroed on entry to every stationary state, and `tools/smoke.mjs` samples
 * the live AI state + speed during play and fails the build if a soldier is ever
 * in a firing state above `ENEMY.stoppedSpeed`. The rule is a test, not a
 * comment.
 *
 * The visible consequence is that the player can always read intent: a soldier
 * that has stopped and lit its visor is about to shoot, and that is 400 ms of
 * warning to break line of sight.
 */

export type EnemyState =
  | 'idle'
  | 'patrol'
  | 'advance'
  | 'halt'
  | 'aim'
  | 'fire'
  | 'reposition'
  | 'dead';

/** States in which the soldier is allowed to have velocity. */
export const MOVING_STATES: ReadonlySet<EnemyState> = new Set<EnemyState>([
  'patrol',
  'advance',
  'reposition',
]);

/**
 * States in which the soldier is planted: settling, winding up, or shooting.
 * Disjoint from MOVING_STATES by construction — that disjointness IS the
 * doctrine, and the smoke test asserts speed ≈ 0 for every state in this set.
 */
export const STATIONARY_COMBAT_STATES: ReadonlySet<EnemyState> = new Set<EnemyState>([
  'halt',
  'aim',
  'fire',
]);

/** The only state in which a round can leave the barrel. */
export const FIRING_STATES: ReadonlySet<EnemyState> = new Set<EnemyState>(['fire']);

export interface EnemyContext {
  readonly collision: CollisionWorld;
  readonly nav: NavGraph;
  playerFeet(): THREE.Vector3;
  playerAlive(): boolean;
  /** Enemy discharged a round: draw the tracer. */
  onEnemyShot(origin: THREE.Vector3, dir: THREE.Vector3, distance: number): void;
  onEnemyMuzzle(position: THREE.Vector3): void;
  onPlayerDamaged(amount: number, from: THREE.Vector3): void;
  onEnemyKilled(enemy: Enemy): void;
}

// Shared geometry — one upload for every soldier.
const GEO_BODY = new THREE.CapsuleGeometry(ENEMY.radius, ENEMY.height - ENEMY.radius * 2, 6, 12);
const GEO_HELMET = new THREE.BoxGeometry(0.3, 0.16, 0.34);
const GEO_VISOR = new THREE.BoxGeometry(0.26, 0.085, 0.05);
const GEO_CHEVRON = new THREE.ConeGeometry(0.17, 0.42, 4);
const GEO_RIFLE = new THREE.BoxGeometry(0.06, 0.08, 0.62);
const GEO_SHOULDER = new THREE.BoxGeometry(0.52, 0.16, 0.24);

const MAT_HELMET = new THREE.MeshStandardMaterial({ color: 0x2c3033, roughness: 0.75 });
const MAT_RIFLE = new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.55, metalness: 0.5 });

let nextId = 1;

export class Enemy implements HitTarget {
  readonly id = nextId++;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly radius = ENEMY.radius;
  readonly height = ENEMY.height;

  yaw = 0;
  health: number = ENEMY.health;
  alive = true;
  state: EnemyState = 'idle';
  stateTime = 0;
  killedByHeadshot = false;

  readonly group = new THREE.Group();
  /**
   * The rigged soldier, when one loaded. `null` falls the whole class back to
   * M1's capsule build — the level still plays identically, which is the
   * "degraded, not broken" rule the asset layer is built around.
   */
  private readonly soldier: RiggedSoldier | null = null;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly visorMat: THREE.MeshStandardMaterial;
  private readonly body: THREE.Mesh;
  /** Set for one frame when a round leaves the barrel, for the fire clip. */
  private firedThisFrame = false;
  private elapsed = 0;

  // Navigation.
  private path: number[] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  private braceOffset = 0;

  // Perception.
  private canSeePlayer = false;
  private readonly lastSeen = new THREE.Vector3();
  private timeSinceSeen = Infinity;
  private alerted = false;

  // Firing.
  private burstLeft = 0;
  private burstTimer = 0;
  private postBurstLeft = 0;
  private burstsSinceMove = 0;
  private flinchTimer = 0;
  private deathTimer = 0;
  private corpseTimer = 0;
  private telegraph = 0;
  /**
   * M4: in a co-op room the SERVER owns this soldier.
   *
   * When true, `update()` runs the VISUAL half only — the clip blend, the visor
   * telegraph, the death dressing — and position/yaw/state/health arrive from
   * `applyNetworkState`. The state machine, the sensing and the movement are
   * simply not run, because the authoritative copy of them is running in
   * `server/room.ts` against the same collision world.
   *
   * Nothing about the SINGLE-PLAYER path changes: `networked` is false there and
   * every M1-M3 doctrine assertion still exercises the real state machine.
   */
  private networked = false;

  // Death dressing — see `kill()`.
  private readonly deathShove = new THREE.Vector3();
  private deathTwist = 0;
  private droppedWeapon: THREE.Object3D | null = null;
  private readonly droppedVel = new THREE.Vector3();
  private readonly droppedSpin = new THREE.Vector3();
  private droppedFloor = 0;

  constructor(
    private readonly ctx: EnemyContext,
    spawn: THREE.Vector3,
    private readonly scene: THREE.Scene,
    assets?: Assets,
  ) {
    this.position.copy(spawn);
    this.yaw = rng.range(0, Math.PI * 2);

    // M2: a real rigged soldier replaces the capsule. Everything below the
    // visual layer — the state machine, the hit volumes, the doctrine audit — is
    // untouched, which is the point: the art pass must not be able to change how
    // the game plays.
    if (assets?.soldier) {
      const s = new RiggedSoldier(assets, {
        height: ENEMY.height,
        tint: 0xbcc4b2,
        visorColor: 0xff4a12,
        visor: true,
        // THE HOSTILES CARRY THE PLAYER'S WEAPON. Same source GLB, world-lit,
        // shadow-casting, in the right hand. A firefight in which the thing
        // shooting at you is visibly holding nothing is the single most common
        // "unfinished" read in a generated build, and both dissections have it.
        weapon: buildWorldCarbine(assets, ENEMY_CARBINE_LENGTH),
      });
      if (s.valid) {
        this.soldier = s;
        this.group.add(s.object);
      }
    }

    // Per-enemy material clones so flinch/telegraph do not bleed between units.
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x74836b,
      roughness: 0.8,
      emissive: 0x000000,
    });
    this.visorMat = new THREE.MeshStandardMaterial({
      color: 0xff5a2a,
      emissive: 0xff5a2a,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });

    this.body = new THREE.Mesh(GEO_BODY, this.bodyMat);
    this.body.position.y = ENEMY.height / 2;
    this.body.castShadow = true;

    if (!this.soldier) {
      // ---- M1 graybox fallback ------------------------------------------
      this.group.add(this.body);

      const helmet = new THREE.Mesh(GEO_HELMET, MAT_HELMET);
      helmet.position.y = ENEMY.height - 0.09;
      helmet.castShadow = true;
      this.group.add(helmet);

      const shoulders = new THREE.Mesh(GEO_SHOULDER, MAT_HELMET);
      shoulders.position.y = ENEMY.height - 0.36;
      shoulders.castShadow = true;
      this.group.add(shoulders);

      // FACING INDICATORS — a visor on the front of the head and a chest
      // chevron. On a capsule, facing must be readable at 30 m from any angle
      // and one cue is not enough. The rigged model retires the CHEVRON (a
      // human silhouette states its own facing far better than a cone does) but
      // KEEPS the visor, because the telegraph is a STATE cue, not a facing cue
      // — see RiggedSoldier's visor plate.
      const visor = new THREE.Mesh(GEO_VISOR, this.visorMat);
      visor.position.set(0, ENEMY.height - 0.14, -0.16);
      markBloom(visor);
      this.group.add(visor);

      const chevron = new THREE.Mesh(GEO_CHEVRON, this.visorMat);
      chevron.position.set(0, ENEMY.height - 0.55, -0.32);
      chevron.rotation.x = -Math.PI / 2;
      markBloom(chevron);
      this.group.add(chevron);

      const rifle = new THREE.Mesh(GEO_RIFLE, MAT_RIFLE);
      rifle.position.set(0.19, ENEMY.height - 0.62, -0.24);
      rifle.castShadow = true;
      this.group.add(rifle);
    }

    this.group.traverse((o) => o.layers.set(LAYER.WORLD));
    scene.add(this.group);
    this.syncTransform();
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Chest height — the point enemies aim from and the player usually hits. */
  chest(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + ENEMY.height - 0.55, this.position.z);
  }

  dispose(): void {
    this.scene.remove(this.group);
    if (this.droppedWeapon) this.scene.remove(this.droppedWeapon);
    this.droppedWeapon = null;
    this.soldier?.dispose();
    this.bodyMat.dispose();
    this.visorMat.dispose();
  }

  // ---------------------------------------------------------------- damage

  takeDamage(amount: number, headshot: boolean): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    this.flinchTimer = ENEMY.flinchMs / 1000;
    this.bodyMat.emissive.setHex(0xffffff);
    this.bodyMat.emissiveIntensity = 1.4;
    // Being shot at is information: an unaware soldier becomes aware.
    this.alerted = true;
    this.timeSinceSeen = 0;
    this.lastSeen.copy(this.ctx.playerFeet());
    if (this.health <= 0) {
      this.kill(headshot);
      return true;
    }
    // A hit while winding up spoils the shot — the player is rewarded for
    // interrupting a telegraph.
    if (this.state === 'aim') this.stateTime = Math.max(0, this.stateTime - 0.12);
    return false;
  }

  /** Server-owned soldiers take their whole state from the snapshot. */
  setNetworked(on: boolean): void {
    this.networked = on;
  }

  /**
   * Adopt the authoritative state for this tick.
   *
   * Death is edge-triggered rather than level-triggered: the local death
   * dressing (the directional shove, the yaw twist, the dropped weapon, the
   * clip) must fire exactly once, on the snapshot where `alive` goes false, not
   * on every snapshot afterwards.
   */
  applyNetworkState(s: {
    position: THREE.Vector3;
    yaw: number;
    state: EnemyState;
    health: number;
    alive: boolean;
  }): void {
    this.position.copy(s.position);
    this.yaw = s.yaw;
    this.health = s.health;
    const died = this.alive && !s.alive;
    if (this.state !== s.state) {
      this.state = s.state;
      this.stateTime = 0;
    }
    if (died) {
      // `false` = do not raise onEnemyKilled: the kill FEED is driven by the
      // server's own broadcast, so every client shows the same fight in the
      // same order, including kills made by other players.
      this.kill(false, false);
    }
    this.alive = s.alive;
  }

  private kill(headshot: boolean, notify = true): void {
    this.alive = false;
    this.killedByHeadshot = headshot;
    this.setState('dead');
    this.velocity.set(0, 0, 0);
    this.deathTimer = 0;
    this.corpseTimer = ENEMY.corpseLingerMs / 1000;
    this.visorMat.emissiveIntensity = 0;
    if (headshot) this.bodyMat.color.setHex(0x5a4a46);

    // ---- the death gets weight --------------------------------------------
    // The death CLIP owns the fall (see updateDeath), and it is the same clip
    // every time. Three cheap layers on top make each death read as a
    // consequence of the shot that caused it rather than as a canned animation:
    //
    //  1. A DIRECTIONAL SHOVE. The corpse slides a few centimetres along the
    //     line the round travelled, decaying fast. A body that drops perfectly
    //     vertically after being shot from the side is the tell.
    //  2. A YAW TWIST, seeded per soldier, so six corpses do not lie parallel.
    //  3. THE WEAPON IS DROPPED — detached at its world transform and left to
    //     fall. It is one line of physics and it is the difference between a
    //     corpse and a mannequin.
    const from = this.ctx.playerFeet();
    _dir.set(this.position.x - from.x, 0, this.position.z - from.z);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    _dir.normalize();
    this.deathShove.copy(_dir).multiplyScalar(headshot ? 0.34 : 0.2);
    this.deathTwist = rng.signed(headshot ? 0.55 : 0.32);

    const dropped = this.soldier?.dropWeapon();
    if (dropped) {
      this.scene.add(dropped);
      this.droppedWeapon = dropped;
      this.droppedVel.set(_dir.x * 1.5 + rng.signed(0.4), 1.1, _dir.z * 1.5 + rng.signed(0.4));
      this.droppedSpin.set(rng.signed(7), rng.signed(5), rng.signed(7));
      // Rest height for a rifle lying on whatever surface it was dropped over.
      this.droppedFloor =
        this.ctx.collision.groundHeight(dropped.position.x, dropped.position.z, 0.2, dropped.position.y + 0.5, 0.5) + 0.06;
    }

    if (notify) this.ctx.onEnemyKilled(this);
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    this.stateTime += dt;
    this.elapsed += dt;

    if (this.state === 'dead') {
      this.updateDeath(dt);
      return;
    }

    if (!this.networked) {
      this.sense();
      this.think(dt);
      this.move(dt);
    }
    this.updateVisuals(dt);
    this.syncTransform();
    this.firedThisFrame = false;
  }

  // -------------------------------------------------------------- sensing

  private sense(): void {
    const player = this.ctx.playerFeet();
    if (!this.ctx.playerAlive()) {
      this.canSeePlayer = false;
      this.timeSinceSeen = Infinity;
      return;
    }
    const eye = _eye.set(this.position.x, this.position.y + ENEMY.height - 0.2, this.position.z);
    const target = _target.set(player.x, player.y + 1.2, player.z);
    const dist = eye.distanceTo(target);
    if (dist > ENEMY.viewDistance) {
      this.canSeePlayer = false;
      return;
    }
    _toPlayer.subVectors(target, eye).normalize();
    const fwd = _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const angle = Math.acos(clamp(fwd.dot(_toPlayer), -1, 1));
    // An alerted soldier gets full awareness; an unaware one has a real cone.
    const fov = (this.alerted ? 200 : ENEMY.fovDeg) * DEG * 0.5;
    if (angle > fov) {
      this.canSeePlayer = false;
      return;
    }
    this.canSeePlayer = this.ctx.collision.hasLineOfSight(eye, target);
    if (this.canSeePlayer) {
      this.timeSinceSeen = 0;
      this.alerted = true;
      this.lastSeen.copy(player);
    }
  }

  // -------------------------------------------------------- state machine

  private setState(next: EnemyState): void {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
    // Hard invariant: entering a non-moving state kills velocity outright.
    if (!MOVING_STATES.has(next)) this.velocity.set(0, 0, 0);
  }

  private think(dt: number): void {
    this.timeSinceSeen += dt;
    this.repathTimer -= dt;
    if (this.flinchTimer > 0) this.flinchTimer -= dt;

    const player = this.ctx.playerFeet();
    const dist = Math.hypot(player.x - this.position.x, player.z - this.position.z);
    const inBand = dist <= ENEMY.preferredRange + 4 && dist >= ENEMY.minRange - 2;
    const engaged = this.canSeePlayer && this.ctx.playerAlive();

    switch (this.state) {
      case 'idle':
        this.setState('patrol');
        break;

      case 'patrol': {
        if (engaged) {
          this.setState('advance');
          this.repathTimer = 0;
          break;
        }
        if (this.pathDone() || this.repathTimer <= 0) this.repathToRandom();
        break;
      }

      case 'advance': {
        if (!engaged && this.timeSinceSeen > ENEMY.memoryMs / 1000) {
          this.alerted = false;
          this.setState('patrol');
          break;
        }
        if (engaged && inBand && dist > ENEMY.minRange - 1) {
          this.setState('halt');
          break;
        }
        if (this.repathTimer <= 0 || this.pathDone()) {
          this.repathToFiringPosition();
          this.repathTimer = 0.85;
        }
        break;
      }

      case 'halt': {
        // Settle. Zero velocity is already guaranteed by setState.
        if (this.stateTime * 1000 >= ENEMY.haltMs) {
          if (engaged) {
            this.setState('aim');
            this.telegraph = 0;
          } else {
            this.setState('advance');
            this.repathTimer = 0;
          }
        }
        break;
      }

      case 'aim': {
        if (!engaged) {
          this.setState('advance');
          this.repathTimer = 0;
          break;
        }
        if (this.flinchTimer > 0) break; // a hit spoils the wind-up
        if (this.stateTime * 1000 >= ENEMY.telegraphMs) {
          this.setState('fire');
          this.burstLeft = ENEMY.burstCount;
          this.burstTimer = 0;
        }
        break;
      }

      case 'fire': {
        if (this.burstLeft > 0) {
          this.burstTimer -= dt;
          if (this.burstTimer <= 0) {
            this.shoot();
            this.burstLeft--;
            this.burstTimer = ENEMY.burstIntervalMs / 1000;
            // Recovery starts when the LAST round leaves, not when the state
            // was entered — otherwise the pause scales with the burst length.
            if (this.burstLeft === 0) this.postBurstLeft = ENEMY.postBurstMs / 1000;
          }
        } else if ((this.postBurstLeft -= dt) <= 0) {
          this.burstsSinceMove++;
          if (!engaged || this.burstsSinceMove >= ENEMY.burstsBeforeReposition) {
            this.burstsSinceMove = 0;
            this.setState('reposition');
            this.repositionToCover();
          } else {
            this.setState('aim');
          }
        }
        break;
      }

      case 'reposition': {
        if (this.pathDone()) {
          this.setState(engaged ? 'halt' : 'advance');
          this.repathTimer = 0;
        }
        break;
      }

      default:
        break;
    }
  }

  private shoot(): void {
    // THE ROUND LEAVES THE ACTUAL BARREL. With a carbine in hand there is a real
    // muzzle to ask for, so the tracer and the flash light come from the weapon's
    // own muzzle marker; the analytic chest-offset estimate below stays as the
    // fallback for the capsule build. A tracer that starts 30 cm from the gun it
    // supposedly came out of is a small thing that reads as wrong instantly.
    const muzzle = _muzzle;
    if (!this.soldier?.muzzleWorld(muzzle)) {
      muzzle.set(this.position.x, this.position.y + ENEMY.height - 0.62, this.position.z);
      const right = _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      muzzle.addScaledVector(right, 0.19);
      muzzle.addScaledVector(_fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 0.3);
    }

    const player = this.ctx.playerFeet();
    _target.set(player.x, player.y + 1.15, player.z);
    _dir.subVectors(_target, muzzle).normalize();

    // Aim cone — wide enough that strafing genuinely works.
    const cone = ENEMY.spreadDeg * DEG;
    _perpA.set(0, 1, 0);
    if (Math.abs(_dir.y) > 0.95) _perpA.set(1, 0, 0);
    _perpA.crossVectors(_dir, _perpA).normalize();
    _perpB.crossVectors(_dir, _perpA).normalize();
    const a = rng() * Math.PI * 2;
    const rad = Math.tan(cone) * Math.sqrt(rng());
    _dir
      .addScaledVector(_perpA, Math.cos(a) * rad)
      .addScaledVector(_perpB, Math.sin(a) * rad)
      .normalize();

    const worldHit = this.ctx.collision.raycast(muzzle, _dir, ENEMY.range);
    const worldDist = worldHit ? worldHit.distance : ENEMY.range;
    const hitT = rayCapsule(
      muzzle,
      _dir,
      player.x,
      player.y,
      player.z,
      1.8,
      0.34,
      Math.min(worldDist, ENEMY.range),
    );

    this.firedThisFrame = true;
    this.ctx.onEnemyMuzzle(muzzle);
    this.ctx.onEnemyShot(muzzle, _dir, hitT ?? worldDist);

    if (hitT !== null) {
      const head = player.y + 1.55;
      const impactY = muzzle.y + _dir.y * hitT;
      const damage = impactY > head ? ENEMY.headshotDamage : ENEMY.damage;
      this.ctx.onPlayerDamaged(damage, this.position);
    }
  }

  // --------------------------------------------------------------- routing

  private pathDone(): boolean {
    return this.pathIndex >= this.path.length;
  }

  private setPathTo(goal: number): void {
    if (goal < 0) return;
    const start = this.ctx.nav.nearest(this.position);
    if (!start) return;
    this.path = this.ctx.nav.findPath(start.index, goal);
    this.pathIndex = this.path.length > 1 ? 1 : 0;
  }

  private repathToRandom(): void {
    const nodes = this.ctx.nav.nodes;
    if (!nodes.length) return;
    // Patrol far enough to actually cross the compound.
    let pick = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cand = rng.int(nodes.length);
      if (nodes[cand].position.distanceTo(this.position) > 8) {
        pick = cand;
        break;
      }
    }
    this.setPathTo(pick >= 0 ? pick : rng.int(nodes.length));
    this.repathTimer = 6;
  }

  /** Nearest node that has LOS to the player at a comfortable range. */
  private repathToFiringPosition(): void {
    const player = this.ctx.playerFeet();
    _target.set(player.x, player.y + 1.2, player.z);
    let best = -1;
    let bestScore = Infinity;
    for (const n of this.ctx.nav.nodes) {
      const d = n.position.distanceTo(_target);
      if (d > ENEMY.preferredRange + 8 || d < ENEMY.minRange) continue;
      _eye.set(n.position.x, n.position.y + ENEMY.height - 0.2, n.position.z);
      if (!this.ctx.collision.hasLineOfSight(_eye, _target)) continue;
      const travel = n.position.distanceTo(this.position);
      const score =
        Math.abs(d - ENEMY.preferredRange) + travel * 0.55 + (n.cover ? 0 : ENEMY.coverBias * 6);
      if (score < bestScore) {
        bestScore = score;
        best = n.index;
      }
    }
    if (best >= 0) this.setPathTo(best);
    else {
      // No firing position found: walk to the last known player position.
      const near = this.ctx.nav.nearest(this.lastSeen);
      if (near) this.setPathTo(near.index);
    }
  }

  /** Move to a different covered node still able to see the player. */
  private repositionToCover(): void {
    const player = this.ctx.playerFeet();
    _target.set(player.x, player.y + 1.2, player.z);
    let best = -1;
    let bestScore = Infinity;
    for (const n of this.ctx.nav.nodes) {
      const travel = n.position.distanceTo(this.position);
      if (travel < 3 || travel > 16) continue;
      const d = n.position.distanceTo(_target);
      if (d > ENEMY.preferredRange + 6 || d < ENEMY.minRange) continue;
      _eye.set(n.position.x, n.position.y + ENEMY.height - 0.2, n.position.z);
      if (!this.ctx.collision.hasLineOfSight(_eye, _target)) continue;
      const score =
        Math.abs(d - ENEMY.preferredRange) * 0.7 +
        travel * 0.3 +
        (n.cover ? 0 : ENEMY.coverBias * 8) +
        rng.range(0, 2.5); // avoid every soldier picking the same tile
      if (score < bestScore) {
        bestScore = score;
        best = n.index;
      }
    }
    if (best >= 0) this.setPathTo(best);
    else this.repathToFiringPosition();
  }

  // -------------------------------------------------------------- movement

  private move(dt: number): void {
    const moving = MOVING_STATES.has(this.state);

    if (!moving) {
      // INVARIANT: stationary states have exactly zero horizontal velocity.
      this.velocity.x = 0;
      this.velocity.z = 0;
    } else {
      const speed =
        this.state === 'patrol'
          ? ENEMY.patrolSpeed
          : this.state === 'advance'
            ? ENEMY.advanceSpeed
            : ENEMY.repositionSpeed;

      let tx = 0;
      let tz = 0;
      if (!this.pathDone()) {
        const node = this.ctx.nav.nodes[this.path[this.pathIndex]];
        const dx = node.position.x - this.position.x;
        const dz = node.position.z - this.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.75) {
          this.pathIndex++;
        } else {
          tx = (dx / d) * speed;
          tz = (dz / d) * speed;
        }
      }
      this.velocity.x = damp(this.velocity.x, tx, 1 / ENEMY.accel, dt);
      this.velocity.z = damp(this.velocity.z, tz, 1 / ENEMY.accel, dt);
    }

    // Gravity + collide (identical rules to the player: step-up, no slopes).
    this.velocity.y -= 22.5 * dt;
    const feetBefore = this.position.y;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.ctx.collision.resolveHorizontal(
      this.position,
      ENEMY.radius,
      ENEMY.height,
      feetBefore,
      0.46,
    );
    this.position.y += this.velocity.y * dt;
    const ground = this.ctx.collision.groundHeight(
      this.position.x,
      this.position.z,
      ENEMY.radius,
      Math.max(this.position.y, feetBefore),
      0.46,
    );
    if (ground > -Infinity && this.position.y <= ground + 1e-3) {
      this.position.y = ground;
      this.velocity.y = 0;
    }
    if (this.position.y < -6) this.position.y = 0;

    // ---- facing -----------------------------------------------------------
    if (moving && this.speed > 0.2) {
      // FACE THE VELOCITY while moving.
      const targetYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
      this.yaw = turnToward(this.yaw, targetYaw, ENEMY.turnRate, dt);
    } else if (STATIONARY_COMBAT_STATES.has(this.state) || this.canSeePlayer) {
      const p = this.ctx.playerFeet();
      const targetYaw = Math.atan2(-(p.x - this.position.x), -(p.z - this.position.z));
      this.yaw = turnToward(this.yaw, targetYaw, ENEMY.aimTurnRate, dt);
    }
  }

  // -------------------------------------------------------------- visuals

  private updateVisuals(dt: number): void {
    // Telegraph: the visor and chevron light up during the aim wind-up and stay
    // hot through the burst. This is the readable "I am about to shoot" cue.
    const wantTelegraph =
      this.state === 'aim'
        ? clamp((this.stateTime * 1000) / ENEMY.telegraphMs, 0, 1)
        : this.state === 'fire'
          ? 1
          : 0;
    this.telegraph = damp(this.telegraph, wantTelegraph, 0.06, dt);
    this.visorMat.emissiveIntensity = 0.9 + this.telegraph * 3.6;
    this.soldier?.setTelegraph(this.telegraph);

    // Flinch flash decays back to unlit.
    if (this.bodyMat.emissiveIntensity > 0) {
      this.bodyMat.emissiveIntensity = Math.max(0, this.bodyMat.emissiveIntensity - dt * 9);
      if (this.bodyMat.emissiveIntensity <= 0) this.bodyMat.emissive.setHex(0x000000);
      this.soldier?.setFlash(this.bodyMat.emissiveIntensity);
    }

    // Slight crouch into the firing stance so the pose reads as braced. The
    // rigged model gets this from its aim clip instead, so the manual offset is
    // suppressed — doubling it would read as a bob.
    const braced = !this.soldier && STATIONARY_COMBAT_STATES.has(this.state) ? -0.09 : 0;
    this.braceOffset = damp(this.braceOffset, braced, 0.12, dt);

    // ---- drive the rigged clips ------------------------------------------
    // The mapping is a direct read of the doctrine, which is why it is short:
    // MOVING_STATES get the locomotion blend, the planted combat states get the
    // aim pose. Those two sets are disjoint by construction (that disjointness
    // IS the doctrine), so a soldier can never be blending a walk cycle while
    // shooting — the animation cannot contradict the rule the way it did in the
    // pipeline's build, where enemies visibly fired mid-run.
    this.soldier?.update(dt, {
      speed: this.speed,
      locomotion: clamp(this.speed / ENEMY.repositionSpeed, 0, 1),
      stance: 'stand',
      pitch: 0,
      firing: this.firedThisFrame,
      aiming: STATIONARY_COMBAT_STATES.has(this.state),
      reloading: false,
      dead: false,
      elapsed: this.elapsed,
    });
  }

  private updateDeath(dt: number): void {
    this.deathTimer += dt;
    this.elapsed += dt;
    const t = clamp(this.deathTimer / (ENEMY.deathCollapseMs / 1000), 0, 1);
    this.visorMat.emissiveIntensity = Math.max(0, 0.9 * (1 - t));

    if (this.soldier) {
      // The rigged death clip owns the fall completely. The M1 procedural
      // collapse below is NOT also applied — running both would fold the body
      // twice and drive it through the floor. This is the hook M1 said the death
      // clip would use, used.
      this.soldier.setTelegraph(0);
      this.soldier.setFlash(0);
      this.soldier.update(dt, {
        speed: 0,
        locomotion: 0,
        stance: 'stand',
        pitch: 0,
        firing: false,
        aiming: false,
        reloading: false,
        dead: true,
        elapsed: this.elapsed,
      });
      // The shove decays over the first ~300 ms, which is the window in which
      // the clip is still falling — after that the corpse is settled and any
      // further drift would read as sliding.
      const shove = Math.max(0, 1 - this.deathTimer / 0.3);
      const e = 1 - (1 - shove) * (1 - shove);
      this.group.position.set(
        this.position.x + this.deathShove.x * e,
        this.position.y,
        this.position.z + this.deathShove.z * e,
      );
      this.group.rotation.y = this.yaw + this.deathTwist * Math.min(1, this.deathTimer / 0.5);
    } else {
      // Collapse: fold at the ankles, sink, and settle.
      this.group.rotation.x = -t * t * 1.5;
      this.group.position.y = this.position.y - t * 0.18;
      this.body.scale.y = 1 - t * 0.08;
    }

    // ---- the dropped weapon falls and settles -------------------------------
    const w = this.droppedWeapon;
    if (w) {
      if (w.position.y > this.droppedFloor) {
        this.droppedVel.y -= 18 * dt;
        w.position.addScaledVector(this.droppedVel, dt);
        w.rotation.x += this.droppedSpin.x * dt;
        w.rotation.y += this.droppedSpin.y * dt;
        w.rotation.z += this.droppedSpin.z * dt;
        if (w.position.y <= this.droppedFloor) {
          w.position.y = this.droppedFloor;
          // Land flat: a rifle at rest lies on its side, not stood on its stock.
          w.rotation.set(Math.PI / 2, w.rotation.y, 0);
          this.droppedVel.set(0, 0, 0);
        }
      }
      if (this.corpseTimer <= 0) {
        this.scene.remove(w);
        this.droppedWeapon = null;
      }
    }

    this.corpseTimer -= dt;
    if (this.corpseTimer <= 0 && this.group.visible) {
      this.group.visible = false;
    }
  }

  private syncTransform(): void {
    this.group.position.set(
      this.position.x,
      this.position.y + this.braceOffset,
      this.position.z,
    );
    this.group.rotation.y = this.yaw;
  }
}

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perpA = new THREE.Vector3();
const _perpB = new THREE.Vector3();
