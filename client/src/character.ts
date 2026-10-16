import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CLOTH_COLORS, HAIR_COLORS, OUTFIT, PRINTS, SKIN_TONES, SLOTS, type Print } from '../../shared/config';
import { DEFAULT_LOOK, type Look } from '../../shared/look';

// ---------------------------------------------------------------------------
// Modelo base (client/public/models/personagem.glb, exportado de assets-src/personagem/BASEmodel.blend)
// O modelo tem ~4,8 unidades de altura; o jogo usa metros.
// ---------------------------------------------------------------------------
export const HEIGHT = 1.75;
let template: THREE.SkinnedMesh;
export let MODEL_SCALE = 1;

// O GLTFLoader remove caracteres reservados dos nomes ("upperarm.L" vira "upperarmL").
// Normalizamos tudo do mesmo jeito para poder usar os nomes originais do Blender no código.
const norm = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '');

// Grupo de cada osso: cabeça, braço ou perna (o resto é tronco).
function groupOf(bone: string): 0 | 1 | 2 | -1 {
  const b = norm(bone).replace(/(L|R)$/, '');
  if (b === 'neck' || b === 'head') return 0;
  if (/^(upperarm|lowerarm|hand|upfinger\d?|midfinger\d?|lowerfinger\d?|tooseup|toosemid|lowertoose)$/.test(b)) return 1;
  if (/^(upperleg|lowerleg|foot|toose)$/.test(b)) return 2;
  return -1;
}

const REST = new Map<string, { local: THREE.Quaternion; parent: THREE.Quaternion; parentInv: THREE.Quaternion }>();

// Articulações na pose de repouso (unidades do modelo), compartilhadas por todos os materiais.
const JOINTS = {
  uShoulder: { value: new THREE.Vector3() },
  uElbow: { value: new THREE.Vector3() },
  uWrist: { value: new THREE.Vector3() },
  uHip: { value: new THREE.Vector3() },
  uKnee: { value: new THREE.Vector3() },
  uAnkle: { value: new THREE.Vector3() },
  uNeck: { value: new THREE.Vector3() },
  uHeadC: { value: new THREE.Vector3() },
  uWaist: { value: 0 },
  uChestY: { value: 0 },
  uScale: { value: 1 },
};

const PRINT_TEX = new Map<Print, THREE.Texture>();

export async function loadCharacter(url = '/models/personagem.glb') {
  const [gltf] = await Promise.all([new GLTFLoader().loadAsync(url), loadPrints()]);
  gltf.scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !template) template = o as THREE.SkinnedMesh;
  });
  if (!template) throw new Error('personagem.glb sem SkinnedMesh');

  const geo = template.geometry;
  geo.computeBoundingBox();
  MODEL_SCALE = HEIGHT / (geo.boundingBox!.max.y - geo.boundingBox!.min.y);
  JOINTS.uScale.value = MODEL_SCALE;

  // Peso de cada grupo (cabeça, braço, perna) por vértice. Interpolado na GPU,
  // isso dá fronteiras suaves entre tronco/braço/perna em vez do serrilhado dos triângulos.
  const joints = geo.attributes.skinIndex as THREE.BufferAttribute;
  const weights = geo.attributes.skinWeight as THREE.BufferAttribute;
  const bones = template.skeleton.bones;
  const groups = bones.map((b) => groupOf(b.name));
  const groupW = new Float32Array(joints.count * 3);
  for (let i = 0; i < joints.count; i++) {
    for (let k = 0; k < 4; k++) {
      const g = groups[joints.getComponent(i, k)];
      if (g >= 0) groupW[i * 3 + g] += weights.getComponent(i, k);
    }
  }
  geo.setAttribute('groupW', new THREE.BufferAttribute(groupW, 3));

  // Pose de repouso de cada osso e posições das articulações.
  gltf.scene.updateMatrixWorld(true);
  const tmp = new THREE.Quaternion();
  const byName = new Map(bones.map((b) => [norm(b.name), b]));
  for (const b of bones) {
    const parentQ = b.parent ? b.parent.getWorldQuaternion(tmp).clone() : new THREE.Quaternion();
    REST.set(norm(b.name), { local: b.quaternion.clone(), parent: parentQ, parentInv: parentQ.clone().invert() });
  }
  const at = (name: string, out: THREE.Vector3) => {
    const b = byName.get(norm(name));
    if (b) b.getWorldPosition(out);
    out.x = Math.abs(out.x);
  };
  at('upperarm.L', JOINTS.uShoulder.value);
  at('lowerarm.L', JOINTS.uElbow.value);
  at('hand.L', JOINTS.uWrist.value);
  at('upperleg.L', JOINTS.uHip.value);
  at('lowerleg.L', JOINTS.uKnee.value);
  at('foot.L', JOINTS.uAnkle.value);
  at('neck', JOINTS.uNeck.value);
  at('head', JOINTS.uHeadC.value);
  JOINTS.uHeadC.value.x = 0;
  JOINTS.uHeadC.value.y += 0.225; // centro do crânio fica acima da base do osso "head"
  JOINTS.uWaist.value = JOINTS.uHip.value.y + 0.27;
  JOINTS.uChestY.value = JOINTS.uNeck.value.y - 0.62;
}

