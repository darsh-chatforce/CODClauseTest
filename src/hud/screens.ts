/** Start / pause / end screens. Pure DOM; the game loop keeps rendering behind them. */

export interface MissionStats {
  won: boolean;
  score: number;
  kills: number;
  totalHostiles: number;
  accuracy: number;
  shotsFired: number;
  timeSeconds: number;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`screen element #${id} missing`);
  return el as T;
};

/** A toggle: its label, its current value, and what to do when it changes. */
export interface SettingSpec {
  id: string;
  label: string;
  note?: string;
  initial: boolean;
  onChange(value: boolean): void;
}

export class Screens {
  private readonly start = $('screen-start');
  private readonly end = $('screen-end');
  private readonly pause = $('screen-pause');
  private readonly endTitle = $('end-title');
  private readonly endEyebrow = $('end-eyebrow');
  private readonly endStats = $('end-stats');
  private readonly inspectBanner = $('inspect-banner');
  private readonly settingInputs = new Map<string, HTMLInputElement[]>();

  constructor(onStart: () => void, onRestart: () => void, settings: SettingSpec[] = []) {
    $<HTMLButtonElement>('btn-start').addEventListener('click', onStart);
    $<HTMLButtonElement>('btn-restart').addEventListener('click', onRestart);
    this.buildSettings(settings);
  }

  /**
   * Render the same settings into the start screen AND the pause screen from one
   * definition.
   *
   * Two panels, one source. Hand-writing the markup twice is how an option ends
   * up present in one place and missing in the other, or — worse — how two
   * controls end up bound to the same setting and disagreeing about its value.
   * Every input for a given id is kept in a list and they are all written on
   * change, so the two panels can never drift.
   */
  private buildSettings(specs: SettingSpec[]): void {
    if (!specs.length) return;
    for (const host of ['settings-start', 'settings-pause']) {
      const el = document.getElementById(host);
      if (!el) continue;
      for (const spec of specs) {
        const label = document.createElement('label');
        label.className = 'opt';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = spec.initial;
        input.id = `${host}-${spec.id}`;
        const text = document.createElement('span');
        text.textContent = spec.label;
        if (spec.note) {
          const note = document.createElement('span');
          note.className = 'note';
          note.textContent = ` ${spec.note}`;
          text.append(note);
        }
        input.addEventListener('change', () => {
          spec.onChange(input.checked);
          for (const other of this.settingInputs.get(spec.id) ?? []) {
            other.checked = input.checked;
          }
        });
        label.append(input, text);
        el.append(label);
        const list = this.settingInputs.get(spec.id) ?? [];
        list.push(input);
        this.settingInputs.set(spec.id, list);
      }
    }
  }

  /** Set a toggle from code (the test surface), keeping both panels in step. */
  setSetting(id: string, value: boolean): void {
    for (const input of this.settingInputs.get(id) ?? []) input.checked = value;
  }

  showStart(): void {
    this.setVisible(this.start, true);
    this.setVisible(this.end, false);
    this.setVisible(this.pause, false);
  }

  showPause(): void {
    this.setVisible(this.start, false);
    this.setVisible(this.end, false);
    this.setVisible(this.pause, true);
  }

  hideAll(): void {
    this.setVisible(this.start, false);
    this.setVisible(this.end, false);
    this.setVisible(this.pause, false);
  }

  showEnd(stats: MissionStats): void {
    this.endEyebrow.textContent = 'MISSION';
    this.endTitle.textContent = stats.won ? 'COMPLETE' : 'FAILED';
    const rows: Array<[string, string]> = [
      ['SCORE', String(Math.round(stats.score))],
      ['HOSTILES DOWN', `${stats.kills} / ${stats.totalHostiles}`],
      ['ACCURACY', `${(stats.accuracy * 100).toFixed(1)}%`],
      ['ROUNDS FIRED', String(stats.shotsFired)],
      ['TIME', formatTime(stats.timeSeconds)],
      ['RESULT', stats.won ? 'COMPOUND CLEAR' : 'KIA'],
    ];
    this.endStats.replaceChildren(
      ...rows.map(([k, v]) => {
        const d = document.createElement('div');
        const a = document.createElement('span');
        a.textContent = k;
        const b = document.createElement('span');
        b.textContent = v;
        d.append(a, b);
        return d;
      }),
    );
    this.setVisible(this.start, false);
    this.setVisible(this.pause, false);
    this.setVisible(this.end, true);
  }

  setInspectBanner(visible: boolean): void {
    this.inspectBanner.classList.toggle('hidden', !visible);
  }

  private setVisible(el: HTMLElement, visible: boolean): void {
    el.classList.toggle('hidden', !visible);
  }
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
