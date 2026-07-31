import { createRng } from '../core/rng';

/**
 * Audio.
 *
 * ============================================================================
 * WHY THIS IS SYNTHESISED RATHER THAN GENERATED OR DOWNLOADED
 * ============================================================================
 *
 * The brief allowed either the backend's generative audio tools or hand-built
 * synthesis. Synthesis won on four grounds, and they are the same grounds every
 * other choice in this project was made on:
 *
 *  1. **Payload.** The shipped game is 13 MB and most of that is the sky and the
 *     soldier. A dozen generated WAVs at any usable quality is another 2-6 MB for
 *     sounds that are, in this game, half a second long. Every one of them is a
 *     filtered noise burst with an envelope; storing a rendered PCM copy of a
 *     filtered noise burst is paying megabytes for arithmetic.
 *  2. **Latency and layering.** A gunshot here is FOUR nodes whose parameters are
 *     driven per shot — the crack brightens with the first round of a burst and
 *     darkens as the barrel heats, the tail changes with the shooter's distance,
 *     and enemy fire is the same synth at a different distance rather than a
 *     different file. A sample set cannot do distance without either a filter
 *     chain on top (i.e. this code anyway) or N variants per range band.
 *  3. **Determinism and testability.** No fetch, no decode, no 404, no CDN, no
 *     "the audio silently failed to load and nobody noticed". `audio.init()` is a
 *     pure function of the AudioContext, and the smoke suite asserts it does not
 *     throw and that the graph came up. The asset layer's whole reason for
 *     existing (DECISIONS §19) is that a silently-missing asset renders as the
 *     fallback; not having assets is a stronger version of the same guarantee.
 *  4. **It is the honest version of the deliverable.** A generated gunshot would
 *     be a better gunshot. It would also be a black box I could not defend line
 *     by line, and the point of this build is that every choice in it has a
 *     reason attached.
 *
 * The trade is stated plainly in DECISIONS §30: these are GOOD synthesised
 * sounds, not recorded ones, and a shipping game would want recordings for the
 * weapon at least.
 *
 * ============================================================================
 * MASTERING
 * ============================================================================
 *
 * "No clipping" is a structural property here, not a mixing opinion:
 *
 *      voices → bus gain → limiter (compressor, ratio 20:1, knee 0) → master
 *
 * The limiter's threshold sits at -8 dBFS with a 3 ms attack, and the master gain
 * is held at 0.62, so the sum of every simultaneous voice in the worst case (a
 * three-round burst from two soldiers while the player is firing) cannot reach
 * 0 dBFS. Web Audio does not clip internally — it clips at the DEVICE — so
 * without a limiter the failure mode is a crackle that only appears on someone
 * else's machine.
 *
 * ============================================================================
 * DISTANCE
 * ============================================================================
 *
 * `positional()` models three things that actually distinguish a near gunshot
 * from a far one, and skips the rest:
 *   · inverse falloff on gain,
 *   · a low-pass whose corner drops with distance (air absorbs treble — this is
 *     the cue that reads as "far away" far more than volume does),
 *   · stereo pan from the bearing relative to the player's facing.
 * A `PannerNode` would give HRTF for free and cost a graph node per voice; at six
 * hostiles firing three-round bursts that is a lot of nodes for a game whose
 * camera is a first-person head with no elevation cue worth modelling.
 */

/** Audio uses its OWN generator. Drawing from the shared gameplay `rng` would
 *  make the simulation depend on how many sounds played, which would break the
 *  reproducibility the seeded RNG exists to provide. */
const arng = createRng(0xa0d10);

const MASTER_GAIN = 0.62;

export interface ShotOptions {
  /** Metres from the listener. 0 = the player's own weapon. */
  distance: number;
  /** Radians: bearing to the source relative to where the player is looking. */
  bearing: number;
  /** Enemy fire is darker and a touch quieter at the same distance. */
  enemy?: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambientNodes: AudioScheduledSourceNode[] = [];
  private started = false;

  /** True once the graph exists. Reported in the test snapshot. */
  ready = false;
  /** Non-null if construction failed — surfaced rather than swallowed. */
  error: string | null = null;
  /** Player-facing mute, from the settings screen. */
  muted = false;

  /**
   * Build the graph.
   *
   * NEVER THROWS. Browsers refuse to create an AudioContext before a user
   * gesture, headless Chrome runs with `--mute-audio`, and some environments
   * have no audio device at all. None of those is a reason for the GAME to fail,
   * so every one of them ends up as `ready === false` plus a recorded reason.
   * `tools/smoke.mjs` asserts this call does not throw.
   */
  init(): void {
    if (this.ctx || this.error) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.error = 'no AudioContext in this browser';
        return;
      }
      const ctx = new Ctor();
      this.ctx = ctx;

