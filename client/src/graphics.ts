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

  constructor(canvas: HTMLCanvasElement, readonly scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
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

    scene.add(new THREE.HemisphereLight('#cfe3ff', '#5b5246', 0.5));
    this.sun = new THREE.DirectionalLight('#fff1dc', 3.6);
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -32;
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 32;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);

    this.quality = defaultQuality();
    this.applyQuality();
    addEventListener('resize', () => this.resize());
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
      this.composer.addPass(new RenderPass(this.scene, this.camera));
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
    this.sun.position.copy(this.shadowTarget).addScaledVector(SUN_DIR, 80);
  }

  render(timeMs: number) {
    this.sky.material.uniforms.time.value = timeMs;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
