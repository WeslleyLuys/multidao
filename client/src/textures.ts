import * as THREE from 'three';

// Texturas geradas em canvas: nenhuma imagem externa, tudo leve e original.

export function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function toTexture(c: HTMLCanvasElement, repeat = true) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, amount: number, alpha: number) {
  for (let i = 0; i < amount; i++) {
    const v = Math.floor(rand() * 255);
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

export function asphaltTexture() {
  const rand = rng(7);
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, 512, 512);
  noise(ctx, 512, 512, rand, 26000, 0.35);
  // Manchas e remendos
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(20,22,25,${0.08 + rand() * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(rand() * 512, rand() * 512, 20 + rand() * 60, 10 + rand() * 40, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c);
}

export function paverTexture() {
  const rand = rng(11);
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#8c8880';
  ctx.fillRect(0, 0, 512, 512);
  const n = 8;
  const s = 512 / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 172 + Math.floor(rand() * 26);
      ctx.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
      ctx.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
    }
  }
  noise(ctx, 512, 512, rand, 9000, 0.25);
  return toTexture(c);
}

export type FacadeStyle = 'concrete' | 'brick' | 'office' | 'glass';

// Cada textura representa 4 colunas x 4 andares (16 m x 14 m).
export const FACADE_CELL = { w: 16, h: 14 };

export function facadeTexture(style: FacadeStyle, seed: number) {
  const rand = rng(seed);
  const [c, ctx] = canvas(512, 512);
  const cw = 128;
  const ch = 128;

  if (style === 'office') {
    ctx.fillStyle = '#e9e6df';
    ctx.fillRect(0, 0, 512, 512);
    for (let f = 0; f < 4; f++) {
      const y = f * ch + 30;
      const g = ctx.createLinearGradient(0, y, 0, y + 80);
      g.addColorStop(0, '#5d7489');
      g.addColorStop(1, '#2c3a49');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, 512, 80);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for (let x = 0; x < 512; x += 64) ctx.fillRect(x, y, 3, 80);
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = `rgba(230,236,240,${0.15 + rand() * 0.3})`;
        ctx.fillRect(Math.floor(rand() * 8) * 64 + 3, y, 61, 30 + rand() * 50);
      }
    }
    return toTexture(c);
  }

  if (style === 'glass') {
    const g = ctx.createLinearGradient(0, 0, 512, 512);
    g.addColorStop(0, '#9fb8cc');
    g.addColorStop(1, '#5f7b93');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    for (let x = 0; x < 512; x += 64) {
      for (let y = 0; y < 512; y += 64) {
        ctx.fillStyle = `rgba(255,255,255,${rand() * 0.12})`;
        ctx.fillRect(x, y, 64, 64);
      }
    }
    ctx.fillStyle = '#2a3440';
    for (let x = 0; x < 512; x += 64) ctx.fillRect(x, 0, 4, 512);
    for (let y = 0; y < 512; y += 64) ctx.fillRect(0, y, 512, 5);
    return toTexture(c);
  }

  // concreto e tijolo: janelas individuais com moldura, persianas e varandas ocasionais
  const brick = style === 'brick';
  ctx.fillStyle = brick ? '#b8664a' : '#efeae0';
  ctx.fillRect(0, 0, 512, 512);
  if (brick) {
    ctx.fillStyle = 'rgba(70,30,20,0.25)';
    for (let y = 0; y < 512; y += 8) {
      ctx.fillRect(0, y, 512, 1);
      for (let x = (y / 8) % 2 ? 0 : 8; x < 512; x += 16) ctx.fillRect(x, y, 1, 8);
    }
  } else noise(ctx, 512, 512, rand, 6000, 0.12);

  for (let f = 0; f < 4; f++) {
    // faixa entre andares
    ctx.fillStyle = brick ? 'rgba(240,230,215,0.9)' : 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, f * ch + ch - 8, 512, 8);
    for (let col = 0; col < 4; col++) {
      const x = col * cw + 28;
      const y = f * ch + 22;
      const w = 72;
      const h = 84;
      ctx.fillStyle = brick ? '#efe6d6' : '#c9c3b8';
      ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, '#6e8396');
      g.addColorStop(1, '#27323d');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      // persiana
      if (rand() < 0.45) {
        ctx.fillStyle = ['#e8e1d0', '#d8d3c8', '#c6b79b'][Math.floor(rand() * 3)];
        ctx.fillRect(x, y, w, h * (0.2 + rand() * 0.6));
      }
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x + w / 2 - 2, y, 4, h);
      // varanda
      if (!brick && rand() < 0.3) {
        ctx.fillStyle = 'rgba(60,64,70,0.85)';
        ctx.fillRect(x - 10, y + h - 18, w + 20, 4);
        for (let i = x - 10; i <= x + w + 10; i += 8) ctx.fillRect(i, y + h - 18, 2, 24);
      }
    }
  }
  return toTexture(c);
}

