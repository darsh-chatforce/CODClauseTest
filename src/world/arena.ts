import * as THREE from 'three';
import { ARENA, LAYER } from '../config';
import { rng } from '../core/rng';
import type { CollisionWorld } from './collision';
import type { Assets, MaterialName, PropName } from './assets';

/**
 * "Operation Nightfall" — the compound.
 *
 * M2 keeps M1's approved MASSING byte-for-byte and re-skins it. Every box spec,
 * every position, every dimension below is unchanged; what changed is that each
 * spec now names a real PBR material, that the crates/barriers/containers are
 * dressed with generated props, and that the world no longer ends at the top of
 * a wall.
 *
 * Three rules carried forward or added:
 *
 * - **One spec list still drives geometry AND collision** (M1 §4.3). Meshes and
 *   colliders are created in the same loop from the same array, so they cannot
 *   drift.
 * - **NEW: a prop is fitted to its collider, not placed near it.** Every Tripo
 *   model is normalised into the exact AABB of the box it replaces
 *   (`fitToBox`). A visual that disagrees with its collision box is a lie the
 *   player discovers by walking into thin air, and it is the most common way a
 *   "dressed" level starts playing worse than its graybox.
 * - **NEW: two ground materials at non-harmonic scales.** See `buildGround`.
 */

export interface ArenaBuild {
  group: THREE.Group;
  /** Where the player starts, and which way they face (radians, +Z = 0). */
  playerSpawn: THREE.Vector3;
  playerYaw: number;
  /** Candidate enemy spawns, ordered so the first N are well-spread. */
  enemySpawns: THREE.Vector3[];
  /** Top of the raised terrace, for nav-graph sampling. */
  terraceY: number;
  /** How many generated props were actually placed (0 = all fell back to boxes). */
  propsPlaced: number;
}

/** Surface classes. The name maps to a baked PBR material set. */
type Surface = MaterialName;

