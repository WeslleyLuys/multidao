import { CLOTH_COLORS, HAIR_COLORS, ITEMS, LIMITS, OUTFIT, PATTERNS, PRINTS, SKIN_TONES, SLOTS, TEAMS, type Item, type Slot, type TeamId } from './config';

// Uma peça de roupa: estilo, cor principal, cor do detalhe e estampa (todos índices).
export interface Piece {
  s: number;
  c: number;
  a: number;
  p: number;
}

export interface Look {
  skin: number;
  hair: number;
  head: Piece;
  torso: Piece;
  legs: Piece;
  feet: Piece;
  print: number; // índice em PRINTS (estampa no peito)
  item: Item;
  sign: string;
}

function int(v: unknown, max: number, fallback = 0): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
}

export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const DEFAULT_LOOK: Look = {
  skin: 1,
  hair: 0,
  head: { s: 0, c: 1, a: 0, p: 0 },
  torso: { s: 0, c: 0, a: 3, p: 3 },
  legs: { s: 0, c: 10, a: 0, p: 0 },
  feet: { s: 0, c: 1, a: 0, p: 0 },
  print: 0,
  item: 'flag',
  sign: '',
};

// Valida tudo que vem de fora (rede ou localStorage). Valores inválidos voltam ao padrão.
export function sanitizeLook(raw: any): Look {
  const piece = (slot: Slot): Piece => {
    const r = raw?.[slot];
    const d = DEFAULT_LOOK[slot];
    return {
      s: int(r?.s, OUTFIT[slot].length - 1, d.s),
      c: int(r?.c, CLOTH_COLORS.length - 1, d.c),
      a: int(r?.a, CLOTH_COLORS.length - 1, d.a),
      p: int(r?.p, PATTERNS.length - 1, d.p),
    };
  };
  const look = {
    skin: int(raw?.skin, SKIN_TONES.length - 1, DEFAULT_LOOK.skin),
    hair: int(raw?.hair, HAIR_COLORS.length - 1, DEFAULT_LOOK.hair),
    print: int(raw?.print, PRINTS.length - 1, 0),
    item: (ITEMS as readonly string[]).includes(raw?.item) ? raw.item : DEFAULT_LOOK.item,
    sign: cleanText(raw?.sign, LIMITS.sign),
  } as Look;
  for (const slot of SLOTS) look[slot] = piece(slot);
  return look;
}

/** Índices em CLOTH_COLORS das cores de um lado (ignora o branco). */
export function teamClothColors(team: TeamId): number[] {
  return [TEAMS[team].color, TEAMS[team].accent].filter((c) => c !== '#ffffff').map((c) => CLOTH_COLORS.indexOf(c)).filter((i) => i >= 0);
}

// Visual aleatório (bots e botão "Aleatório"). `teamColors` favorece as cores do lado no tronco.
export function randomLook(rand: () => number = Math.random, teamColors: number[] = []): Look {
  const pick = (n: number) => Math.floor(rand() * n);
  const piece = (slot: Slot, patternChance: number): Piece => ({
    s: pick(OUTFIT[slot].length),
    c: pick(CLOTH_COLORS.length),
    a: pick(CLOTH_COLORS.length),
    p: rand() < patternChance ? 1 + pick(PATTERNS.length - 1) : 0,
  });
  const look: Look = {
    skin: pick(SKIN_TONES.length),
    hair: pick(HAIR_COLORS.length - 1),
    head: piece('head', 0.25),
    torso: piece('torso', 0.45),
    legs: piece('legs', 0.1),
    feet: piece('feet', 0.1),
    print: rand() < 0.08 ? 1 + pick(PRINTS.length - 1) : 0,
    item: (['none', 'none', 'flag', 'flag', 'sign', 'flag-br', 'flag-pt'] as const)[pick(7)],
    sign: '',
  };
  if (rand() < 0.5) look.head.s = 0; // metade com cabelo à mostra
  if (teamColors.length && rand() < 0.65) look.torso.c = teamColors[pick(teamColors.length)];
  if (look.legs.s === 0 && rand() < 0.6) look.legs.c = [1, 2, 10, 13][pick(4)];
  return look;
}
