/**
 * Keyboard + mouse input with pointer lock.
 *
 * Two rules that matter for feel:
 *  1. Look delta accumulates from raw `movementX/Y` and is consumed once per
 *     frame — never sampled from a position, never smoothed. Mouse smoothing is
 *     the single most common way a browser FPS ends up feeling like syrup.
 *  2. Every action exposes both a held state and a one-frame `pressed` edge, so
 *     jump/reload/toggle logic never has to invent its own debouncing.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'jump'
  | 'crouch'
  | 'fire'
  | 'ads'
  | 'reload'
  | 'inspect'
  | 'pause';

const KEY_BINDINGS: Record<string, Action> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Space: 'jump',
  KeyC: 'crouch',
  ControlLeft: 'crouch',
  KeyR: 'reload',
  KeyT: 'inspect',
  Escape: 'pause',
};

const MOUSE_BINDINGS: Record<number, Action> = {
  0: 'fire',
  2: 'ads',
};

export class Input {
  private readonly held = new Set<Action>();
  private readonly pressedThisFrame = new Set<Action>();
  private readonly releasedThisFrame = new Set<Action>();
  private lookX = 0;
  private lookY = 0;

  /** True while the browser owns the cursor. */
  locked = false;
  /** Fired when pointer lock is lost (drives the pause screen). */
  onLockChange: ((locked: boolean) => void) | null = null;

  /** Orbit drag delta for the third-person inspect camera (unlocked mouse). */
  private dragX = 0;
  private dragY = 0;
  private dragging = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  // ------------------------------------------------------------------ query

  isDown(action: Action): boolean {
    return this.held.has(action);
  }

  wasPressed(action: Action): boolean {
    return this.pressedThisFrame.has(action);
  }

  wasReleased(action: Action): boolean {
    return this.releasedThisFrame.has(action);
  }

  /** Consumes the accumulated look delta in pixels. Call exactly once a frame. */
  takeLook(): { x: number; y: number } {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  takeDrag(): { x: number; y: number } {
    const out = { x: this.dragX, y: this.dragY };
    this.dragX = 0;
    this.dragY = 0;
    return out;
  }

  /** Clears one-frame edges. Call at the very end of the frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }

  /** Drop all held state (used when leaving gameplay). */
  releaseAll(): void {
    this.held.clear();
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.lookX = 0;
    this.lookY = 0;
  }

  // ------------------------------------------------------------- lock/mouse

  requestLock(): void {
    if (!this.locked) void this.canvas.requestPointerLock?.();
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  // ------------------------------------------------------------- test seams
  // Headless Chrome cannot enter pointer lock, so scripted playtests drive look
  // and actions through these. They are the SAME state the real handlers write.

  injectLook(dx: number, dy: number): void {
    this.lookX += dx;
    this.lookY += dy;
  }

  injectAction(action: Action, down: boolean): void {
    if (down) this.press(action);
    else this.release(action);
  }

  // --------------------------------------------------------------- internal

  private press(action: Action): void {
    if (!this.held.has(action)) this.pressedThisFrame.add(action);
    this.held.add(action);
  }

  private release(action: Action): void {
    if (this.held.delete(action)) this.releasedThisFrame.add(action);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const action = KEY_BINDINGS[e.code];
    if (!action) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;
    this.press(action);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const action = KEY_BINDINGS[e.code];
    if (action) this.release(action);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const action = MOUSE_BINDINGS[e.button];
    if (action) {
      if (e.button === 2) e.preventDefault();
      this.press(action);
    }
    if (!this.locked && e.button === 0) this.dragging = true;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const action = MOUSE_BINDINGS[e.button];
    if (action) this.release(action);
    if (e.button === 0) this.dragging = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.locked) {
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    } else if (this.dragging) {
      this.dragX += e.movementX;
      this.dragY += e.movementY;
    }
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
    this.dragging = false;
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.releaseAll();
    this.onLockChange?.(this.locked);
  };
}
