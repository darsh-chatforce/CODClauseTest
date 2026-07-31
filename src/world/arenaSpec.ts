import * as THREE from 'three';
import { ARENA } from '../config';
import type { CollisionWorld } from './collision';
import type { MaterialName, PropName } from './assets';

/**
 * THE ARENA LAYOUT — the single spec list, extracted so a SERVER can build the
 * same world without a renderer.
 *
 * M1 §4.3 established the rule this file exists to keep: **geometry and
 * collision come from ONE spec list**, created in the same loop, so the meshes
 * and the colliders cannot drift. M4 adds a third consumer — an authoritative
 * multiplayer server that needs the collision world and the nav graph but has no
 * scene, no materials and no GPU — and the obvious way to feed it would have
 * been to write the collider boxes out a second time. That is exactly the drift
 * the rule forbids, and it would drift silently: the server would happily
 * simulate enemies walking through a wall the client draws.
 *
 * So the spec list moves here, whole and unchanged, and everything else consumes
 * it:
 *
 *   arenaLayout()          →  pure data. No THREE.Mesh, no material, no scene.
 *   buildArena()  (client) →  layout → meshes + props + colliders + decals
 *   addArenaColliders()    →  layout → colliders only (client AND server)
 *
 * It is deliberately free of `rng`: the spec list is deterministic, so the
 * server and every client compute byte-identical geometry without exchanging a
 * single message about it. (The RNG in `arena.ts` is confined to decal scatter
 * and prop yaw — purely visual, and never consulted here.)
 */

/** Surface classes. The name maps to a baked PBR material set. */
type Surface = MaterialName;

/** The M1 VALUE LADDER, preserved. Tints live with the specs that use them. */
export const TINT = {
  floor: 0x8e8b83,
  trim: 0x7d7a72,
} as const;

export interface BoxSpec {
  x: number;
  y: number;
  z: number; // centre
  sx: number;
  sy: number;
  sz: number; // size
  surface: Surface;
  /** Tint multiplied over the albedo — the M1 value ladder, preserved. */
  tint: number;
  /** Replace the box mesh with this generated prop, fitted to the box. */
  prop?: PropName;
  /** Random yaw quarter-turns for props, so a row of crates is not a comb. */
  propSpin?: boolean;
  /** Tiles per metre override. */
  tiles?: number;
  /** Multipliers over the baked roughness / metalness maps. */
  metalness?: number;
  roughness?: number;
}

export interface ArenaLayout {
  specs: BoxSpec[];
  /** Staircase flights, for decal placement. */
  flights: Array<{ x: number; width: number; z: number }>;
  /** Shipping containers, for decal placement. */
  containers: Array<[number, number, number, number]>;
  playerSpawn: THREE.Vector3;
  playerYaw: number;
  enemySpawns: THREE.Vector3[];
  terraceY: number;
}

