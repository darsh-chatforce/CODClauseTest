import * as THREE from 'three';

/**
 * Procedural sprite textures drawn on a canvas at boot.
 *
 * M1 ships zero art *files*; these are code. They are cached so a texture is
 * uploaded to the GPU exactly once regardless of how many emitters use it.
 */

const cache = new Map<string, THREE.Texture>();

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  return [canvas, ctx];
}

function finish(key: string, canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Hot core with a soft falloff — muzzle flash, impact spark burst. */
export function flashTexture(): THREE.Texture {
  const key = 'flash';
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 128;
  const [canvas, ctx] = makeCanvas(S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,242,1)');
  g.addColorStop(0.18, 'rgba(255,226,150,0.95)');
  g.addColorStop(0.42, 'rgba(255,150,48,0.45)');
  g.addColorStop(1, 'rgba(255,110,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // Star spikes so it does not read as a plain blob.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,236,190,0.55)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    ctx.beginPath();
    ctx.moveTo(S / 2, S / 2);
    ctx.lineTo(S / 2 + Math.cos(a) * S * 0.48, S / 2 + Math.sin(a) * S * 0.48);
    ctx.stroke();
  }
  return finish(key, canvas);
}

/** Small round particle — sparks, debris, blood puffs. */
export function dotTexture(): THREE.Texture {
  const key = 'dot';
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 64;
  const [canvas, ctx] = makeCanvas(S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finish(key, canvas);
}

/** Soft-edged dark disc — bullet holes / scorch decals. */
export function decalTexture(): THREE.Texture {
  const key = 'decal';
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 64;
  const [canvas, ctx] = makeCanvas(S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(12,10,9,0.95)');
  g.addColorStop(0.45, 'rgba(24,20,16,0.7)');
  g.addColorStop(0.8, 'rgba(30,26,20,0.22)');
  g.addColorStop(1, 'rgba(30,26,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finish(key, canvas);
}
