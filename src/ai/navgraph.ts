import * as THREE from 'three';
import { ARENA, ENEMY } from '../config';
import type { CollisionWorld } from '../world/collision';

/**
 * Waypoint navigation, built by sampling the arena at load.
 *
 * Deliberately NOT a navmesh: the compound is boxes on two levels, so a 2 m grid
 * of standable points plus traversability edges gives correct paths (including
 * up both staircases) in ~120 nodes, and it is inspectable — `debugPoints()`
 * renders the graph, which is how the AI was tuned.
 *
 * Nodes carry a `cover` flag (something ≥ 0.8 m tall within 1.8 m) which the
 * reposition logic biases toward, so soldiers tend to stop next to something
 * rather than in the open.
 */

export interface NavNode {
  readonly index: number;
  readonly position: THREE.Vector3;
  readonly neighbours: number[];
  /** There is a body-height obstacle adjacent to this node. */
  readonly cover: boolean;
}

const SPACING = 2.0;
const MAX_EDGE_RISE = 1.7;

export class NavGraph {
  readonly nodes: NavNode[] = [];

  constructor(private readonly collision: CollisionWorld) {
    this.build();
  }

  private build(): void {
    const half = ARENA.size / 2 - 1.2;
    const r = ENEMY.radius;

    for (let x = -half; x <= half + 1e-6; x += SPACING) {
      for (let z = -half; z <= half + 1e-6; z += SPACING) {
        // Highest surface at this column (probe from above the terrace).
        const y = this.collision.groundHeight(x, z, r * 0.8, 12, 0);
        if (y === -Infinity || y < -0.5 || y > ARENA.terraceHeight + 0.6) continue;
        if (!this.collision.isClear(x, z, r, y + 0.06, ENEMY.height * 0.92)) continue;

        this.nodes.push({
          index: this.nodes.length,
          position: new THREE.Vector3(x, y, z),
          neighbours: [],
          cover: this.hasCoverNear(x, z, y),
        });
      }
    }

    // Edges: near neighbours whose height difference is climbable and whose
    // midpoint is standable (stops paths cutting through a crate corner).
    const maxDist = SPACING * 1.55;
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const b = this.nodes[j];
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const flat = Math.hypot(dx, dz);
        if (flat > maxDist) continue;
        const rise = Math.abs(b.position.y - a.position.y);
        if (rise > MAX_EDGE_RISE) continue;
        const mx = (a.position.x + b.position.x) / 2;
        const mz = (a.position.z + b.position.z) / 2;
        const my = Math.max(a.position.y, b.position.y);
        if (!this.collision.isClear(mx, mz, ENEMY.radius * 0.9, my + 0.08, 1.2)) continue;
        a.neighbours.push(j);
        b.neighbours.push(i);
      }
    }
  }

  private hasCoverNear(x: number, z: number, y: number): boolean {
    for (const b of this.collision.boxes) {
      if (b.max.y < y + 0.8) continue;
      if (b.min.y > y + 1.4) continue;
      const cx = Math.max(b.min.x, Math.min(x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(z, b.max.z));
      const d = Math.hypot(x - cx, z - cz);
      if (d < 1.8) return true;
    }
    return false;
  }

  nearest(point: THREE.Vector3): NavNode | null {
    let best: NavNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d =
        (n.position.x - point.x) ** 2 +
        (n.position.z - point.z) ** 2 +
        (n.position.y - point.y) ** 2 * 3; // penalise the wrong storey
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** A* over the waypoint graph. Returns node indices from `start` to `goal`. */
  findPath(start: number, goal: number): number[] {
    if (start === goal) return [goal];
    const n = this.nodes.length;
    const g = new Float32Array(n).fill(Infinity);
    const f = new Float32Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open: number[] = [start];
    g[start] = 0;
    f[start] = this.heuristic(start, goal);

    while (open.length) {
      // Small graph: a linear scan beats a heap and allocates nothing.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const current = open.splice(bi, 1)[0];
      if (current === goal) {
        const path: number[] = [];
        let c = current;
        while (c !== -1) {
          path.push(c);
          c = from[c];
        }
        return path.reverse();
      }
      closed[current] = 1;
      for (const nb of this.nodes[current].neighbours) {
        if (closed[nb]) continue;
        const tentative = g[current] + this.nodes[current].position.distanceTo(this.nodes[nb].position);
        if (tentative >= g[nb]) continue;
        from[nb] = current;
        g[nb] = tentative;
        f[nb] = tentative + this.heuristic(nb, goal);
        if (!open.includes(nb)) open.push(nb);
      }
    }
    return [];
  }

  private heuristic(a: number, b: number): number {
    return this.nodes[a].position.distanceTo(this.nodes[b].position);
  }

  /** Debug visual for the graph (points + cover highlight). */
  debugPoints(): THREE.Points {
    const positions = new Float32Array(this.nodes.length * 3);
    const colors = new Float32Array(this.nodes.length * 3);
    this.nodes.forEach((n, i) => {
      positions[i * 3] = n.position.x;
      positions[i * 3 + 1] = n.position.y + 0.1;
      positions[i * 3 + 2] = n.position.z;
      colors[i * 3] = n.cover ? 1 : 0.2;
      colors[i * 3 + 1] = n.cover ? 0.7 : 0.9;
      colors[i * 3 + 2] = n.cover ? 0.2 : 1;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.18, vertexColors: true, depthTest: false }),
    );
  }
}