// ---------------------------------------------------------------------------
// Estampas VIP (texturas). A bandeira do Brasil vem do SVG oficial (domínio público).
// ---------------------------------------------------------------------------
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function canvasTex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export let BRAZIL_FLAG: HTMLImageElement | undefined;

export function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.4 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

async function loadPrints() {
  try {
    BRAZIL_FLAG = await loadImage('/vip/brasil.svg');
  } catch {
    BRAZIL_FLAG = undefined;
  }
  for (const id of PRINTS) {
    if (id === 'none') continue;
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d')!;
    if (id === 'flag-br' && BRAZIL_FLAG) {
      ctx.drawImage(BRAZIL_FLAG, 16, 256 - 172, 480, 336); // proporção oficial 10:7
    } else if (id === 'lula') {
      // Selo vermelho com estrela e nome
      ctx.fillStyle = '#c8102e';
      ctx.beginPath();
      ctx.roundRect(36, 60, 440, 392, 48);
      ctx.fill();
      drawStar(ctx, 256, 190, 92, '#ffffff');
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 132px system-ui, sans-serif';
      ctx.fillText('LULA', 256, 370);
    } else if (id === 'bolsonaro') {
      // Selo verde com borda amarela, bandeira e nome
      ctx.fillStyle = '#009c3b';
      ctx.beginPath();
      ctx.roundRect(24, 92, 464, 328, 40);
      ctx.fill();
      ctx.lineWidth = 16;
      ctx.strokeStyle = '#ffdf00';
      ctx.stroke();
      if (BRAZIL_FLAG) ctx.drawImage(BRAZIL_FLAG, 186, 128, 140, 98);
      ctx.fillStyle = '#ffdf00';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 80px system-ui, sans-serif';
      ctx.fillText('BOLSONARO', 256, 320, 420);
    } else if (id === 'br-10') {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 92px system-ui, sans-serif';
      ctx.lineWidth = 10;
      ctx.strokeStyle = '#002776';
      ctx.fillStyle = '#009c3b';
      ctx.strokeText('BRASIL', 256, 110);
      ctx.fillText('BRASIL', 256, 110);
      ctx.font = '900 260px system-ui, sans-serif';
      ctx.lineWidth = 16;
      ctx.strokeText('10', 256, 330);
      ctx.fillText('10', 256, 330);
    }
    PRINT_TEX.set(id, canvasTex(c));
  }
}

