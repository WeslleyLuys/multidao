// Identidade e regras do jogo, compartilhadas entre cliente e servidor.
// Para trocar nome, cores, lados ou o catálogo de roupas, altere este arquivo.

export const GAME = {
  name: 'Multidão',
  tagline: 'A manifestação online. Escolha seu lado, monte seu visual e vá para a avenida.',
  street: 'Avenida Central',
};

// color: cor principal do lado; accent: cor secundária (faixas, bandeiras, carro de som).
export const TEAMS = [
  { id: 0, name: 'Esquerda', color: '#d62828', accent: '#ffffff' },
  { id: 1, name: 'Direita', color: '#1f9d55', accent: '#ffd23f' },
] as const;

export type TeamId = 0 | 1;

// A avenida corre no eixo X. Z é a largura (pista + calçadas).
export const WORLD = {
  halfLength: 180,
  roadHalfWidth: 14,
  halfWidth: 22, // limite de caminhada (inclui calçadas)
};

export const SPAWN: Record<TeamId, { minX: number; maxX: number }> = {
  0: { minX: -150, maxX: -25 },
  1: { minX: 25, maxX: 150 },
};

// Carros de som: obstáculos sólidos (AABB) usados pelo servidor e pelo cliente.
export const TRUCKS = [
  { x: -60, z: 0, team: 0 as TeamId },
  { x: 60, z: 0, team: 1 as TeamId },
].map((t) => ({ ...t, halfX: 5, halfZ: 1.6 }));

export const TICK_RATE = 20;
export const SNAPSHOT_RATE = 15;
export const WALK_SPEED = 4;
export const RUN_SPEED = 7.5;
export const PLAYER_RADIUS = 0.45;
export const MAX_PLAYERS = 200;
export const BOTS_PER_TEAM = 24;

// ---------- Visual ----------
export const SKIN_TONES = ['#f6d2b8', '#e8b48f', '#c98c62', '#a0673f', '#6e4428', '#4a2c1a'];
export const HAIR_COLORS = ['#2b1d14', '#120d0a', '#5a3a22', '#8a5a2b', '#c9a36a', '#b8b8b8'];
export const CLOTH_COLORS = [
  '#ffffff', '#1d2129', '#6b7280', '#d62828', '#ff6b4a', '#ff9f1c', '#ffd23f', '#2ec27e',
  '#1f9d55', '#5b8def', '#1d3a8a', '#9b5de5', '#f15bb5', '#8d6e63', '#c9b38a', '#556b2f',
];

export const PATTERNS = ['plain', 'stripes', 'vstripes', 'sash', 'star', 'checker', 'dots', 'camo'] as const;
export const PATTERN_LABEL: Record<Pattern, string> = {
  plain: 'Liso', stripes: 'Listras', vstripes: 'Listras verticais', sash: 'Faixa',
  star: 'Estrela', checker: 'Xadrez', dots: 'Bolinhas', camo: 'Camuflado',
};

// Estilos por parte do corpo. A ordem importa: o índice é o que trafega na rede.
export const OUTFIT = {
  head: ['hair', 'bald', 'cap', 'beanie', 'bandana'],
  torso: ['tshirt', 'tank', 'longsleeve', 'jacket'],
  legs: ['pants', 'bermuda', 'shorts'],
  feet: ['sneakers', 'boots', 'flipflops', 'barefoot'],
} as const;

export const OUTFIT_LABEL: Record<string, string> = {
  hair: 'Cabelo', bald: 'Careca', cap: 'Boné', beanie: 'Gorro', bandana: 'Bandana',
  tshirt: 'Camiseta', tank: 'Regata', longsleeve: 'Manga longa', jacket: 'Jaqueta',
  pants: 'Calça', bermuda: 'Bermuda', shorts: 'Shorts',
  sneakers: 'Tênis', boots: 'Bota', flipflops: 'Chinelo', barefoot: 'Descalço',
};

export const SLOTS = ['head', 'torso', 'legs', 'feet'] as const;
export const SLOT_LABEL: Record<Slot, string> = { head: 'Cabeça', torso: 'Tronco', legs: 'Pernas', feet: 'Pés' };

export const ITEMS = ['none', 'flag', 'sign', 'flag-br', 'flag-pt'] as const;
export const ITEM_LABEL: Record<Item, string> = {
  none: 'Nada', flag: 'Bandeira do lado', sign: 'Cartaz', 'flag-br': 'Bandeira do Brasil', 'flag-pt': 'Bandeira do PT',
};

// Estampas no peito da camiseta.
export const PRINTS = ['none', 'flag-br', 'br-10', 'lula', 'bolsonaro'] as const;
export const PRINT_LABEL: Record<Print, string> = {
  none: 'Nenhuma', 'flag-br': 'Bandeira do Brasil', 'br-10': 'Brasil 10', lula: 'Lula', bolsonaro: 'Bolsonaro',
};

// Itens VIP. Enquanto não houver contas e pagamento, ficam liberados para todos
// (a validação de quem pode usar entra no servidor junto com o sistema de contas).
export const VIP = new Set<string>(['flag-br', 'flag-pt', 'br-10', 'lula', 'bolsonaro']);
export const EMOTES = ['wave', 'jump', 'dance', 'clap'] as const;

export type Pattern = (typeof PATTERNS)[number];
export type Slot = (typeof SLOTS)[number];
export type Item = (typeof ITEMS)[number];
export type Print = (typeof PRINTS)[number];
export type Emote = (typeof EMOTES)[number];

export const LIMITS = {
  name: 16,
  sign: 24,
  chat: 140,
  chatIntervalMs: 900,
  emoteIntervalMs: 1200,
  lookIntervalMs: 1500,
  connectionsPerIp: 4,
};
