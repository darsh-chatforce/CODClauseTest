import * as THREE from 'three';
import { LAYER } from '../config';
import { SIGHT_HEIGHT } from './viewmodel';
import type { Assets } from '../world/assets';

/**
 * The generated carbine, fitted to the game.
 *
 * M2 generated `public/models/props/carbine.glb` (Tripo text-to-3D, AR pattern,
 * optic on the rail, 13,734 verts, 654 KB) and then DELIBERATELY DID NOT SHIP IT
 * — see DECISIONS §24. The reason is the whole point of this file: the ADS
 * alignment in this project is GEOMETRIC (DECISIONS §2.5). The aim-down-sights
 * pose is not a hand-tuned offset that "looks right"; it is
 * `y = -SIGHT_HEIGHT, x = 0`, which puts the optic exactly on the screen centre
 * **provided the optic is actually at `(0, SIGHT_HEIGHT)` in model space.**
 *
 * A generated mesh arrives in an arbitrary pose at an arbitrary scale with its
 * origin wherever the generator felt like putting it. Dropping it in and nudging
 * the pose until the dot looks centred is precisely the move this project exists
 * to not make: it produces a number nobody can defend and that silently breaks
 * the next time the asset is regenerated.
 *
 * So the mesh is MEASURED and FITTED:
 *
 *  1. Scaled by its own bounding box to a real carbine's overall length.
 *  2. Its OPTIC is located by a region rule expressed in NORMALISED bounding-box
 *     coordinates, so the rule survives a re-generation at a different scale.
 *  3. The model is TRANSLATED so the measured optic centre lands on
 *     `(0, SIGHT_HEIGHT)`. The ADS pose is then correct by construction, not by
 *     eye — and `tools/smoke.mjs` PROVES it by projecting the optic through the
 *     real viewmodel camera in the real ADS pose and asserting it lands within a
 *     few pixels of the crosshair.
 *  4. The BORE is located the same way, so the muzzle (flash, tracer origin,
 *     light) sits on the barrel axis rather than at the model origin.
 *  5. The MAGAZINE is split out of the single generated mesh into its own
 *     object, so M1's reload animation — which drops the mag, swaps it and seats
 *     a fresh one — keeps working with the real weapon instead of being quietly
 *     dropped as "not supported by the asset".
 *
 * Every one of those five steps is a measurement with a failure mode, so every
 * one of them reports. `CarbineFit.problems` is non-empty if any region rule
 * caught nothing plausible, and the caller falls back to the placeholder rifle
 * rather than shipping a weapon whose optic is somewhere unknown.
 */

/** Overall length of a short-barrelled 5.56 carbine, stock collapsed (metres).
 *  The mesh is normalised into a unit box, so this IS the scale factor. */
export const CARBINE_LENGTH = 0.86;

/**
 * Region rules, in normalised bounding-box coordinates (0..1 across the model's
 * own bounds: u = right, v = up, w = forward-from-muzzle).
 *
 * MEASURED off the shipped mesh (raw bounds x ±0.0577, y ±0.1947, z ±0.5):
 *   · barrel/muzzle device  z < -0.42      → w < 0.08
 *   · optic body            y > 0.128, z ∈ [-0.12, 0.14] → v > 0.80, w ∈ [0.38, 0.64]
 *   · magazine              y < -0.02, z ∈ [-0.06, 0.115] → v < 0.45, w ∈ [0.40, 0.62]
 * The magazine window stops at w = 0.62 because the PISTOL GRIP occupies
 * w ∈ [0.65, 0.78] below the same v line — the two are separated by a clean gap
 * in the vertex histogram, which is why a box rule is honest here rather than a
 * guess.
 */
const REGION = {
  bore: { v: [0.0, 1.0], w: [0.0, 0.08] },
  optic: { v: [0.8, 1.0], w: [0.38, 0.66] },
  magazine: { v: [0.0, 0.45], w: [0.4, 0.62] },
} as const;

export interface CarbineFit {
  group: THREE.Group;
  /** Muzzle, in the fitted model's local space — on the bore axis. */
  muzzle: THREE.Vector3;
  /** The magazine, as its own object. Null if the split found nothing. */
  magazine: THREE.Object3D | null;
  /** Measured optic centre after fitting. Should be ≈ (0, SIGHT_HEIGHT, z). */
  optic: THREE.Vector3;
  /** Non-empty = do not ship this; fall back to the placeholder. */
  problems: string[];
  /** Diagnostics, surfaced in the test snapshot. */
  stats: {
    vertices: number;
    lengthMetres: number;
    opticX: number;
    opticY: number;
    magazineTriangles: number;
  };
}

interface Bounds {
  min: THREE.Vector3;
  size: THREE.Vector3;
}

function inRegion(
  p: THREE.Vector3,
  b: Bounds,
  r: { v: readonly number[]; w: readonly number[] },
): boolean {
  const v = (p.y - b.min.y) / b.size.y;
  // w runs from the MUZZLE (-Z, w=0) to the buttplate (+Z, w=1).
  const w = (p.z - b.min.z) / b.size.z;
  return v >= r.v[0] && v <= r.v[1] && w >= r.w[0] && w <= r.w[1];
}

