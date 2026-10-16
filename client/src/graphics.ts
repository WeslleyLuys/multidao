import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export type Quality = 'low' | 'medium' | 'high';
export const QUALITY_LABEL: Record<Quality, string> = { low: 'Baixa', medium: 'Média', high: 'Alta' };
const QUALITY_KEY = 'multidao-quality';

export const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.42).normalize();

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function createStars() {
  const count = 1800;
  const pos = new Float32Array(count * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    // Pontos numa esfera, só no hemisfério de cima.
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const y = Math.abs(u) * 0.95 + 0.05;
    pos.set([r * Math.cos(th) * 900, y * 900, r * Math.sin(th) * 900], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -1;
  return p;
}

function createMoon() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 62);
  g.addColorStop(0, '#fffbe8');
  g.addColorStop(0.75, '#e6e2d0');
  g.addColorStop(0.85, 'rgba(230,226,208,0.35)');
  g.addColorStop(1, 'rgba(230,226,208,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(150,145,130,0.35)';
  for (const [x, y, r] of [[48, 50, 10], [76, 70, 14], [60, 84, 7], [82, 44, 6]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

export function defaultQuality(): Quality {
  try {
    const saved = localStorage.getItem(QUALITY_KEY) as Quality | null;
    if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
  } catch {}
  return matchMedia('(pointer: coarse)').matches ? 'low' : 'medium';
}

export class Graphics {
  readonly renderer: THREE.WebGLRenderer;
  readonly sun: THREE.DirectionalLight;
  quality: Quality;
  private sky: Sky;
  private composer?: EffectComposer;
  private gtao?: GTAOPass;
  private shadowTarget = new THREE.Vector3();
  private hemi: THREE.HemisphereLight;
  private renderPass?: RenderPass;

  constructor(canvas: HTMLCanvasElement, public scene: THREE.Scene, public camera: THREE.PerspectiveCamera) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft foi removido no three r18x

    // Céu físico com nuvens; também serve de mapa de ambiente (reflexos e luz indireta).
    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.cloudCoverage.value = 0.38;
    u.cloudDensity.value = 0.5;
    u.sunPosition.value.copy(SUN_DIR);
    scene.add(this.sky);

    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(4000);
    for (const k of Object.keys(u)) envSky.material.uniforms[k].value = u[k].value;
    envSky.material.uniforms.cloudCoverage.value = 0;
    envScene.add(envSky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(envScene).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    scene.fog = new THREE.Fog('#a9bccb', 110, 430);

    this.hemi = new THREE.HemisphereLight('#cfe3ff', '#5b5246', 0.5);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff1dc', 3.6);
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -32;
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 32;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target, this.stars, this.moon);

    this.quality = defaultQuality();
    this.applyQuality();
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Troca a cena/câmera renderizada (avenida <-> arena), levando céu, luzes e ambiente junto. */
  setScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera = this.camera) {
    if (scene === this.scene && camera === this.camera) return;
    scene.add(this.sky, this.hemi, this.sun, this.sun.target, this.stars, this.moon);
    scene.environment = this.scene.environment;
    scene.environmentIntensity = this.scene.environmentIntensity;
    if (!scene.fog) scene.fog = this.scene.fog;
    this.scene = scene;
    this.camera = camera;
    if (this.renderPass) {
      this.renderPass.scene = scene;
      this.renderPass.camera = camera;
    }
    if (this.gtao) {
      this.gtao.scene = scene;
      this.gtao.camera = camera;
    }
    this.resize();
  }

  setQuality(q: Quality) {
    this.quality = q;
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {}
    this.applyQuality();
  }

  private applyQuality() {
    const q = this.quality;
    const dpr = devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'low' ? Math.min(dpr, 1) : q === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2));

    const shadows = q !== 'low';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      // Materiais precisam recompilar quando sombras ligam/desligam.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
    this.sun.castShadow = shadows;
    const size = q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }

    if (q === 'high' && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(this.renderPass);
      this.gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
      this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1, samples: 12 });
      this.gtao.blendIntensity = 0.85;
      this.composer.addPass(this.gtao);
      this.composer.addPass(new OutputPass());
    } else if (q !== 'high' && this.composer) {
      this.composer.dispose();
      this.gtao?.dispose();
      this.composer = undefined;
      this.gtao = undefined;
      this.renderPass = undefined;
    }
    this.resize();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // A sombra cobre só a área em volta do foco, que acompanha o jogador.
  follow(target: THREE.Vector3) {
    // Encaixa no grid de texels para a sombra não "tremer" ao andar.
    const texel = 64 / this.sun.shadow.mapSize.x;
    this.shadowTarget.set(Math.round(target.x / texel) * texel, 0, Math.round(target.z / texel) * texel);
    this.sun.target.position.copy(this.shadowTarget);
    this.sun.position.copy(this.shadowTarget).addScaledVector(this.lightDir, 80);
  }

  // ---------- Dia e noite ----------
  /** 0 = dia pleno, 1 = noite fechada (o mundo usa para janelas e postes acesos). */
  night = 0;
  private sunDir = SUN_DIR.clone();
  private lightDir = SUN_DIR.clone();
  private stars = createStars();
  private moon = createMoon();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  /**
   * t em [0, 1): 0 = meia-noite, 0.25 = 6h, 0.5 = meio-dia, 0.75 = 18h.
   * O sol faz um arco de leste a oeste; à noite a luz vem da lua (do lado oposto).
   */
  setTimeOfDay(t: number) {
    const ang = (t - 0.25) * Math.PI * 2;
    this.sunDir.set(Math.cos(ang), Math.sin(ang), 0.35).normalize();
    const elev = this.sunDir.y;
    const day = smooth(-0.1, 0.18, elev);
    const golden = (1 - smooth(0.02, 0.32, Math.abs(elev))) * smooth(-0.12, 0.0, elev); // nascer/pôr do sol
    this.night = 1 - day;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.rayleigh.value = 1.4 + golden * 1.4;
    u.turbidity.value = 4.5 + golden * 3.5;
    u.mieCoefficient.value = 0.004 + golden * 0.006;
    u.cloudCoverage.value = 0.38 - this.night * 0.15;

    // Luz principal: sol de dia, lua azulada à noite.
    const moonDir = new THREE.Vector3(-this.sunDir.x, Math.max(0.35, -this.sunDir.y), -this.sunDir.z).normalize();
    this.lightDir.copy(day > 0.15 ? this.sunDir : moonDir);
    if (day > 0.15) {
      this.sun.color.copy(this.c1.set('#fff1dc')).lerp(this.c2.set('#ff9a52'), golden);
      this.sun.intensity = 3.6 * day;
    } else {
      this.sun.color.set('#9fb4ff');
      this.sun.intensity = 0.55;
    }
    this.hemi.intensity = 0.14 + 0.42 * day;
    this.hemi.color.copy(this.c1.set('#1d2b4d')).lerp(this.c2.set('#cfe3ff'), day);
    this.hemi.groundColor.copy(this.c1.set('#1a1814')).lerp(this.c2.set('#5b5246'), day);
    this.scene.environmentIntensity = 0.07 + 0.5 * day;
    this.renderer.toneMappingExposure = 0.62 + this.night * 0.28;

    // Neblina acompanha a cor do céu no horizonte.
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(this.c1.set('#0b1220')).lerp(this.c2.set('#a9bccb'), day).lerp(this.c2.set('#c98e6a'), golden * 0.6);
    }

    (this.stars.material as THREE.PointsMaterial).opacity = smooth(0.35, 0.9, this.night);
    this.stars.visible = this.night > 0.3;
    const md = new THREE.Vector3(-this.sunDir.x, -this.sunDir.y, -this.sunDir.z);
    this.moon.userData.dir = md;
    this.moon.visible = md.y > -0.05;
  }

  /** Desligado nos eventos: a arma em primeira pessoa não combina com o GTAO. */
  aoEnabled = true;

  /** Cena desenhada por cima de tudo (arma em primeira pessoa), com o depth limpo antes. */
  overlay?: { scene: THREE.Scene; camera: THREE.Camera };

  render(timeMs: number) {
    // Nuvens: tempo em "vai e volta" (0..600 s) — números pequenos não estouram a precisão do shader
    // (com milissegundos crescendo sem parar, as nuvens quebravam, principalmente no celular).
    const s = timeMs / 1000;
    this.sky.material.uniforms.time.value = (600 - Math.abs((s % 1200) - 600)) * 40;
    // Estrelas e lua acompanham a câmera (parecem "no infinito").
    this.stars.position.copy(this.camera.position);
    this.stars.rotation.y = s * 0.002;
    const md = this.moon.userData.dir as THREE.Vector3 | undefined;
    if (md) {
      this.moon.position.copy(this.camera.position).addScaledVector(md, 900);
      this.moon.lookAt(this.camera.position);
    }
    if (this.composer && this.aoEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    if (this.overlay) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.overlay.scene, this.overlay.camera);
      this.renderer.autoClear = true;
    }
  }
}
