import { JAIL, PLAYER_RADIUS, RUN_SPEED, SOLIDS, WALK_SPEED, WORLD, type Rect } from './config';

export interface Body {
  x: number;
  z: number;
}

// Mesma regra de movimento no servidor (autoridade) e no cliente (predição).
// `jail`: se o jogador está preso, fica confinado à cela.
export function step(b: Body, dx: number, dz: number, run: boolean, dt: number, jail?: Rect): boolean {
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return false;
  const speed = run ? RUN_SPEED : WALK_SPEED;
  b.x += (dx / len) * speed * dt;
  b.z += (dz / len) * speed * dt;
  resolve(b, jail);
  return true;
}

export function resolve(b: Body, jail?: Rect) {
  const r = PLAYER_RADIUS;
  if (jail) {
    // Preso: só anda dentro da cela.
    b.x = clamp(b.x, jail.x - jail.halfX + r, jail.x + jail.halfX - r);
    b.z = clamp(b.z, jail.z - jail.halfZ + r, jail.z + jail.halfZ - r);
    return;
  }
  b.x = clamp(b.x, -WORLD.halfLength + r, WORLD.halfLength - r);
  b.z = clamp(b.z, -WORLD.halfWidth + r, WORLD.halfWidth - r);
  for (const t of [...SOLIDS, JAIL.cell]) {
    const ox = t.halfX + r - Math.abs(b.x - t.x);
    const oz = t.halfZ + r - Math.abs(b.z - t.z);
    if (ox > 0 && oz > 0) {
      if (ox < oz) b.x += Math.sign(b.x - t.x || 1) * ox;
      else b.z += Math.sign(b.z - t.z || 1) * oz;
    }
  }
}

export function clamp(v: number, min: number, max: number) {
  return v < min ? min : v > max ? max : v;
}

export function inRect(b: Body, r: Rect) {
  return Math.abs(b.x - r.x) <= r.halfX && Math.abs(b.z - r.z) <= r.halfZ;
}
