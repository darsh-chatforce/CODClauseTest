import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The asset layer.
 *
 * M1 shipped with zero asset files, which made "did it load?" a question that
 * could not be asked. M2 introduces ~30 files, and with them the single most
 * common way a generated build looks broken: **an asset silently fails to load
 * and the game renders the fallback.** Both pipeline dissections contain a
 * version of it — a cyan placeholder cube where the player model should be, a
 * 404 on a relative asset URL that nothing surfaced.
 *
 * So the rules here are:
 *
 * 1. **Every load is recorded.** `AssetReport` lists what succeeded and what
 *    failed, with the URL and the error. `tools/smoke.mjs` asserts `failed === 0`.
 *    A missing texture is now a red test, not a slightly-wrong screenshot.
 * 2. **Failure is never fatal.** A failed asset resolves to `null` and the caller
 *    keeps its graybox path, so a bad deploy is a *degraded* game rather than a
 *    black screen. Loud in the report, soft in the frame.
 * 3. **URLs are resolved against `document.baseURI`, once, here.** Vite is
 *    configured `base: './'`; a bare `/textures/x.png` works on a dev server and
 *    404s the moment the build is served from a subpath. That exact bug is a
 *    documented pipeline regression, so the resolution happens in one function
 *    that everything goes through.
 */

export interface AssetFailure {
  url: string;
  error: string;
}

export interface AssetReport {
  requested: number;
  loaded: number;
  failed: AssetFailure[];
  ms: number;
}

export function assetUrl(rel: string): string {
  return new URL(rel, document.baseURI).href;
}

/** A PBR material's three maps, as loaded. Any of them may be null. */
export interface MaterialMaps {
  map: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
}

export type MaterialName = 'concrete' | 'plaster' | 'metal' | 'sand' | 'ground_slab';
export type DecalName = 'grime' | 'hazard' | 'stencil';
export type PropName =
  | 'crate_military'
  | 'barrier_concrete'
  | 'sandbag_wall'
  | 'watchtower'
  | 'antenna_mast'
  | 'oil_drum';

const MATERIALS: MaterialName[] = ['concrete', 'plaster', 'metal', 'sand', 'ground_slab'];
const DECALS: DecalName[] = ['grime', 'hazard', 'stencil'];
const PROPS: PropName[] = [
  'crate_military',
  'barrier_concrete',
  'sandbag_wall',
  'watchtower',
  'antenna_mast',
  'oil_drum',
];
/** Soldier animation clips, by the name the AnimationMixer looks up. */
export const SOLDIER_CLIPS = ['idle', 'walk', 'run', 'aim', 'fire', 'death'] as const;
export type SoldierClip = (typeof SOLDIER_CLIPS)[number];

export class Assets {
  readonly materials = new Map<MaterialName, MaterialMaps>();
  readonly decals = new Map<DecalName, THREE.Texture>();
  readonly props = new Map<PropName, THREE.Object3D>();
  /** Rigged soldier mesh (shared source; instances are SkeletonUtils clones). */
  soldier: GLTF | null = null;
  readonly soldierClips = new Map<SoldierClip, THREE.AnimationClip>();
  /** The generated carbine. One source, cloned for the viewmodel AND every
   *  soldier's hands — the player and the hostiles carry the same weapon. */
  carbine: GLTF | null = null;
  /** Blend mask between the two ground materials. Used at repeat = 1. */
  groundMask: THREE.Texture | null = null;
  /** Photographic dusk sky, as a cube background. */
  skyCube: THREE.CubeTexture | null = null;
  /** The same sky as an equirect, for PMREM → scene.environment. */
  skyEquirect: THREE.Texture | null = null;

  private readonly failures: AssetFailure[] = [];
  private requested = 0;
  private loadedCount = 0;

  private readonly texLoader = new THREE.TextureLoader();
  private readonly gltfLoader = new GLTFLoader();