interface BoxSpec {
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
  /** Per-spec PBR overrides — a painted container and a galvanised rail are both
   *  "metal" but they are not the same surface. */
  metalness?: number;
  roughness?: number;
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * The M1 graybox palette, carried over as TINTS on top of the textures.
 *
 * M1 §4.6 built a value ladder — floor darkest, cover lightest, ~10% steps — so
 * form read from value alone. Texturing a level usually destroys that read,
 * because photographic albedo has its own values that ignore the design. Keeping
 * the ladder as a multiply preserves the gameplay legibility the layout was
 * tuned for: the things you can hide behind still pop out of the ground plane.
 */
const TINT = {
  floor: 0x8e8b83,
  trim: 0x7d7a72,
} as const;

export function buildArena(
  scene: THREE.Scene,
  collision: CollisionWorld,
  assets: Assets,
): ArenaBuild {
  const group = new THREE.Group();
  group.name = 'arena';
  scene.add(group);

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

  // ------------------------------------------------------------ realisation
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const material = (s: BoxSpec): THREE.MeshStandardMaterial => {
    const tiles = s.tiles ?? ARENA.tilesPerMetreWall;
    // NO BLANKET DEFAULTS. These are MULTIPLIERS over the baked roughness /
    // metalness maps, and `undefined` means "the map is the value" (scalar 1).
    //
    // Until M3 this line supplied `0.55 / 0.7` for every metal surface and
    // `0.92 / 0.02` for everything else, which meant a spec could never opt out —
    // and it paired with a bug in `assets.standard()` that discarded the number
    // anyway (DECISIONS §31). With that bug fixed, a blanket default would have
    // become a blanket *scaling* of every baked map, so it goes too: only a spec
    // that deliberately says "this surface is painted, not bare" gets a scalar.
    const rough = s.roughness;
    const metal = s.metalness;
    const key = `${s.surface}|${s.tint}|${tiles}|${rough ?? 'map'}|${metal ?? 'map'}`;
    let m = materialCache.get(key);
    if (!m) {
      m = assets.standard(s.surface, {
        repeat: tiles,
        color: s.tint,
        roughness: rough,
        metalness: metal,
        normalScale: s.surface === 'sand' ? 0.6 : 1.0,
      });
      materialCache.set(key, m);
    }
    return m;
  };

  let propsPlaced = 0;
  for (const s of specs) {
    const box = new THREE.Box3(
      new THREE.Vector3(s.x - s.sx / 2, s.y - s.sy / 2, s.z - s.sz / 2),
      new THREE.Vector3(s.x + s.sx / 2, s.y + s.sy / 2, s.z + s.sz / 2),
    );

    const source = s.prop ? assets.props.get(s.prop) : undefined;
    if (source) {
      const inst = fitToBox(source, box, s.propSpin === true);
      inst.layers.set(LAYER.WORLD);
      inst.traverse((o) => {
        o.layers.set(LAYER.WORLD);
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      group.add(inst);
      propsPlaced++;
    } else {
      // No prop, or the prop failed to load: the graybox box, textured. This is
      // the "degraded, not broken" path — the level still plays identically.
      const mesh = new THREE.Mesh(UNIT_BOX, material(s));
      mesh.position.set(s.x, s.y, s.z);
      mesh.scale.set(s.sx, s.sy, s.sz);
      mesh.castShadow = s.sy > 0.6;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER.WORLD);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }

    // COLLISION IS AUTHORED, GEOMETRY IS DRESSED. The collider comes from the
    // spec either way, so swapping art can never change how the level plays and
    // can never invalidate the nav graph or the enclosure audit.
    collision.addBox(
      new THREE.Vector3(s.x, s.y, s.z),
      new THREE.Vector3(s.sx, s.sy, s.sz),
    );
  }

  buildGround(group, collision, assets);
  buildBerm(group, assets);
  buildDecals(group, assets, flights, containers);

  return {
    group,
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
    propsPlaced,
  };
}

/**
 * THE TWO-GROUND RULE.
 *
 * A 40 m floor carrying one texture reads as a grid however seamless that
 * texture is, because the eye locks onto the PERIOD, not the seam. So the floor
 * is two different materials at two non-harmonic scales:
 *
 *   base   poured slab apron   0.28 tiles/m  (a ~3.6 m slab module)
 *   over   drifted sand        0.11 tiles/m  (a ~9 m drift)
 *
 * 0.28 / 0.11 ≈ 2.55, deliberately NOT 2, so the two patterns never come back
 * into phase. The sand layer is masked by `ground_mask.png` stretched ONCE
 * across the whole floor (repeat = 1), so the mask itself contributes no period
 * — it is the thing that breaks the other two.
 */
function buildGround(group: THREE.Group, collision: CollisionWorld, assets: Assets): void {
  const size = ARENA.size;

  const slab = new THREE.Mesh(
    UNIT_BOX,
    assets.standard('ground_slab', {
      repeat: size * ARENA.tilesPerMetreGround,
      color: TINT.floor,
      roughness: 0.95,
    }),
  );
  slab.position.set(0, -0.5, 0);
  slab.scale.set(size, 1, size);
  slab.receiveShadow = true;
  slab.layers.set(LAYER.WORLD);
  group.add(slab);
  collision.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(size, 1, size));

  const sandMat = assets.standard('sand', {
    repeat: size * ARENA.tilesPerMetreGroundB,
    color: 0xbdae90,
    roughness: 0.98,
    normalScale: 0.7,
  });
  if (assets.groundMask) {
    // Stretched ONCE over the whole floor (repeat 1), so the mask has no period
    // of its own — it exists to destroy the period of the two textures under it.
    sandMat.alphaMap = assets.groundMask;
    sandMat.transparent = true;
    sandMat.depthWrite = false;
    sandMat.polygonOffset = true;
    sandMat.polygonOffsetFactor = -1;
    sandMat.polygonOffsetUnits = -1;
  } else {
    // No mask: do NOT lay an opaque second floor over the first — that would
    // silently delete the slab layer and leave one texture, which is the exact
    // failure this rule exists to prevent. Skip the drift entirely instead.
    return;
  }

  const drift = new THREE.Mesh(new THREE.PlaneGeometry(size, size), sandMat);
  drift.rotation.x = -Math.PI / 2;
  drift.position.y = 0.004;
  drift.receiveShadow = true;
  drift.layers.set(LAYER.WORLD);
  drift.name = 'ground-drift';
  group.add(drift);
}

/**
 * The horizon.
 *
 * M1's compound ended at the top of a 6 m wall with raw sky beyond it, so from
 * any elevated position the world visibly stopped. This is an earth berm ringing
 * the compound at 46–150 m, rising 11 m and falling away into the fog. It is
 * DECORATIVE ONLY — no colliders, outside the enclosure audit's rays — and its
 * job is entirely negative: to make sure no sightline ever terminates on a bare
 * wall edge against the sky.
 */
function buildBerm(group: THREE.Group, assets: Assets): void {
  const inner = ARENA.bermInnerRadius;
  const outer = ARENA.bermOuterRadius;
  // TESSELLATION IS THE FIX FOR BOTH REPORTED SYMPTOMS (DECISIONS §35).
  //
  // At M2's 192 × 22 this ring spans 360° and 212 m of radius, so one quad is
  // 1.875° wide — a 3.3 m facet at 100 m. Two consequences, and the bug report
  // named both:
  //
  //  · FLICKER. The berm's only high-frequency feature is its own SILHOUETTE
  //    against a bright sky, and that silhouette was a chain of long straight
  //    facet edges. Under a pan each edge crosses pixel boundaries as a unit and
  //    pops. The measured speckle map (`tools/flicker.mjs`) shows this exactly:
  //    the terrain BODY is stable and the outline is a bright fringe.
  //  · "LIGHTING ISSUES". `computeVertexNormals()` on facets that large produces
  //    a normal field with visible radial banding and no smooth terminator, so a
  //    dune lit by a 22° sun reads as a flat brown blob with streaks in it.
  //
  // Doubling round and nearly doubling radially costs ~31 k triangles on ONE
  // decorative mesh with no collider — cheap at a locked 60 fps — and attacks
  // the actual cause rather than dressing it with fog.
  const segments = 384;
  const rings = 40;

  const geo = new THREE.RingGeometry(inner, outer, segments, rings);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i); // RingGeometry is built in XY; rotated to XZ below.
    const r = Math.hypot(x, y);
    const t = (r - inner) / (outer - inner);
    const theta = Math.atan2(y, x);