// ---------------------------------------------------------------------------
// Shader de roupa: pinta cada parte do corpo com estilo, cor, estampa e cor do detalhe.
// Usa a posição de repouso (antes do skinning), então a roupa acompanha o corpo animado.
// ---------------------------------------------------------------------------
const OUTFIT_GLSL = /* glsl */ `
  varying vec3 vRest;
  varying vec3 vGroup;
  uniform float uScale;
  uniform vec3 uShoulder, uElbow, uWrist, uHip, uKnee, uAnkle, uNeck, uHeadC;
  uniform float uWaist, uChestY;
  float outRough = 0.8;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float sdStar(vec2 p, float r, float rf) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-k1.x, k1.y);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
  }

  // 0: cor principal, 1: cor do detalhe, 2: tom escuro (camuflado). part: 0 cabeça, 1 tronco, 2 pernas, 3 pés.
  float patternMask(float pat, vec3 m, int part) {
    if (pat < 0.5) return 0.0;
    if (pat < 1.5) return step(0.5, fract(m.y * 11.0));
    if (pat < 2.5) return step(0.5, fract((m.x + m.z * 0.8) * 11.0));
    if (pat < 3.5) {
      if (part == 2) return step(0.105, abs(m.x)) * step(abs(m.x), 0.14);
      return step(abs(m.x * 0.9 - (m.y - 1.22)), 0.045);
    }
    if (pat < 4.5) {
      if (part == 1) return (m.z > 0.0 && sdStar(vec2(m.x, m.y - 1.24), 0.085, 0.45) < 0.0) ? 1.0 : 0.0;
      vec2 c = vec2(m.x + m.z, m.y) * 14.0;
      return sdStar(fract(c) - 0.5, 0.32, 0.45) < 0.0 ? 1.0 : 0.0;
    }
    if (pat < 5.5) { vec3 c = floor(m * 14.0); return mod(c.x + c.y + c.z, 2.0); }
    if (pat < 6.5) return step(length(fract(m * 13.0) - 0.5), 0.24);
    float n = noise(m * 9.0) + 0.5 * noise(m * 23.0);
    return n > 0.95 ? 2.0 : n > 0.72 ? 1.0 : 0.0;
  }

  // Tecido: estampa + leve variação de trama.
  vec3 cloth(vec3 base, vec3 acc, float pat, vec3 m, int part) {
    float k = patternMask(pat, m, part);
    vec3 c = k > 1.5 ? base * 0.55 : mix(base, acc, k);
    outRough = 0.88;
    return c * (0.94 + 0.06 * noise(m * 70.0));
  }

  // Posição ao longo do braço: 0 ombro, 1 cotovelo, 2 pulso (>2 = mão).
  float armT(vec3 P) {
    vec3 se = uElbow - uShoulder;
    float t1 = dot(P - uShoulder, se) / dot(se, se);
    if (t1 <= 1.0) return t1;
    vec3 ew = uWrist - uElbow;
    return 1.0 + dot(P - uElbow, ew) / dot(ew, ew);
  }
  // Posição ao longo da perna: <0 acima do quadril, 1 joelho, 2 tornozelo (>2 = pé).
  float legT(float y) {
    if (y > uHip.y) return (uHip.y - y) / (uHip.y - uKnee.y);
    if (y > uKnee.y) return (uHip.y - y) / (uHip.y - uKnee.y);
    if (y > uAnkle.y) return 1.0 + (uKnee.y - y) / (uKnee.y - uAnkle.y);
    return 2.0 + (uAnkle.y - y) / max(uAnkle.y, 0.01);
  }

  vec3 skin() { outRough = 0.55; return OUT_SKIN; }
  vec3 hem(vec3 c, float t, float edge) { return t > edge - 0.05 ? c * 0.8 : c; }

  vec3 shoes(vec3 p, vec3 m, float feetS) {
    if (feetS > 2.5) return skin();                                            // descalço
    if (feetS > 1.5) {                                                          // chinelo
      if (p.y < 0.055) { outRough = 0.6; return OUT_C3; }
      if (p.y < 0.14 && abs(abs(p.x) - uAnkle.x) < 0.035 && p.z > uAnkle.z + 0.08) { outRough = 0.5; return OUT_A3; }
      return skin();
    }
    if (p.y < 0.065) { outRough = 0.6; return feetS > 0.5 ? OUT_C3 * 0.35 : OUT_A3; } // sola
    vec3 c = cloth(OUT_C3, OUT_A3, OUT_PAT.w, m, 3);
    outRough = feetS > 0.5 ? 0.4 : 0.6;
    return c;
  }

  vec3 outfitColor() {
    vec3 p = vRest;
    vec3 m = vRest * uScale;
    vec3 P = vec3(abs(p.x), p.y, p.z);
    float headS = OUT_STYLE.x, torsoS = OUT_STYLE.y, legsS = OUT_STYLE.z, feetS = OUT_STYLE.w;

    // ----- Cabeça e pescoço -----
    if (vGroup.x > 0.5) {
      vec3 h = p - uHeadC;
      if (h.y < -0.24) return skin(); // pescoço
      if (h.z > 0.17) {
        vec2 e = vec2(abs(h.x) - 0.1, h.y);
        float d = length(e * vec2(1.0, 0.8));
        if (d < 0.026) { outRough = 0.15; return d < 0.011 && e.x > 0.0 && h.y > 0.004 ? vec3(0.9) : vec3(0.04); }
        if (abs(e.x) < 0.05 && abs(h.y - 0.075 + abs(e.x) * 0.2) < 0.012) return OUT_HAIR * 0.85;
        if (abs(h.x) < 0.045 && abs(h.y + 0.135) < 0.008) return OUT_SKIN * 0.72;
      }
      float hairLine = mix(0.12, -0.17, clamp(-h.z * 3.5, 0.0, 1.0));
      bool hair = h.y > hairLine;
      vec3 hairC = OUT_HAIR * (0.85 + 0.15 * noise(p * 40.0));
      if (headS < 0.5) { outRough = 0.7; return hair ? hairC : skin(); }       // cabelo
      if (headS < 1.5) return skin();                                         // careca
      if (headS < 2.5) {                                                      // boné
        if (h.y > 0.14) { vec3 c = cloth(OUT_C0, OUT_A0, OUT_PAT.x, m, 0); return h.y < 0.17 ? c * 0.82 : c; }
        return hair ? hairC : skin();
      }
      if (headS < 3.5) {                                                      // gorro
        if (h.y > 0.03) { vec3 c = cloth(OUT_C0, OUT_A0, OUT_PAT.x, m, 0); return h.y < 0.1 ? c * 0.85 : c; }
        return skin();
      }
      if (abs(h.y - 0.13) < 0.05) return cloth(OUT_C0, OUT_A0, OUT_PAT.x, m, 0); // bandana
      return hair ? hairC : skin();
    }

    // ----- Braços -----
    if (vGroup.y > 0.5) {
      float t = armT(P);
      if (t >= 2.0) return skin();                                             // mão
      float sleeve = torsoS < 0.5 ? 0.5 : torsoS < 1.5 ? -0.2 : 1.97;
      if (t >= sleeve) return skin();
      vec3 c = cloth(OUT_C1, OUT_A1, OUT_PAT.y, m, 1);
      if (torsoS > 2.5 && t > 1.82) return OUT_A1;                             // punho da jaqueta
      return hem(c, t, sleeve);
    }

    // ----- Pernas e pés -----
    if (vGroup.z > 0.5) {
      float t = legT(p.y);
      if (t > 1.97) return shoes(p, m, feetS);
      if (feetS > 0.5 && feetS < 1.5 && t > 1.45) return shoes(p, m, feetS);   // cano da bota
      float end = legsS < 0.5 ? 1.95 : legsS < 1.5 ? 0.85 : 0.38;
      if (t >= end) return skin();
      return hem(cloth(OUT_C2, OUT_A2, OUT_PAT.z, m, 2), t, end);
    }

    // ----- Tronco -----
    if (p.y < uWaist) {
      vec3 c = cloth(OUT_C2, OUT_A2, OUT_PAT.z, m, 2);
      if (p.y > uWaist - 0.07) { outRough = 0.4; return OUT_C2 * 0.4; }        // cinto
      return c;
    }
    float tank = torsoS > 0.5 && torsoS < 1.5 ? 1.0 : 0.0;
    float collar = (p.z > 0.0 ? uNeck.y - 0.17 - tank * 0.12 : uNeck.y - 0.06) + 2.6 * P.x * P.x;
    if (p.y > collar) return skin();                                           // gola
    if (tank > 0.5 && P.x > 0.3 && p.y > uShoulder.y - 0.42) return skin();    // cava da regata
    if (torsoS > 2.5 && p.z > 0.0 && P.x < 0.03) { outRough = 0.3; return OUT_A1; } // zíper
    vec3 c = cloth(OUT_C1, OUT_A1, OUT_PAT.y, m, 1);
    if (p.y > collar - 0.05) c *= 0.82;                                        // acabamento da gola
    if (p.y < uWaist + 0.06) c *= 0.85;                                        // barra
    #ifdef HAS_PRINT
    if (uPrintOn > 0.5 && p.z > 0.0) {
      vec2 uv = vec2(p.x / 0.6 + 0.5, (p.y - uChestY) / 0.6 + 0.5);
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        vec4 t = texture2D(uPrint, uv);
        c = mix(c, t.rgb, t.a);
      }
    }
    #endif
    return c;
  }
`;

