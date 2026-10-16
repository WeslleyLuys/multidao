import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CLOTH_COLORS, TEAMS, type Emote, type TeamId } from '../../shared/config';
import type { Look } from '../../shared/look';
import { BRAZIL_FLAG, CharacterRig, MODEL_SCALE, drawStar, isCap } from './character';
import { flagGeometry, waving } from './wave';

const geo = {
  pole: new THREE.CylinderGeometry(0.022, 0.022, 2.3, 8).translate(0, 1.15, 0),
  flag: flagGeometry(1.1, 0.7),
  flagBr: flagGeometry(1.1, 0.77), // proporção oficial 10:7
  board: new RoundedBoxGeometry(1.0, 0.62, 0.035, 1, 0.012),
  brim: new RoundedBoxGeometry(0.2, 0.025, 0.13, 1, 0.01),
};

const materials = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, roughness = 0.75) {
  const key = `${color}|${roughness}`;
  let m = materials.get(key);
  if (!m) materials.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness })));
  return m;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const flagMaterials = new Map<TeamId, THREE.MeshStandardMaterial>();
export function flagMaterial(team: TeamId) {
  let m = flagMaterials.get(team);
  if (!m) {
    const { color, accent } = TEAMS[team];
    const map = canvasTexture(256, 160, (ctx) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 256, 160);
      ctx.fillStyle = accent;
      ctx.fillRect(0, 62, 256, 36);
      ctx.beginPath();
      ctx.arc(128, 80, 38, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(128, 80, 24, 0, Math.PI * 2);
      ctx.fill();
    });
    m = waving(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.9 }));
    flagMaterials.set(team, m);
  }
  return m;
}

let brazilMaterial: THREE.MeshStandardMaterial | undefined;
function brazilFlagMaterial() {
  if (!brazilMaterial) {
    const map = canvasTexture(1000, 700, (ctx) => {
      if (BRAZIL_FLAG) ctx.drawImage(BRAZIL_FLAG, 0, 0, 1000, 700);
      else {
        ctx.fillStyle = '#009c3b';
        ctx.fillRect(0, 0, 1000, 700);
      }
    });
    brazilMaterial = waving(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.9 }));
  }
  return brazilMaterial;
}

let ptMaterial: THREE.MeshStandardMaterial | undefined;
function ptFlagMaterial() {
  if (!ptMaterial) {
    // Bandeira vermelha com a estrela branca e a sigla PT
    const map = canvasTexture(1000, 700, (ctx) => {
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(0, 0, 1000, 700);
      drawStar(ctx, 500, 370, 300, '#ffffff');
      ctx.fillStyle = '#c8102e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 150px system-ui, sans-serif';
      ctx.fillText('PT', 500, 400);
    });
    ptMaterial = waving(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.9 }));
  }
  return ptMaterial;
}

function signMaterial(text: string, team: TeamId) {
  const map = canvasTexture(512, 320, (ctx) => {
    ctx.fillStyle = '#fbf7ee';
    ctx.fillRect(0, 0, 512, 320);
    ctx.strokeStyle = TEAMS[team].color;
    ctx.lineWidth = 22;
    ctx.strokeRect(11, 11, 490, 298);
    ctx.fillStyle = '#1b1b1b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    wrapText(ctx, (text || TEAMS[team].name).toUpperCase(), 256, 160, 450, 280);
  });
  const face = new THREE.MeshStandardMaterial({ map, roughness: 0.9 });
  const edge = mat('#c9a979');
  return [edge, edge, edge, edge, face, face];
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, maxH: number) {
  for (let size = 92; size >= 36; size -= 6) {
    ctx.font = `900 ${size}px system-ui, sans-serif`;
    const lines: string[] = [];
    let line = '';
    for (const w of text.split(' ')) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    lines.push(line);
    const fits = lines.length * size * 1.1 <= maxH && lines.every((l) => ctx.measureText(l).width <= maxW);
    if (fits || size <= 36) {
      const top = y - ((lines.length - 1) * size * 1.1) / 2;
      lines.forEach((l, i) => ctx.fillText(l, x, top + i * size * 1.1));
      return;
    }
  }
}

