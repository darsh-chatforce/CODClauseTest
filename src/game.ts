import * as THREE from 'three';
import {
  ARENA,
  CAMERA,
  ENEMY,
  FEEL,
  LOOK,
  MISSION,
  PLAYER,
  VIEWMODEL,
  WEAPON,
} from './config';
import { Enemy, STATIONARY_COMBAT_STATES, type EnemyContext } from './ai/enemy';
import { NavGraph } from './ai/navgraph';
import { AudioEngine } from './audio/audio';
import { clamp, damp } from './core/mathx';
import { rng } from './core/rng';
import { FovKick, Hitstop, ShakeRig } from './fx/feel';
import { ImpactFx } from './fx/impacts';
import { PostFx } from './fx/postfx';
import { TracerPool } from './fx/tracers';
import { Hud } from './hud/hud';
import { Screens, type MissionStats } from './hud/screens';
import { Input } from './input/input';
import { PlayerAvatar } from './player/avatar';
import { Player } from './player/player';
import { NetClient } from './net/client';
import { PF } from './net/protocol';
import { RemotePlayer } from './net/remote';
import { fitCarbine, type CarbineFit } from './weapons/carbine';
import { Rifle, type WeaponHit } from './weapons/rifle';
import { Viewmodel } from './weapons/viewmodel';
import { buildArena, type ArenaBuild } from './world/arena';
import { Assets, type AssetReport } from './world/assets';
import { CollisionWorld } from './world/collision';
import {
  applySky,
  buildEnvironment,
  configureRenderer,
  type EnvironmentHandles,
} from './world/environment';

export type GamePhase = 'menu' | 'playing' | 'paused' | 'won' | 'lost';

/** Luminance distribution of the presented frame. See `requestFrameStats`. */
export interface FrameStats {
  /** Mean relative luminance, 0..1. */
  mean: number;
  /** Fraction of pixels crushed to black. */
  dark: number;
  /** Fraction of pixels blown to white. */
  bright: number;
  ok: boolean;
}

