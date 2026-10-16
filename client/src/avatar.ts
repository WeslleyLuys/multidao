import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CLOTH_COLORS, TEAMS, type Emote, type TeamId } from '../../shared/config';
import type { Look } from '../../shared/look';
import { BRAZIL_FLAG, CharacterRig, MODEL_SCALE, drawStar, isCap } from './character';
import { flagGeometry, waving } from './wave';
import { buildGun } from './match/guns';

const geo = {
  pole: new THREE.CylinderGeometry(0.022, 0.022, 2.3, 8).translate(0, 1.15, 0),
  flag: flagGeometry(1.1, 0.7),
  flagBr: flagGeometry(1.1, 0.77), // proporção oficial 10:7
  board: new RoundedBoxGeometry(1.0, 0.62, 0.035, 1, 0.012),
  brim: new RoundedBoxGeometry(0.2, 0.025, 0.13, 1, 0.01),
  vest: new RoundedBoxGeometry(0.37, 0.36, 0.27, 2, 0.04),
};
const vestMaterial = new THREE.MeshStandardMaterial({ color: '#3b4230', roughness: 0.85 });

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
// Dobra dos dedos (para apontar com o indicador).
const FINGER_CURL = 1.5;

type Rot = [number, number, number];
type Pose = Record<string, Rot>;
// Ossos animados, pais antes dos filhos.
const BONES = [
  'wiest', 'hip', 'chest', 'neck', 'head',
  'upperarm.L', 'lowerarm.L', 'hand.L', 'upperarm.R', 'lowerarm.R', 'hand.R',
  'upperleg.L', 'lowerleg.L', 'foot.L', 'upperleg.R', 'lowerleg.R', 'foot.R',
  'upfinger2.R', 'upfinger3.R', 'upfinger4.R', 'tooseup.R',
];
const ZERO: Rot = [0, 0, 0];
// Ações em que a mão direita continua livre para a bandeira/cartaz.
// Animações extras além das ações da barra: agressão, reação e interações em dupla.
export type AnimName = Emote | 'hit' | 'hitItem' | 'shove' | 'stagger' | 'knockdown' | 'hug' | 'kiss' | 'hand';
// Ações em que a mão direita continua livre para a bandeira/cartaz.
const FREE_HAND = new Set<AnimName>(['jump', 'dance', 'wave', 'crouch', 'hitItem', 'stagger', 'shove']);
// Ações curtas que não são canceladas por andar.
const ONE_SHOT = new Set<AnimName>(['jump', 'hit', 'hitItem', 'shove', 'stagger']);

const propGeo = {
  can: new THREE.CylinderGeometry(0.033, 0.033, 0.12, 14),
  canTop: new THREE.CylinderGeometry(0.03, 0.033, 0.012, 14),
  cig: new THREE.CylinderGeometry(0.0055, 0.0055, 0.085, 6).rotateX(Math.PI / 2),
  tip: new THREE.CylinderGeometry(0.006, 0.006, 0.012, 6).rotateX(Math.PI / 2),
  drop: new THREE.SphereGeometry(0.026, 5, 4),
  puff: new THREE.IcosahedronGeometry(0.05, 0),
  puddle: new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
};
const propMat = {
  can: new THREE.MeshStandardMaterial({ color: '#c8102e', roughness: 0.3, metalness: 0.7 }),
  canTop: new THREE.MeshStandardMaterial({ color: '#d9dde2', roughness: 0.25, metalness: 0.9 }),
  cig: new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.8 }),
  tip: new THREE.MeshStandardMaterial({ color: '#ff6a1a', emissive: '#ff4a00', emissiveIntensity: 2 }),
};

let heartTex: THREE.Texture | undefined;
function heartTexture() {
  if (!heartTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff3b6b';
    ctx.beginPath();
    ctx.moveTo(32, 56);
    ctx.bezierCurveTo(4, 36, 6, 10, 22, 10);
    ctx.bezierCurveTo(28, 10, 32, 15, 32, 20);
    ctx.bezierCurveTo(32, 15, 36, 10, 42, 10);
    ctx.bezierCurveTo(58, 10, 60, 36, 32, 56);
    ctx.fill();
    heartTex = new THREE.CanvasTexture(c);
    heartTex.colorSpace = THREE.SRGBColorSpace;
  }
  return heartTex;
}