export interface OutfitUniforms {
  uSkin: { value: THREE.Color };
  uHair: { value: THREE.Color };
  uCol: { value: THREE.Color[] };
  uAcc: { value: THREE.Color[] };
  uStyle: { value: THREE.Vector4 };
  uPat: { value: THREE.Vector4 };
  uPrint: { value: THREE.Texture | null };
  uPrintOn: { value: number };
}

function outfitMaterial(uniforms: Partial<OutfitUniforms>, crowd: boolean) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, JOINTS, uniforms);
    const defs = crowd
      ? `
        flat varying vec3 vSkin; flat varying vec3 vHair; flat varying vec3 vC1; flat varying vec3 vC2; flat varying vec3 vC3; flat varying float vHeadS;
        #define OUT_SKIN vSkin
        #define OUT_HAIR vHair
        #define OUT_C0 vC1
        #define OUT_A0 vC1
        #define OUT_C1 vC1
        #define OUT_A1 vC1
        #define OUT_C2 vC2
        #define OUT_A2 vC2
        #define OUT_C3 vC3
        #define OUT_A3 vec3(0.92)
        #define OUT_STYLE vec4(vHeadS, 0.0, 0.0, 0.0)
        #define OUT_PAT vec4(0.0)
      `
      : `
        uniform vec3 uSkin; uniform vec3 uHair; uniform vec3 uCol[4]; uniform vec3 uAcc[4]; uniform vec4 uStyle; uniform vec4 uPat;
        uniform sampler2D uPrint; uniform float uPrintOn;
        #define HAS_PRINT
        #define OUT_SKIN uSkin
        #define OUT_HAIR uHair
        #define OUT_C0 uCol[0]
        #define OUT_A0 uAcc[0]
        #define OUT_C1 uCol[1]
        #define OUT_A1 uAcc[1]
        #define OUT_C2 uCol[2]
        #define OUT_A2 uAcc[2]
        #define OUT_C3 uCol[3]
        #define OUT_A3 uAcc[3]
        #define OUT_STYLE uStyle
        #define OUT_PAT uPat
      `;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 groupW;
        varying vec3 vGroup;
        varying vec3 vRest;
        ${crowd ? 'attribute vec3 restPos; attribute vec3 iSkin; attribute vec3 iHair; attribute vec3 iC1; attribute vec3 iC2; attribute vec3 iC3; attribute float iHeadS;\nflat varying vec3 vSkin; flat varying vec3 vHair; flat varying vec3 vC1; flat varying vec3 vC2; flat varying vec3 vC3; flat varying float vHeadS;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGroup = groupW;
        vRest = ${crowd ? 'restPos' : 'position'};
        ${crowd ? 'vSkin = iSkin; vHair = iHair; vC1 = iC1; vC2 = iC2; vC3 = iC3; vHeadS = iHeadS;' : ''}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${defs}\n${OUTFIT_GLSL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( outfitColor(), opacity );')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = outRough;');
  };
  material.customProgramCacheKey = () => (crowd ? 'outfit2-crowd' : 'outfit2');
  return material;
}