/**
 * Orchestrator: owns the renderer, the systems, the phase machine and the frame.
 *
 * The frame is deliberately explicit about which clock each system reads.
 * `gameplayDt` is scaled by hitstop; `dt` (real) drives camera, shake, HUD and
 * effects — a frozen frame you cannot see is a hitch, not hitstop.
 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  private readonly collision = new CollisionWorld();
  private arena!: ArenaBuild;
  private nav!: NavGraph;
  private readonly assets = new Assets();
  private assetReport: AssetReport = { requested: 0, loaded: 0, failed: [], ms: 0 };
  private skySource: 'hdri' | 'procedural' = 'procedural';
  private env!: EnvironmentHandles;

  private readonly input: Input;
  private readonly player: Player;
  private avatar!: PlayerAvatar;
  private readonly viewmodel = new Viewmodel();
  private readonly rifle: Rifle;
  private enemies: Enemy[] = [];

  private readonly hud: Hud;
  private readonly screens: Screens;

  private readonly playerTracers: TracerPool;
  private readonly enemyTracers: TracerPool;
  private readonly impacts: ImpactFx;
  private readonly shake = new ShakeRig();
  private readonly hitstop = new Hitstop();
  private readonly fovKick = new FovKick();
  readonly audio = new AudioEngine();
  private postfx!: PostFx;
  /** Non-null once the generated carbine has been measured and fitted. */
  private carbine: CarbineFit | null = null;

  /** Footstep cadence — distance-driven, not timer-driven, so steps land with
   *  the stride at every speed instead of running at a fixed rate. */
  private stepDistance = 0;
  private stepLeft = false;

  /**
   * M4: the co-op link. NULL in single player, and that is the whole design.
   *
   * Nothing below constructs it, waits for it, or checks it during boot. The
   * offline game is byte-for-byte the M3 build; `net` becomes non-null only when
   * the player presses HOST or JOIN, and every use of it is guarded. A finished
   * single-player game must not acquire a runtime dependency on a socket.
   */
  net: NetClient | null = null;
  private readonly remotes = new Map<string, RemotePlayer>();

  /** Rolling frame-time window for the measured frame cost (see `frameCost`). */
  private readonly frameTimes = new Float32Array(120);
  private frameTimeIndex = 0;
  private frameTimeCount = 0;

  phase: GamePhase = 'menu';
  private missionTime = 0;
  private score = 0;
  private kills = 0;
  private elapsed = 0;
  private lastFrame = 0;

  /** Third-person inspect (T). */
  private inspect = false;
  /** Top-down authoring/debug camera (no key binding; test + tooling only). */
  private overview = false;
  /** Debug: ignore incoming damage. Used by tooling to compose screenshots
   *  without a live firefight ending the mission mid-capture. */
  private invulnerable = false;
  private orbitYaw = 0;
  private orbitPitch = 0.28;
  private orbitDist = 4.4;

  /** Camera feel state. */
  private fov: number = CAMERA.fov;
  /** Smoothed FOV without the additive kick — the resting FOV. */
  private fovBase: number = CAMERA.fov;
  private landDip = 0;
  private lookVelX = 0;
  private lookVelY = 0;

  /**
   * Continuous in-engine invariant audit — the doctrine, enforced at runtime.
   * `aiViolations` counts frames on which a soldier was in a stationary combat
   * state with non-trivial speed. The smoke test asserts it stays at zero.
   */
  aiViolations = 0;
  aiWorstSpeedWhileFiring = 0;

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // WebGL only, by choice: the pipeline's WebGPU path failed twice (a broken
      // cube binding, then a null-image texture that never booted). Reliability
      // over novelty for a reference build.
      failIfMajorPerformanceCaveat: false,
    });
    configureRenderer(this.renderer);

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    this.scene.add(this.camera);

    // Lights and the fallback sky exist BEFORE any asset resolves, so a slow or
    // failed download degrades the look rather than producing a black frame.
    this.env = buildEnvironment(this.scene);
    this.postfx = new PostFx(
      this.renderer,
      this.scene,
      this.camera,
      this.viewmodel.scene,
      this.viewmodel.camera,
    );

    // BOOTING WITH POST-PROCESSING OFF IS ITS OWN PATH, so it is reachable
    // without first booting with it on. `?postfx=0` is not a debug flag — it is
    // the low-end entry point, and `tools/smoke.mjs` loads a second page with it
    // to prove the game comes up on the direct render path from cold. A settings
    // toggle that can only be reached after the composer has already built its
    // render targets is not evidence that the game works without them.
    const params = new URLSearchParams(window.location.search);
    if (params.get('postfx') === '0') this.postfx.enabled = false;

    this.input = new Input(canvas);
    this.player = new Player(this.collision);

    this.playerTracers = new TracerPool(this.scene, 48, 0xffd08a, 0.03);
    this.enemyTracers = new TracerPool(this.scene, 64, 0xff5a3c, 0.036);
    this.impacts = new ImpactFx(this.scene);

    this.hud = new Hud(WEAPON.name);
    this.screens = new Screens(
      () => this.startMission(),
      () => this.startMission(),
      [
        {
          id: 'postfx',
          label: 'POST-PROCESSING',
          note: '· bloom, grade, SMAA',
          initial: this.postfx.enabled,
          onChange: (v) => this.setPostFx(v),
        },
        {
          id: 'ao',
          label: 'AMBIENT OCCLUSION',
          note: '· costs frame time',
          initial: false,
          onChange: (v) => this.setAo(v),
        },
        {
          id: 'audio',
          label: 'AUDIO',
          initial: true,
          onChange: (v) => this.setAudioMuted(!v),
        },
      ],
    );

    this.bindCoopUi();

    this.rifle = new Rifle(this.collision, {
      onShot: (origin, dir, distance, adsT) => this.onPlayerShot(origin, dir, distance, adsT),
      onTargetHit: (hit) => this.onPlayerHitTarget(hit),
      onWorldHit: (point, normal) => {
        this.impacts.worldHit(point, normal);
        this.audio.impact(point.distanceTo(this.player.eyePosition), this.bearingTo(point));
      },
      onDryFire: () => {
        this.hud.showPrompt('PRESS R TO RELOAD');
        this.audio.dryFire();
      },
      onReloadStart: (durationMs) => {
        this.hud.showPrompt(null);
        // Foley is scheduled against the REAL reload duration, so the empty-mag
        // reload's extra 550 ms moves the clacks with it.
        this.audio.reload(durationMs);
      },
      onReloadEnd: () => this.hud.showPrompt(null),
    });

    this.player.onDamage = ({ amount, from }) => this.onPlayerDamaged(amount, from);
    this.player.onDeath = () => this.endMission(false);

    this.input.onLockChange = (locked) => {
      if (!locked && this.phase === 'playing') this.pause();
    };
    canvas.addEventListener('mousedown', () => {
      if (this.phase === 'paused') this.resume();
      else if (this.phase === 'playing' && !this.input.locked && !this.inspect) {
        this.input.requestLock();
      }
    });

    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.screens.showStart();
    this.hud.setHealth(PLAYER.maxHealth);
    this.hud.setAmmo(WEAPON.magSize, WEAPON.startReserve);
    this.hud.setHostiles(ENEMY.count);
  }

  /**
   * Load the assets, then build everything that depends on them.
   *
   * This is deliberately a SECOND phase rather than a constructor that happens
   * to await. The world is not built — and the automation surface is not
   * published — until every asset has resolved one way or the other, so no
   * assertion and no screenshot can ever catch the game mid-load. A build whose
   * screenshots are taken before its textures arrive looks exactly like a build
   * with no textures, and that is a genuinely hard bug to see.
   */
  async init(): Promise<AssetReport> {
    this.assetReport = await this.assets.loadAll();

    const sky = applySky(this.renderer, [this.scene, this.viewmodel.scene], this.env, this.assets);
    this.skySource = sky.source;

    this.arena = buildArena(this.scene, this.collision, this.assets);
    this.nav = new NavGraph(this.collision);
    this.avatar = new PlayerAvatar(this.scene, this.assets);

    // ---- the generated carbine replaces the placeholder --------------------
    // `fitCarbine` MEASURES the mesh and returns the optic/muzzle/magazine it
    // found. If any of those measurements failed it says so, and the placeholder
    // rifle stays — because a weapon whose optic is somewhere unknown breaks ADS,
    // which is a gameplay failure, not a cosmetic one. Loud in the report, soft
    // in the frame.
    const fit = fitCarbine(this.assets);
    if (fit && fit.problems.length === 0) {
      this.carbine = fit;
      this.viewmodel.setModel(fit.group, fit.muzzle, fit.magazine, fit.optic);
    } else if (fit) {
      for (const p of fit.problems) console.error(`[carbine] ${p}`);
    }

    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
    return this.assetReport;
  }

  // ------------------------------------------------------------ lifecycle

  startMission(): void {
    // The mission-start click is the user gesture browsers require before an
    // AudioContext may make noise. This is the only place it can legitimately
    // happen, so it happens here.
    this.audio.resume();
    this.audio.ui(1);
    // In a room, RESTART is a request: the server owns the mission, and it
    // resets for everyone at once so two players can never be in different
    // missions in the same compound.
    if (this.net?.online) this.net.restart();
    rng.reseed(0x5eed1e);
    this.player.reset(this.arena.playerSpawn, this.arena.playerYaw);
    this.rifle.reset();
    this.viewmodel.clearShells();
    this.stepDistance = 0;
    this.shake.reset();
    this.hitstop.reset();
    this.fovKick.reset();
    this.playerTracers.clear();
    this.enemyTracers.clear();
    this.impacts.clear();
    this.hud.clearFeedback();

    for (const e of this.enemies) e.dispose();
    this.enemies = [];
    const ctx: EnemyContext = {
      collision: this.collision,
      nav: this.nav,
      playerFeet: () => this.player.position,
      playerAlive: () => !this.player.dead,
      onEnemyShot: (o, d, dist) => {
        this.enemyTracers.fire(o, d, dist);
        // Enemy fire is the SAME synth as the player's, at a real distance and
        // bearing. That is the payoff of synthesising rather than sampling: six
        // soldiers at six ranges are six filter settings, not six sample sets.
        this.audio.shot({
          distance: o.distanceTo(this.player.eyePosition),
          bearing: this.bearingTo(o),
          enemy: true,
        });
      },
      onEnemyMuzzle: (p) => this.impacts.muzzleLight(p, 5),
      onPlayerDamaged: (amount, from) => {
        // In a co-op room the SERVER already applied this damage and will send
        // the authoritative health in the next snapshot; applying it locally as
        // well would double it. The FEEDBACK (shake, arc, vignette) still fires,
        // because it is driven from the health change, not from here.
        if (this.net?.online) return;
        if (!this.invulnerable) this.player.takeDamage(amount, from);
      },
      onEnemyKilled: (e) => this.onEnemyKilled(e),
    };
    for (let i = 0; i < ENEMY.count; i++) {
      const spawn = this.arena.enemySpawns[i % this.arena.enemySpawns.length];
      this.enemies.push(new Enemy(ctx, spawn.clone(), this.scene, this.assets));
    }
    // `startMission` rebuilds the roster, so the networked flag is re-applied.
    if (this.net?.online) for (const e of this.enemies) e.setNetworked(true);

    this.missionTime = 0;
    this.score = 0;
    this.kills = 0;
    this.aiViolations = 0;
    this.aiWorstSpeedWhileFiring = 0;
    this.inspect = false;
    this.avatar.setVisible(false);
    this.screens.setInspectBanner(false);
    this.screens.hideAll();

    this.phase = 'playing';
    document.body.classList.add('playing');
    document.body.classList.remove('inspect');
    this.hud.setHealth(this.player.health);
    this.hud.setAmmo(this.rifle.mag, this.rifle.reserve);
    this.hud.setHostiles(this.enemies.length);
    this.hud.setObjective(MISSION.objective);
    this.input.requestLock();
  }

  pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.input.releaseAll();
    this.screens.showPause();
    document.body.classList.remove('playing');
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.screens.hideAll();
    document.body.classList.add('playing');
    this.input.requestLock();
  }

  private endMission(won: boolean): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    this.phase = won ? 'won' : 'lost';
    document.body.classList.remove('playing', 'inspect');
    this.inspect = false;
    this.avatar.setVisible(false);
    this.screens.setInspectBanner(false);
    this.input.exitLock();

    if (won) {
      this.score += Math.max(0, 180 - this.missionTime) * MISSION.scoreTimeBonusPerSec;
      this.score += this.rifle.accuracy * MISSION.scoreAccuracyBonus;
    }
    this.audio.sting(won);
    this.screens.showEnd(this.stats());
  }

  stats(): MissionStats {
    return {
      won: this.phase === 'won',
      score: this.score,
      kills: this.kills,
      totalHostiles: ENEMY.count,
      accuracy: this.rifle.accuracy,
      shotsFired: this.rifle.shotsFired,
      timeSeconds: this.missionTime,
    };
  }

  // ------------------------------------------------------------ callbacks

  private onPlayerShot(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    distance: number,
    adsT: number,
  ): void {
    this.playerTracers.fire(origin, dir, distance);
    this.viewmodel.punch(adsT);
    this.audio.shot({ distance: 0, bearing: 0 });
    // The world-side flash sits a little downrange of the eye so nearby geometry
    // actually lights up; the viewmodel has its own flash in its own scene.
    this.tmpV.copy(origin).addScaledVector(dir, 0.6);
    this.impacts.muzzleLight(this.tmpV, 7);
    this.shake.addTrauma(adsT > 0.5 ? FEEL.traumaFireAds : FEEL.traumaFire);
    this.fovKick.punch(FEEL.fovKickFire * (1 - adsT * 0.6));
  }

  private onPlayerHitTarget(hit: WeaponHit): void {
    const enemy = hit.target as Enemy;
    this.tmpDir.subVectors(this.player.eyePosition, hit.point).normalize();
    this.impacts.fleshHit(hit.point, this.tmpDir);
    if (this.net?.online) {
      // Server-validated: no local damage, and the hit marker waits for the
      // server's `hit` message so the player is never told they killed
      // something they did not.
      this.shake.addTrauma(0.03);
      return;
    }
    const killed = enemy.takeDamage(hit.damage, hit.headshot);
    this.hud.hitMarker(killed);
    this.audio.hitConfirm(killed);
    if (!killed) this.shake.addTrauma(0.03);
  }

  private onEnemyKilled(enemy: Enemy): void {
    this.kills++;
    const headshot = enemy.killedByHeadshot;
    this.score += headshot ? MISSION.scoreHeadshot : MISSION.scoreKill;
    this.hud.addKill(`HOSTILE ${String(enemy.id).padStart(2, '0')}`, headshot);
    this.hud.setHostiles(this.enemies.filter((e) => e.alive).length);
    this.hitstop.trigger(FEEL.hitstopKillMs);
    this.shake.addTrauma(FEEL.traumaKill);
  }

  private onPlayerDamaged(amount: number, from: THREE.Vector3): void {
    void amount;
    this.hud.setHealth(this.player.health);
    this.hud.damageFrom(Math.atan2(from.x - this.player.position.x, from.z - this.player.position.z));
    this.shake.addTrauma(FEEL.traumaHit);
    this.fovKick.punch(-FEEL.fovKickHit);
    this.audio.playerHurt();
  }

  /** Bearing of a world point relative to where the player is looking, for the
   *  audio pan. 0 = dead ahead, +π/2 = hard right. */
  private bearingTo(p: THREE.Vector3): number {
    const dx = p.x - this.player.position.x;
    const dz = p.z - this.player.position.z;
    return Math.atan2(dx, dz) - (this.player.yaw + Math.PI);
  }

  // ---------------------------------------------------------------- frame

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const rawDt = now - this.lastFrame;
    const dt = Math.min(rawDt / 1000, 0.05);
    this.lastFrame = now;
    this.elapsed += dt;
    // Rolling 120-frame window of real wall-clock frame times. This is the only
    // honest way to answer "does the post-processing hold 60 fps on this
    // machine" — a question the milestone asks explicitly, and one that a
    // screenshot cannot answer.
    this.frameTimes[this.frameTimeIndex] = rawDt;
    this.frameTimeIndex = (this.frameTimeIndex + 1) % this.frameTimes.length;
    this.frameTimeCount = Math.min(this.frameTimeCount + 1, this.frameTimes.length);

    const timeScale = this.hitstop.update(dt);
    const gameplayDt = dt * timeScale;

    if (this.phase === 'playing') this.updatePlaying(dt, gameplayDt);

    // Real-delta systems: feedback must stay live during hitstop.
    this.shake.update(dt);
    this.playerTracers.update(dt);
    this.enemyTracers.update(dt);
    this.impacts.update(dt);
    this.hud.update(dt, this.player.yaw);

    this.updateCamera(dt);
    this.updateViewmodel(dt);
    this.render();
    this.input.endFrame();
  };

  private updatePlaying(dt: number, gameplayDt: number): void {
    this.missionTime += gameplayDt;

    // ---- inspect toggle ---------------------------------------------------
    if (this.input.wasPressed('inspect')) this.toggleInspect();
    if (this.input.wasPressed('pause')) this.pause();

    // ---- look -------------------------------------------------------------
    const look = this.input.takeLook();
    const drag = this.input.takeDrag();
    if (this.inspect) {
      this.orbitYaw -= (look.x + drag.x) * LOOK.sensitivity * 1.4;
      this.orbitPitch = clamp(
        this.orbitPitch + (look.y + drag.y) * LOOK.sensitivity * 1.4,
        -0.5,
        1.2,
      );
      // Slow auto-orbit when the player is not driving it, so the inspect view
      // shows the whole model without input.
      if (Math.abs(look.x) + Math.abs(drag.x) < 0.5) this.orbitYaw += dt * 0.35;
    } else {
      this.player.applyLook(look.x, look.y);
      const invDt = dt > 1e-5 ? 1 / dt : 0;
      this.lookVelX = damp(this.lookVelX, look.x * LOOK.sensitivity * invDt, 0.05, dt);
      this.lookVelY = damp(this.lookVelY, look.y * LOOK.sensitivity * invDt, 0.05, dt);
    }

    const canAct = !this.inspect && !this.player.dead;

    // ---- player -----------------------------------------------------------
    this.player.update(gameplayDt, this.input, canAct);
    if (this.player.landedImpact > PLAYER.landSoftSpeed) {
      const k = clamp(
        (this.player.landedImpact - PLAYER.landSoftSpeed) /
          (PLAYER.landHardSpeed - PLAYER.landSoftSpeed),
        0,
        1,
      );
      this.landDip = -0.06 - k * 0.11;
      this.shake.addTrauma(FEEL.traumaLand * (0.4 + k));
      this.audio.land(0.35 + k);
    }

    // ---- footsteps ---------------------------------------------------------
    // Cadence is driven by DISTANCE TRAVELLED, not by a timer: one step per
    // 0.82 m of stride at every speed, which is why a sprint sounds faster than
    // a walk without a single rate constant anywhere. Crouching shortens the
    // stride and softens the step, so sneaking is audibly different — which
    // matters, because the AI's perception is real (DECISIONS §7.6) and the
    // player needs the audio to agree with what the soldiers can tell.
    if (this.player.grounded && this.player.speed > 0.7) {
      const stride = this.player.crouching ? 0.62 : this.player.sprinting ? 0.95 : 0.82;
      this.stepDistance += this.player.speed * gameplayDt;
      if (this.stepDistance >= stride) {
        this.stepDistance -= stride;
        this.stepLeft = !this.stepLeft;
        // Alternate the foot: a small pan and pitch offset per side. Two
        // identical footsteps in a row read as one sound played twice, which is
        // exactly what a footstep loop must not sound like.
        this.audio.footstep(!this.player.crouching, 0, this.stepLeft ? -0.5 : 0.5);
      }
    } else {
      this.stepDistance = Math.min(this.stepDistance, 0.55);
    }

    // ---- weapon -----------------------------------------------------------
    this.player.ads = canAct && this.input.isDown('ads') && !this.player.sprinting;
    this.rifle.adsWanted = this.player.ads;
    if (canAct && this.input.wasPressed('reload')) this.rifle.startReload();
    if (canAct && this.player.sprinting && this.rifle.adsT > 0) this.rifle.adsWanted = false;

    this.rifle.update(gameplayDt, {
      moving: this.player.speed > 0.6,
      sprinting: this.player.sprinting,
      grounded: this.player.grounded,
      crouching: this.player.crouching,
    });

    if (canAct && this.input.isDown('fire') && !this.player.sprinting) {
      this.fireOnce();
    }
    // Auto-reload when the mag runs dry and the trigger is still held.
    if (canAct && this.rifle.mag === 0 && !this.rifle.reloading && this.rifle.reserve > 0) {
      this.rifle.startReload();
    }

    // ---- enemies + doctrine audit ----------------------------------------
    // In a co-op room the SERVER owns the AI, so the authoritative state is
    // adopted before the visual update and the local state machine never runs.
    // The doctrine audit below still runs, and still means something: it is now
    // auditing the SERVER's soldiers through the snapshot, so a server that
    // let a soldier fire while moving would go red on every client.
    if (this.net?.online) this.applyNetworkEnemies();

    let alive = 0;
    for (const e of this.enemies) {
      e.update(gameplayDt);
      if (e.alive) alive++;
      if (STATIONARY_COMBAT_STATES.has(e.state) && e.speed > ENEMY.stoppedSpeed) {
        this.aiViolations++;
        this.aiWorstSpeedWhileFiring = Math.max(this.aiWorstSpeedWhileFiring, e.speed);
      }
    }
    if (this.net?.online) {
      alive = this.net.hostilesAlive;
      this.updateRemotePlayers(dt);
      // The server owns damage, so it owns health. Local damage is not applied
      // in a room (see `onPlayerDamaged`'s guard) and this is the only writer.
      const hp = this.net.selfHealth();
      if (hp !== null) this.player.setHealth(hp);
      this.net.sendInput({
        position: this.player.position,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        flags:
          (this.player.speed > 0.6 ? PF.MOVING : 0) |
          (this.player.sprinting ? PF.SPRINTING : 0) |
          (this.player.crouching ? PF.CROUCHING : 0) |
          (this.rifle.adsT > 0.5 ? PF.AIMING : 0) |
          (this.player.dead ? PF.DEAD : 0),
      });
    }

    // ---- HUD ---------------------------------------------------------------
    this.hud.setAmmo(this.rifle.mag, this.rifle.reserve);
    this.hud.setReload(this.rifle.reloadProgress);
    this.hud.setHostiles(alive);
    this.hud.setTimer(this.missionTime);
    this.hud.setAds(this.rifle.adsT > 0.6);
    this.hud.setCrosshairSpread(this.rifle.spread, this.fov, this.renderer.domElement.clientHeight);
    this.hud.setHealth(this.player.health);

    // In a room the SERVER decides when the compound is clear, so a client that
    // has not yet received the last kill does not declare victory early.
    if (this.net?.online) {
      if (this.net.phase === 'won') this.endMission(true);
      else if (this.net.phase === 'lost') this.endMission(false);
    } else if (alive === 0) {
      this.endMission(true);
    }
  }

  /** Adopt the authoritative enemy states from the interpolated snapshot. */
  private applyNetworkEnemies(): void {
    const states = this.net!.enemies();
    for (const s of states) {
      // Enemy ids are assigned by a module-level counter that both processes
      // run, but a client that has restarted has a different offset — so match
      // by INDEX within the room's fixed-size roster rather than by raw id.
      const e = this.enemies[(s.id - 1) % this.enemies.length];
      if (e) e.applyNetworkState({ ...s, state: s.state });
    }
  }

  /** Spawn, update and DESPAWN teammates from the snapshot's player list. */
  private updateRemotePlayers(dt: number): void {
    const seen = new Set<string>();
    for (const rp of this.net!.remotePlayers()) {
      seen.add(rp.id);
      let remote = this.remotes.get(rp.id);
      if (!remote) {
        remote = new RemotePlayer(rp, this.scene, this.assets);
        this.remotes.set(rp.id, remote);
      }
      remote.update(dt, rp);
    }
    // ANYONE ABSENT FROM THE SNAPSHOT IS GONE. Despawn is derived from the
    // authoritative player list rather than from a 'left' message, so a dropped
    // packet cannot leave a ghost teammate standing in the compound forever.
    for (const [id, remote] of this.remotes) {
      if (seen.has(id)) continue;
      remote.dispose(this.scene);
      this.remotes.delete(id);
    }
  }

  private fireOnce(): void {
    if (!this.rifle.canFire && this.rifle.mag > 0) return;
    // FIRE ALONG THE AUTHORITATIVE AIM, NOT THE CAMERA MATRIX.
    //
    // `updateCamera()` runs LATER in the frame than `updatePlaying()`, so
    // reading `camera.getWorldDirection()` here returns the orientation from the
    // PREVIOUS frame — every shot in the game was fired along a one-frame-stale
    // aim. At 60 Hz with a fast flick that is a real miss, and it is invisible
    // because the tracer is drawn along the same stale direction, so the round
    // goes exactly where the picture says it went.
    //
    // It surfaced as a FLAKY hit-registration assertion (8 rounds, 0-1 hits,
    // different every run) rather than as a reported bug — which is the useful
    // part: a flake is usually a defect with a quiet voice. Fixed at the source
    // rather than retried, per the M1 rule.
    //
    // The expression is the same YXZ basis `updateCamera` builds, so the camera
    // and the bullet cannot disagree.
    const pitch = this.player.pitch + this.rifle.recoilPitch;
    const yaw = this.player.yaw + this.rifle.recoilYaw;
    const cp = Math.cos(pitch);
    this.tmpDir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
    // THE SERVER DECIDES WHAT THIS HIT. The local resolution still runs so the
    // shooter gets instant tracer/impact/recoil feedback (that is the prediction
    // that makes a shooter feel responsive), but in a room the DAMAGE is
    // discarded — `onPlayerHitTarget` returns early — and the authoritative
    // result arrives as a `hit`/`kill` message a round-trip later.
    if (this.net?.online) this.net.sendFire(this.player.eyePosition, this.tmpDir);
    this.rifle.fire(this.player.eyePosition, this.tmpDir, this.enemies, (pitch, yaw) => {
      this.player.pitch = clamp(this.player.pitch + pitch, LOOK.pitchMin, LOOK.pitchMax);
      this.player.yaw += yaw;
    });
  }

  // --------------------------------------------------------------- camera

  private updateCamera(dt: number): void {
    this.landDip = damp(this.landDip, 0, 0.1, dt);

    if (this.overview) {
      // Debug/authoring view: top-down over the compound. Used for the arena
      // layout screenshot and for eyeballing AI pathing.
      this.camera.position.set(0, 52, 0.001);
      this.camera.lookAt(0, 0, 0);
      this.setFov(60);
      return;
    }

    if (this.inspect) {
      const focus = this.tmpV.set(
        this.player.position.x,
        this.player.position.y + 1.0,
        this.player.position.z,
      );
      const cy = Math.cos(this.orbitPitch);
      this.tmpDir
        .set(
          Math.sin(this.orbitYaw) * cy,
          Math.sin(this.orbitPitch),
          Math.cos(this.orbitYaw) * cy,
        )
        .normalize();
      // Pull the orbit camera in when a wall is in the way — an inspect view
      // that ends up inside the geometry inspects nothing.
      const blocked = this.collision.raycast(focus, this.tmpDir, this.orbitDist + 0.35);
      const dist = blocked ? Math.max(1.2, blocked.distance - 0.35) : this.orbitDist;
      this.camera.position.copy(focus).addScaledVector(this.tmpDir, dist);
      this.camera.lookAt(focus);
      this.fovBase = damp(this.fovBase, CAMERA.fov, CAMERA.fovTau, dt);
      this.setFov(this.fovBase);
      return;
    }

    const eye = this.player.eyePosition;
    this.camera.position.set(
      eye.x + this.shake.offset.x,
      eye.y + this.shake.offset.y + this.landDip,
      eye.z + this.shake.offset.z,
    );
    this.euler.set(
      this.player.pitch + this.rifle.recoilPitch,
      this.player.yaw + this.rifle.recoilYaw,
      this.shake.roll,
    );
    this.camera.quaternion.setFromEuler(this.euler);

    // FOV: ADS pull + sprint widen are SMOOTHED state; the kick is ADDITIVE on
    // top. They are kept in separate variables on purpose — feeding the kick
    // back into the smoothing filter makes a damage kick permanently drag the
    // resting FOV, which is exactly the kind of drift that is invisible in a
    // screenshot and awful to play.
    const sprintT = this.player.sprinting ? 1 : 0;
    const target =
      CAMERA.fov + (CAMERA.adsFov - CAMERA.fov) * this.rifle.adsT + CAMERA.sprintFovBonus * sprintT;
    this.fovBase = damp(this.fovBase, target, CAMERA.fovTau, dt);
    this.setFov(this.fovBase + this.fovKick.update(dt));
  }

  private setFov(value: number): void {
    this.fov = value;
    if (Math.abs(this.camera.fov - value) > 1e-4) {
      this.camera.fov = value;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateViewmodel(dt: number): void {
    this.viewmodel.update(dt, {
      adsT: this.rifle.adsT,
      sprintT: this.player.sprinting ? 1 : 0,
      speedNorm: clamp(this.player.speed / PLAYER.sprintSpeed, 0, 1),
      moving: this.player.speed > 0.5,
      grounded: this.player.grounded,
      lookVelX: this.lookVelX,
      lookVelY: this.lookVelY,
      reloadProgress: this.rifle.reloadProgress,
      elapsed: this.elapsed,
    });

    // The avatar is only visible in the inspect camera, but it is updated every
    // frame so the pose is correct the instant T is pressed.
    this.avatar.update(dt, this.player.position, this.player.yaw, {
      speed: this.player.speed,
      locomotion: clamp(this.player.speed / PLAYER.sprintSpeed, 0, 1),
      stance: !this.player.grounded ? 'air' : this.player.crouching ? 'crouch' : 'stand',
      pitch: this.player.pitch,
      firing: false,
      // The avatar's aim pose is driven by ADS, which is the player-side
      // equivalent of the enemy doctrine's planted combat states.
      aiming: this.rifle.adsT > 0.5,
      reloading: this.rifle.reloading,
      dead: this.player.dead,
      elapsed: this.elapsed,
    });
  }

  private toggleInspect(): void {
    this.inspect = !this.inspect;
    this.avatar.setVisible(this.inspect);
    this.screens.setInspectBanner(this.inspect);
    document.body.classList.toggle('inspect', this.inspect);
    this.hud.setCrosshairVisible(!this.inspect);
    if (this.inspect) {
      this.orbitYaw = this.player.yaw + Math.PI;
      this.orbitPitch = 0.28;
    }
  }

  // --------------------------------------------------------------- render

  /**
   * FRAME LUMINANCE — the exposure gate.
   *
   * M1's single worst bug was a level that rendered BLACK because the sun was
   * at 11°, and the only reason it was caught was that a human looked at a PNG.
   * M2 introduces a real HDRI, an explicit tone-mapping exposure and two IBL
   * intensities — four more ways to end up with a frame that is technically
   * correct and visually unusable, and none of them throw.
   *
   * So the presented frame is MEASURED. This samples the actual composited
   * canvas (both passes, after tone mapping, exactly what a screenshot would
   * capture) and returns its luminance distribution. `tools/smoke.mjs` asserts
   * the mean sits in a readable band and that the frame is not mostly crushed
   * to black or blown to white. "Too dark to play" is now a failing test rather
   * than a thing someone notices.
   */
  requestFrameStats(): Promise<FrameStats> {
    return new Promise((resolve) => {
      this.pendingFrameStats.push(resolve);
    });
  }

  private readonly pendingFrameStats: Array<(s: FrameStats) => void> = [];
  private statsCanvas: HTMLCanvasElement | null = null;

  private captureFrameStats(): void {
    if (!this.pendingFrameStats.length) return;
    const W = 192;
    const H = 108;
    if (!this.statsCanvas) {
      this.statsCanvas = document.createElement('canvas');
      this.statsCanvas.width = W;
      this.statsCanvas.height = H;
    }
    const ctx = this.statsCanvas.getContext('2d', { willReadFrequently: true });
    const waiting = this.pendingFrameStats.splice(0);
    if (!ctx) {
      for (const r of waiting) r({ mean: 0, dark: 1, bright: 0, ok: false });
      return;
    }
    // Sampled INSIDE the frame callback, immediately after both render passes,
    // so the drawing buffer is still valid without paying for
    // `preserveDrawingBuffer` on every frame of normal play.
    ctx.drawImage(this.canvas, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    let sum = 0;
    let dark = 0;
    let bright = 0;
    const n = W * H;
    for (let i = 0; i < data.length; i += 4) {
      const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      sum += l;
      if (l < 0.02) dark++;
      if (l > 0.98) bright++;
    }
    const stats: FrameStats = {
      mean: sum / n,
      dark: dark / n,
      bright: bright / n,
      ok: true,
    };
    for (const r of waiting) r(stats);
  }

  private render(): void {
    // The composer draws BOTH scenes (see `fx/postfx.ts`'s ScenePass) because
    // the depth clear between them is load-bearing. When post-processing is off
    // — the settings toggle, and the path the smoke suite also boots — the
    // original M1/M2 direct render runs instead, unchanged.
    if (!this.postfx.render(!this.inspect)) {
      this.renderer.render(this.scene, this.camera);
      if (!this.inspect) {
        // Second pass: the viewmodel, in its own scene and camera, on a cleared
        // depth buffer. This is what makes it impossible for the gun to clip
        // through geometry or be lit by the world.
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
        this.renderer.autoClear = true;
      }
    }
    this.captureFrameStats();
  }

  private readonly onResize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodel.setAspect(w / h);
    this.postfx?.setSize(w, h, dpr);
  };

  // ------------------------------------------------------------ test API

  /** Everything a scripted playtest needs, in one snapshot. */
  snapshot(): unknown {
    return {
      phase: this.phase,
      inspect: this.inspect,
      missionTime: this.missionTime,
      score: this.score,
      kills: this.kills,
      aiViolations: this.aiViolations,
      aiWorstSpeedWhileFiring: this.aiWorstSpeedWhileFiring,
      hostilesAlive: this.enemies.filter((e) => e.alive).length,
      player: {
        x: this.player.position.x,
        y: this.player.position.y,
        z: this.player.position.z,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        health: this.player.health,
        speed: this.player.speed,
        grounded: this.player.grounded,
        sprinting: this.player.sprinting,
        crouching: this.player.crouching,
        dead: this.player.dead,
        eyeHeight: this.player.eyeHeight,
      },
      weapon: {
        mag: this.rifle.mag,
        reserve: this.rifle.reserve,
        reloading: this.rifle.reloading,
        reloadProgress: this.rifle.reloadProgress,
        adsT: this.rifle.adsT,
        spread: this.rifle.spread,
        shotsFired: this.rifle.shotsFired,
        shotsHit: this.rifle.shotsHit,
      },
      camera: { fov: this.camera.fov, fovBase: this.fovBase },
      enemies: this.enemies.map((e) => ({
        id: e.id,
        state: e.state,
        alive: e.alive,
        health: e.health,
        speed: e.speed,
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
        yaw: e.yaw,
      })),
      nav: { nodes: this.nav.nodes.length },
      arena: { size: ARENA.size, propsPlaced: this.arena.propsPlaced },
      viewmodelBudget: VIEWMODEL.maxScreenCoverage,
      postfx: { enabled: this.postfx.enabled, ao: this.postfx.ao },
      audio: { ready: this.audio.ready, error: this.audio.error, muted: this.audio.muted },
      // The carbine's OWN measurements, surfaced so a bad fit is visible in the
      // snapshot rather than only in a screenshot.
      carbine: this.carbine
        ? { fitted: true, ...this.carbine.stats }
        : { fitted: false, vertices: 0, lengthMetres: 0, opticX: 0, opticY: 0, magazineTriangles: 0 },
      assets: {
        requested: this.assetReport.requested,
        loaded: this.assetReport.loaded,
        failed: this.assetReport.failed.map((f) => f.url),
        ms: this.assetReport.ms,
        skySource: this.skySource,
        soldierClips: [...this.assets.soldierClips.keys()],
      },
    };
  }

  measureViewmodelCoverage(): number {
    return this.viewmodel.measureScreenCoverage(this.renderer);
  }

  /**
   * Wire the start screen's HOST / JOIN controls.
   *
   * Guarded on the elements existing: the co-op panel is markup, and a build
   * that strips it must still boot into single player rather than throwing
   * during construction.
   */
  private bindCoopUi(): void {
    const $ = <T extends HTMLElement>(id: string): T | null =>
      document.getElementById(id) as T | null;
    const nameEl = $<HTMLInputElement>('coop-name');
    const codeEl = $<HTMLInputElement>('coop-code');
    const hostBtn = $<HTMLButtonElement>('coop-host');
    const joinBtn = $<HTMLButtonElement>('coop-join');
    const statusEl = $('coop-status');
    if (!hostBtn || !joinBtn || !statusEl) return;

    const callsign = (): string =>
      (nameEl?.value || '').trim() || `SOLDIER ${Math.floor(Math.random() * 90 + 10)}`;

    const paint = (): void => {
      const c = this.coopStatus();
      statusEl.classList.remove('live', 'bad');
      if (c.status === 'connected') {
        statusEl.classList.add('live');
        statusEl.textContent =
          `ROOM ${c.room} · ${c.players} in the compound · share the code`;
      } else if (c.status === 'connecting') {
        statusEl.textContent = 'Connecting…';
      } else if (c.status === 'error') {
        statusEl.classList.add('bad');
        statusEl.textContent = `${c.error ?? 'connection failed'} — playing solo`;
      } else {
        statusEl.textContent = 'Playing solo · the server is optional';
      }
    };

    hostBtn.addEventListener('click', () => {
      this.joinCoop(null, callsign());
      this.net!.onStatus = (st) => {
        if (st === 'connected') for (const e of this.enemies) e.setNetworked(true);
        paint();
      };
      paint();
    });
    joinBtn.addEventListener('click', () => {
      const code = (codeEl?.value || '').trim().toUpperCase();
      this.joinCoop(code || null, callsign());
      this.net!.onStatus = (st) => {
        if (st === 'connected') for (const e of this.enemies) e.setNetworked(true);
        paint();
      };
      paint();
    });
    setInterval(paint, 700);
  }

  // ------------------------------------------------------------------- co-op

  /**
   * Host or join a room.
   *
   * `room = null` creates one and the server allocates the code. Everything is
   * fire-and-forget: a failure to connect leaves the game exactly as it was,
   * playing offline, with the reason on `net.error`.
   */
  joinCoop(room: string | null, name: string, url = defaultServerUrl()): void {
    this.leaveCoop();
    const net = new NetClient();
    this.net = net;

    net.onKill = (k) => {
      // THE SHARED KILL FEED. Every client renders the same event, including
      // kills made by other players, because the event comes from the one
      // process that validated it.
      const mine = k.byId === net.selfId;
      this.hud.addKill(
        `HOSTILE ${String(k.enemyId).padStart(2, '0')}`,
        k.headshot,
        mine ? 'YOU' : k.byName,
      );
      if (mine) {
        this.kills++;
        this.score += k.headshot ? MISSION.scoreHeadshot : MISSION.scoreKill;
        this.hud.hitMarker(true);
        this.audio.hitConfirm(true);
        this.hitstop.trigger(FEEL.hitstopKillMs);
        this.shake.addTrauma(FEEL.traumaKill);
      }
    };
    net.onHit = (_enemyId, killed) => {
      if (!killed) {
        this.hud.hitMarker(false);
        this.audio.hitConfirm(false);
      }
    };
    net.onJoined = (who) => this.hud.showPrompt(`${who} JOINED`);
    net.onLeft = (who) => this.hud.showPrompt(`${who} LEFT`);
    net.onStatus = (st) => {
      if (st === 'connected') {
        for (const e of this.enemies) e.setNetworked(true);
        this.hud.showPrompt(`ROOM ${net.room}`);
      }
    };
    net.connect(url, room, name);
  }

  /** Drop back to single player. Always safe, even if never connected. */
  leaveCoop(): void {
    for (const [, r] of this.remotes) r.dispose(this.scene);
    this.remotes.clear();
    for (const e of this.enemies) e.setNetworked(false);
    this.net?.disconnect();
    this.net = null;
  }

  /** What the kill feed currently shows. Test surface for the shared feed. */
  killFeedEntries(): string[] {
    return this.hud.feedEntries();
  }

  /**
   * Where each teammate's avatar is actually DRAWN this frame.
   *
   * Deliberately the RENDERED transform (`group.position`), not the newest wire
   * value. The interpolation assertion is only worth anything if it measures
   * what the eye sees: reading the snapshot back would prove the packets
   * arrived at 15 Hz, which was never in doubt, and would say nothing about
   * whether the avatar stair-steps between them.
   */
  remoteAvatars(): Array<{ id: string; name: string; x: number; y: number; z: number; yaw: number }> {
    const out = [];
    for (const r of this.remotes.values()) {
      out.push({
        id: r.id,
        name: r.name,
        x: r.group.position.x,
        y: r.group.position.y,
        z: r.group.position.z,
        yaw: r.group.rotation.y,
      });
    }
    return out;
  }

  coopStatus(): {
    online: boolean;
    status: string;
    room: string | null;
    id: string | null;
    name: string;
    players: number;
    remotes: number;
    error: string | null;
  } {
    return {
      online: this.net?.online ?? false,
      status: this.net?.status ?? 'offline',
      room: this.net?.room ?? null,
      id: this.net?.selfId ?? null,
      name: this.net?.name ?? '',
      players: this.net?.playerCount() ?? (this.net ? 0 : 1),
      remotes: this.remotes.size,
      error: this.net?.error ?? null,
    };
  }

  /**
   * The ADS alignment, as a number.
   *
   * Returns the optic's position in normalised device coordinates. Call it once
   * the ADS pose has settled and it must be (0, 0). See
   * `Viewmodel.projectOptic()` for why this assertion is the one that keeps
   * DECISIONS §2.5 honest now that the weapon is a generated mesh.
   */
  opticNdc(): { x: number; y: number } {
    return this.viewmodel.projectOptic();
  }

  /** Is the ADS sight line clear through the optic's aperture? */
  opticClear(): { clear: boolean; blockedBy: string | null; distance: number } {
    return this.viewmodel.probeSightLine();
  }

  /** Mean/95th-percentile frame time over the rolling window, plus the fps. */
  frameCost(): { meanMs: number; p95Ms: number; fps: number; samples: number } {
    const n = this.frameTimeCount;
    if (n === 0) return { meanMs: 0, p95Ms: 0, fps: 0, samples: 0 };
    const slice = Array.from(this.frameTimes.slice(0, n)).sort((a, b) => a - b);
    const mean = slice.reduce((a, b) => a + b, 0) / n;
    const p95 = slice[Math.min(n - 1, Math.floor(n * 0.95))];
    return { meanMs: mean, p95Ms: p95, fps: mean > 0 ? 1000 / mean : 0, samples: n };
  }

  /** Reset the frame-time window — call before timing a specific configuration. */
  resetFrameCost(): void {
    this.frameTimeCount = 0;
    this.frameTimeIndex = 0;
  }

  setPostFx(on: boolean): void {
    this.postfx.enabled = on;
  }

  setAo(on: boolean): void {
    this.postfx.setAo(on);
  }

  /** Enable/disable individual post-processing stages, for cost measurement. */
  setPostFxParts(parts: { bloom?: boolean; smaa?: boolean }): void {
    this.postfx.setParts(parts);
  }

  setAudioMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  /** Initialise audio without a gesture — the smoke suite asserts this is safe. */
  initAudio(): { ready: boolean; error: string | null } {
    this.audio.init();
    return { ready: this.audio.ready, error: this.audio.error };
  }

  /**
   * Enclosure proof: cast rays outward from a grid of interior points in 16
   * compass directions and confirm every one is stopped by geometry inside the
   * arena bound. The pipeline shipped a compound with a missing wall.
   */
  auditEnclosure(): { samples: number; leaks: Array<{ x: number; z: number; angle: number }> } {
    const leaks: Array<{ x: number; z: number; angle: number }> = [];
    const dir = new THREE.Vector3();
    const origin = new THREE.Vector3();
    let samples = 0;
    for (let x = -16; x <= 16; x += 8) {
      for (let z = -16; z <= 16; z += 8) {
        for (let a = 0; a < 16; a++) {
          const angle = (a / 16) * Math.PI * 2;
          for (const y of [0.4, 1.6, 3.4, 5.4]) {
            origin.set(x, y, z);
            dir.set(Math.cos(angle), 0, Math.sin(angle));
            samples++;
            const hit = this.collision.raycast(origin, dir, ARENA.size * 1.6);
            if (!hit) leaks.push({ x, z, angle });
          }
        }
      }
    }
    return { samples, leaks };
  }

  testInput(): Input {
    return this.input;
  }

  forceFire(): void {
    this.fireOnce();
  }

  /**
   * Move the player to a column and drop them onto the highest STANDABLE
   * surface there (terrace, crate, floor) rather than the literal y they were
   * at — teleporting inside a solid deck is not a useful test state.
   */
  teleport(x: number, z: number): void {
    const surface = this.collision.groundHeight(x, z, PLAYER.radius, 4.2, 0);
    this.player.position.set(x, surface > -Infinity ? surface : 0, z);
    this.player.velocity.set(0, 0, 0);
    // PUSH OUT OF GEOMETRY.
    //
    // M2 added real props (a watchtower, an antenna mast, six oil drums) and
    // therefore eight new colliders, and the M1 teleport resolved only the
    // VERTICAL axis. A teleport that lands inside a solid box leaves the player
    // embedded in it, and then every shot they take immediately hits the inside
    // face of that box at ~0 m — which is precisely how the hit-registration
    // assertion started failing after the art pass, with no error anywhere.
    //
    // Fixing the teleport rather than the assertion is the rule: the assertion
    // was right, the engine was wrong. A teleport that can strand the player
    // inside the level is a real defect, test-only entry point or not.
    this.collision.resolveHorizontal(
      this.player.position,
      PLAYER.radius,
      PLAYER.height,
      this.player.position.y,
      PLAYER.stepHeight,
    );
  }

  /**
   * Does the player currently have an unobstructed line to this hostile's chest?
   *
   * Test-support API in the same family as `auditEnclosure()`: it runs the
   * engine's OWN `hasLineOfSight` against the real collision world rather than
   * letting the harness guess. The hit-registration assertion needs a firing
   * position that is actually clear — without this it was choosing a stand-off
   * bearing geometrically and sometimes landing behind the bunker, which turned
   * a hit-registration test into a coin flip about cover.
   */
  hasLosTo(enemyId: number): boolean {
    const e = this.enemies.find((x) => x.id === enemyId);
    if (!e) return false;
    e.chest(this.tmpV);
    const eye = this.player.eyePosition;
    return this.collision.hasLineOfSight(eye, this.tmpV);
  }

  setPlayerAim(yaw: number, pitch: number): void {
    this.player.yaw = yaw;
    this.player.pitch = pitch;
  }

  damagePlayer(n: number): void {
    this.player.takeDamage(n, this.tmpV.set(this.player.position.x + 5, 0, this.player.position.z));
  }

  killAllEnemies(): void {
    for (const e of this.enemies) if (e.alive) e.takeDamage(9999, false);
  }

  setOverview(on: boolean): void {
    this.overview = on;
  }

  setInvulnerable(on: boolean): void {
    this.invulnerable = on;
  }

  setInspect(on: boolean): void {
    if (this.inspect !== on) this.toggleInspect();
  }
}

/**
 * Where the co-op server lives, by default.
 *
 * Derived from the page rather than hardcoded, so the same build works in dev
 * and behind any host in a deploy, and so the smoke harness can point two
 * clients at one server via `?server=` without a special build.
 */
export function defaultServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('server');
  if (explicit) return explicit;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.hostname}:8787`;
}
