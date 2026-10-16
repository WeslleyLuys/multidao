import { RUN_SPEED, WALK_SPEED, type TeamId } from './config';
import { BODY_HEIGHT, BODY_RADIUS } from './weapons';

// Arena dos eventos: terreno abandonado com carros quebrados, paletes, pneus, lixo etc.
// Gerada a partir de uma semente e espelhada no eixo X, para ser justa com os dois lados.

export type ObstacleKind = 'car' | 'pallets' | 'tires' | 'trash' | 'dumpster' | 'container' | 'barrier' | 'wall' | 'drums' | 'bus';

export interface Obstacle {
  kind: ObstacleKind;
  x: number;
  z: number;
  hx: number; // meia largura em X (já considerando a rotação)
  hz: number; // meia largura em Z
  h: number; // altura
  rot: 0 | 1; // 1 = girado 90°
  v: number; // variação visual (0..1)
}

export interface Chest {
  id: number;
  x: number;
  z: number;
}

export interface Arena {
  half: number; // metade do lado do mapa quadrado
  obstacles: Obstacle[];
  chests: Chest[];
  spawns: Record<TeamId, { x: number; z: number }[]>;
}

export const MATCH_SIZES = [1, 2, 4, 8, 12] as const;
export type MatchSize = (typeof MATCH_SIZES)[number];
export const ARENA_HALF: Record<MatchSize, number> = { 1: 18, 2: 24, 4: 34, 8: 48, 12: 60 };

// Dimensões base (largura x profundidade x altura) de cada tipo, antes da rotação.
const KINDS: Record<ObstacleKind, { w: number; d: number; h: number; weight: number }> = {
  car: { w: 4.3, d: 1.9, h: 1.45, weight: 6 },
  bus: { w: 10, d: 2.6, h: 3.1, weight: 1 },
  pallets: { w: 1.25, d: 1.25, h: 1.2, weight: 5 },
  tires: { w: 1.6, d: 1.6, h: 1.0, weight: 5 },
  trash: { w: 1.8, d: 1.4, h: 0.9, weight: 4 },
  dumpster: { w: 2.2, d: 1.4, h: 1.5, weight: 3 },
  container: { w: 6.1, d: 2.45, h: 2.6, weight: 2 },
  barrier: { w: 3, d: 0.6, h: 1.1, weight: 4 },
  wall: { w: 5, d: 0.5, h: 2.6, weight: 3 },
  drums: { w: 1.4, d: 1.4, h: 1.1, weight: 4 },
};

export function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function buildArena(size: MatchSize, seed: number): Arena {
  const rand = rng(seed);
  const half = ARENA_HALF[size];
  const obstacles: Obstacle[] = [];
  const kinds = Object.keys(KINDS) as ObstacleKind[];
  const total = kinds.reduce((s, k) => s + KINDS[k].weight, 0);
  const pickKind = () => {
    let r = rand() * total;
    for (const k of kinds) if ((r -= KINDS[k].weight) < 0) return k;
    return 'car';
  };

  const spawnX = half - 4;
  const free = (x: number, z: number, hx: number, hz: number, gap: number) => {
    if (Math.abs(x) + hx > half - 1.5 || Math.abs(z) + hz > half - 1.5) return false;
    if (Math.abs(x) + hx > spawnX - 4 && Math.abs(z) < half * 0.5) return false; // áreas de nascimento livres
    if (Math.abs(x) < hx + 1.2) return false; // corredor central (o espelho não pode sobrepor)
    return obstacles.every((o) => Math.abs(o.x - x) > o.hx + hx + gap || Math.abs(o.z - z) > o.hz + hz + gap);
  };

  // Gera só o lado x < 0 e espelha.
  const target = Math.round((half * half) / 30);
  for (let tries = 0; tries < target * 30 && obstacles.length < target * 2; tries++) {
    const kind = pickKind();
    const k = KINDS[kind];
    const rot = (rand() < 0.5 ? 0 : 1) as 0 | 1;
    const hx = (rot ? k.d : k.w) / 2;
    const hz = (rot ? k.w : k.d) / 2;
    const x = -(hx + 1.2 + rand() * (half - hx - 2));
    const z = (rand() * 2 - 1) * (half - hz - 1.5);
    if (!free(x, z, hx, hz, 1.6)) continue;
    const v = rand();
    obstacles.push({ kind, x, z, hx, hz, h: k.h * (kind === 'pallets' || kind === 'tires' ? 0.6 + rand() * 0.8 : 1), rot, v });
    obstacles.push({ kind, x: -x, z, hx, hz, h: obstacles[obstacles.length - 1].h, rot, v });
  }

  // Muros de cobertura no meio, para o centro não virar um corredor aberto.
  for (const z of [-half * 0.35, half * 0.35]) {
    if (free(-3, z, 0.25, 2.5, 1)) {
      obstacles.push({ kind: 'wall', x: -3, z, hx: 0.25, hz: 2.5, h: 2.6, rot: 1, v: rand() });
      obstacles.push({ kind: 'wall', x: 3, z, hx: 0.25, hz: 2.5, h: 2.6, rot: 1, v: rand() });
    }
  }

  // Baús: espelhados também.
  const chests: Chest[] = [];
  const chestCount = Math.max(2, Math.round(size * 1.5 + 2));
  for (let tries = 0; tries < 2000 && chests.length < chestCount * 2; tries++) {
    const x = -(2 + rand() * (half - 6));
    const z = (rand() * 2 - 1) * (half - 3);
    if (!free(x, z, 0.7, 0.5, 1.4)) continue;
    if (chests.some((c) => Math.hypot(c.x - x, c.z - z) < 7)) continue;
    chests.push({ id: chests.length, x, z }, { id: chests.length + 1, x: -x, z });
  }

  const spawns: Record<TeamId, { x: number; z: number }[]> = { 0: [], 1: [] };
  const lanes = 12;
  for (let i = 0; i < lanes; i++) {
    const z = (i / (lanes - 1) - 0.5) * half * 0.8;
    spawns[0].push({ x: -spawnX, z });
    spawns[1].push({ x: spawnX, z });
  }
  return { half, obstacles, chests, spawns };
}