/** Build the spec list. Pure, deterministic, renderer-free. */
export function arenaLayout(): ArenaLayout {
  const H = ARENA.size / 2; // 20
  const T = ARENA.wallThickness;
  const WH = ARENA.wallHeight;
  const TY = ARENA.terraceHeight;

  const specs: BoxSpec[] = [];
  const push = (s: BoxSpec) => specs.push(s);

  // ------------------------------------------------- perimeter (all 4 walls)
  const wallLen = ARENA.size + T * 2;
  const wall = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    push({ x, y, z, sx, sy, sz, surface: 'plaster', tint: 0xb0aba1 });
  };
  wall(0, WH / 2, -H - T / 2, wallLen, WH, T); // N
  wall(0, WH / 2, H + T / 2, wallLen, WH, T); // S
  wall(-H - T / 2, WH / 2, 0, T, WH, wallLen); // W
  wall(H + T / 2, WH / 2, 0, T, WH, wallLen); // E

  // TRIM ON WALL TOPS. A 6 m plaster wall that simply stops is a slab edge; a
  // real compound wall is capped. This is a 0.28 m concrete coping course
  // overhanging by 0.12 m on each side, which gives the wall a hard shadow line
  // along its whole length — the cheapest possible silhouette upgrade, and it is
  // the single biggest reason the perimeter now reads as built rather than as
  // extruded. It goes through the same spec list as everything else, so it gets
  // a collider too; that is harmless (it sits at 6.14 m, above every enclosure
  // ray and above any reachable surface) and keeping the invariant "every spec
  // makes both a mesh and a collider" unbroken is worth more than the saving.
  const TRIM_H = 0.28;
  const TRIM_OVER = 0.12;
  const trims: Array<[number, number, number, number, number]> = [
    [0, -H - T / 2, wallLen + TRIM_OVER * 2, T + TRIM_OVER * 2, 0],
    [0, H + T / 2, wallLen + TRIM_OVER * 2, T + TRIM_OVER * 2, 0],
    [-H - T / 2, 0, T + TRIM_OVER * 2, wallLen + TRIM_OVER * 2, 1],
    [H + T / 2, 0, T + TRIM_OVER * 2, wallLen + TRIM_OVER * 2, 1],
  ];
  for (const [tx, tz, sx, sz] of trims) {
    push({
      x: tx,
      y: WH + TRIM_H / 2,
      z: tz,
      sx,
      sy: TRIM_H,
      sz,
      surface: 'concrete',
      tint: TINT.trim,
      tiles: 0.6,
    });
  }

  // Buttresses — pure silhouette work so the walls are not four flat slabs.
  for (const t of [-13, -6.5, 0, 6.5, 13]) {
    push({ x: t, y: WH / 2, z: -H + 0.45, sx: 1.1, sy: WH, sz: 0.9, surface: 'concrete', tint: 0x9c9890 });
    push({ x: t, y: WH / 2, z: H - 0.45, sx: 1.1, sy: WH, sz: 0.9, surface: 'concrete', tint: 0x9c9890 });
    push({ x: -H + 0.45, y: WH / 2, z: t, sx: 0.9, sy: WH, sz: 1.1, surface: 'concrete', tint: 0x9c9890 });
    push({ x: H - 0.45, y: WH / 2, z: t, sx: 0.9, sy: WH, sz: 1.1, surface: 'concrete', tint: 0x9c9890 });
  }

  // ------------------------------------------- elevated northern firing line
  const decks: Array<[number, number, number, number]> = [
    [-19.4, -6.0, -19.4, -11.0], // NW deck
    [-6.0, 7.0, -19.4, -15.6], // north catwalk
    [7.0, 19.4, -19.4, -12.0], // NE deck
  ];
  for (const [x0, x1, z0, z1] of decks) {
    push({
      x: (x0 + x1) / 2,
      y: TY / 2,
      z: (z0 + z1) / 2,
      sx: x1 - x0,
      sy: TY,
      sz: z1 - z0,
      surface: 'concrete',
      tint: 0x928e86,
    });
  }

  // Deck railings — waist-high cover, now corrugated steel.
  const railY = TY + 0.45;
  const railSpans: Array<[number, number, number]> = [
    [-19.4, -10.4, -11.0],
    [-8.6, -6.0, -11.0],
    [-6.0, 3.2, -15.6],
    [5.0, 7.0, -15.6],
    [7.0, 12.6, -12.0],
    [15.0, 19.4, -12.0],
  ];
  for (const [x0, x1, z] of railSpans) {
    push({
      x: (x0 + x1) / 2,
      y: railY,
      z,
      sx: x1 - x0,
      sy: 0.9,
      sz: 0.28,
      surface: 'metal',
      tint: 0xb9b2a4,
      tiles: 1.1,
      // Multipliers over the baked maps (see `material()` below). A deck railing
      // is painted and handled, not bare mill steel.
      metalness: 0.4,
      roughness: 0.95,
    });
  }
  push({ x: -19.26, y: railY, z: -15.2, sx: 0.28, sy: 0.9, sz: 8.4, surface: 'metal', tint: 0xb9b2a4, tiles: 1.1 });
  push({ x: 19.26, y: railY, z: -15.7, sx: 0.28, sy: 0.9, sz: 7.4, surface: 'metal', tint: 0xb9b2a4, tiles: 1.1 });

  // ------------------------------------------------------------- staircases
  const stepRise = TY / 10;
  const stepRun = 0.52;
  const flights: Array<{ x: number; width: number; z: number }> = [
    { x: -9.5, width: 2.6, z: -11.0 },
    { x: 13.8, width: 2.6, z: -12.0 },
  ];
  for (const f of flights) {
    for (let i = 0; i < 10; i++) {
      const top = TY - i * stepRise;
      const zFront = f.z + i * stepRun;
      push({
        x: f.x,
        y: top / 2,
        z: zFront + stepRun / 2,
        sx: f.width,
        sy: top,
        sz: stepRun,
        surface: 'concrete',
        tint: 0xa5a199,
        tiles: 0.8,
      });
    }
    for (const side of [-1, 1]) {
      push({
        x: f.x + side * (f.width / 2 + 0.16),
        y: TY / 2 + 0.35,
        z: f.z + (10 * stepRun) / 2,
        sx: 0.28,
        sy: TY + 0.7,
        sz: 10 * stepRun,
        surface: 'metal',
        tint: 0xb9b2a4,
        tiles: 1.1,
      });
    }
  }

  // ------------------------------------------------------- central bunker
  push({ x: 1.5, y: 1.6, z: 2.0, sx: 7.0, sy: 3.2, sz: 6.0, surface: 'plaster', tint: 0x9d9a92 });
  push({ x: 1.5, y: 3.35, z: 2.0, sx: 7.8, sy: 0.3, sz: 6.8, surface: 'concrete', tint: TINT.trim, tiles: 0.6 });
  push({ x: -2.4, y: 1.9, z: 5.4, sx: 0.6, sy: 3.8, sz: 0.6, surface: 'concrete', tint: 0xa09c94 });
  push({ x: 5.4, y: 1.9, z: 5.4, sx: 0.6, sy: 3.8, sz: 0.6, surface: 'concrete', tint: 0xa09c94 });

  // ------------------------------------------------------------ cover field
  const crates: Array<[number, number, number]> = [
    [-14.5, 6.0, 0],
    [-13.3, 6.0, 0],
    [-14.5, 6.0, 1],
    [-6.0, 13.5, 0],
    [-4.8, 13.5, 0],
    [-4.8, 13.5, 1],
    [11.0, 9.5, 0],
    [12.2, 9.6, 0],
    [11.0, 9.5, 1],
    [15.5, -3.0, 0],
    [-16.0, -4.0, 0],
    [-16.0, -5.2, 0],
    [3.0, 15.0, 0],
    [4.2, 15.4, 0],
    [-2.0, -6.0, 0],
    [8.5, -7.0, 0],
  ];
  for (const [cx, cz, stack] of crates) {
    const s = 1.2;
    push({
      x: cx,
      y: s / 2 + stack * s,
      z: cz,
      sx: s,
      sy: s,
      sz: s,
      surface: 'metal',
      tint: 0xffffff,
      prop: 'crate_military',
      propSpin: true,
    });
  }

  // Barriers alternate jersey barrier / sandbag wall — two silhouettes at the
  // same cover height keeps the crouch-cover ring from reading as one repeated
  // object, which is what a single-prop cover field always does.
  const barriers: Array<[number, number, boolean]> = [
    [-9.0, 0.5, true],
    [-9.0, -3.5, true],
    [9.5, 3.0, true],
    [0.0, 10.5, true],
    [-3.5, 8.0, false],
    [6.0, -4.5, false],
    [16.5, 6.0, false],
    [-17.0, 10.0, false],
    [13.0, 14.0, true],
    [-11.5, 15.5, true],
  ];
  barriers.forEach(([bx, bz, alongX], i) => {
    push({
      x: bx,
      y: 0.475,
      z: bz,
      sx: alongX ? 3.2 : 0.85,
      sy: 0.95,
      sz: alongX ? 0.85 : 3.2,
      surface: 'concrete',
      tint: 0xffffff,
      prop: i % 2 === 0 ? 'barrier_concrete' : 'sandbag_wall',
    });
  });

  const containers: Array<[number, number, number, number]> = [
    [-15.0, 0.5, 2.6, 6.4],
    [16.0, -8.0, 2.6, 5.2],
    [-8.0, 17.0, 6.0, 2.6],
    [12.5, 17.5, 5.4, 2.6],
    [0.0, -9.0, 5.0, 2.4],
  ];
  for (const [cx, cz, sx, sz] of containers) {
    push({
      x: cx,
      y: 1.3,
      z: cz,
      sx,
      sy: 2.6,
      sz,
      surface: 'metal',
      tint: 0xb6a98f,
      tiles: 0.75,
      // Containers are PAINTED steel, not bare — a mirror shows you the
      // environment, not the object, so a fully-metallic surface has no form of
      // its own.
      //
      // NOTE FOR THE RECORD: these two numbers were written at M2 to fix exactly
      // that, and until M3 they had NEVER EXECUTED — `assets.standard()` was
      // overwriting them (DECISIONS §31). The containers are visibly blue slabs
      // in `shots/01_spawn.png` because of it. Both the map and the override are
      // fixed now; this is the first build in which this line does anything.
      metalness: 0.18,
      roughness: 0.9,
    });
  }

  // Oil drums — small, cheap silhouette variety at ground level.
  const drums: Array<[number, number]> = [
    [-13.0, 3.4],
    [-12.2, 4.1],
    [10.2, -5.4],
    [2.6, 12.4],
    [-5.4, -9.6],
    [17.2, 2.2],
  ];
  for (const [dx, dz] of drums) {
    push({
      x: dx,
      y: 0.44,
      z: dz,
      sx: 0.62,
      sy: 0.88,
      sz: 0.62,
      surface: 'metal',
      tint: 0xffffff,
      prop: 'oil_drum',
      propSpin: true,
    });
  }

  // Watchtower in the SE corner and an antenna mast on the NW deck. Both are
  // TALL: the compound previously had nothing above 6 m, so every silhouette
  // died at the wall line. These give the skyline two verticals to read against
  // the dusk, which is most of what makes an outdoor level feel sited.
  push({
    x: 16.4,
    y: 3.6,
    z: 15.6,
    sx: 2.8,
    sy: 7.2,
    sz: 2.8,
    surface: 'metal',
    tint: 0xffffff,
    prop: 'watchtower',
  });
  push({
    x: -17.2,
    y: ARENA.terraceHeight + 3.1,
    z: -17.4,
    sx: 1.4,
    sy: 6.2,
    sz: 1.4,
    surface: 'metal',
    tint: 0xffffff,
    prop: 'antenna_mast',
  });

  return {
    specs,
    flights,
    containers,
    playerSpawn: new THREE.Vector3(-14.0, 0, 16.5),
    playerYaw: -0.64,
    enemySpawns: [
      new THREE.Vector3(-12.0, TY, -14.0),
      new THREE.Vector3(14.5, TY, -15.5),
      new THREE.Vector3(13.0, 0, 4.0),
      new THREE.Vector3(-16.0, 0, -8.0),
      new THREE.Vector3(2.0, 0, -13.5),
      new THREE.Vector3(-4.0, 0, 12.0),
      new THREE.Vector3(17.0, 0, 12.0),
      new THREE.Vector3(-17.5, 0, 3.0),
    ],
    terraceY: TY,
  };
}

/**
 * Register every collider from the layout, plus the ground slab.
 *
 * THE ONLY function that turns the layout into collision, used by the client
 * (via `buildArena`) and by the server. One implementation means the two cannot
 * disagree about where the walls are.
 */
export function addArenaColliders(collision: CollisionWorld, layout: ArenaLayout): void {
  for (const s of layout.specs) {
    collision.addBox(
      new THREE.Vector3(s.x, s.y, s.z),
      new THREE.Vector3(s.sx, s.sy, s.sz),
    );
  }
  // The floor. `buildGround` draws it on the client; the box is authored here so
  // a headless world still has something to stand on.
  const size = ARENA.size;
  collision.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(size, 1, size));
}