/**
 * Fit the generated carbine for first-person use.
 *
 * Returns `null` if the asset is absent — the caller keeps the placeholder.
 */
export function fitCarbine(assets: Assets): CarbineFit | null {
  const src = assets.carbine;
  if (!src) return null;

  const problems: string[] = [];
  const group = new THREE.Group();
  group.name = 'viewmodel-carbine';

  // The GLTF scene is cloned so the same source can also arm six enemies.
  const model = src.scene.clone(true);

  // ---- 1. scale by measurement -------------------------------------------
  model.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(model, true);
  const rawSize = raw.getSize(new THREE.Vector3());
  // The long axis IS the barrel axis; if the generator ever returns a model
  // whose longest axis is not Z the whole fit is meaningless, so say so.
  if (rawSize.z < rawSize.x || rawSize.z < rawSize.y) {
    problems.push(
      `carbine long axis is not Z (size ${rawSize.x.toFixed(3)}, ${rawSize.y.toFixed(3)}, ${rawSize.z.toFixed(3)})`,
    );
  }
  const scale = rawSize.z > 1e-5 ? CARBINE_LENGTH / rawSize.z : 1;
  model.scale.multiplyScalar(scale);
  model.updateMatrixWorld(true);

  // ---- 2/3. locate the optic and the bore, in fitted space -----------------
  const box = new THREE.Box3().setFromObject(model, true);
  const bounds: Bounds = { min: box.min.clone(), size: box.getSize(new THREE.Vector3()) };

  const opticBox = new THREE.Box3();
  const boreBox = new THREE.Box3();
  let vertices = 0;
  const p = new THREE.Vector3();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    vertices += pos.count;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
      if (inRegion(p, bounds, REGION.optic)) opticBox.expandByPoint(p);
      if (inRegion(p, bounds, REGION.bore)) boreBox.expandByPoint(p);
    }
  });

  if (opticBox.isEmpty()) problems.push('optic region caught no vertices');
  if (boreBox.isEmpty()) problems.push('bore region caught no vertices');
  if (problems.length) {
    return {
      group,
      muzzle: new THREE.Vector3(0, 0, -CARBINE_LENGTH * 0.5),
      magazine: null,
      optic: new THREE.Vector3(),
      problems,
      stats: { vertices, lengthMetres: CARBINE_LENGTH, opticX: 0, opticY: 0, magazineTriangles: 0 },
    };
  }

  // The OPTICAL AXIS is the centre of the optic body's cross-section, not its
  // centroid: a red dot's tube is hollow and its mount hangs below the tube, so
  // a vertex centroid sits low. The bounding-box centre of the region is the
  // honest read of "where does the eye look through".
  const opticCentre = opticBox.getCenter(new THREE.Vector3());
  const boreCentre = boreBox.getCenter(new THREE.Vector3());

  // ---- 3. translate so the optic lands on the ADS axis --------------------
  // THIS is the line that makes ADS correct by construction. x → 0 puts the
  // optic on the vertical centreline; y → SIGHT_HEIGHT means the ADS pose's
  // `y = -SIGHT_HEIGHT` lands it exactly on the screen centre.
  const shift = new THREE.Vector3(-opticCentre.x, SIGHT_HEIGHT - opticCentre.y, 0);
  model.position.add(shift);
  model.updateMatrixWorld(true);
  opticCentre.add(shift);
  boreCentre.add(shift);

  // ---- 4. muzzle on the bore axis -----------------------------------------
  const muzzle = new THREE.Vector3(boreCentre.x, boreCentre.y, box.min.z + shift.z);

  // ---- 5. split the magazine out of the single generated mesh -------------
  const magazine = splitMagazine(model, bounds);
  let magazineTriangles = 0;
  if (!magazine) {
    // Not fatal — the weapon is fine, the reload just loses its mag swap. Loud
    // in the report, soft in the frame, same rule as the asset layer.
    problems.push('magazine region caught no triangles (reload mag-swap disabled)');
  } else {
    const idx = (magazine as THREE.Mesh).geometry.getIndex();
    magazineTriangles = idx ? idx.count / 3 : 0;
  }

  group.add(model);
  group.traverse((o) => {
    // NO LAYER ASSIGNMENT, deliberately — and this cost a red assertion.
    //
    // `LAYER.VIEWMODEL` is a hangover from a design in which the weapon lived in
    // the WORLD scene and was separated by a layer mask. It has not worked that
    // way since M1: the viewmodel has its own scene and its own camera, and that
    // camera — like every three.js camera — has only layer 0 enabled. Setting
    // the carbine to layer 1 therefore made it invisible to the only camera that
    // ever draws it, in both the frame AND the coverage measurement.
    //
    // It was caught by "viewmodel is actually on screen (not culled away)"
    // reading 0.00% — an assertion added at M1 for a completely different reason
    // (a frustum-culling bug), which is the argument for keeping cheap
    // sanity assertions around: this one found a defect three milestones later
    // that no screenshot review would have flagged as anything but "the gun is
    // gone".
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = false;
      m.receiveShadow = false;
      // A near-camera object whose bounds are computed once and then animated by
      // a parent will pop out at the frame edge. Cheaper to never cull it than
      // to keep its bounds correct.
      m.frustumCulled = false;
      tuneMaterial(m);
    }
  });

  return {
    group,
    muzzle,
    magazine,
    optic: opticCentre,
    problems,
    stats: {
      vertices,
      lengthMetres: CARBINE_LENGTH,
      opticX: opticCentre.x,
      opticY: opticCentre.y,
      magazineTriangles,
    },
  };
}