      // ---- master chain: limiter then gain -------------------------------
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;

      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      limiter.connect(master);
      master.connect(ctx.destination);
      this.master = master;

      const bus = (gain: number): GainNode => {
        const g = ctx.createGain();
        g.gain.value = gain;
        g.connect(limiter);
        return g;
      };
      this.sfx = bus(1.0);
      this.ambientBus = bus(0.5);
      this.uiBus = bus(0.55);

      this.noise = makeNoiseBuffer(ctx);
      this.ready = true;
    } catch (e) {
      this.error = String(e);
      this.ctx = null;
      this.ready = false;
    }
  }

  /**
   * Resume after a user gesture and start the ambient bed.
   *
   * Called from the mission-start click. `resume()` returns a promise that some
   * browsers simply never settle when the gesture is not trusted, so it is fired
   * and forgotten with a catch rather than awaited — a game that waits on the
   * audio policy before starting is a game that sometimes does not start.
   */
  resume(): void {
    this.init();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    if (!this.started) {
      this.started = true;
      this.startAmbient();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : MASTER_GAIN;
  }

  private get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ------------------------------------------------------------- primitives

  /**
   * One noise voice: a slice of the shared noise buffer through a filter, with
   * an explicit envelope. Every impulsive sound in the game is one or more of
   * these, which is why there is exactly one of it.
   */
  private noiseVoice(
    bus: GainNode,
    opts: {
      when?: number;
      duration: number;
      gain: number;
      type: BiquadFilterType;
      freq: number;
      q?: number;
      /** Filter frequency at the END of the envelope — the "sweep". */
      freqEnd?: number;
      attack?: number;
      pan?: number;
      playbackRate?: number;
    },
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = (opts.when ?? 0) + this.now;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = arng.range(0, 1.5);
    src.loopEnd = src.loopStart + 0.4;
    src.playbackRate.value = opts.playbackRate ?? 1;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, opts.freqEnd),
        t + opts.duration,
      );
    }
    filter.Q.value = opts.q ?? 1;

    const env = ctx.createGain();
    const attack = opts.attack ?? 0.002;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);

    src.connect(filter);
    filter.connect(env);
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      env.connect(pan);
      pan.connect(bus);
    } else {
      env.connect(bus);
    }
    src.start(t);
    src.stop(t + opts.duration + 0.05);
  }

  /** One pitched voice — used for the low body of a shot and for UI blips. */
  private toneVoice(
    bus: GainNode,
    opts: {
      when?: number;
      duration: number;
      gain: number;
      freq: number;
      freqEnd?: number;
      type?: OscillatorType;
      pan?: number;
    },
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = (opts.when ?? 0) + this.now;
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t + opts.duration);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);
    osc.connect(env);
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      env.connect(pan);
      pan.connect(bus);
    } else {
      env.connect(bus);
    }
    osc.start(t);
    osc.stop(t + opts.duration + 0.02);
  }

  /** Gain, brightness and pan for a source at `distance` on `bearing`. */
  private positional(distance: number, bearing: number): {
    gain: number;
    cutoff: number;
    pan: number;
  } {
    const d = Math.max(0, distance);
    return {
      gain: 1 / (1 + d / 9),
      // 18 kHz at the muzzle down to ~1.2 kHz at 60 m: air absorption is the
      // cue that reads as distance, more than level is.
      cutoff: 1200 + 16800 / (1 + d / 6),
      pan: Math.sin(bearing) * Math.min(1, d / 4) * 0.85,
    };
  }

  // ------------------------------------------------------------------ sounds

  /**
   * A rifle shot: transient crack, body, mechanical action, and a tail.
   *
   * FOUR LAYERS, because a gunshot is four events and a single noise burst is
   * the thing that reads as a toy:
   *   · CRACK — a 25 ms high-passed transient sweeping down. The supersonic snap.
   *   · BODY — a fast low sine drop, 220 → 60 Hz. The chest thump.
   *   · ACTION — a short bright tick. The bolt cycling; it is what makes a
   *     3-round burst sound like a mechanism rather than a repeated sample.
   *   · TAIL — a longer, much darker, quieter burst delayed by 40 ms. The
   *     compound's walls answering. Scaled UP with distance, because a far shot
   *     is mostly its own reflections.
   */
  shot(opts: ShotOptions): void {
    if (!this.sfx || !this.ready) return;
    const { gain, cutoff, pan } = this.positional(opts.distance, opts.bearing);
    const enemy = opts.enemy ? 0.78 : 1;
    const bright = opts.enemy ? 0.72 : 1;
    const v = gain * enemy;
    if (v < 0.02) return;

    this.noiseVoice(this.sfx, {
      duration: 0.055,
      gain: 0.55 * v,
      type: 'highpass',
      freq: Math.min(cutoff, 1800 * bright),
      freqEnd: Math.min(cutoff, 420),
      q: 0.8,
      pan,
    });
    this.toneVoice(this.sfx, {
      duration: 0.1,
      gain: 0.42 * v,
      freq: 220 * bright,
      freqEnd: 58,
      type: 'sine',
      pan,
    });
    this.noiseVoice(this.sfx, {
      when: 0.012,
      duration: 0.035,
      gain: 0.14 * v * bright,
      type: 'bandpass',
      freq: Math.min(cutoff, 3400),
      q: 3.2,
      pan,
    });
    // The tail grows with distance: near, it is a detail; at 40 m it is the shot.
    const tail = 0.16 + Math.min(0.55, opts.distance / 55);
    this.noiseVoice(this.sfx, {
      when: 0.04,
      duration: 0.22 + opts.distance * 0.004,
      gain: tail * v,
      type: 'lowpass',
      freq: Math.min(cutoff, 900),
      freqEnd: 240,
      q: 0.7,
      pan: pan * 0.5,
    });
  }

  /** Round found flesh. Deliberately dry and short — this is information. */
  hitConfirm(killed: boolean): void {
    if (!this.uiBus || !this.ready) return;
    this.toneVoice(this.uiBus, {
      duration: killed ? 0.16 : 0.055,
      gain: killed ? 0.3 : 0.22,
      freq: killed ? 1180 : 1560,
      freqEnd: killed ? 620 : 1240,
      type: 'triangle',
    });
    if (killed) {
      this.toneVoice(this.uiBus, { when: 0.07, duration: 0.2, gain: 0.22, freq: 780, freqEnd: 380, type: 'triangle' });
      this.noiseVoice(this.uiBus, { duration: 0.12, gain: 0.1, type: 'lowpass', freq: 500, freqEnd: 160 });
    }
  }

  /** A round hit world geometry near the player: a spall tick. */
  impact(distance: number, bearing: number): void {
    if (!this.sfx || !this.ready) return;
    const { gain, cutoff, pan } = this.positional(distance, bearing);
    if (gain < 0.05) return;
    this.noiseVoice(this.sfx, {
      duration: 0.06,
      gain: 0.22 * gain,
      type: 'bandpass',
      freq: Math.min(cutoff, arng.range(1600, 3200)),
      q: 2.4,
      pan,
    });
  }

  /**
   * Reload foley, scheduled AGAINST THE ANIMATION.
   *
   * The three clacks land at the same normalised times the viewmodel's reload
   * animation uses (mag out at 25%, mag in at 62%, bolt at 88%), computed from
   * the real reload duration, so foley and animation cannot drift apart when the
   * empty-mag reload runs 550 ms longer than the normal one. Sound scheduled
   * from its own timer instead is how a reload ends up clicking after the mag is
   * already seated.
   */
  reload(durationMs: number): void {
    if (!this.sfx || !this.ready) return;
    const s = durationMs / 1000;
    // Mag release + the magazine falling clear.
    this.noiseVoice(this.sfx, { when: s * 0.18, duration: 0.05, gain: 0.2, type: 'bandpass', freq: 2400, q: 2.6 });
    this.noiseVoice(this.sfx, { when: s * 0.28, duration: 0.09, gain: 0.16, type: 'lowpass', freq: 900, freqEnd: 300 });
    // Fresh magazine seated — the heaviest of the three.
    this.noiseVoice(this.sfx, { when: s * 0.62, duration: 0.07, gain: 0.28, type: 'lowpass', freq: 1500, freqEnd: 380, q: 1.2 });
    this.toneVoice(this.sfx, { when: s * 0.62, duration: 0.06, gain: 0.14, freq: 180, freqEnd: 90 });
    // Bolt release.
    this.noiseVoice(this.sfx, { when: s * 0.88, duration: 0.06, gain: 0.24, type: 'bandpass', freq: 3100, q: 3.0 });
  }

  /** Dry fire — the click that means "you are out", paired with the HUD prompt. */
  dryFire(): void {
    if (!this.sfx || !this.ready) return;
    this.noiseVoice(this.sfx, { duration: 0.03, gain: 0.16, type: 'bandpass', freq: 2600, q: 4 });
  }

  /** A footstep. `hard` = the player, softer for anything else. */
  footstep(hard: boolean, distance = 0, bearing = 0): void {
    if (!this.sfx || !this.ready) return;
    const { gain, cutoff, pan } = this.positional(distance, bearing);
    if (gain < 0.06) return;
    this.noiseVoice(this.sfx, {
      duration: 0.075,
      gain: (hard ? 0.115 : 0.07) * gain,
      type: 'lowpass',
      freq: Math.min(cutoff, arng.range(900, 1500)),
      freqEnd: 260,
      q: 0.9,
      pan,
    });
  }

  /** Landing from a jump. Scaled by impact speed. */
  land(strength: number): void {
    if (!this.sfx || !this.ready) return;
    const k = Math.max(0.2, Math.min(1, strength));
    this.noiseVoice(this.sfx, { duration: 0.14, gain: 0.2 * k, type: 'lowpass', freq: 700, freqEnd: 140 });
    this.toneVoice(this.sfx, { duration: 0.12, gain: 0.18 * k, freq: 110, freqEnd: 48 });
  }

  /** The player was hit: a body thud plus a brief ringing edge. */
  playerHurt(): void {
    if (!this.sfx || !this.ready) return;
    this.toneVoice(this.sfx, { duration: 0.18, gain: 0.34, freq: 150, freqEnd: 52 });
    this.noiseVoice(this.sfx, { duration: 0.11, gain: 0.2, type: 'bandpass', freq: 620, q: 1.6 });
  }

  /** UI tick. `weight` 0..1 — a menu hover vs a mission start. */
  ui(weight = 0.4): void {
    if (!this.uiBus || !this.ready) return;
    this.toneVoice(this.uiBus, {
      duration: 0.04 + weight * 0.06,
      gain: 0.16 + weight * 0.12,
      freq: 880 - weight * 300,
      freqEnd: 620 - weight * 260,
      type: 'square',
    });
  }

  /** Mission end. Won = a rising pair; lost = a falling one. */
  sting(won: boolean): void {
    if (!this.uiBus || !this.ready) return;
    const a = won ? 330 : 300;
    const b = won ? 495 : 190;
    this.toneVoice(this.uiBus, { duration: 0.45, gain: 0.22, freq: a, freqEnd: a, type: 'triangle' });
    this.toneVoice(this.uiBus, { when: 0.18, duration: 0.7, gain: 0.24, freq: b, freqEnd: b, type: 'triangle' });
    this.toneVoice(this.uiBus, { when: 0.18, duration: 0.7, gain: 0.1, freq: b / 2, freqEnd: b / 2, type: 'sine' });
  }

  // ------------------------------------------------------------------ ambient

  /**
   * The bed: wind and a distant rumble, both continuous, both modulated.
   *
   * Two layers and an LFO. Wind is the noise buffer through a band-pass whose
   * frequency and gain are walked by a slow LFO, so it breathes instead of
   * hissing; the rumble is a 42 Hz triangle under a low-pass, which is the
   * "somewhere else, something large" bed that makes an empty compound feel like
   * it is inside a bigger world. Both are started ONCE and never restarted —
   * retriggering an ambient loop on mission restart is an audible seam.
   */
  private startAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || !this.ambientBus || !this.noise) return;

    // ---- wind ------------------------------------------------------------
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 620;
    windFilter.Q.value = 0.55;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.33;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.ambientBus);
    wind.start();
    this.ambientNodes.push(wind);

    // Gusts: an LFO on the filter corner AND on the gain, at incommensurate
    // rates so the pattern never audibly repeats.
    const gustA = ctx.createOscillator();
    gustA.frequency.value = 0.061;
    const gustAGain = ctx.createGain();
    gustAGain.gain.value = 380;
    gustA.connect(gustAGain);
    gustAGain.connect(windFilter.frequency);
    gustA.start();
    this.ambientNodes.push(gustA);

    const gustB = ctx.createOscillator();
    gustB.frequency.value = 0.037;
    const gustBGain = ctx.createGain();
    gustBGain.gain.value = 0.16;
    gustB.connect(gustBGain);
    gustBGain.connect(windGain.gain);
    gustB.start();
    this.ambientNodes.push(gustB);

    // ---- distant rumble ---------------------------------------------------
    const rumble = ctx.createOscillator();
    rumble.type = 'triangle';
    rumble.frequency.value = 42;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 120;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.11;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(this.ambientBus);
    rumble.start();
    this.ambientNodes.push(rumble);

    const swell = ctx.createOscillator();
    swell.frequency.value = 0.023;
    const swellGain = ctx.createGain();
    swellGain.gain.value = 0.07;
    swell.connect(swellGain);
    swellGain.connect(rumbleGain.gain);
    swell.start();
    this.ambientNodes.push(swell);
  }

  dispose(): void {
    for (const n of this.ambientNodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.ambientNodes = [];
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.ready = false;
  }
}

/**
 * Two seconds of pink-ish noise, generated once.
 *
 * White noise reads as a hiss; a gunshot's noise content and wind's are both
 * weighted toward the low end, so this is a cheap one-pole pink filter over
 * white. Two seconds is long enough that the loop point is never audible when
 * voices take random 400 ms slices out of it.
 */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = arng() * 2 - 1;
    last = 0.97 * last + 0.03 * white;
    // Sum of the pink component and a little of the raw white keeps the top end.
    data[i] = Math.max(-1, Math.min(1, last * 7.5 + white * 0.35));
  }
  return buffer;
}