  get report(): AssetReport {
    return {
      requested: this.requested,
      loaded: this.loadedCount,
      failed: [...this.failures],
      ms: this.elapsed,
    };
  }

  private elapsed = 0;

  /** Load everything. Never rejects — inspect `report` instead. */
  async loadAll(): Promise<AssetReport> {
    const t0 = performance.now();
    await Promise.all([
      this.loadSky(),
      this.loadMaterials(),
      this.loadDecals(),
      this.loadSoldier(),
      this.loadProps(),
      this.loadCarbine(),
    ]);
    this.elapsed = Math.round(performance.now() - t0);
    if (this.failures.length) {
      // One console error per failure. The smoke suite asserts a clean console,
      // so a missing asset fails the build twice over — by the asset report AND
      // by console hygiene. Deliberate belt and braces.
      for (const f of this.failures) {
        console.error(`[assets] FAILED ${f.url}: ${f.error}`);
      }
    }
    return this.report;
  }

  // ------------------------------------------------------------- primitives

  private async texture(
    rel: string,
    { srgb = false, repeat = true }: { srgb?: boolean; repeat?: boolean } = {},
  ): Promise<THREE.Texture | null> {
    this.requested++;
    const url = assetUrl(rel);
    try {
      const tex = await this.texLoader.loadAsync(url);
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
      if (repeat) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
      }
      tex.anisotropy = 8;
      this.loadedCount++;
      return tex;
    } catch (e) {
      this.failures.push({ url, error: String(e) });
      return null;
    }
  }

  private async gltf(rel: string): Promise<GLTF | null> {
    this.requested++;
    const url = assetUrl(rel);
    try {
      const g = await this.gltfLoader.loadAsync(url);
      this.loadedCount++;
      return g;
    } catch (e) {
      this.failures.push({ url, error: String(e) });
      return null;
    }
  }

  // ----------------------------------------------------------------- groups

  private async loadSky(): Promise<void> {
    // Cube faces for the BACKGROUND (1024²/face — the sky is most of the frame
    // in an outdoor level, so it gets the resolution) and a small equirect for
    // the IBL (PMREM throws away high frequencies anyway).
    this.requested++;
    const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => assetUrl(`sky/${f}.png`));
    try {
      const cube = await new THREE.CubeTextureLoader().loadAsync(faces);
      cube.colorSpace = THREE.SRGBColorSpace;
      this.skyCube = cube;
      this.loadedCount++;
    } catch (e) {
      this.failures.push({ url: faces[0], error: String(e) });
    }

    const eq = await this.texture('sky/env.png', { srgb: true, repeat: false });
    if (eq) {
      eq.mapping = THREE.EquirectangularReflectionMapping;
      this.skyEquirect = eq;
    }
  }

  private async loadMaterials(): Promise<void> {
    await Promise.all(
      MATERIALS.map(async (name) => {
        const [map, normalMap, roughnessMap, metalnessMap] = await Promise.all([
          this.texture(`textures/${name}_albedo.jpg`, { srgb: true }),
          this.texture(`textures/${name}_normal.png`),
          this.texture(`textures/${name}_rough.png`),
          name === 'metal' ? this.texture(`textures/metal_metalness.png`) : Promise.resolve(null),
        ]);
        this.materials.set(name, { map, normalMap, roughnessMap, metalnessMap });
      }),
    );
  }

  private async loadDecals(): Promise<void> {
    this.groundMask = await this.texture('textures/ground_mask.png', { repeat: false });
    await Promise.all(
      DECALS.map(async (name) => {
        const t = await this.texture(`textures/decal_${name}.png`, {
          srgb: true,
          repeat: name === 'hazard',
        });
        if (t) this.decals.set(name, t);
      }),
    );
  }

  private async loadSoldier(): Promise<void> {
    this.soldier = await this.gltf('models/soldier.glb');
    await Promise.all(
      SOLDIER_CLIPS.map(async (name) => {
        const g = await this.gltf(`models/soldier_${name}.glb`);
        const clip = g?.animations?.[0];
        if (!clip) return;
        // The clip GLBs are named by the bake step. Trust but VERIFY: a clip
        // exported as `copy_walk` while the code asks for `walk` is a silent
        // no-animation bug, and it is exactly the kind of thing that survives a
        // screenshot review. Rename defensively and record the discrepancy.
        if (clip.name !== name) {
          console.warn(`[assets] clip ${name} exported as "${clip.name}" — renaming`);
          clip.name = name;
        }
        this.soldierClips.set(name, clip);
      }),
    );
  }

  /** The carbine is NOT in `PROPS`: it is not scenery, it is the weapon, and it
   *  is fitted by measurement rather than fitted to a collider box. */
  private async loadCarbine(): Promise<void> {
    this.carbine = await this.gltf('models/props/carbine.glb');
  }

  private async loadProps(): Promise<void> {
    await Promise.all(
      PROPS.map(async (name) => {
        const g = await this.gltf(`models/props/${name}.glb`);
        if (g) this.props.set(name, g.scene);
      }),
    );
  }

  // ------------------------------------------------------------------ apply

  /**
   * Build a `MeshStandardMaterial` from a loaded material set at a given world
   * tiling scale. `repeat` is in TILES PER METRE, so a caller states the physical
   * size of the texture rather than a UV number that means nothing on its own.
   */
  standard(
    name: MaterialName,
    opts: {
      repeat?: number;
      color?: number;
      roughness?: number;
      metalness?: number;
      normalScale?: number;
    } = {},
  ): THREE.MeshStandardMaterial {
    const maps = this.materials.get(name);
    const mat = new THREE.MeshStandardMaterial({
      color: opts.color ?? 0xffffff,
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0.0,
    });
    if (!maps) return mat;
    const r = opts.repeat ?? 1;
    const clone = (t: THREE.Texture | null): THREE.Texture | null => {
      if (!t) return null;
      const c = t.clone();
      c.needsUpdate = true;
      c.wrapS = THREE.RepeatWrapping;
      c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(r, r);
      c.anisotropy = t.anisotropy;
      c.colorSpace = t.colorSpace;
      return c;
    };
    mat.map = clone(maps.map);
    mat.normalMap = clone(maps.normalMap);
    mat.roughnessMap = clone(maps.roughnessMap);
    mat.metalnessMap = clone(maps.metalnessMap);
    if (mat.normalMap) mat.normalScale.setScalar(opts.normalScale ?? 1);
    // A roughnessMap only MODULATES `roughness`, and a metalnessMap only
    // modulates `metalness` — leaving the scalars at a default silently throws
    // the map away. So when a map is present and the caller said nothing, the
    // scalar goes to 1 and the map IS the value.
    //
    // ENGINE DEFECT FIXED AT M3 (DECISIONS §31). The previous version set those
    // scalars to 1 UNCONDITIONALLY, i.e. it also overwrote whatever the caller
    // had explicitly asked for. Every `roughness:`/`metalness:` override in
    // `world/arena.ts` was therefore dead code, including the shipping
    // containers' `metalness: 0.18` — which carries a comment explaining that it
    // is the fix for containers mirroring the sky, a fix that had never once
    // executed. The containers went on mirroring the sky for the whole of M2 and
    // are visibly blue slabs in `shots/01_spawn.png`.
    //
    // This is a textbook silent-override bug and it is instructive because of
    // WHERE it hid: behind a comment asserting the opposite. A code comment is
    // not a test. Nothing in the suite could see it, because the suite had no
    // way to ask "did that number reach the GPU?".
    if (mat.roughnessMap) mat.roughness = opts.roughness ?? 1;
    if (mat.metalnessMap) mat.metalness = opts.metalness ?? 1;
    mat.needsUpdate = true;
    return mat;
  }
}
