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
export const ARENA_HALF: Record<MatchSize, number> = { 1: 26, 2: 34, 4: 48, 8: 68, 12: 86 };

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
  // Densidade fixa por área, com teto para os mapas grandes não pesarem.
  const target = Math.min(150, Math.round((half * half) / 34));
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

// ---------- Física do jogador ----------
// Movimento com aceleração/inércia, pulo e possibilidade de subir em obstáculos.
// A mesma função roda no servidor (autoridade) e no cliente (predição).
export interface Mover {
  x: number;
  z: number;
  y: number; // altura dos pés
  vx: number;
  vz: number;
  vy: number;
  grounded: boolean;
}

export interface MoveInput {
  dx: number;
  dz: number;
  run: boolean;
  jump: boolean;
}

export const GRAVITY = 22;
export const JUMP_SPEED = 7.2;
export const STEP_HEIGHT = 0.5; // degraus que se sobe andando (paletes baixos, pneus)
const ACCEL_GROUND = 14;
const ACCEL_AIR = 3;

export function newMover(x: number, z: number): Mover {
  return { x, z, y: 0, vx: 0, vz: 0, vy: 0, grounded: true };
}

/** Avança a física; retorna 0 parado, 1 andando, 2 correndo. */
export function arenaMove(m: Mover, inp: MoveInput, dt: number, arena: Arena): number {
  const len = Math.hypot(inp.dx, inp.dz);
  const speed = inp.run ? RUN_SPEED : WALK_SPEED;
  const tx = len > 0.01 ? (inp.dx / Math.max(1, len)) * speed : 0;
  const tz = len > 0.01 ? (inp.dz / Math.max(1, len)) * speed : 0;
  const k = 1 - Math.exp(-(m.grounded ? ACCEL_GROUND : ACCEL_AIR) * dt);
  m.vx += (tx - m.vx) * k;
  m.vz += (tz - m.vz) * k;

  if (inp.jump && m.grounded) {
    m.vy = JUMP_SPEED;
    m.grounded = false;
  }
  m.vy -= GRAVITY * dt;

  // Move eixo por eixo para "deslizar" nos obstáculos.
  m.x += m.vx * dt;
  collide(m, arena, 'x');
  m.z += m.vz * dt;
  collide(m, arena, 'z');
  m.y += m.vy * dt;

  const ground = groundHeight(m, arena);
  if (m.y <= ground) {
    m.y = ground;
    m.vy = 0;
    m.grounded = true;
  } else if (m.grounded && m.vy <= 0 && m.y - ground < STEP_HEIGHT) {
    m.y = ground; // desce degraus sem "voar"
    m.vy = 0;
  } else m.grounded = false;

  const sp = Math.hypot(m.vx, m.vz);
  return sp < 0.4 ? 0 : sp > (WALK_SPEED + RUN_SPEED) / 2 ? 2 : 1;
}

/** Altura do chão sob o jogador (topo do obstáculo em que ele está, ou 0). */
function groundHeight(m: Mover, arena: Arena) {
  const r = BODY_RADIUS * 0.6;
  let g = 0;
  for (const o of arena.obstacles) {
    if (Math.abs(m.x - o.x) < o.hx + r && Math.abs(m.z - o.z) < o.hz + r && o.h <= m.y + STEP_HEIGHT && o.h > g) g = o.h;
  }
  return g;
}

function collide(m: Mover, arena: Arena, axis: 'x' | 'z') {
  const r = BODY_RADIUS;
  const lim = arena.half - r;
  m.x = Math.max(-lim, Math.min(lim, m.x));
  m.z = Math.max(-lim, Math.min(lim, m.z));
  for (const o of arena.obstacles) {
    if (m.y >= o.h - STEP_HEIGHT) continue; // dá para subir/está em cima
    const ox = o.hx + r - Math.abs(m.x - o.x);
    const oz = o.hz + r - Math.abs(m.z - o.z);
    if (ox > 0 && oz > 0) {
      if (axis === 'x') {
        m.x += Math.sign(m.x - o.x || 1) * ox;
        m.vx = 0;
      } else {
        m.z += Math.sign(m.z - o.z || 1) * oz;
        m.vz = 0;
      }
    }
  }
}

// ---------- Projéteis (foguete e granada) ----------
export interface Proj {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Avança um projétil. Com bounce = 0 (foguete) retorna true ao tocar algo.
 * Com bounce > 0 (granada) quica em chão e obstáculos e nunca "acerta".
 */
export function projStep(p: Proj, dt: number, arena: Arena, gravity: number, bounce: number): boolean {
  p.vel.y -= gravity * dt;
  const prev = { ...p.pos };
  const next = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt, z: p.pos.z + p.vel.z * dt };
  if (next.y <= 0.06) {
    if (!bounce) {
      p.pos = { ...next, y: 0.06 };
      return true;
    }
    next.y = 0.06;
    p.vel.y = Math.abs(p.vel.y) * bounce;
    p.vel.x *= 0.7;
    p.vel.z *= 0.7;
    if (Math.abs(p.vel.y) < 0.8) p.vel.y = 0;
  }
  const lim = arena.half - 0.2;
  if (Math.abs(next.x) > lim || Math.abs(next.z) > lim) {
    if (!bounce) {
      p.pos = next;
      return true;
    }
    if (Math.abs(next.x) > lim) p.vel.x = -p.vel.x * bounce;
    if (Math.abs(next.z) > lim) p.vel.z = -p.vel.z * bounce;
    next.x = Math.max(-lim, Math.min(lim, next.x));
    next.z = Math.max(-lim, Math.min(lim, next.z));
  }
  for (const o of arena.obstacles) {
    const inside = Math.abs(next.x - o.x) < o.hx && Math.abs(next.z - o.z) < o.hz && next.y < o.h;
    if (!inside) continue;
    if (!bounce) {
      p.pos = next;
      return true;
    }
    // Quica na face pela qual entrou.
    if (prev.y >= o.h) {
      next.y = o.h + 0.02;
      p.vel.y = Math.abs(p.vel.y) * bounce;
      p.vel.x *= 0.7;
      p.vel.z *= 0.7;
    } else if (Math.abs(prev.x - o.x) >= o.hx) {
      next.x = prev.x;
      p.vel.x = -p.vel.x * bounce;
    } else {
      next.z = prev.z;
      p.vel.z = -p.vel.z * bounce;
    }
  }
  p.pos = next;
  return false;
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
export function rayBody(o: Vec3, d: Vec3, bx: number, bz: number, by = 0): { t: number; y: number } | null {
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
  const y = o.y + d.y * t - by; // altura relativa aos pés
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