/**
 * Máscara de janelas acesas (para a noite), alinhada com facadeTexture do mesmo estilo.
 * Preto = apagado; amarelo quente/branco frio = luz acesa.
 */
export function windowLightsTexture(style: FacadeStyle, seed: number) {
  const rand = rng(seed * 31 + 7);
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 512, 512);
  const color = () => (rand() < 0.75 ? `hsl(${38 + rand() * 12}, 90%, ${62 + rand() * 18}%)` : `hsl(205, 60%, ${78 + rand() * 12}%)`);
  if (style === 'office') {
    for (let f = 0; f < 4; f++) {
      for (let x = 0; x < 512; x += 64) {
        if (rand() < 0.45) {
          ctx.fillStyle = color();
          ctx.fillRect(x + 3, f * 128 + 30, 61, 80);
        }
      }
    }
  } else if (style === 'glass') {
    for (let x = 0; x < 512; x += 64) {
      for (let y = 0; y < 512; y += 64) {
        if (rand() < 0.35) {
          ctx.fillStyle = color();
          ctx.fillRect(x + 4, y + 5, 60, 59);
        }
      }
    }
  } else {
    for (let f = 0; f < 4; f++) {
      for (let col = 0; col < 4; col++) {
        if (rand() < 0.4) {
          ctx.fillStyle = color();
          ctx.fillRect(col * 128 + 28, f * 128 + 22, 72, 84);
        }
      }
    }
  }
  return toTexture(c);
}

const SHOPS = ['PADARIA', 'FARMÁCIA', 'CAFÉ', 'LIVRARIA', 'LANCHONETE', 'ÓTICA', 'PAPELARIA', 'SORVETERIA', 'FLORICULTURA', 'BAZAR'];
const SHOP_COLORS = ['#c0392b', '#1f6f8b', '#2e8b57', '#8e44ad', '#d35400', '#2c3e50', '#b8860b', '#16a085'];

// Térreo com vitrines. Cobre 8 m de largura x 4,5 m de altura.
export function storefrontTexture(seed: number) {
  const rand = rng(seed);
  const [c, ctx] = canvas(512, 288);
  const color = SHOP_COLORS[Math.floor(rand() * SHOP_COLORS.length)];
  ctx.fillStyle = '#2a2d31';
  ctx.fillRect(0, 0, 512, 288);
  // letreiro
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 64);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 38px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(SHOPS[Math.floor(rand() * SHOPS.length)], 256, 34);
  // vitrines com interior iluminado
  for (const [x, w] of [[16, 200], [296, 200]] as const) {
    const g = ctx.createLinearGradient(0, 80, 0, 280);
    g.addColorStop(0, '#f3dfb5');
    g.addColorStop(1, '#8a6b45');
    ctx.fillStyle = g;
    ctx.fillRect(x, 84, w, 190);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = `hsl(${Math.floor(rand() * 360)},45%,${45 + rand() * 25}%)`;
      ctx.fillRect(x + 10 + rand() * (w - 50), 180 + rand() * 50, 20 + rand() * 30, 20 + rand() * 40);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(x + 20, 84);
    ctx.lineTo(x + 90, 84);
    ctx.lineTo(x + 30, 274);
    ctx.lineTo(x, 274);
    ctx.fill();
    ctx.strokeStyle = '#1b1d20';
    ctx.lineWidth = 8;
    ctx.strokeRect(x, 84, w, 190);
  }
  // porta
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(226, 96, 60, 192);
  ctx.fillStyle = '#4b5966';
  ctx.fillRect(232, 102, 48, 180);
  return { map: toTexture(c), awning: color };
}

export function ledPanelTexture(text: string, color: string) {
  const [c, ctx] = canvas(1024, 256);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = color;
  ctx.font = '900 150px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 136);
  // grade de LEDs
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let x = 0; x < 1024; x += 8) ctx.fillRect(x, 0, 2, 256);
  for (let y = 0; y < 256; y += 8) ctx.fillRect(0, y, 1024, 2);
  return toTexture(c, false);
}