const color = (hex: string) => new THREE.Color(hex);

export function setOutfit(u: OutfitUniforms, look: Look) {
  u.uSkin.value.set(SKIN_TONES[look.skin] ?? SKIN_TONES[0]);
  u.uHair.value.set(HAIR_COLORS[look.hair] ?? HAIR_COLORS[0]);
  SLOTS.forEach((slot, i) => {
    const piece = look[slot];
    u.uCol.value[i].set(CLOTH_COLORS[piece.c] ?? CLOTH_COLORS[0]);
    u.uAcc.value[i].set(CLOTH_COLORS[piece.a] ?? CLOTH_COLORS[0]);
  });
  u.uStyle.value.set(look.head.s, look.torso.s, look.legs.s, look.feet.s);
  u.uPat.value.set(look.head.p, look.torso.p, look.legs.p, look.feet.p);
  const print = PRINT_TEX.get(PRINTS[look.print] ?? 'none') ?? null;
  u.uPrint.value = print;
  u.uPrintOn.value = print ? 1 : 0;
}

export function isCap(look: Look) {
  return OUTFIT.head[look.head.s] === 'cap';
}

// ---------------------------------------------------------------------------
// Instância animável do personagem
// ---------------------------------------------------------------------------
export class CharacterRig {
  readonly container = new THREE.Group(); // escala unidades do modelo -> metros
  readonly mesh: THREE.SkinnedMesh;
  readonly uniforms: OutfitUniforms;
  private bones = new Map<string, THREE.Bone>();
  private q = new THREE.Quaternion();
  private qa = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(look: Look) {
    this.uniforms = {
      uSkin: { value: color('#ffffff') },
      uHair: { value: color('#000000') },
      uCol: { value: [0, 1, 2, 3].map(() => color('#ffffff')) },
      uAcc: { value: [0, 1, 2, 3].map(() => color('#ffffff')) },
      uStyle: { value: new THREE.Vector4() },
      uPat: { value: new THREE.Vector4() },
      uPrint: { value: null },
      uPrintOn: { value: 0 },
    };
    setOutfit(this.uniforms, look);

    const root = cloneSkinned(template.parent ?? template) as THREE.Object3D;
    let mesh: THREE.SkinnedMesh | undefined;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
      if ((o as THREE.Bone).isBone) this.bones.set(norm(o.name), o as THREE.Bone);
    });
    this.mesh = mesh!;
    this.mesh.material = outfitMaterial(this.uniforms, false);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // o bounding da pose em "A" não acompanha a animação
    this.container.scale.setScalar(MODEL_SCALE);
    this.container.add(root);
  }

  bone(name: string) {
    return this.bones.get(norm(name));
  }

  /** Volta todos os ossos para a pose de repouso. */
  reset() {
    for (const [name, b] of this.bones) {
      const r = REST.get(name);
      if (r) b.quaternion.copy(r.local);
    }
  }

  /**
   * Gira um osso por ângulos (x: frente/trás, y: girar, z: abrir/fechar lateralmente)
   * definidos no espaço do modelo, relativos ao pai em repouso.
   */
  rotate(name: string, x: number, y: number, z: number) {
    const key = norm(name);
    const b = this.bones.get(key);
    const r = REST.get(key);
    if (!b || !r) return;
    // Ordem: primeiro abre/fecha (z), depois frente/trás (x), por fim gira (y).
    this.qa.setFromEuler(this.e.set(x, y, z, 'YXZ'));
    // local = P⁻¹ · Δ · P · Lrest
    this.q.copy(r.parentInv).multiply(this.qa).multiply(r.parent).multiply(r.local);
    b.quaternion.copy(this.q);
  }

  dispose() {
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Geometria estática posada (para a multidão instanciada).
// ---------------------------------------------------------------------------
export function bakePose(pose: (rig: CharacterRig) => void): THREE.BufferGeometry {
  const rig = new CharacterRig(DEFAULT_LOOK);
  rig.reset();
  pose(rig);
  rig.container.updateMatrixWorld(true);
  rig.mesh.skeleton.update();

  const src = rig.mesh.geometry;
  const count = src.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(src.attributes.position as THREE.BufferAttribute, i);
    rig.mesh.applyBoneTransform(i, v);
    v.applyMatrix4(rig.mesh.matrixWorld); // já em metros (o container aplica a escala)
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(src.index);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('restPos', src.attributes.position);
  g.setAttribute('groupW', src.attributes.groupW);
  g.computeVertexNormals();
  rig.dispose();
  return g;
}

export function crowdMaterial() {
  return outfitMaterial({}, true);
}

export function printTexture(id: Print) {
  return PRINT_TEX.get(id);
}
