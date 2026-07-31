import * as THREE from 'three';
import { ENEMY, MISSION, PLAYER, WEAPON } from '../src/config';
import { Enemy, type EnemyContext } from '../src/ai/enemy';
import { NavGraph } from '../src/ai/navgraph';
import { CollisionWorld, rayCapsule, raySphere } from '../src/world/collision';
import { addArenaColliders, arenaLayout, type ArenaLayout } from '../src/world/arenaSpec';
import {
  PF,
  SNAPSHOT_HZ,
  type EnemyWire,
  type PlayerWire,
  type ServerMessage,
  type Snapshot,
} from '../src/net/protocol';

/**
 * One co-op room: an authoritative copy of the compound and its hostiles.
 *
 * THE HEADLINE: this runs the game's OWN `Enemy`, `NavGraph`, `CollisionWorld`
 * and `arenaLayout()` — not a server-side reimplementation of them. There is no
 * second AI, no second collision model, no second set of collider boxes. The
 * server imports the same modules the browser does and gets the same 106 box
 * specs and the same 328 nav waypoints, because M1's "one spec list drives
 * geometry AND collision" rule was extended in M4 to span two processes rather
 * than being copied across them (see `world/arenaSpec.ts`).
 *
 * That is the whole reason this file is short. A multiplayer server that
 * reimplements its game's AI is a second game that has to be kept in sync with
 * the first by hand, and it diverges the first time somebody tunes a number.
 */

const TICK_HZ = 60;
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;
/** Drop a client that has not sent anything for this long. */
const TIMEOUT_MS = 15000;

export interface RoomPlayer {
  id: string;
  name: string;
  send(msg: ServerMessage): void;
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  health: number;
  flags: number;
  score: number;
  kills: number;
  lastSeen: number;
  alive: boolean;
}

export class Room {
  readonly code: string;
  private readonly collision = new CollisionWorld();
  private readonly nav: NavGraph;
  private readonly layout: ArenaLayout;
  /** A scene the server never renders. `Enemy` builds a few meshes for its
   *  fallback visual; nothing here ever reaches a GPU, and constructing a
   *  `THREE.Mesh` is pure arithmetic. Paying that is far cheaper than forking
   *  `Enemy` into a headless twin that would need keeping in step. */
  private readonly scene = new THREE.Scene();

  readonly players = new Map<string, RoomPlayer>();
  private enemies: Enemy[] = [];
  private phase: Snapshot['phase'] = 'lobby';
  private missionTime = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private sinceSnapshot = 0;

  /**
   * WHICH PLAYER IS THIS ENEMY FIGHTING?
   *
   * `EnemyContext` was written for single-player and exposes one `playerFeet()`.
   * Rather than widen that interface — and change the single-player code path
   * that three milestones of assertions are built on — the server sets this
   * cursor immediately before each `enemy.update()`. `Enemy` calls `playerFeet()`
   * synchronously inside that call, so the cursor is exact.
   *
   * It is a small deliberate coupling and it is written down because it is the
   * kind of thing that looks like a bug later: the alternative was a signature
   * change rippling through `ai/enemy.ts`, `game.ts` and the doctrine assertions.
   */
  private target: RoomPlayer | null = null;
  private readonly farAway = new THREE.Vector3(0, -999, 0);

  constructor(code: string) {
    this.code = code;
    this.layout = arenaLayout();
    addArenaColliders(this.collision, this.layout);
    this.nav = new NavGraph(this.collision);
    this.reset();
  }

  get empty(): boolean {
    return this.players.size === 0;
  }

  // ------------------------------------------------------------------ mission

  reset(): void {
    for (const e of this.enemies) e.dispose();
    this.enemies = [];

    const ctx: EnemyContext = {
      collision: this.collision,
      nav: this.nav,
      playerFeet: () => this.target?.position ?? this.farAway,
      playerAlive: () => this.target?.alive ?? false,
      onEnemyShot: () => {
        /* tracers are cosmetic and reconstructed client-side from enemy state */
      },
      onEnemyMuzzle: () => {},
      onPlayerDamaged: (amount) => {
        const p = this.target;
        if (!p || !p.alive) return;
        p.health = Math.max(0, p.health - amount);
        if (p.health <= 0) {
          p.alive = false;
          p.flags |= PF.DEAD;
        }
      },
      onEnemyKilled: () => {
        /* handled where the shot is validated, so the killer is known */
      },
    };

    for (let i = 0; i < ENEMY.count; i++) {
      const spawn = this.layout.enemySpawns[i % this.layout.enemySpawns.length];
      this.enemies.push(new Enemy(ctx, spawn.clone(), this.scene));
    }
    this.missionTime = 0;
    for (const p of this.players.values()) {
      p.health = PLAYER.maxHealth;
      p.alive = true;
      p.flags = 0;
      p.position.copy(this.layout.playerSpawn);
    }
    this.phase = this.players.size > 0 ? 'playing' : 'lobby';
  }

  // -------------------------------------------------------------------- join

  add(player: RoomPlayer): void {
    player.position.copy(this.layout.playerSpawn);
    player.yaw = this.layout.playerYaw;
    player.health = PLAYER.maxHealth;
    player.alive = true;
    this.players.set(player.id, player);
    this.broadcast({ t: 'joined', id: player.id, name: player.name }, player.id);
    if (this.phase === 'lobby') this.phase = 'playing';
    this.start();
  }