/**
 * Split the magazine out of the weapon's single mesh.
 *
 * The generator returns ONE mesh with ONE material — there is no `magazine`
 * node to find. Rather than accept that as "the asset does not support a reload
 * animation", the triangles inside the magazine region are moved to a second
 * geometry that SHARES the original's vertex attribute buffers and differs only
 * in its index. That costs one extra draw call and zero extra memory, and it
 * keeps M1's reload — the mag drops at 25%, is hidden through the swap, and
 * seats at 62% — working with the real weapon.
 */
function splitMagazine(model: THREE.Object3D, bounds: Bounds): THREE.Object3D | null {
  let result: THREE.Object3D | null = null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) meshes.push(m);
  });

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const index = geo.getIndex();
    const pos = geo.getAttribute('position');
    if (!index || !pos) continue;

    const keep: number[] = [];
    const mag: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const i0 = index.getX(t);
      const i1 = index.getX(t + 1);
      const i2 = index.getX(t + 2);
      a.fromBufferAttribute(pos as THREE.BufferAttribute, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos as THREE.BufferAttribute, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos as THREE.BufferAttribute, i2).applyMatrix4(mesh.matrixWorld);
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (inRegion(centroid, bounds, REGION.magazine)) {
        mag.push(i0, i1, i2);
      } else {
        keep.push(i0, i1, i2);
      }
    }
    // A split that takes everything, or nothing, is not a split.
    if (mag.length < 30 || keep.length < 30) continue;

    const magGeo = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) {
      magGeo.setAttribute(name, geo.attributes[name]);
    }
    magGeo.setIndex(mag);
    magGeo.computeBoundingSphere();

    const magMesh = new THREE.Mesh(magGeo, mesh.material);
    magMesh.name = 'carbine-magazine';
    magMesh.frustumCulled = false;
    // Same parent and same local transform as the mesh it came from, so the
    // shared vertex positions land in exactly the same place.
    magMesh.position.copy(mesh.position);
    magMesh.quaternion.copy(mesh.quaternion);
    magMesh.scale.copy(mesh.scale);
    mesh.parent?.add(magMesh);

    geo.setIndex(keep);
    geo.computeBoundingSphere();
    result = magMesh;
    break;
  }
  return result;
}

/**
 * A generated weapon's PBR comes back as a mid-grey plastic. A carbine held 40 cm
 * from the eye is the most-looked-at object in the game, so it gets a pass:
 * darker, less uniformly rough, and genuinely metallic on the metal so the
 * viewmodel's dedicated three-point rig has something to catch.
 */
function tuneMaterial(mesh: THREE.Mesh): void {
  const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const out = src.map((m) => {
    const c = (m as THREE.MeshStandardMaterial).clone();
    c.color.multiplyScalar(0.72);
    c.roughness = Math.min(1, (c.roughness ?? 0.6) * 0.85 + 0.12);
    c.metalness = Math.max(c.metalness ?? 0, 0.45);
    c.envMapIntensity = 1.15;
    return c;
  });
  mesh.material = Array.isArray(mesh.material) ? out : out[0];
}

/**
 * A world-space carbine for the soldiers' hands.
 *
 * The same source mesh, lit by the world instead of the viewmodel rig, shadow
 * casting, and parented to a hand bone by the caller. Enemies carrying the same
 * weapon the player carries is not a detail: a firefight where the thing shooting
 * at you is holding nothing reads as unfinished, and both pipeline dissections
 * describe exactly that.
 */
export function buildWorldCarbine(assets: Assets, lengthMetres: number): THREE.Object3D | null {
  if (!assets.carbine) return null;
  const model = assets.carbine.scene.clone(true);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  const scale = size.z > 1e-5 ? lengthMetres / size.z : 1;
  model.scale.multiplyScalar(scale);
  model.traverse((o) => {
    o.layers.set(LAYER.WORLD);
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
    }
  });
  const wrap = new THREE.Group();
  wrap.name = 'world-carbine';
  wrap.add(model);
  // A muzzle marker so soldiers' tracers and flash lights leave the actual
  // barrel rather than the centre of the chest. The lateral bore offset is a
  // couple of millimetres and invisible at engagement range, so this takes the
  // -Z extreme on the centreline rather than re-running the full region fit.
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, -lengthMetres * 0.5);
  wrap.add(muzzle);
  return wrap;
}
