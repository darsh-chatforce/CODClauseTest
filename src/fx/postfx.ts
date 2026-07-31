import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SKY } from '../config';

/**
 * Post-processing.
 *
 * THE RULE THIS FILE IS BUILT AROUND: **bloom belongs to things that emit
 * light, not to things that are bright.**
 *
 * A threshold bloom — the one-line version, `UnrealBloomPass(threshold 0.85)` on
 * the composited frame — is what a generated build ships, and it is wrong in a
 * specific and expensive way: at dusk the brightest things in frame are the sky
 * and the sun-facing concrete, so a threshold bloom blooms the SKY. The picture
 * goes soft, contrast collapses, and the actual emitters (an enemy's visor
 * winding up to fire, a muzzle flash, a tracer) gain nothing because they were
 * never the brightest pixels in the first place. The one gameplay-critical
 * emissive in this game is a 400 ms telegraph the player is supposed to read
 * across 30 m, so blooming everything EXCEPT it is an anti-feature.
 *
 * So bloom here is SELECTIVE, by the standard three.js two-pass method:
 *
 *   1. Every object that is allowed to bloom is tagged once, at construction,
 *      via `markBloom()`. Nothing is tagged by accident and nothing is tagged by
 *      brightness.
 *   2. The bloom pass re-renders the scene with every UNTAGGED material swapped
 *      for flat black — which keeps OCCLUSION correct, so a visor behind a wall
 *      does not glow through it. That is the reason for the second render rather
 *      than a layer mask, which would have been cheaper and wrong.
 *   3. The blurred result is added to the HDR scene colour BEFORE tone mapping,
 *      which is where a real light bloom happens.
 *
 * The chain is deliberately short — two full-screen passes plus SMAA:
 *
 *   ScenePass (world + viewmodel, HDR linear, into a render target)
 *     → FinalPass  (add bloom · ACES tone map at the project exposure
 *                   · dusk grade · vignette · sRGB encode)
 *     → SMAAPass   (to the canvas)
 *
 * `FinalPass` folds what would otherwise be three separate `ShaderPass`es
 * (bloom mix, `OutputPass`, grade/vignette) into one, because each pass is a
 * full-screen read+write at 1080p and they are all cheap arithmetic.
 *
 * IMPORTANT — why tone mapping moves into `FinalPass`: since three r152 the
 * renderer only applies `toneMapping` when it draws to the CANVAS. Rendering the
 * scene into a composer target therefore yields linear HDR, which is exactly what
 * bloom needs, and makes the tone map this file's job. The ACES implementation
 * below is three's own, byte for byte, so `postfx off` and `postfx on` agree on
 * exposure instead of being two different-looking games.
 */

// ---------------------------------------------------------------- tagging

/**
 * Mark an object (and its descendants) as an authored emitter.
 *
 * Call sites are the whole allow-list: enemy visors, the muzzle flash sprite and
 * its viewmodel twin, tracers, impact sparks, and the optic's red dot.
 */
export function markBloom(object: THREE.Object3D): void {
  object.traverse((o) => {
    o.userData.bloom = true;
  });
}

// ------------------------------------------------------------- scene pass

/**
 * Renders the two scenes the game actually has — the world, then the viewmodel
 * on a cleared depth buffer — into one target.
 *
 * This exists instead of two `RenderPass`es because the depth clear between them
 * is the thing that stops the weapon clipping through walls (DECISIONS §2.1), and
 * `RenderPass` has no way to express "second scene, same target, depth cleared".
 */
class ScenePass extends Pass {
  /** Set by the game each frame: the viewmodel is not drawn in inspect mode. */
  drawViewmodel = true;
  /** When true, everything untagged renders black (the bloom pre-pass). */
  bloomOnly = false;

  private readonly black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private readonly saved = new Map<number, THREE.Material | THREE.Material[]>();

  constructor(
    private readonly world: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly vmScene: THREE.Scene,
    private readonly vmCamera: THREE.Camera,
  ) {
    super();
    this.needsSwap = true;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    void readBuffer;
    const target = this.renderToScreen ? null : writeBuffer;
    const prevBackground = this.world.background;
    const prevClear = renderer.getClearColor(_color).clone();
    const prevAlpha = renderer.getClearAlpha();

    if (this.bloomOnly) {
      // The sky is not an emitter. It is also most of the frame, so leaving it
      // in would make the bloom pass a very expensive way to blur the sky.
      this.world.background = null;
      renderer.setClearColor(0x000000, 1);
      this.darken(this.world);
      this.darken(this.vmScene);
    }

    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.clear();
    renderer.render(this.world, this.camera);
    if (this.drawViewmodel) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.vmScene, this.vmCamera);
      renderer.autoClear = true;
    }

    if (this.bloomOnly) {
      this.restore();
      this.world.background = prevBackground;
      renderer.setClearColor(prevClear, prevAlpha);
    }
  }

  /** Swap every untagged material for flat black, remembering the originals. */
  private darken(scene: THREE.Scene): void {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints)) return;
      if (o.userData.bloom) return;
      const holder = o as unknown as { material: THREE.Material | THREE.Material[] };
      if (!holder.material) return;
      this.saved.set(o.id, holder.material);
      holder.material = this.black;
    });
  }

  private restore(): void {
    for (const [id, mat] of this.saved) {
      const o = this.world.getObjectById(id) ?? this.vmScene.getObjectById(id);
      if (o) (o as unknown as { material: THREE.Material | THREE.Material[] }).material = mat;
    }
    this.saved.clear();
  }

  override dispose(): void {
    this.black.dispose();
  }
}