  remove(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    // The DESPAWN is just this: the player leaves the map, so it leaves every
    // subsequent snapshot, and clients remove any avatar whose id is absent.
    // There is no separate "despawn" message to lose.
    this.broadcast({ t: 'left', id, name: p.name });
    if (this.empty) this.stop();
  }

  // ------------------------------------------------------------------ input

  applyInput(
    id: string,
    m: { x: number; y: number; z: number; yaw: number; pitch: number; flags: number },
  ): void {
    const p = this.players.get(id);
    if (!p) return;
    p.lastSeen = Date.now();
    // CLIENT-AUTHORITATIVE MOVEMENT, by choice — see `net/protocol.ts`. The one
    // thing enforced is that a player cannot re-animate themselves by claiming
    // to be alive; life and death are the server's.
    p.position.set(m.x, m.y, m.z);
    p.yaw = m.yaw;
    p.pitch = m.pitch;
    p.flags = (m.flags & ~PF.DEAD) | (p.alive ? 0 : PF.DEAD);
  }

  /**
   * A client says it fired. The SERVER decides what that hit.
   *
   * This is the assertion that makes the co-op honest: the client sends only an
   * origin and a direction, and every consequence — which enemy, whether it was
   * a head, how much damage, whether it died, who gets the kill — is computed
   * here against the server's own authoritative enemy positions, using the
   * game's own `rayCapsule`/`raySphere` hit volumes. A client can lie about
   * where it is standing; it cannot lie about what it killed.
   */
  applyFire(id: string, o: THREE.Vector3, dir: THREE.Vector3): void {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase !== 'playing') return;
    p.lastSeen = Date.now();
    dir.normalize();

    const worldHit = this.collision.raycast(o, dir, WEAPON.range);
    const maxT = worldHit ? worldHit.distance : WEAPON.range;

    let best: Enemy | null = null;
    let bestT = Infinity;
    let bestHead = false;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const head = raySphere(o, dir, e.position.x, e.position.y + ENEMY.height - 0.14, e.position.z, 0.19, maxT);
      const body = rayCapsule(o, dir, e.position.x, e.position.y, e.position.z, ENEMY.height, ENEMY.radius, maxT);
      const t = head ?? body;
      if (t === null || t >= bestT) continue;
      bestT = t;
      best = e;
      bestHead = head !== null;
    }
    if (!best) return;

    const damage = bestHead ? WEAPON.damage * WEAPON.headshotMultiplier : WEAPON.damage;
    const killed = best.takeDamage(damage, bestHead);
    p.send({ t: 'hit', enemyId: best.id, killed, headshot: bestHead });
    if (killed) {
      p.kills++;
      p.score += bestHead ? MISSION.scoreHeadshot : MISSION.scoreKill;
      // THE SHARED KILL FEED. One event, broadcast to everyone including the
      // shooter, so every client's feed shows the same fight in the same order.
      this.broadcast({
        t: 'kill',
        byId: p.id,
        byName: p.name,
        enemyId: best.id,
        headshot: bestHead,
      });
    }
  }

  // -------------------------------------------------------------------- loop

  private start(): void {
    if (this.tickTimer) return;
    this.lastTick = Date.now();
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  private stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    const now = Date.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.05);
    this.lastTick = now;

    for (const p of this.players.values()) {
      if (now - p.lastSeen > TIMEOUT_MS) this.remove(p.id);
    }

    if (this.phase === 'playing') {
      this.missionTime += dt;
      let alive = 0;
      for (const e of this.enemies) {
        // Set the cursor, then update. See the note on `target`.
        this.target = this.pickTarget(e);
        e.update(dt);
        if (e.alive) alive++;
      }
      this.target = null;
      if (alive === 0 && this.enemies.length) this.phase = 'won';
      else if ([...this.players.values()].every((p) => !p.alive) && this.players.size > 0) {
        this.phase = 'lost';
      }
    }

    this.sinceSnapshot += dt * 1000;
    if (this.sinceSnapshot >= SNAPSHOT_INTERVAL_MS) {
      this.sinceSnapshot = 0;
      this.broadcast({ t: 'snapshot', s: this.snapshot(now) });
    }
  }

  /** Nearest LIVING player. Enemies fight whoever is closest, which is the
   *  simplest rule that produces sane co-op behaviour with 2-4 players. */
  private pickTarget(e: Enemy): RoomPlayer | null {
    let best: RoomPlayer | null = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = p.position.distanceToSquared(e.position);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private snapshot(now: number): Snapshot {
    const players: PlayerWire[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        yaw: p.yaw,
        pitch: p.pitch,
        health: p.health,
        flags: p.flags,
      });
    }
    const enemies: EnemyWire[] = this.enemies.map((e) => ({
      id: e.id,
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      yaw: e.yaw,
      state: e.state,
      health: e.health,
      alive: e.alive,
    }));
    return {
      t: now,
      players,
      enemies,
      hostilesAlive: this.enemies.filter((e) => e.alive).length,
      missionTime: this.missionTime,
      phase: this.phase,
    };
  }

  broadcast(msg: ServerMessage, exceptId?: string): void {
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      try {
        p.send(msg);
      } catch {
        /* a dead socket is reaped by the timeout sweep */
      }
    }
  }

  dispose(): void {
    this.stop();
    for (const e of this.enemies) e.dispose();
    this.enemies = [];
  }
}
