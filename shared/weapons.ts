// Armas dos eventos. O índice no array é o id que trafega na rede.
export interface Weapon {
  key: 'fists' | 'pistol' | 'rifle' | 'shotgun' | 'cannon';
  name: string;
  dmg: number; // dano por projétil/chumbo
  interval: number; // ms entre disparos
  mag: number; // munição no pente (0 = ilimitado)
  reserve: number; // munição extra que vem no baú
  pellets: number;
  spread: number; // radianos
  range: number; // metros
  auto: boolean; // segura o botão para atirar
  reload: number; // ms
  projectile?: { speed: number; radius: number; gravity: number };
  weight: number; // chance relativa de sair no baú
}

export const WEAPONS: Weapon[] = [
  { key: 'fists', name: 'Soco', dmg: 18, interval: 420, mag: 0, reserve: 0, pellets: 1, spread: 0, range: 1.9, auto: false, reload: 0, weight: 0 },
  { key: 'pistol', name: 'Pistola', dmg: 24, interval: 260, mag: 12, reserve: 36, pellets: 1, spread: 0.012, range: 70, auto: false, reload: 1200, weight: 40 },
  { key: 'rifle', name: 'Fuzil', dmg: 17, interval: 105, mag: 30, reserve: 90, pellets: 1, spread: 0.022, range: 110, auto: true, reload: 1800, weight: 25 },
  { key: 'shotgun', name: 'Shotgun', dmg: 12, interval: 850, mag: 6, reserve: 18, pellets: 9, spread: 0.085, range: 26, auto: false, reload: 2100, weight: 25 },
  { key: 'cannon', name: 'Canhão', dmg: 95, interval: 1400, mag: 2, reserve: 6, pellets: 1, spread: 0, range: 160, auto: false, reload: 2600, projectile: { speed: 30, radius: 4.5, gravity: 4 }, weight: 10 },
];

export const FISTS = 0;
export const HEADSHOT = 2;
export const EYE_HEIGHT = 1.6;
export const BODY_RADIUS = 0.42;
export const BODY_HEIGHT = 1.8;
export const MAX_HP = 100;

export function pickChestWeapon(rand: () => number) {
  const total = WEAPONS.reduce((s, w) => s + w.weight, 0);
  let r = rand() * total;
  for (let i = 0; i < WEAPONS.length; i++) {
    r -= WEAPONS[i].weight;
    if (r < 0) return i;
  }
  return 1;
}

/** Direção do olhar a partir de yaw (giro) e pitch (olhar para cima/baixo). */
export function aimDir(yaw: number, pitch: number) {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
}