interface Particle {
  mesh: THREE.Mesh | THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  max: number;
  kind: 'drop' | 'smoke' | 'heart';
}

export class Avatar {
  readonly root = new THREE.Group();
  private rig: CharacterRig;
  private holder?: THREE.Group;
  private props = new THREE.Group();
  private can: THREE.Group;
  private cig: THREE.Group;
  private signMats?: THREE.Material[];
  private nameTag?: THREE.Sprite;
  private bubble?: THREE.Sprite;
  private bubbleUntil = 0;
  private phase = Math.random() * 10;
  private idle = Math.random() * 10;
  private emote?: { e: AnimName; t: number; side?: 'L' | 'R' };
  private cur = new Map<string, Rot>();
  private bodyY = 0;
  private bodyRotX = 0;
  private particles: Particle[] = [];
  private puddle?: THREE.Mesh;
  private emitAcc = 0;
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(readonly team: TeamId, look: Look, name?: string, isSelf = false, tagColor?: string) {
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

    // Colete (eventos): criado na pose de repouso, preso ao peito, aparece só com armadura.
    const chest = this.rig.bone('chest');
    if (chest) {
      const vest = new THREE.Mesh(geo.vest, vestMaterial);
      vest.position.set(0, 3.32, 0.03); // unidades do modelo
      vest.scale.setScalar(1 / MODEL_SCALE);
      vest.castShadow = true;
      this.rig.container.add(vest);
      this.rig.container.updateMatrixWorld(true);
      chest.attach(vest);
      vest.visible = false;
      this.vest = vest;
    }

    // Objetos de mão das ações (latinha e cigarro), presos à mão direita.
    this.can = new THREE.Group();
    const canTop = new THREE.Mesh(propGeo.canTop, propMat.canTop);
    canTop.position.y = 0.066;
    this.can.add(new THREE.Mesh(propGeo.can, propMat.can), canTop);
    this.can.position.set(0, 0.0, 0.06);
    this.cig = new THREE.Group();
    const tip = new THREE.Mesh(propGeo.tip, propMat.tip);
    tip.position.z = 0.048;
    this.cig.add(new THREE.Mesh(propGeo.cig, propMat.cig), tip);
    this.cig.position.set(0.0, -0.02, 0.07);
    this.props.add(this.can, this.cig);
    this.props.scale.setScalar(1 / MODEL_SCALE);
    this.can.visible = this.cig.visible = false;
    this.rig.bone('hand.R')?.add(this.props);

    if (name) {
      this.nameTag = labelSprite(name, tagColor ?? (isSelf ? '#ffd23f' : TEAMS[team].color));
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

  /** Inicia uma ação. Todas (menos o pulo) ficam em loop até andar ou receber 'stop'. */
  playEmote(e: Emote) {
    this.emote = e === 'stop' ? undefined : { e, t: 0 };
  }

  /** Animação extra (agressão, reação, interação). side: de que lado está o parceiro (mãos dadas). */
  playAnim(e: AnimName, side?: 'L' | 'R') {
    this.emote = { e, t: 0, side };
  }

  get hasItem() {
    return !!this.holder;
  }

  get currentEmote(): AnimName | undefined {
    return this.emote?.e;
  }

  // ---------- Combate (eventos) ----------
  private combat = false;
  private gun?: THREE.Group;
  private gunId = -1;
  private aimPitch = 0;
  private punchT = 0;
  private dead = false;
  private deadT = 0;
  private qp = new THREE.Quaternion();
  private ax = new THREE.Vector3(1, 0, 0);

  /** Arma na mão (0 = soco, sem arma). Ativa a pose de combate. */
  setWeapon(w: number) {
    this.combat = true;
    if (w === this.gunId) return;
    this.gunId = w;
    this.gun?.removeFromParent();
    this.gun = undefined;
    const model = buildGun(w);
    const hand = this.rig.bone('hand.R');
    if (!model || !hand) return;
    const holder = new THREE.Group();
    holder.scale.setScalar(1 / MODEL_SCALE);
    holder.add(model.group);
    model.group.position.set(0, -0.03, 0.06);
    hand.add(holder);
    this.gun = holder;
  }

  private vest?: THREE.Object3D;
  setArmor(on: boolean) {
    if (this.vest) this.vest.visible = on;
  }

  /** Policial: arma em posição de patrulha (cano para baixo), cabeça e tronco livres. */
  private patrol = false;
  setPatrol(w: number) {
    this.patrol = true;
    this.setWeapon(w);
    this.setAim(-0.6);
    this.setArmor(true);
  }

  setAim(pitch: number) {
    this.aimPitch = pitch;
  }

  punch() {
    this.punchT = 0.3;
  }

  setDead(dead: boolean) {
    this.dead = dead;
  }

  // ---------- Animação ----------
  update(dt: number, moving: number) {
    if (this.bubble && performance.now() > this.bubbleUntil) this.clearBubble();
    // Andar encerra a ação (menos o pulo, que dá para fazer correndo).
    if (moving && this.emote && !ONE_SHOT.has(this.emote.e)) this.emote = undefined;

    const run = moving === 2;
    this.phase += dt * (run ? 10.5 : moving ? 7 : 0);
    this.idle += dt;
    const t = this.idle;
    const breathe = Math.sin(t * 1.7) * 0.025;
    const P: Pose = {};
    let bodyY = 0;
    let bodyRotX = 0;

    if (moving) {
      // Caminhada: quadril gira, tronco compensa, joelhos e cotovelos dobram.
      const s = Math.sin(this.phase);
      const c = Math.cos(this.phase);
      const amp = run ? 0.85 : 0.5;
      P['upperleg.L'] = [-s * amp, 0, 0];
      P['upperleg.R'] = [s * amp, 0, 0];
      P['lowerleg.L'] = [Math.max(0, -c) * amp * 1.5 + 0.08, 0, 0];
      P['lowerleg.R'] = [Math.max(0, c) * amp * 1.5 + 0.08, 0, 0];
      P['foot.L'] = [s * 0.22, 0, 0];
      P['foot.R'] = [-s * 0.22, 0, 0];
      P.wiest = [0, s * 0.14, c * 0.03];
      P.chest = [run ? 0.22 : 0.06, -s * 0.2, 0];
      P.head = [run ? -0.12 : -0.02, s * 0.07, 0];
      const arm = amp * 0.85;
      P['upperarm.L'] = [s * arm, 0, -ARM_DOWN + 0.05];
      P['upperarm.R'] = [-s * arm, 0, ARM_DOWN - 0.05];
      P['lowerarm.L'] = [run ? -1.35 : -0.3 - Math.max(0, -s) * 0.35, 0, 0];
      P['lowerarm.R'] = [run ? -1.35 : -0.3 - Math.max(0, s) * 0.35, 0, 0];
      bodyY = Math.abs(c) * (run ? 0.06 : 0.03) - (run ? 0.04 : 0.01);
    } else {
      // Parado: respira, transfere o peso entre as pernas e olha em volta.
      const sway = Math.sin(t * 0.8);
      const w = (sway + 1) / 2;
      P.wiest = [0, Math.sin(t * 0.45) * 0.04, sway * 0.035];
      P.chest = [0.03 + breathe, -Math.sin(t * 0.45) * 0.04, -sway * 0.025];
      P.head = [Math.sin(t * 0.37) * 0.05, Math.sin(t * 0.23) * 0.4, 0];
      P['upperarm.L'] = [0.04 + breathe * 0.5, 0, -ARM_DOWN - breathe];
      P['upperarm.R'] = [0.04 + breathe * 0.5, 0, ARM_DOWN + breathe];
      P['lowerarm.L'] = [-0.22, 0, 0];
      P['lowerarm.R'] = [-0.22, 0, 0];
      P['upperleg.L'] = [-0.05 * w, 0, 0.03 * sway];
      P['lowerleg.L'] = [0.12 * w, 0, 0];
      P['upperleg.R'] = [-0.05 * (1 - w), 0, 0.03 * sway];
      P['lowerleg.R'] = [0.12 * (1 - w), 0, 0];
    }
    if (this.holder) {
      P['upperarm.R'] = [-0.35, 0, ARM_DOWN - 0.1];
      P['lowerarm.R'] = [-1.15, 0, 0];
    }

    let prop: 'can' | 'cig' | null = null;
    let emitPee = false;
    let emitSmoke = 0; // 0 nada, 1 brasa, 2 tragada
    let emitHearts = false;
    if (this.emote) {
      const e = this.emote.e;
      const et = (this.emote.t += dt);
      const p = et * 10;
      if (e === 'wave') {
        P['upperarm.R'] = [-0.2, 0, -1.95];
        P['lowerarm.R'] = [0, 0, -0.25 + Math.sin(p) * 0.45];
        P.head = [0, 0.1, 0];
      } else if (e === 'jump') {
        const k = et / 0.9;
        if (k >= 1) this.emote = undefined;
        const h = Math.sin(Math.PI * Math.min(1, k));
        bodyY += h * 0.55;
        P['upperleg.L'] = [-0.75 * h, 0, 0];
        P['upperleg.R'] = [-0.75 * h, 0, 0];
        P['lowerleg.L'] = [1.25 * h, 0, 0];
        P['lowerleg.R'] = [1.25 * h, 0, 0];
        P['upperarm.L'] = [-0.3, 0, 1.6 * h - ARM_DOWN * (1 - h)];
        P['upperarm.R'] = [-0.3, 0, -1.6 * h + ARM_DOWN * (1 - h)];
      } else if (e === 'dance') {
        const k = Math.sin(p * 0.6);
        P.chest = [0.05, k * 0.45, k * 0.1];
        P.wiest = [0, -k * 0.2, -k * 0.12];
        P.head = [Math.abs(k) * 0.15, -k * 0.2, 0];
        P['upperarm.L'] = [-0.3, 0, 1.1 + k * 0.6];
        if (!this.holder) P['upperarm.R'] = [-0.3, 0, -1.1 + k * 0.6];
        P['lowerarm.L'] = [-0.6, 0, 0];
        P['lowerarm.R'] = [-0.6, 0, 0];
        P['upperleg.L'] = [-Math.max(0, k) * 0.5, 0, 0];
        P['upperleg.R'] = [-Math.max(0, -k) * 0.5, 0, 0];
        P['lowerleg.L'] = [Math.max(0, k) * 0.8, 0, 0];
        P['lowerleg.R'] = [Math.max(0, -k) * 0.8, 0, 0];
        bodyY = Math.abs(k) * 0.08 - 0.03;
      } else if (e === 'clap') {
        const k = Math.abs(Math.sin(p * 1.3));
        P['upperarm.L'] = [-1.25, -0.35 - k * 0.25, -ARM_DOWN + 0.35];
        P['upperarm.R'] = [-1.25, 0.35 + k * 0.25, ARM_DOWN - 0.35];
        P['lowerarm.L'] = [-0.55, 0, 0];
        P['lowerarm.R'] = [-0.55, 0, 0];
        P.head = [-0.05, 0, 0];
      } else if (e === 'point') {
        // Braço estendido, só o indicador esticado; a outra mão na cintura.
        P['upperarm.R'] = [-1.5, 0.05, ARM_DOWN - 0.55];
        P['lowerarm.R'] = [-0.05, 0, 0];
        for (const f of ['upfinger2.R', 'upfinger3.R', 'upfinger4.R']) P[f] = [0, 0, FINGER_CURL];
        P['tooseup.R'] = [0, 0, FINGER_CURL * 0.5];
        P['upperarm.L'] = [0.15, 0.3, -ARM_DOWN - 0.25];
        P['lowerarm.L'] = [-1.6, 0, 0];
        P.chest = [0.06, 0.15 + Math.sin(p * 0.3) * 0.03, 0];
        P.head = [-0.05, -0.15, 0];
      } else if (e === 'crouch') {
        bodyY = -0.5;
        P['upperleg.L'] = [-1.45, 0, -0.12];
        P['upperleg.R'] = [-1.45, 0, 0.12];
        P['lowerleg.L'] = [2.35, 0, 0];
        P['lowerleg.R'] = [2.35, 0, 0];
        P['foot.L'] = [-0.85, 0, 0];
        P['foot.R'] = [-0.85, 0, 0];
        P.wiest = [0, 0, 0];
        P.chest = [0.35 + breathe, 0, 0];
        P.head = [-0.25, Math.sin(t * 0.23) * 0.3, 0];
        P['upperarm.L'] = [-0.85, 0, -ARM_DOWN + 0.15];
        P['lowerarm.L'] = [-0.55, 0, 0];
        if (!this.holder) {
          P['upperarm.R'] = [-0.85, 0, ARM_DOWN - 0.15];
          P['lowerarm.R'] = [-0.55, 0, 0];
        }
      } else if (e === 'lie') {
        // Deitado de barriga para cima, mãos atrás da cabeça, um joelho dobrado.
        bodyRotX = -Math.PI / 2;
        bodyY = 0.12;
        P['upperarm.L'] = [0.2, 0, 2.5];
        P['upperarm.R'] = [0.2, 0, -2.5];
        P['lowerarm.L'] = [-2.1, 0, 0];
        P['lowerarm.R'] = [-2.1, 0, 0];
        P['upperleg.R'] = [-0.75, 0, 0];
        P['lowerleg.R'] = [1.35, 0, 0];
        P['upperleg.L'] = [0, 0, -0.05];
        P.head = [0.35, Math.sin(t * 0.2) * 0.2, 0];
        P.chest = [breathe * 2, 0, 0];
      } else if (e === 'drink') {
        // Segura a latinha no peito e dá goles de tempos em tempos.
        prop = 'can';
        const c = et % 4;
        const sip = c > 2.2 && c < 3.6 ? Math.sin(((c - 2.2) / 1.4) * Math.PI) : 0;
        P['upperarm.R'] = [-0.4 - sip * 0.7, 0.2 + sip * 0.15, ARM_DOWN - 0.15 - sip * 0.15];
        P['lowerarm.R'] = [-1.6 - sip * 0.9, 0.3, 0];
        P.head = [-0.35 * sip, 0, 0];
        P.chest = [0.02 - 0.08 * sip + breathe, 0, 0];
      } else if (e === 'smoke') {
        // Cigarro na mão; leva à boca, traga e solta a fumaça.
        prop = 'cig';
        const c = et % 5;
        const puff = c > 1 && c < 2.3 ? Math.sin(((c - 1) / 1.3) * Math.PI) : 0;
        P['upperarm.R'] = [-0.2 - puff * 0.9, 0.15 + puff * 0.25, ARM_DOWN - 0.1 - puff * 0.25];
        P['lowerarm.R'] = [-1.2 - puff * 1.35, 0.25, 0];
        P.head = [-0.1 * puff, 0, 0];
        emitSmoke = c > 2.4 && c < 3.6 ? 2 : 1;
      } else if (e === 'pee') {
        // Quadril à frente, mãos na frente, olhando para baixo (cartum, nada explícito).
        P.wiest = [-0.14, 0, 0];
        P.chest = [-0.06 + breathe, 0, 0];
        P.head = [0.45, Math.sin(t * 0.3) * 0.15, 0];
        P['upperarm.L'] = [-0.45, -0.25, -ARM_DOWN - 0.05];
        P['upperarm.R'] = [-0.45, 0.25, ARM_DOWN + 0.05];
        P['lowerarm.L'] = [-1.1, -0.3, 0];
        P['lowerarm.R'] = [-1.1, 0.3, 0];
        emitPee = et > 0.7;
      } else if (e === 'hit') {
        // Soco de direita
        const k = Math.sin(Math.min(1, et / 0.38) * Math.PI);
        if (et > 0.4) this.emote = undefined;
        P['upperarm.R'] = [-1.25 - k * 0.35, 0.25, ARM_DOWN - 0.25];
        P['lowerarm.R'] = [-1.6 + k * 1.5, 0, 0];
        P['upperarm.L'] = [-1.0, -0.3, -ARM_DOWN + 0.25];
        P['lowerarm.L'] = [-1.6, 0, 0];
        P.chest = [0.1, -0.35 * k, 0];
      } else if (e === 'hitItem') {
        // Golpe com a bandeira/cartaz: levanta e desce
        const k = Math.min(1, et / 0.55);
        if (et > 0.6) this.emote = undefined;
        const up = k < 0.45 ? k / 0.45 : 1 - (k - 0.45) / 0.55;
        P['upperarm.R'] = [-0.6 - up * 2.1, 0.2, ARM_DOWN - 0.3];
        P['lowerarm.R'] = [-0.4 - up * 0.6, 0, 0];
        P.chest = [0.25 * (1 - up), -0.25 * (1 - up), 0];
      } else if (e === 'shove') {
        // Empurrão com as duas mãos
        const k = Math.sin(Math.min(1, et / 0.4) * Math.PI);
        if (et > 0.42) this.emote = undefined;
        P['upperarm.L'] = [-1.45 * k - 0.2, -0.35, -ARM_DOWN + 0.4];
        P['upperarm.R'] = [-1.45 * k - 0.2, 0.35, ARM_DOWN - 0.4];
        P['lowerarm.L'] = [-0.25, 0, 0];
        P['lowerarm.R'] = [-0.25, 0, 0];
        P.chest = [0.3 * k, 0, 0];
      } else if (e === 'stagger') {
        // Cambaleia para trás
        const k = Math.sin(Math.min(1, et / 0.6) * Math.PI);
        if (et > 0.62) this.emote = undefined;
        P.chest = [-0.4 * k, 0, 0.1 * k];
        P.head = [-0.3 * k, 0, 0];
        P['upperarm.L'] = [-0.4, 0, -ARM_DOWN + 1.0 * k];
        P['upperarm.R'] = [-0.4, 0, ARM_DOWN - 1.0 * k];
        P['upperleg.L'] = [0.25 * k, 0, 0];
      } else if (e === 'knockdown') {
        // Cai de costas, fica no chão e levanta
        if (et > 4.1) this.emote = undefined;
        bodyRotX = et < 3.5 ? -Math.PI / 2 : 0;
        bodyY = et < 3.5 ? 0.12 : 0;
        P['upperarm.L'] = [0, 0, 1.3];
        P['upperarm.R'] = [0, 0, -1.3];
        P['upperleg.L'] = [-0.3, 0, -0.15];
        P['lowerleg.L'] = [0.5, 0, 0];
        P.head = [0.25, Math.sin(t * 1.2) * 0.3, 0];
      } else if (e === 'hug') {
        // Abraço: braços em volta do outro
        P['upperarm.L'] = [-1.25, -0.65, -ARM_DOWN + 0.55];
        P['upperarm.R'] = [-1.25, 0.65, ARM_DOWN - 0.55];
        P['lowerarm.L'] = [-1.2, -0.5, 0];
        P['lowerarm.R'] = [-1.2, 0.5, 0];
        P.chest = [0.14 + breathe, Math.sin(t * 1.4) * 0.06, 0];
        P.head = [0.12, 0.35, 0.1];
      } else if (e === 'kiss') {
        // Beijo: inclina, mãos na cintura do outro, corações subindo
        P.chest = [0.24 + breathe, 0, 0];
        P.head = [0.12, 0.12, 0.15];
        P['upperarm.L'] = [-0.75, -0.35, -ARM_DOWN + 0.3];
        P['upperarm.R'] = [-0.75, 0.35, ARM_DOWN - 0.3];
        P['lowerarm.L'] = [-0.9, -0.3, 0];
        P['lowerarm.R'] = [-0.9, 0.3, 0];
        emitHearts = true;
      } else if (e === 'hand') {
        // Mãos dadas: o braço do lado do outro se abre um pouco e balança
        const sw = Math.sin(t * 1.6) * 0.15;
        if (this.emote.side === 'R') {
          P['upperarm.R'] = [sw, 0, ARM_DOWN - 0.32];
          P['lowerarm.R'] = [-0.15, 0, 0];
        } else {
          P['upperarm.L'] = [sw, 0, -ARM_DOWN + 0.32];
          P['lowerarm.L'] = [-0.15, 0, 0];
        }
        P.head = [0, this.emote.side === 'R' ? -0.3 : 0.3, 0];
      }
    }

    if (this.combat) {
      // Pose de combate: arma apontada para a frente (com a inclinação da mira) ou guarda de soco.
      const p = this.aimPitch;
      if (!this.patrol) {
        P.chest = [0.05 - p * 0.35, 0, 0];
        P.head = [-p * 0.45, 0, 0];
      }
      if (this.gunId > 0) {
        P['upperarm.R'] = [-1.45 - p * 0.6, 0.15, ARM_DOWN - 0.15];
        P['lowerarm.R'] = [-0.15, 0, 0];
        P['upperarm.L'] = [-1.3 - p * 0.6, -0.55, -ARM_DOWN + 0.25];
        P['lowerarm.L'] = [-0.45, 0, 0];
      } else {
        this.punchT = Math.max(0, this.punchT - dt);
        const jab = Math.sin((this.punchT / 0.3) * Math.PI);
        P['upperarm.R'] = [-1.1 - jab * 0.5, 0.25, ARM_DOWN - 0.2];
        P['lowerarm.R'] = [-1.5 + jab * 1.3, 0, 0];
        P['upperarm.L'] = [-1.1, -0.25, -ARM_DOWN + 0.2];
        P['lowerarm.L'] = [-1.6, 0, 0];
      }
    }

    // Aplica a pose com transição suave (nada de "teleporte" entre poses).
    const rig = this.rig;
    rig.reset();
    const k = 1 - Math.exp(-dt * 16);
    for (const name of BONES) {
      const target = P[name] ?? ZERO;
      let c = this.cur.get(name);
      if (!c) this.cur.set(name, (c = [...target] as Rot));
      c[0] += (target[0] - c[0]) * k;
      c[1] += (target[1] - c[1]) * k;
      c[2] += (target[2] - c[2]) * k;
      if (c[0] || c[1] || c[2]) rig.rotate(name, c[0], c[1], c[2]);
    }
    this.bodyY += (bodyY - this.bodyY) * Math.min(1, dt * 12);
    this.bodyRotX += (bodyRotX - this.bodyRotX) * Math.min(1, dt * 6);
    rig.container.position.y = this.bodyY;

    // Eliminado (eventos): cai deitado.
    this.deadT += ((this.dead ? 1 : 0) - this.deadT) * Math.min(1, dt * 6);
    rig.container.rotation.x = Math.min(this.bodyRotX, -this.deadT * Math.PI * 0.5);
    const lying = this.emote?.e === 'lie';
    if (this.nameTag) {
      this.nameTag.visible = !this.dead;
      this.nameTag.position.y = lying ? 0.8 : (this.holder && !this.emote ? 2.95 : 2.05) + this.bodyY;
    }

    // Objetos de mão
    const handBusy = !!this.emote && !FREE_HAND.has(this.emote.e);
    if (this.holder) this.holder.visible = !handBusy;
    this.can.visible = prop === 'can';
    this.cig.visible = prop === 'cig';

    this.root.updateMatrixWorld(true);
    const keepUpright = (obj: THREE.Object3D, extra?: THREE.Quaternion) => {
      obj.parent!.getWorldQuaternion(this.qa).invert();
      this.root.getWorldQuaternion(this.qb);
      if (extra) this.qb.multiply(extra);
      obj.quaternion.copy(this.qa.multiply(this.qb));
    };
    if (this.gun) keepUpright(this.gun, this.qp.setFromAxisAngle(this.ax, -this.aimPitch));
    // No golpe com bandeira/cartaz o mastro acompanha a mão (balança); no resto fica em pé.
    if (this.holder?.visible && this.emote?.e !== 'hitItem') keepUpright(this.holder);
    if (prop) keepUpright(this.props);

    this.updateParticles(dt, emitPee, emitSmoke, emitHearts);
  }

  // ---------- Partículas (fumaça e xixi) ----------
  private heartAcc = 0;
  private spawnParticle(kind: Particle['kind'], pos: THREE.Vector3, vel: THREE.Vector3, life: number) {
    const scene = this.root.parent;
    if (!scene) return;
    const m =
      kind === 'heart'
        ? new THREE.Sprite(new THREE.SpriteMaterial({ map: heartTexture(), transparent: true, depthWrite: false }))
        : new THREE.Mesh(
            kind === 'drop' ? propGeo.drop : propGeo.puff,
            new THREE.MeshStandardMaterial({ color: kind === 'drop' ? '#f2d230' : '#d9d9d9', transparent: true, opacity: kind === 'drop' ? 0.8 : 0.5, depthWrite: false, roughness: 0.3 }),
          );
    if (kind === 'heart') m.scale.setScalar(0.22);
    m.position.copy(pos);
    scene.add(m);
    this.particles.push({ mesh: m, vel, life, max: life, kind });
  }

  private updateParticles(dt: number, pee: boolean, smoke: number, hearts = false) {
    this.heartAcc += dt;
    if (hearts && this.heartAcc > 0.45) {
      this.heartAcc = 0;
      const head = this.rig.bone('head');
      if (head) {
        const at = head.getWorldPosition(new THREE.Vector3());
        at.y += 0.35;
        at.x += (Math.random() - 0.5) * 0.3;
        this.spawnParticle('heart', at, new THREE.Vector3((Math.random() - 0.5) * 0.2, 0.55, 0), 1.8);
      }
    }
    this.emitAcc += dt;
    const fwd = this.v1.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    if (pee && this.emitAcc > 0.015) {
      this.emitAcc = 0;
      const pelvis = this.rig.bone('wiest');
      if (pelvis) {
        const at = pelvis.getWorldPosition(this.v2).addScaledVector(fwd, 0.16);
        at.y -= 0.12;
        const vel = fwd.clone().multiplyScalar(1.5 + Math.random() * 0.2).add(new THREE.Vector3((Math.random() - 0.5) * 0.08, 0.6, 0));
        this.spawnParticle('drop', at.clone(), vel, 1.2);
      }
    } else if (smoke && this.emitAcc > (smoke === 2 ? 0.06 : 0.35)) {
      this.emitAcc = 0;
      if (smoke === 2) {
        const head = this.rig.bone('head');
        if (head) {
          const at = head.getWorldPosition(this.v2).addScaledVector(fwd, 0.14);
          at.y += 0.02;
          this.spawnParticle('smoke', at.clone(), fwd.clone().multiplyScalar(0.4).add(new THREE.Vector3(0, 0.25, 0)), 1.6);
        }
      } else {
        this.spawnParticle('smoke', this.cig.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, 0.3, 0), 1.2);
      }
    }

    // A poça cresce enquanto faz xixi e some devagar depois.
    if (pee && !this.puddle && this.root.parent) {
      this.puddle = new THREE.Mesh(propGeo.puddle, new THREE.MeshStandardMaterial({ color: '#d8b92a', transparent: true, opacity: 0.55, roughness: 0.1, depthWrite: false }));
      this.puddle.scale.setScalar(0.01);
      this.root.parent.add(this.puddle);
    }
    if (this.puddle) {
      const m = this.puddle.material as THREE.MeshStandardMaterial;
      if (pee) {
        this.puddle.position.copy(this.root.position).addScaledVector(fwd, 0.75).setY(0.02);
        this.puddle.scale.setScalar(Math.min(0.5, this.puddle.scale.x + dt * 0.15));
        m.opacity = 0.55;
      } else {
        m.opacity -= dt * 0.05;
        if (m.opacity <= 0) {
          this.puddle.removeFromParent();
          m.dispose();
          this.puddle = undefined;
        }
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      const k = 1 - pt.life / pt.max;
      const mat = pt.mesh.material as THREE.Material & { opacity: number };
      if (pt.kind === 'drop') {
        pt.vel.y -= 9.8 * dt;
        pt.mesh.position.addScaledVector(pt.vel, dt);
        if (pt.mesh.position.y <= 0.02) pt.life = 0;
      } else if (pt.kind === 'heart') {
        pt.mesh.position.addScaledVector(pt.vel, dt);
        pt.mesh.scale.setScalar(0.22 + Math.sin(k * Math.PI) * 0.08);
        mat.opacity = 1 - k * k;
      } else {
        pt.mesh.position.addScaledVector(pt.vel, dt);
        pt.mesh.scale.setScalar(1 + k * 4);
        mat.opacity = 0.45 * (1 - k);
      }
      if (pt.life <= 0) {
        pt.mesh.removeFromParent();
        mat.dispose();
        this.particles.splice(i, 1);
      }
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
    for (const p of this.particles) p.mesh.removeFromParent();
    this.puddle?.removeFromParent();
    this.rig.dispose();
  }
}