    // A RIDGELINE, NOT A RING OF CONES.
    //
    // The first version put a sharp crest at a FIXED radius and varied only its
    // height, which produced exactly what it sounds like: a ring of smooth
    // Toblerone cones. Two changes fix it. The crest RADIUS varies with angle
    // too, so the ridge meanders instead of being a circle; and the radial
    // profile has a soft shoulder rather than a `sin` peak, so hills have tops
    // instead of points. Five theta harmonics at declining amplitude give the
    // silhouette detail at more than one scale, which is what stops a landform
    // reading as a primitive.
    const crest =
      0.15 * (1 + 0.42 * Math.sin(theta * 2 + 1.7) + 0.2 * Math.sin(theta * 5 - 0.4));
    const wobble =
      0.78 +
      0.17 * Math.sin(theta * 3 + 0.8) +
      0.12 * Math.sin(theta * 5 - 2.1) +
      0.08 * Math.sin(theta * 9 + 4.2) +
      0.05 * Math.sin(theta * 17 + 1.1) +
      0.03 * Math.sin(theta * 29 - 3.3);

    const u = t / crest;
    // Soft shoulder in, long slow decay out.
    const profile =
      u <= 1
        ? u * u * (3 - 2 * u) // smoothstep up to the crest
        : Math.max(0, 1 - Math.pow((t - crest) / (1 - crest), 1.15));

    // The outer skirt is driven BELOW zero rather than tapered to it. A ring
    // that ends at ground level ends on a visible circular edge against the sky
    // no matter how far away it is put; a ring that keeps falling passes under
    // the horizon and simply stops existing. The fog finishes the job.
    const skirt = Math.pow(t, 2.0) * ARENA.bermFalloff;
    pos.setZ(i, profile * ARENA.bermHeight * wobble - skirt);
    // World-space UVs so the sand tiles at the same physical scale as the floor.
    uv.setXY(i, x * ARENA.tilesPerMetreGroundB, y * ARENA.tilesPerMetreGroundB);
  }
  geo.computeVertexNormals();

  const mat = assets.standard('sand', {
    repeat: 1, // UVs are already in world tiles.
    color: 0x8e8168,
    roughness: 1.0,
    normalScale: 0.5,
  });
  const berm = new THREE.Mesh(geo, mat);
  berm.rotation.x = -Math.PI / 2;
  berm.position.y = -0.6;
  berm.name = 'terrain-berm';
  berm.receiveShadow = true;
  berm.layers.set(LAYER.WORLD);
  group.add(berm);
}

/**
 * Grime, hazard and stencil decals.
 *
 * Placed where a real compound would carry them: dirt where the ground meets a
 * vertical face, hazard chevrons on the stair cheeks, unit stencils on the
 * containers. They do two jobs — they hide the hard line where two materials
 * meet, and they make the place read as OCCUPIED rather than as level geometry.
 */