const _color = new THREE.Color();

// ------------------------------------------------------------- final pass

/**
 * Bloom mix + ACES tone map + dusk grade + vignette + sRGB encode, in one pass.
 *
 * THE GRADE. "Colour grade toward dusk" is easy to overdo into an orange filter
 * over a blue game, so it is expressed as the two things a low sun actually does
 * and nothing else: shadows pick up the sky's cool bounce, highlights pick up the
 * sun's warmth, and the whole frame loses a little saturation in the deepest
 * values because the eye does the same at low light. The split is driven by the
 * pixel's own luminance, so it lands on the picture's tonal structure rather than
 * on a fixed colour.
 *
 * THE VIGNETTE is deliberately weak (`uVignette` ≈ 0.3) and starts late. A
 * vignette's job here is to stop the eye leaving the frame and to give the HUD's
 * corner readouts something to sit on; a heavy one just looks like a filter and
 * eats the peripheral information a shooter needs.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tBloom: { value: null as THREE.Texture | null },
    uBloom: { value: 1.0 },
    uExposure: { value: SKY.exposure },
    uVignette: { value: 0.3 },
    uGrade: { value: 1.0 },
    uShadowTint: { value: new THREE.Color(0x4d6b93) },
    uHighlightTint: { value: new THREE.Color(0xffc98a) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uBloom;
    uniform float uExposure;
    uniform float uVignette;
    uniform float uGrade;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    varying vec2 vUv;

    // three.js ACESFilmicToneMapping, verbatim, so postfx on/off agree.
    //
    // The nf- prefix is not decoration. three injects its OWN RRTAndODTFit and
    // ACESFilmicToneMapping into every ShaderMaterial whose draw target is the
    // CANVAS, and NOT into one whose target is a render target. So this shader
    // compiled cleanly as a mid-chain pass and broke the instant a measurement
    // run disabled SMAA and made it the last pass, with "function already has a
    // body". A latent, configuration-dependent shader break, surfaced only by
    // instrumenting for an unrelated performance question.
    vec3 nfRRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 nfACESFilmic(vec3 color) {
      const mat3 ACESInputMat = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777)
      );
      const mat3 ACESOutputMat = mat3(
        vec3( 1.60475, -0.10208, -0.00327),
        vec3(-0.53108,  1.10813, -0.07276),
        vec3(-0.07367, -0.00605,  1.07602)
      );
      color *= uExposure / 0.6;
      color = ACESInputMat * color;
      color = nfRRTAndODTFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }

    vec3 nfLinearToSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c));
    }

    void main() {
      vec3 hdr = texture2D(tDiffuse, vUv).rgb;
      hdr += texture2D(tBloom, vUv).rgb * uBloom;

      vec3 col = nfACESFilmic(hdr);

      // ---- dusk grade -----------------------------------------------------
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float shadow = 1.0 - smoothstep(0.0, 0.45, luma);
      float highlight = smoothstep(0.55, 1.0, luma);
      vec3 graded = col;
      graded = mix(graded, graded * uShadowTint * 1.55, shadow * 0.28);
      graded = mix(graded, graded * uHighlightTint * 1.06, highlight * 0.32);
      // Slight desaturation in the deepest values — scotopic falloff, cheaply.
      graded = mix(vec3(luma), graded, 1.0 - shadow * 0.16);
      col = mix(col, graded, uGrade);

      // ---- vignette --------------------------------------------------------
      vec2 d = vUv - 0.5;
      float r = dot(d, d) * 2.0;
      col *= 1.0 - uVignette * smoothstep(0.35, 1.25, r);

      gl_FragColor = vec4(nfLinearToSRGB(col), 1.0);
    }
  `,
};

// ------------------------------------------------------------------- rig

export interface PostFxFrameCost {
  /** Milliseconds of wall-clock frame time, averaged. */
  ms: number;
  fps: number;
}

export class PostFx {
  /** Toggled from the settings screen. False = the M1/M2 direct render path. */
  enabled = true;
  /** Ambient occlusion is opt-in and measured; see DECISIONS §29. */
  ao = false;
  private bloomEnabled = true;
  private readonly bloomStrength = 1.0;

