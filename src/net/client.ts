import * as THREE from 'three';
import {
  INPUT_HZ,
  INTERP_DELAY_MS,
  type ClientMessage,
  type EnemyWire,
  type PlayerWire,
  type ServerMessage,
  type Snapshot,
} from './protocol';

/**
 * The client half of the co-op link.
 *
 * DESIGN CONSTRAINT, above everything else: **this file must be removable.**
 * The single-player game does not import it, does not wait for it, and does not
 * change behaviour when the server is absent. `NetClient` is constructed only
 * when the player actually asks to host or join, every failure resolves to
 * "you are offline", and `Game` checks one nullable field. M4's whole risk is
 * that multiplayer quietly becomes load-bearing for a game that was finished
 * without it.
 *
 * ============================================================================
 * SNAPSHOT INTERPOLATION
 * ============================================================================
 *
 * The server sends the world 15 times a second; the client draws it 60 times a
 * second. The naive fix — snap remote entities to the newest snapshot — gives
 * exactly the stutter everybody recognises as "netcode": four identical frames
 * then a jump.
 *
 * So remote players and enemies are rendered at `now - INTERP_DELAY_MS`, which
 * is *between* two snapshots that have already arrived, and their transforms are
 * interpolated between them. Deliberately in the past, deliberately never
 * extrapolated: extrapolation guesses, and a wrong guess has to be corrected,
 * which is a visible snap. Being 120 ms behind is invisible in PvE co-op;
 * guessing wrong is not.
 *
 * Yaw is interpolated the short way round the circle — the one place a naive
 * lerp produces a soldier spinning 350° the wrong way to get 10°.
 */

export type NetStatus = 'offline' | 'connecting' | 'connected' | 'error';

export interface RemotePlayerState {
  id: string;
  name: string;
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  health: number;
  flags: number;
}

export interface NetEnemyState {
  id: number;
  position: THREE.Vector3;
  yaw: number;
  state: EnemyWire['state'];
  health: number;
  alive: boolean;
}

export interface KillEvent {
  byId: string;
  byName: string;
  enemyId: number;
  headshot: boolean;
}

/** How many snapshots to keep. ~1.5 s at 15 Hz — plenty for the delay buffer. */
const BUFFER = 24;

function shortAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class NetClient {
  status: NetStatus = 'offline';
  error: string | null = null;
  selfId: string | null = null;
  room: string | null = null;
  name = '';

  /** Fired when the server confirms a kill by anyone — the SHARED feed. */
  onKill: ((k: KillEvent) => void) | null = null;
  /** Fired when this client's own round is confirmed to have hit. */
  onHit: ((enemyId: number, killed: boolean, headshot: boolean) => void) | null = null;
  onJoined: ((name: string) => void) | null = null;
  onLeft: ((name: string) => void) | null = null;
  onStatus: ((s: NetStatus) => void) | null = null;

  private ws: WebSocket | null = null;
  private readonly buffer: Array<{ recvAt: number; s: Snapshot }> = [];
  private seq = 0;
  private lastInputAt = 0;
  /** Server time minus client time, smoothed — so the render clock can sit in
   *  the server's timeline without either machine's wall clock being trusted. */
  private clockOffset = 0;
  private clockInit = false;

  /** Latest authoritative values that are NOT interpolated (they are discrete). */
  hostilesAlive = 0;
  phase: Snapshot['phase'] = 'lobby';
  missionTime = 0;

  get online(): boolean {
    return this.status === 'connected';
  }

  connect(url: string, room: string | null, name: string): void {
    this.setStatus('connecting');
    this.error = null;
    this.name = name;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.fail(String(e));
      return;
    }
    this.ws.onopen = () => this.send({ t: 'join', room, name });
    this.ws.onerror = () => this.fail('could not reach the server');
    this.ws.onclose = () => {
      if (this.status !== 'error') this.setStatus('offline');
      this.selfId = null;
    };
    this.ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(m);
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.buffer.length = 0;
    this.selfId = null;
    this.room = null;
    this.setStatus('offline');
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    this.onStatus?.(s);
  }

  private fail(message: string): void {
    this.error = message;
    this.setStatus('error');
  }

  private send(m: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        this.selfId = m.id;
        this.room = m.room;
        this.name = m.name;
        this.setStatus('connected');
        break;
      case 'snapshot': {
        const now = performance.now();
        if (!this.clockInit) {
          this.clockOffset = m.s.t - now;
          this.clockInit = true;
        } else {
          // Gently track the server clock; a hard set on every packet would
          // make the interpolation cursor jitter with the network.
          this.clockOffset += (m.s.t - now - this.clockOffset) * 0.05;
        }
        this.buffer.push({ recvAt: now, s: m.s });
        while (this.buffer.length > BUFFER) this.buffer.shift();
        this.hostilesAlive = m.s.hostilesAlive;
        this.phase = m.s.phase;
        this.missionTime = m.s.missionTime;
        break;
      }
      case 'kill':
        this.onKill?.(m);
        break;
      case 'hit':
        this.onHit?.(m.enemyId, m.killed, m.headshot);
        break;
      case 'joined':
        this.onJoined?.(m.name);
        break;
      case 'left':
        this.onLeft?.(m.name);
        break;
      case 'error':
        this.fail(m.message);
        break;
      default:
        break;
    }
  }

  /** Report where we are. Rate-limited to `INPUT_HZ` regardless of frame rate. */
  sendInput(p: {
    position: THREE.Vector3;
    yaw: number;
    pitch: number;
    flags: number;
  }): void {
    if (!this.online) return;
    const now = performance.now();
    if (now - this.lastInputAt < 1000 / INPUT_HZ) return;
    this.lastInputAt = now;
    this.send({
      t: 'input',
      seq: this.seq++,
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      yaw: p.yaw,
      pitch: p.pitch,
      flags: p.flags,
    });
  }

  /** Tell the server a round left the barrel. It decides what it hit. */
  sendFire(origin: THREE.Vector3, dir: THREE.Vector3): void {
    if (!this.online) return;
    this.send({
      t: 'fire',
      ox: origin.x, oy: origin.y, oz: origin.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
    });
  }

  restart(): void {
    this.send({ t: 'restart' });
  }

  // ------------------------------------------------------------ interpolation

  /** The two snapshots straddling the render cursor, and the blend between. */
  private pair(): { a: Snapshot; b: Snapshot; t: number } | null {
    if (this.buffer.length < 2) return null;
    const target = performance.now() + this.clockOffset - INTERP_DELAY_MS;
    for (let i = this.buffer.length - 2; i >= 0; i--) {
      const a = this.buffer[i].s;
      const b = this.buffer[i + 1].s;
      if (a.t <= target && target <= b.t) {
        const span = b.t - a.t;
        return { a, b, t: span > 1e-3 ? (target - a.t) / span : 0 };
      }
    }
    // The cursor is behind everything we hold (a stall). Hold the OLDEST pair
    // rather than jumping to the newest: a freeze reads as lag, a jump reads as
    // a bug.
    return { a: this.buffer[0].s, b: this.buffer[1].s, t: 0 };
  }

  /** Every OTHER player, interpolated. The local player is never in here. */
  remotePlayers(): RemotePlayerState[] {
    const p = this.pair();
    if (!p) return [];
    const out: RemotePlayerState[] = [];
    for (const b of p.b.players) {
      if (b.id === this.selfId) continue;
      const a = p.a.players.find((x) => x.id === b.id) ?? b;
      out.push({
        id: b.id,
        name: b.name,
        position: new THREE.Vector3(
          a.x + (b.x - a.x) * p.t,
          a.y + (b.y - a.y) * p.t,
          a.z + (b.z - a.z) * p.t,
        ),
        yaw: shortAngle(a.yaw, b.yaw, p.t),
        pitch: a.pitch + (b.pitch - a.pitch) * p.t,
        health: b.health,
        flags: b.flags,
      });
    }
    return out;
  }

  /** Authoritative enemies, interpolated. */
  enemies(): NetEnemyState[] {
    const p = this.pair();
    if (!p) return [];
    const out: NetEnemyState[] = [];
    for (const b of p.b.enemies) {
      const a = p.a.enemies.find((x) => x.id === b.id) ?? b;
      out.push({
        id: b.id,
        position: new THREE.Vector3(
          a.x + (b.x - a.x) * p.t,
          a.y + (b.y - a.y) * p.t,
          a.z + (b.z - a.z) * p.t,
        ),
        yaw: shortAngle(a.yaw, b.yaw, p.t),
        // STATE IS NOT INTERPOLATED. It is discrete, and the aim telegraph is a
        // gameplay-critical cue: blending "aim" toward "fire" would produce a
        // visor that is neither, which is worse than being 120 ms late.
        state: b.state,
        health: b.health,
        alive: b.alive,
      });
    }
    return out;
  }

  /** The local player's own authoritative health (the server owns damage). */
  selfHealth(): number | null {
    const last = this.buffer[this.buffer.length - 1];
    if (!last || !this.selfId) return null;
    const me = last.s.players.find((x) => x.id === this.selfId);
    return me ? me.health : null;
  }

  playerCount(): number {
    const last = this.buffer[this.buffer.length - 1];
    return last ? last.s.players.length : 0;
  }
}

export type { PlayerWire };
