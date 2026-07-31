/**
 * The wire protocol, shared by the client and the server.
 *
 * It lives in `src/` rather than in `server/` on purpose: both processes import
 * THIS file, so a message the server sends and a message the client parses are
 * the same TypeScript type. A protocol defined twice is a protocol that drifts,
 * and the failure mode is a field that silently reads `undefined` on one side.
 *
 * ============================================================================
 * THE AUTHORITY MODEL, stated plainly
 * ============================================================================
 *
 * This is co-op PvE, and the split is deliberately asymmetric:
 *
 *   · ENEMIES are SERVER-AUTHORITATIVE. The server runs the real `Enemy` class
 *     against the real `CollisionWorld` and the real `NavGraph`, built from the
 *     same `arenaLayout()` the client draws. Clients never simulate AI in a
 *     room; they render what the snapshot says.
 *   · HITS are SERVER-VALIDATED. A client sends "I fired from here, along here".
 *     The server does the raycast itself, against its own authoritative enemy
 *     positions, and decides what was hit. A client cannot claim a kill.
 *   · PLAYER MOVEMENT is CLIENT-AUTHORITATIVE, and this is a real trade rather
 *     than an oversight. The client simulates its own movement with the existing
 *     controller (which is the "prediction" — it never waits for the server) and
 *     reports the result; the server relays it. Full authority would mean
 *     running `Player` + `CollisionWorld` per client on the server and
 *     reconciling mispredictions, which is the right answer for competitive PvP
 *     and the wrong place to spend the complexity budget for four people
 *     shooting AI together: there is nothing to gain by cheating at walking, and
 *     the thing worth protecting — who killed what — is already validated.
 *
 * DECISIONS §37 carries the full argument and what it would cost to change.
 */

/** Snapshots per second. 15 Hz is the middle of the brief's 10-15 Hz band. */
export const SNAPSHOT_HZ = 15;
/** Client input sends per second. */
export const INPUT_HZ = 20;
/**
 * How far in the past remote entities are rendered, in milliseconds.
 *
 * Interpolation needs two snapshots to sit between, so the buffer must exceed
 * one snapshot interval (66.7 ms at 15 Hz) or the client runs out of future and
 * has to extrapolate — which looks like remote players stuttering and then
 * teleporting. 120 ms gives most of a second snapshot in hand for jitter, at the
 * cost of remote players being ~2 frames "behind" what the server thinks. In a
 * PvE co-op that latency costs nothing; in PvP it would be the whole design.
 */
export const INTERP_DELAY_MS = 120;

export type EnemyStateWire =
  | 'idle' | 'patrol' | 'advance' | 'halt' | 'aim' | 'fire' | 'reposition' | 'dead';

export interface PlayerWire {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  /** Bitfield: 1 = moving, 2 = sprinting, 4 = crouching, 8 = aiming, 16 = dead. */
  flags: number;
}

export const PF = {
  MOVING: 1,
  SPRINTING: 2,
  CROUCHING: 4,
  AIMING: 8,
  DEAD: 16,
} as const;

export interface EnemyWire {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: EnemyStateWire;
  health: number;
  alive: boolean;
}

/** One authoritative world sample. */
export interface Snapshot {
  /** Server tick time, ms. */
  t: number;
  players: PlayerWire[];
  enemies: EnemyWire[];
  hostilesAlive: number;
  missionTime: number;
  phase: 'lobby' | 'playing' | 'won' | 'lost';
}

// ------------------------------------------------------------ client → server

export type ClientMessage =
  | { t: 'join'; room: string | null; name: string }
  | { t: 'input'; seq: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number }
  /** A round left the barrel. The SERVER decides what it hit. */
  | { t: 'fire'; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }
  | { t: 'restart' }
  | { t: 'ping'; ts: number };

// ------------------------------------------------------------ server → client

export type ServerMessage =
  | { t: 'welcome'; id: string; room: string; name: string; snapshotHz: number }
  | { t: 'snapshot'; s: Snapshot }
  /** Someone killed something. Drives the SHARED kill feed. */
  | { t: 'kill'; byId: string; byName: string; enemyId: number; headshot: boolean }
  | { t: 'joined'; id: string; name: string }
  | { t: 'left'; id: string; name: string }
  | { t: 'hit'; enemyId: number; killed: boolean; headshot: boolean }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string };

/**
 * Room codes are four characters from an alphabet with no 0/O/1/I/5/S, because
 * the whole point is that somebody reads one out loud.
 */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ234789';

export function isRoomCode(s: string): boolean {
  return s.length === 4 && [...s].every((c) => ROOM_ALPHABET.includes(c));
}
