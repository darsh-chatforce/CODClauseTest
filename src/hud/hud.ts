import { FEEL, MISSION, PLAYER } from '../config';
import { clamp, DEG } from '../core/mathx';

/**
 * DOM HUD.
 *
 * The layout lives in `index.html` + `hud.css` and this class only pushes state
 * into it. Two things worth calling out:
 *
 *  - The crosshair gap is DERIVED, not decorative: it is the weapon's current
 *    cone half-angle projected through the camera to pixels, so what the player
 *    sees is literally where their rounds can go. Sprinting visibly blows it
 *    open; ADS collapses it to the dot.
 *  - The directional damage arc is rotated into the player's own frame, so it
 *    points at the shooter rather than at a world direction.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`HUD element #${id} missing`);
  return el as T;
};

export class Hud {
  private readonly body = document.body;
  private readonly crosshair = $('crosshair');
  private readonly ticks = Array.from(
    document.querySelectorAll<HTMLElement>('#crosshair .ch-tick'),
  );
  private readonly hitmarker = $<HTMLElement>('hitmarker');
  private readonly healthValue = $('health-value');
  private readonly healthFill = $('health-fill');
  private readonly ammoMag = $('ammo-mag');
  private readonly ammoReserve = $('ammo-reserve');
  private readonly weaponName = $('weapon-name');
  private readonly reloadFill = $('reload-fill');
  private readonly hostiles = $('hostiles');
  private readonly objectiveText = $('objective-text');
  private readonly timerValue = $('timer-value');
  private readonly killfeed = $('killfeed');
  private readonly vignette = $('vignette');
  private readonly flashEl = $('flash');
  private readonly arcs = $('damage-arcs');
  private readonly prompt = $('prompt');

  private hitmarkerTimer = 0;
  private flashTimer = 0;
  private readonly activeArcs: Array<{ el: HTMLElement; worldAngle: number; life: number }> = [];

  constructor(weaponLabel: string) {
    this.weaponName.textContent = weaponLabel;
    this.objectiveText.textContent = MISSION.objective;
  }

  // ------------------------------------------------------------- readouts

  setHealth(health: number): void {
    const pct = clamp(health / PLAYER.maxHealth, 0, 1);
    this.healthValue.textContent = String(Math.ceil(health));
    this.healthFill.style.width = `${pct * 100}%`;
    this.body.classList.toggle('hurt', pct <= 0.35);
    // Vignette intensity ramps only once the player is genuinely in trouble, so
    // it reads as an alarm rather than as permanent screen dirt.
    const alarm = pct >= 0.6 ? 0 : (0.6 - pct) / 0.6;
    this.vignette.style.opacity = String(alarm * 0.85);
  }

  setAmmo(mag: number, reserve: number): void {
    this.ammoMag.textContent = String(mag);
    this.ammoReserve.textContent = String(reserve);
    this.body.classList.toggle('dry', mag === 0);
  }

  setHostiles(n: number): void {
    this.hostiles.textContent = String(n);
  }

  setObjective(text: string): void {
    this.objectiveText.textContent = text;
  }

  setTimer(seconds: number): void {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    this.timerValue.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  setReload(progress: number | null): void {
    this.body.classList.toggle('reloading', progress !== null);
    if (progress !== null) this.reloadFill.style.width = `${progress * 100}%`;
  }

  setAds(on: boolean): void {
    this.body.classList.toggle('ads', on);
  }

  showPrompt(text: string | null): void {
    if (text) {
      this.prompt.textContent = text;
      this.prompt.classList.add('show');
    } else {
      this.prompt.classList.remove('show');
    }
  }

  /**
   * Crosshair gap in pixels from the weapon's cone half-angle.
   * `spreadDeg` is the half-angle; `fovDeg` the vertical FOV of the world camera.
   */
  setCrosshairSpread(spreadDeg: number, fovDeg: number, viewportHeight: number): void {
    const halfHeightPx = viewportHeight / 2;
    const px =
      (Math.tan(spreadDeg * DEG) / Math.tan((fovDeg * DEG) / 2)) * halfHeightPx;
    const gap = clamp(4 + px, 4, Math.min(140, viewportHeight * 0.2));
    for (const t of this.ticks) t.style.setProperty('--spread', `${gap.toFixed(1)}px`);
  }

  // -------------------------------------------------------------- feedback

  hitMarker(kill: boolean): void {
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarker.style.opacity = '1';
    this.hitmarker.style.transform = `scale(${kill ? 1.25 : 1})`;
    this.hitmarkerTimer = FEEL.hitMarkerMs / 1000;
  }

  /** What the feed currently shows, oldest first. Test surface: the shared
   *  co-op kill feed is asserted through this. */
  feedEntries(): string[] {
    return [...this.killfeed.children].map((c) => (c.textContent ?? '').trim());
  }

  /**
   * `who` exists because of co-op. The feed was written for one player and hard
   * coded the actor as YOU; in a room it renders the SERVER's kill events,
   * including a teammate's, and "YOU ELIMINATED ALPHA > HOSTILE 01" is a feed
   * that lies about who did the shooting on every client that did not.
   */
  addKill(label: string, headshot: boolean, who = 'YOU'): void {
    const row = document.createElement('div');
    row.className = 'kf-row';
    row.innerHTML = `<span class="who">${who}</span><span class="verb">ELIMINATED</span>${label}${
      headshot ? '<span class="hs">HS</span>' : ''
    }`;
    this.killfeed.append(row);
    while (this.killfeed.childElementCount > 5) this.killfeed.firstElementChild?.remove();
    window.setTimeout(() => row.remove(), 5200);
  }

  /** `worldAngle` is atan2-style, in world space; converted per frame. */
  damageFrom(worldAngle: number): void {
    const el = document.createElement('div');
    el.className = 'dmg-arc';
    this.arcs.append(el);
    this.activeArcs.push({ el, worldAngle, life: FEEL.damageArcMs / 1000 });
    this.flashTimer = FEEL.damageFlashMs / 1000;
    this.flashEl.style.opacity = '0.32';
  }

  clearFeedback(): void {
    for (const a of this.activeArcs) a.el.remove();
    this.activeArcs.length = 0;
    this.killfeed.replaceChildren();
    this.hitmarker.style.opacity = '0';
    this.flashEl.style.opacity = '0';
    this.vignette.style.opacity = '0';
    this.body.classList.remove('hurt', 'dry', 'reloading', 'ads');
  }

  /**
   * Per-frame decay. `playerYaw` rotates the damage arcs into view space so an
   * attacker behind you puts the arc at the bottom of the screen.
   */
  update(dt: number, playerYaw: number): void {
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      const k = Math.max(0, this.hitmarkerTimer / (FEEL.hitMarkerMs / 1000));
      this.hitmarker.style.opacity = String(k);
      if (this.hitmarkerTimer <= 0) this.hitmarker.style.opacity = '0';
    }
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const k = Math.max(0, this.flashTimer / (FEEL.damageFlashMs / 1000));
      this.flashEl.style.opacity = String(k * 0.32);
    }
    for (let i = this.activeArcs.length - 1; i >= 0; i--) {
      const a = this.activeArcs[i];
      a.life -= dt;
      if (a.life <= 0) {
        a.el.remove();
        this.activeArcs.splice(i, 1);
        continue;
      }
      // Screen-space bearing: 0 = straight ahead, positive = clockwise.
      const rel = a.worldAngle - playerYaw;
      a.el.style.transform = `rotate(${(rel * 180) / Math.PI}deg)`;
      a.el.style.opacity = String(clamp(a.life / (FEEL.damageArcMs / 1000), 0, 1));
    }
  }

  setCrosshairVisible(visible: boolean): void {
    this.crosshair.style.opacity = visible ? '1' : '0';
  }
}