export function labelSprite(text: string, color: string, opts: { bg?: string; size?: number } = {}) {
  const size = (opts.size ?? 30) * 2;
  const font = `700 ${size}px system-ui, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 56;
  const h = size + 36;
  const map = canvasTexture(w, h, (ctx) => {
    ctx.font = font;
    ctx.fillStyle = opts.bg ?? 'rgba(15,18,22,0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthWrite: false, transparent: true, fog: false, toneMapped: false }));
  const scale = 0.00425;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

// Ângulos base (radianos). Os braços do modelo estão em "A"; ARM_DOWN os traz para junto do corpo.
const ARM_DOWN = 0.62;

export class Avatar {
  readonly root = new THREE.Group();
  private rig: CharacterRig;
  private holder?: THREE.Group;
  private signMats?: THREE.Material[];
  private nameTag?: THREE.Sprite;
  private bubble?: THREE.Sprite;
  private bubbleUntil = 0;
  private phase = Math.random() * 10;
  private idle = Math.random() * 10;
  private emote?: { e: Emote; t: number };
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();

  constructor(readonly team: TeamId, look: Look, name?: string, isSelf = false) {
    this.rig = new CharacterRig(look);
    this.root.add(this.rig.container);
    this.rig.reset();
    this.rig.container.updateMatrixWorld(true);

    if (isCap(look)) {
      const head = this.rig.bone('head');
      if (head) {
        const brim = new THREE.Mesh(geo.brim, mat(CLOTH_COLORS[look.head.c], 0.7));
        brim.castShadow = true;
        brim.position.set(0, 4.55, 0.3); // unidades do modelo
        brim.rotation.x = 0.12;
        brim.scale.setScalar(1 / MODEL_SCALE);
        this.rig.container.add(brim);
        this.rig.container.updateMatrixWorld(true);
        head.attach(brim);
      }
    }
    this.addItem(look);

    if (name) {
      this.nameTag = labelSprite(name, isSelf ? '#ffd23f' : TEAMS[team].color);
      this.nameTag.position.y = look.item === 'none' ? 2.05 : 2.95;
      this.root.add(this.nameTag);
    }
  }

  private addItem(look: Look) {
    if (look.item === 'none') return;
    const hand = this.rig.bone('hand.R');
    if (!hand) return;
    const holder = new THREE.Group();
    holder.scale.setScalar(1 / MODEL_SCALE); // filhos em metros
    hand.add(holder);
    this.holder = holder;

    const pole = new THREE.Mesh(geo.pole, mat('#c9a979', 0.6));
    pole.position.set(0, -0.5, 0.05);
    pole.castShadow = true;
    holder.add(pole);

    if (look.item === 'flag' || look.item === 'flag-br' || look.item === 'flag-pt') {
      const material = look.item === 'flag-br' ? brazilFlagMaterial() : look.item === 'flag-pt' ? ptFlagMaterial() : flagMaterial(this.team);
      const cloth = new THREE.Mesh(look.item === 'flag' ? geo.flag : geo.flagBr, material);
      cloth.position.set(0.02, 1.42, 0.05);
      cloth.castShadow = true;
      holder.add(cloth);
    } else {
      this.signMats = signMaterial(look.sign, this.team);
      const board = new THREE.Mesh(geo.board, this.signMats);
      board.position.set(0, 1.25, 0.05);
      board.castShadow = true;
      holder.add(board);
    }
  }

  say(text: string) {
    this.clearBubble();
    const short = text.length > 42 ? `${text.slice(0, 40)}…` : text;
    this.bubble = labelSprite(short, '#111', { bg: 'rgba(255,255,255,0.94)', size: 28 });
    this.bubble.position.y = (this.nameTag?.position.y ?? 2.1) + 0.5;
    this.root.add(this.bubble);
    this.bubbleUntil = performance.now() + 6000;
  }

  private clearBubble() {
    if (!this.bubble) return;
    this.root.remove(this.bubble);
    this.bubble.material.map?.dispose();
    this.bubble.material.dispose();
    this.bubble = undefined;
  }

  playEmote(e: Emote) {
    this.emote = { e, t: 0 };
  }

  update(dt: number, moving: number) {
    if (this.bubble && performance.now() > this.bubbleUntil) this.clearBubble();
    const rig = this.rig;
    const run = moving === 2;
    this.phase += dt * (run ? 11 : moving ? 7.5 : 0);
    this.idle += dt;
    const s = moving ? Math.sin(this.phase) : 0;
    const amp = run ? 0.75 : 0.45;
    const breathe = Math.sin(this.idle * 1.6) * 0.02;

    rig.reset();
    let y = moving ? Math.abs(Math.cos(this.phase)) * (run ? 0.07 : 0.035) : 0;

    // Pernas
    rig.rotate('upperleg.L', -s * amp, 0, 0);
    rig.rotate('upperleg.R', s * amp, 0, 0);
    rig.rotate('lowerleg.L', Math.max(0, s) * amp * 1.3, 0, 0);
    rig.rotate('lowerleg.R', Math.max(0, -s) * amp * 1.3, 0, 0);
    rig.rotate('chest', (run ? 0.18 : 0.04) + breathe, moving ? s * 0.12 : 0, 0);
    rig.rotate('head', moving ? 0 : Math.sin(this.idle * 0.4) * 0.05, moving ? 0 : Math.sin(this.idle * 0.27) * 0.35, 0);

    // Braços (balanço oposto às pernas)
    let armL = { x: s * amp * 0.9, y: 0, z: -ARM_DOWN - breathe };
    let armR = { x: -s * amp * 0.9, y: 0, z: ARM_DOWN + breathe };
    let foreL = { x: run ? -0.9 : -0.25, y: 0, z: 0 };
    let foreR = { x: run ? -0.9 : -0.25, y: 0, z: 0 };
    if (this.holder) {
      armR = { x: -0.35 + s * 0.05, y: 0, z: ARM_DOWN - 0.1 };
      foreR = { x: -1.15, y: 0, z: 0 };
    }

    if (this.emote) {
      const t = (this.emote.t += dt);
      const p = t * 10;
      if (t > 2.4) this.emote = undefined;
      else if (this.emote.e === 'wave') {
        armR = { x: -0.2, y: 0, z: -1.95 };
        foreR = { x: 0, y: 0, z: -0.25 + Math.sin(p) * 0.45 };
      } else if (this.emote.e === 'jump') {
        y = Math.max(0, Math.sin(t * 7.5)) * 0.5;
        armL = { x: -0.2, y: 0, z: 1.9 };
        armR = { x: -0.2, y: 0, z: -1.9 };
        foreL = foreR = { x: 0, y: 0, z: 0 };
      } else if (this.emote.e === 'dance') {
        const k = Math.sin(p * 0.6);
        rig.rotate('chest', 0.05, k * 0.45, k * 0.1);
        rig.rotate('wiest', 0, 0, -k * 0.12);
        armL = { x: -0.3, y: 0, z: 1.1 + k * 0.6 };
        if (!this.holder) armR = { x: -0.3, y: 0, z: -1.1 + k * 0.6 };
        foreL = foreR = { x: -0.6, y: 0, z: 0 };
        y = Math.abs(k) * 0.08;
      } else if (this.emote.e === 'clap') {
        const k = Math.abs(Math.sin(p * 1.3));
        armL = { x: -1.25, y: -0.35 - k * 0.25, z: -ARM_DOWN + 0.35 };
        armR = { x: -1.25, y: 0.35 + k * 0.25, z: ARM_DOWN - 0.35 };
        foreL = foreR = { x: -0.55, y: 0, z: 0 };
      }
    }

    rig.rotate('upperarm.L', armL.x, armL.y, armL.z);
    rig.rotate('upperarm.R', armR.x, armR.y, armR.z);
    rig.rotate('lowerarm.L', foreL.x, foreL.y, foreL.z);
    rig.rotate('lowerarm.R', foreR.x, foreR.y, foreR.z);
    rig.container.position.y = y;

    // Mantém o mastro em pé, independentemente da rotação da mão.
    if (this.holder) {
      this.root.updateMatrixWorld(true);
      this.holder.parent!.getWorldQuaternion(this.qa).invert();
      this.root.getWorldQuaternion(this.qb);
      this.holder.quaternion.copy(this.qa.multiply(this.qb));
    }
  }

  dispose() {
    for (const m of this.signMats?.slice(4, 5) ?? []) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
    this.clearBubble();
    if (this.nameTag) {
      this.nameTag.material.map?.dispose();
      this.nameTag.material.dispose();
    }
    this.rig.dispose();
  }
}
