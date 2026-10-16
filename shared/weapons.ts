// Armas dos eventos. O índice no array é o id que trafega na rede.
export interface Weapon {
  key: 'fists' | 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'cannon';
  name: string;
  dmg: number; // dano por projétil/chumbo
  interval: number; // ms entre disparos
  mag: number; // munição no pente (0 = ilimitado)
  reserve: number; // munição extra que vem no baú
  pellets: number;
  spread: number; // radianos (sem mirar)
  adsSpread: number; // multiplicador do espalhamento mirando
  zoom: number; // aproximação da mira (botão direito)
  range: number; // metros
  auto: boolean; // segura o botão para atirar
  reload: number; // ms
  recoil: number; // coice visual (0..1)
  projectile?: { speed: number; radius: number; gravity: number };
  weight: number; // chance relativa de sair no baú
}

export const WEAPONS: Weapon[] = [
  { key: 'fists', name: 'Soco', dmg: 20, interval: 420, mag: 0, reserve: 0, pellets: 1, spread: 0, adsSpread: 1, zoom: 1, range: 2, auto: false, reload: 0, recoil: 0, weight: 0 },
  { key: 'pistol', name: 'Pistola', dmg: 24, interval: 240, mag: 12, reserve: 48, pellets: 1, spread: 0.014, adsSpread: 0.4, zoom: 1.3, range: 70, auto: false, reload: 1200, recoil: 0.45, weight: 30 },
  { key: 'smg', name: 'Submetralhadora', dmg: 14, interval: 70, mag: 32, reserve: 96, pellets: 1, spread: 0.035, adsSpread: 0.5, zoom: 1.35, range: 55, auto: true, reload: 1600, recoil: 0.22, weight: 22 },
  { key: 'rifle', name: 'Fuzil', dmg: 19, interval: 105, mag: 30, reserve: 90, pellets: 1, spread: 0.024, adsSpread: 0.3, zoom: 1.7, range: 120, auto: true, reload: 1900, recoil: 0.3, weight: 20 },
  { key: 'shotgun', name: 'Shotgun', dmg: 12, interval: 850, mag: 6, reserve: 18, pellets: 9, spread: 0.085, adsSpread: 0.75, zoom: 1.2, range: 26, auto: false, reload: 2100, recoil: 1, weight: 16 },
  { key: 'sniper', name: 'Sniper', dmg: 80, interval: 1300, mag: 5, reserve: 15, pellets: 1, spread: 0.06, adsSpread: 0.02, zoom: 4, range: 260, auto: false, reload: 2600, recoil: 1, weight: 8 },
  { key: 'cannon', name: 'Canhão', dmg: 95, interval: 1400, mag: 2, reserve: 6, pellets: 1, spread: 0, adsSpread: 1, zoom: 1.5, range: 160, auto: false, reload: 2600, recoil: 1, projectile: { speed: 32, radius: 4.5, gravity: 4 }, weight: 6 },
];

export const FISTS = 0;
export const GRENADE_ID = WEAPONS.length; // usado no killfeed
export const killWeaponName = (w: number) => (w === GRENADE_ID ? 'Granada' : WEAPONS[w]?.name ?? '?');
export const CANNON = WEAPONS.findIndex((w) => w.projectile);
export const HEADSHOT = 2;
export const EYE_HEIGHT = 1.6;
export const BODY_RADIUS = 0.42;
export const BODY_HEIGHT = 1.8;
export const MAX_HP = 100;

// Colete: absorve parte do dano até acabar.
export const ARMOR_MAX = 100;
export const ARMOR_PER_VEST = 50;
export const ARMOR_ABSORB = 0.6;

// Granada: arremesso em arco, quica e explode depois do pavio.
export const GRENADE = { dmg: 100, radius: 5.5, fuse: 2500, speed: 17, gravity: 18, bounce: 0.38, max: 4, interval: 900 };

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