function buildDecals(
  group: THREE.Group,
  assets: Assets,
  flights: Array<{ x: number; width: number; z: number }>,
  containers: Array<[number, number, number, number]>,
): void {
  const H = ARENA.size / 2;

  const quad = (
    tex: THREE.Texture,
    w: number,
    h: number,
    pos: THREE.Vector3,
    rotY: number,
    rotX = 0,
    opacity = 1,
  ): void => {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: true,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    m.rotation.set(rotX, rotY, 0);
    m.layers.set(LAYER.WORLD);
    m.renderOrder = 2;
    group.add(m);
  };

  // Ground grime along the inside of each perimeter wall.
  const grime = assets.decals.get('grime');
  if (grime) {
    for (let i = 0; i < 14; i++) {
      const along = rng.range(-H + 2, H - 2);
      const side = i % 4;
      const inset = 1.6;
      const p =
        side === 0
          ? new THREE.Vector3(along, 0.012, -H + inset)
          : side === 1
            ? new THREE.Vector3(along, 0.012, H - inset)
            : side === 2
              ? new THREE.Vector3(-H + inset, 0.012, along)
              : new THREE.Vector3(H - inset, 0.012, along);
      const s = rng.range(2.2, 3.6);
      quad(grime, s, s, p, rng.range(0, Math.PI * 2), -Math.PI / 2, rng.range(0.14, 0.26));
    }
    // And at the bunker base, where the most traffic would be.
    for (let i = 0; i < 5; i++) {
      quad(
        grime,
        rng.range(2.4, 3.8),
        rng.range(2.4, 3.8),
        new THREE.Vector3(1.5 + rng.range(-4.5, 4.5), 0.012, 2.0 + rng.range(-4, 4)),
        rng.range(0, Math.PI * 2),
        -Math.PI / 2,
        rng.range(0.12, 0.24),
      );
    }
  }

  // Hazard chevrons on the outside face of every stair cheek.
  const hazard = assets.decals.get('hazard');
  if (hazard) {
    for (const f of flights) {
      for (const side of [-1, 1]) {
        const t = hazard.clone();
        t.needsUpdate = true;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(2.2, 0.55);
        t.colorSpace = hazard.colorSpace;
        quad(
          t,
          10 * 0.52,
          0.5,
          new THREE.Vector3(
            f.x + side * (f.width / 2 + 0.16 + 0.145),
            ARENA.terraceHeight * 0.5 + 0.62,
            f.z + (10 * 0.52) / 2,
          ),
          side > 0 ? Math.PI / 2 : -Math.PI / 2,
          0,
          0.9,
        );
      }
    }
  }

  // Unit stencils on the long face of each container.
  const stencil = assets.decals.get('stencil');
  if (stencil) {
    for (const [cx, cz, sx, sz] of containers) {
      const alongX = sx > sz;
      const w = Math.min(alongX ? sx : sz, 4.2) * 0.7;
      quad(
        stencil,
        w,
        w * 0.5,
        alongX
          ? new THREE.Vector3(cx, 1.55, cz + sz / 2 + 0.02)
          : new THREE.Vector3(cx + sx / 2 + 0.02, 1.55, cz),
        alongX ? 0 : Math.PI / 2,
        0,
        0.75,
      );
    }
  }
}

/**
 * Normalise a generated prop into an exact target AABB.
 *
 * Tripo returns models at arbitrary scale, arbitrary origin and (for a prop) no
 * declared forward. Placing one by eye is how a dressed level ends up with a
 * crate you can walk through and a barrier floating 20 cm off the ground. So
 * every prop is measured and fitted: uniform scale to the tightest fit inside
 * the box, then centred horizontally and SEATED on the box floor.
 *
 * Uniform (not per-axis) scale is the point — stretching a crate to fill a
 * non-cubic collider is instantly readable as wrong. A prop that is slightly
 * smaller than its collider is invisible; a distorted one is not.
 */
function fitToBox(source: THREE.Object3D, box: THREE.Box3, spin: boolean): THREE.Object3D {
  const inst = source.clone(true);
  // Clone materials so a per-instance tweak cannot bleed across the level.
  inst.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material) {
      m.material = Array.isArray(m.material)
        ? m.material.map((x) => x.clone())
        : m.material.clone();
    }
  });

  if (spin) inst.rotation.y = Math.floor(rng() * 4) * (Math.PI / 2) + rng.range(-0.09, 0.09);
  inst.updateMatrixWorld(true);

  const src = new THREE.Box3().setFromObject(inst);
  const srcSize = src.getSize(new THREE.Vector3());
  const dstSize = box.getSize(new THREE.Vector3());
  if (srcSize.x < 1e-5 || srcSize.y < 1e-5 || srcSize.z < 1e-5) return inst;

  const scale = Math.min(dstSize.x / srcSize.x, dstSize.y / srcSize.y, dstSize.z / srcSize.z);
  inst.scale.multiplyScalar(scale);
  inst.updateMatrixWorld(true);

  const fitted = new THREE.Box3().setFromObject(inst);
  const centre = fitted.getCenter(new THREE.Vector3());
  const dstCentre = box.getCenter(new THREE.Vector3());
  inst.position.x += dstCentre.x - centre.x;
  inst.position.z += dstCentre.z - centre.z;
  // SEAT on the floor of the collider, not centre-to-centre: a prop that is
  // shorter than its box should stand on the ground, not hover mid-air.
  inst.position.y += box.min.y - fitted.min.y;
  inst.updateMatrixWorld(true);
  return inst;
}