// ---------- Física ----------
export interface Body {
  x: number;
  z: number;
}

export function arenaStep(b: Body, dx: number, dz: number, run: boolean, dt: number, arena: Arena): boolean {
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return false;
  const speed = run ? RUN_SPEED : WALK_SPEED;
  // Move eixo por eixo para "deslizar" nos obstáculos.
  b.x += (dx / len) * speed * dt;
  collide(b, arena, 'x');
  b.z += (dz / len) * speed * dt;
  collide(b, arena, 'z');
  return true;
}

function collide(b: Body, arena: Arena, axis: 'x' | 'z') {
  const r = BODY_RADIUS;
  const lim = arena.half - r;
  b.x = Math.max(-lim, Math.min(lim, b.x));
  b.z = Math.max(-lim, Math.min(lim, b.z));
  for (const o of arena.obstacles) {
    const ox = o.hx + r - Math.abs(b.x - o.x);
    const oz = o.hz + r - Math.abs(b.z - o.z);
    if (ox > 0 && oz > 0) {
      if (axis === 'x') b.x += Math.sign(b.x - o.x || 1) * ox;
      else b.z += Math.sign(b.z - o.z || 1) * oz;
    }
  }
}

// ---------- Raios (tiros e linha de visão) ----------
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Distância até o primeiro obstáculo (ou o chão/limites) na direção do raio. */
export function rayObstacles(o: Vec3, d: Vec3, maxDist: number, arena: Arena): number {
  let best = maxDist;
  if (d.y < 0) best = Math.min(best, -o.y / d.y); // chão
  for (const ob of arena.obstacles) {
    const t = rayBox(o, d, ob.x - ob.hx, 0, ob.z - ob.hz, ob.x + ob.hx, ob.h, ob.z + ob.hz);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

export function rayBox(o: Vec3, d: Vec3, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  let tmin = 0;
  let tmax = Infinity;
  for (const [oa, da, lo, hi] of [[o.x, d.x, minX, maxX], [o.y, d.y, minY, maxY], [o.z, d.z, minZ, maxZ]] as const) {
    if (Math.abs(da) < 1e-9) {
      if (oa < lo || oa > hi) return -1;
    } else {
      let t1 = (lo - oa) / da;
      let t2 = (hi - oa) / da;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Raio contra o cilindro de um jogador. Retorna a distância e a altura do acerto, ou null. */
export function rayBody(o: Vec3, d: Vec3, bx: number, bz: number): { t: number; y: number } | null {
  const fx = o.x - bx;
  const fz = o.z - bz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return null;
  const b = 2 * (fx * d.x + fz * d.z);
  const c = fx * fx + fz * fz - BODY_RADIUS * BODY_RADIUS;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  const y = o.y + d.y * t;
  if (y < 0 || y > BODY_HEIGHT) return null;
  return { t, y };
}

export function lineOfSight(a: Vec3, b: Vec3, arena: Arena) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.01) return true;
  return rayObstacles(a, { x: dx / dist, y: dy / dist, z: dz / dist }, dist, arena) >= dist - 0.05;
}