  private readonly scenePass: ScenePass;
  private readonly bloomScenePass: ScenePass;
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly finalPass: ShaderPass;
  private readonly smaaPass: SMAAPass;
  private gtao: GTAOPass | null = null;
  private width = 1;
  private height = 1;

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly world: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    vmScene: THREE.Scene,
    vmCamera: THREE.PerspectiveCamera,
  ) {
    this.scenePass = new ScenePass(world, camera, vmScene, vmCamera);
    this.bloomScenePass = new ScenePass(world, camera, vmScene, vmCamera);
    this.bloomScenePass.bloomOnly = true;

    // The bloom chain runs at HALF resolution. Bloom is a low-frequency effect
    // by definition, so the only thing full resolution buys is cost — and this
    // chain re-renders the whole scene, so it is the expensive half.
    this.bloomComposer = new EffectComposer(renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(this.bloomScenePass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.62, 0.0);
    this.bloomComposer.addPass(this.bloomPass);

    this.finalComposer = new EffectComposer(renderer);
    // MSAA ON THE COMPOSER TARGETS — a regression fix, not an upgrade.
    //
    // `new WebGLRenderer({ antialias: true })` only antialiases the DEFAULT
    // framebuffer. The moment the scene is rendered into a composer render
    // target instead, that flag does nothing and `EffectComposer` allocates its
    // targets with `samples: 0` — so switching post-processing ON silently threw
    // hardware multisampling away and left SMAA to carry the whole load. SMAA is
    // a morphological filter with no temporal component; on a huge smooth
    // silhouette against a bright sky it reduces the stair-stepping but not the
    // crawl. This puts the 4× MSAA back underneath it.
    this.finalComposer.renderTarget1.samples = 0;
    this.finalComposer.renderTarget2.samples = 0;
    this.finalComposer.addPass(this.scenePass);
    this.finalPass = new ShaderPass(FinalShader);
    this.finalPass.uniforms.tBloom.value = this.bloomComposer.readBuffer.texture;
    this.finalComposer.addPass(this.finalPass);
    this.smaaPass = new SMAAPass();
    this.finalComposer.addPass(this.smaaPass);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    this.finalComposer.setSize(width, height);
    this.finalComposer.setPixelRatio(pixelRatio);
    // `setSize` reallocates the targets' storage, so the sample count is
    // re-asserted rather than assumed to survive.
    this.finalComposer.renderTarget1.samples = 0;
    this.finalComposer.renderTarget2.samples = 0;
    const bw = Math.max(1, Math.floor(width * 0.5));
    const bh = Math.max(1, Math.floor(height * 0.5));
    this.bloomComposer.setSize(bw, bh);
    this.bloomComposer.setPixelRatio(pixelRatio);
    this.bloomPass.setSize(bw * pixelRatio, bh * pixelRatio);
    this.gtao?.setSize(width * pixelRatio, height * pixelRatio);
    // setSize can hand the composer a fresh read buffer.
    this.finalPass.uniforms.tBloom.value = this.bloomComposer.readBuffer.texture;
  }

  /** Turn ambient occlusion on/off. Built lazily — it is the expensive one. */
  setAo(on: boolean): void {
    if (on === this.ao) return;
    this.ao = on;
    if (on && !this.gtao) {
      const g = new GTAOPass(this.world, this.camera, this.width, this.height);
      g.output = GTAOPass.OUTPUT.Default;
      g.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 0.6, scale: 0.9 });
      // Insert between the scene and the final composite so AO darkens the HDR
      // colour rather than the graded output.
      this.finalComposer.insertPass(g, 1);
      this.gtao = g;
    }
    if (this.gtao) this.gtao.enabled = on;
  }

  /**
   * Draw one frame.
   *
   * Returns false when post-processing is off, and the caller falls back to the
   * plain two-pass render. That fallback is not a nicety: it is the settings
   * toggle, it is the low-end path, and it is what the smoke suite boots to prove
   * the game does not depend on the composer being alive.
   */
  render(drawViewmodel: boolean): boolean {
    if (!this.enabled) return false;
    this.scenePass.drawViewmodel = drawViewmodel;
    this.bloomScenePass.drawViewmodel = drawViewmodel;
    if (this.bloomEnabled) this.bloomComposer.render();
    this.finalComposer.render();
    return true;
  }

  /**
   * Turn individual stages off. This exists to MEASURE them: "post-processing
   * costs 5 ms" is not an actionable number, and the only way to find out which
   * of the three stages owns it is to run the frame without each in turn.
   * `tools/look.mjs` uses it to produce the cost breakdown in DECISIONS §29.
   */
  setParts(parts: { bloom?: boolean; smaa?: boolean }): void {
    if (parts.bloom !== undefined) {
      this.bloomEnabled = parts.bloom;
      this.finalPass.uniforms.uBloom.value = parts.bloom ? this.bloomStrength : 0;
    }
    if (parts.smaa !== undefined) this.smaaPass.enabled = parts.smaa;
  }

  dispose(): void {
    this.scenePass.dispose();
    this.bloomScenePass.dispose();
    this.bloomComposer.dispose();
    this.finalComposer.dispose();
  }
}
