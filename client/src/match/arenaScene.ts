import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { rng, type Arena, type Obstacle } from '../../../shared/arena';

// Visual do terreno abandonado. As caixas de colisão (Obstacle) vêm do gerador compartilhado;
// aqui só desenhamos algo que caiba dentro delas.

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function tex(c: HTMLCanvasElement, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function groundTexture() {
  const rand = rng(5);
  const [c, ctx] = canvas(1024, 1024);
  ctx.fillStyle = '#6d6558';
  ctx.fillRect(0, 0, 1024, 1024);
  // manchas de terra, concreto e óleo
  for (let i = 0; i < 260; i++) {
    const g = 70 + Math.floor(rand() * 60);
    ctx.fillStyle = rand() < 0.15 ? `rgba(25,22,20,${0.15 + rand() * 0.25})` : `rgba(${g + 20},${g + 12},${g},${0.15 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(rand() * 1024, rand() * 1024, 10 + rand() * 90, 8 + rand() * 60, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // rachaduras
  ctx.strokeStyle = 'rgba(30,26,22,0.55)';
  for (let i = 0; i < 40; i++) {
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    let x = rand() * 1024;
    let y = rand() * 1024;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (rand() - 0.5) * 70;
      y += (rand() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // granulado
  for (let i = 0; i < 60000; i++) {
    const v = Math.floor(rand() * 255);
    ctx.fillStyle = `rgba(${v},${v},${v},${rand() * 0.12})`;
    ctx.fillRect(rand() * 1024, rand() * 1024, 2, 2);
  }
  return tex(c);
}

function rustTexture(base: string, seed: number) {
  const rand = rng(seed);
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(${110 + rand() * 60},${50 + rand() * 30},${20 + rand() * 20},${0.2 + rand() * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(rand() * 256, rand() * 256, 4 + rand() * 30, 3 + rand() * 18, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rand() * 0.15})`;
    ctx.fillRect(rand() * 256, rand() * 256, 1, 1);
  }
  return tex(c);
}

function corrugatedTexture(base: string, seed: number) {
  const rand = rng(seed);
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 16) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x, 0, 6, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + 8, 0, 3, 256);
  }
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(${120 + rand() * 50},${55 + rand() * 25},${25},${0.25 + rand() * 0.4})`;
    ctx.fillRect(rand() * 256, rand() * 256, 2 + rand() * 20, 2 + rand() * 40);
  }
  return tex(c);
}

function brickTexture() {
  const rand = rng(9);
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#8f8a80';
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 16) {
    for (let x = (y / 16) % 2 ? -16 : 0; x < 256; x += 32) {
      const r = 140 + rand() * 40;
      ctx.fillStyle = `rgb(${r},${r * 0.45},${r * 0.32})`;
      ctx.fillRect(x + 1, y + 1, 30, 14);
    }
  }
  // pichações
  const colors = ['#e63946', '#1d3a8a', '#2ec27e', '#ffd23f', '#9b5de5', '#ffffff'];
  for (let i = 0; i < 5; i++) {
    ctx.strokeStyle = colors[Math.floor(rand() * colors.length)];
    ctx.lineWidth = 4 + rand() * 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    let x = rand() * 256;
    let y = 60 + rand() * 140;
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (rand() - 0.3) * 40;
      y += (rand() - 0.5) * 40;
      ctx.quadraticCurveTo(x + 10, y - 20, x, y);
    }
    ctx.stroke();
  }
  return tex(c);
}

const std = (color: string, roughness = 0.85, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

export class ArenaScene {
  readonly scene = new THREE.Scene();
  readonly chests: { lid: THREE.Object3D; glow: THREE.Mesh; open: boolean; t: number }[] = [];

  constructor(readonly arena: Arena, seed: number) {
    const rand = rng(seed + 7);
    const half = arena.half;
    this.scene.fog = new THREE.Fog('#a99f8f', half * 1.2, half * 4.5);

    // Chão
    const groundTex = groundTexture();
    groundTex.repeat.set((half * 2 + 60) / 18, (half * 2 + 60) / 18);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 + 60, half * 2 + 60), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), std('#5f574b', 1));
    far.rotation.x = -Math.PI / 2;
    far.position.y = -0.05;
    this.scene.add(far);

    // Muro no perímetro: tijolo pichado, pilares de concreto e arame farpado no topo.
    const WALL_H = 4.2;
    const wallTex = brickTexture();
    const concrete = std('#9d978c', 0.95);
    const wire = std('#6b6f75', 0.5, 0.7);
    for (const [x, z, ry] of [[0, -half - 0.4, 0], [0, half + 0.4, 0], [-half - 0.4, 0, Math.PI / 2], [half + 0.4, 0, Math.PI / 2]] as const) {
      const len = half * 2 + 1.6;
      const t = wallTex.clone();
      t.needsUpdate = true;
      t.repeat.set(len / 4, WALL_H / 4);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.8), new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }));
      wall.position.set(x, WALL_H / 2, z);
      wall.rotation.y = ry;
      wall.receiveShadow = wall.castShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(len, 0.18, 1.0), concrete);
      cap.position.set(x, WALL_H + 0.09, z);
      cap.rotation.y = ry;
      this.scene.add(wall, cap);
      // pilares
      const pillars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, WALL_H + 0.4, 1.1), concrete, Math.ceil(len / 7) + 1);
      const m = new THREE.Matrix4();
      let n = 0;
      for (let s = -len / 2; s <= len / 2; s += 7) {
        const px = ry ? x : s;
        const pz = ry ? s : z;
        pillars.setMatrixAt(n++, m.makeTranslation(px, (WALL_H + 0.4) / 2, pz));
      }
      pillars.count = n;
      pillars.castShadow = pillars.receiveShadow = true;
      this.scene.add(pillars);
      // arame farpado: duas linhas finas sobre o muro
      for (const off of [-0.2, 0.2]) {
        const strand = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 4).rotateZ(Math.PI / 2), wire);
        strand.position.set(x + (ry ? off : 0), WALL_H + 0.45 + off * 0.5, z + (ry ? 0 : off));
        strand.rotation.y = ry;
        this.scene.add(strand);
      }
    }

    // Silhuetas de prédios abandonados ao longe
    const ruin = std('#7d776d', 1);
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2 + rand() * 0.1;
      const r = half + 30 + rand() * 60;
      const w = 10 + rand() * 25;
      const h = 8 + rand() * 40;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 10 + rand() * 15), ruin);
      b.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      b.rotation.y = -a;
      this.scene.add(b);
    }

    const textures = {
      car: ['#8a3b2e', '#3b5d7a', '#d9d4c7', '#4f6b3a', '#b88a2a', '#5a5a5a'].map((c, i) => rustTexture(c, 20 + i)),
      container: ['#9c2f22', '#2f5d8a', '#3f6e3a', '#b0702a'].map((c, i) => corrugatedTexture(c, 40 + i)),
      brick: brickTexture(),
    };
    for (const o of arena.obstacles) this.scene.add(this.buildObstacle(o, textures));

    // Baús
    for (const c of arena.chests) {
      const g = new THREE.Group();
      g.position.set(c.x, 0, c.z);
      g.rotation.y = rand() * Math.PI;
      const wood = std('#7a5230', 0.8);
      const band = std('#3a3f45', 0.4, 0.7);
      const body = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.55, 0.75, 2, 0.04), wood);
      body.position.y = 0.28;
      const strap = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.08, 0.77), band);
      strap.position.y = 0.45;
      const lid = new THREE.Group();
      lid.position.set(0, 0.56, -0.375);
      const lidMesh = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.18, 0.75, 2, 0.04), wood);
      lidMesh.position.set(0, 0.09, 0.375);
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.05), std('#d4a72c', 0.3, 0.9));
      lock.position.set(0, 0.0, 0.76);
      lid.add(lidMesh, lock);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 0.65), new THREE.MeshStandardMaterial({ color: '#ffe082', emissive: '#ffcc33', emissiveIntensity: 2.2 }));
      glow.position.y = 0.565;
      for (const m of [body, strap, lidMesh]) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
      g.add(body, strap, lid, glow);
      this.scene.add(g);
      this.chests[c.id] = { lid, glow, open: false, t: 0 };
    }
  }

  setChest(id: number, open: boolean) {
    const c = this.chests[id];
    if (c) c.open = open;
  }

  update(dt: number, time: number) {
    for (const c of this.chests) {
      if (!c) continue;
      c.t = Math.max(0, Math.min(1, c.t + (c.open ? dt : -dt) * 4));
      c.lid.rotation.x = -c.t * 1.9;
      c.glow.visible = !c.open && c.t < 0.05;
      (c.glow.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6 + Math.sin(time * 4) * 0.8;
    }
  }

  private buildObstacle(o: Obstacle, t: { car: THREE.Texture[]; container: THREE.Texture[]; brick: THREE.Texture }) {
    const g = new THREE.Group();
    g.position.set(o.x, 0, o.z);
    if (o.rot) g.rotation.y = Math.PI / 2;
    // Dimensões no espaço local (antes da rotação)
    const w = (o.rot ? o.hz : o.hx) * 2;
    const d = (o.rot ? o.hx : o.hz) * 2;
    const pick = <T>(list: T[]) => list[Math.floor(o.v * list.length) % list.length];
    const add = (mesh: THREE.Mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };

    switch (o.kind) {
      case 'car': {
        const paint = new THREE.MeshStandardMaterial({ map: pick(t.car), roughness: 0.7, metalness: 0.3 });
        const lower = add(new THREE.Mesh(new RoundedBoxGeometry(w, 0.7, d, 2, 0.12), paint));
        lower.position.y = 0.55;
        lower.rotation.z = (o.v - 0.5) * 0.08;
        const cabin = add(new THREE.Mesh(new RoundedBoxGeometry(w * 0.52, 0.55, d * 0.9, 2, 0.12), paint));
        cabin.position.set(-w * 0.05, 1.15, 0);
        const glass = add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.53, 0.38, d * 0.92), std('#1a2026', 0.2, 0.3)));
        glass.position.set(-w * 0.05, 1.17, 0);
        const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.25, 14).rotateX(Math.PI / 2);
        const tire = std('#151515', 0.9);
        for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          if (o.v > 0.6 && dx === 1 && dz === 1) continue; // roda faltando
          const wheel = add(new THREE.Mesh(wheelGeo, tire));
          wheel.position.set(dx * w * 0.32, 0.33, dz * (d / 2 - 0.1));
        }
        if (o.v < 0.3) g.rotation.z = 0.06; // carro torto
        break;
      }
      case 'bus': {
        const paint = new THREE.MeshStandardMaterial({ map: pick(t.car), color: '#e0c35a', roughness: 0.75 });
        const body = add(new THREE.Mesh(new RoundedBoxGeometry(w, o.h - 0.4, d, 2, 0.2), paint));
        body.position.y = (o.h - 0.4) / 2 + 0.4;
        const windows = add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.94, 0.8, d * 1.01), std('#1a2026', 0.25)));
        windows.position.y = o.h - 0.9;
        break;
      }
      case 'pallets': {
        const wood = std(o.v > 0.5 ? '#a07a4c' : '#8b6a40', 0.9);
        const layers = Math.max(1, Math.round(o.h / 0.15));
        for (let i = 0; i < layers; i++) {
          const p = add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.12, d * 0.98), wood));
          p.position.y = 0.06 + i * 0.15;
          p.rotation.y = (Math.sin(i * 12.9 + o.v * 10) * 0.08);
        }
        break;
      }
      case 'tires': {
        const rubber = std('#141414', 0.95);
        const stacks = w > 1.4 ? [[-w / 4, -d / 4], [w / 4, d / 4], [w / 4, -d / 4]] : [[0, 0]];
        for (const [sx, sz] of stacks) {
          const n = Math.max(1, Math.round(o.h / 0.24) - (sx > 0 ? 1 : 0));
          for (let i = 0; i < n; i++) {
            const tire = add(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.12, 8, 16).rotateX(Math.PI / 2), rubber));
            tire.position.set(sx, 0.12 + i * 0.24, sz);
          }
        }
        break;
      }
      case 'trash': {
        const colors = ['#1b1d20', '#253021', '#2a2a2a', '#3a3324'];
        for (let i = 0; i < 6; i++) {
          const bag = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.38 + (i % 3) * 0.08, 1), std(colors[i % colors.length], 0.4)));
          bag.position.set((Math.sin(i * 7.1 + o.v * 9) * w) / 3, 0.3 + (i > 3 ? 0.35 : 0), (Math.cos(i * 3.7 + o.v * 5) * d) / 3);
          bag.scale.y = 0.8;
        }
        break;
      }
      case 'dumpster': {
        const green = std('#2f5d3a', 0.6, 0.4);
        const body = add(new THREE.Mesh(new RoundedBoxGeometry(w, o.h - 0.15, d, 2, 0.05), green));
        body.position.y = (o.h - 0.15) / 2 + 0.1;
        const lid = add(new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), std('#1d2a20', 0.5)));
        lid.position.set(0, o.h, -0.1);
        lid.rotation.x = -0.25;
        break;
      }
      case 'container': {
        const m = new THREE.MeshStandardMaterial({ map: pick(t.container), roughness: 0.6, metalness: 0.4 });
        const box = add(new THREE.Mesh(new THREE.BoxGeometry(w, o.h, d), m));
        box.position.y = o.h / 2;
        break;
      }
      case 'barrier': {
        const concrete = std('#b5b0a6', 0.95);
        const base = add(new THREE.Mesh(new THREE.BoxGeometry(w, o.h * 0.4, d), concrete));
        base.position.y = o.h * 0.2;
        const top = add(new THREE.Mesh(new THREE.BoxGeometry(w, o.h * 0.6, d * 0.45), concrete));
        top.position.y = o.h * 0.7;
        const stripe = add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.3, 0.12, d * 0.47), std('#d62828', 0.7)));
        stripe.position.set(-w * 0.25, o.h * 0.8, 0);
        break;
      }
      case 'wall': {
        const brick = t.brick.clone();
        brick.needsUpdate = true;
        brick.repeat.set(w / 3, o.h / 3);
        const wall = add(new THREE.Mesh(new THREE.BoxGeometry(w, o.h, d), new THREE.MeshStandardMaterial({ map: brick, roughness: 0.95 })));
        wall.position.y = o.h / 2;
        // topo quebrado
        for (let i = 0; i < 4; i++) {
          const chunk = add(new THREE.Mesh(new THREE.BoxGeometry(0.5 + (i % 2) * 0.4, 0.3, d), new THREE.MeshStandardMaterial({ map: brick, roughness: 0.95 })));
          chunk.position.set(-w / 2 + 0.6 + i * (w / 4), o.h + 0.12, 0);
        }
        break;
      }
      case 'drums': {
        const colors = ['#1d4e89', '#a12c2c', '#3c3c3c', '#7a5a1e'];
        const positions = [[-0.33, -0.33], [0.33, -0.3], [-0.3, 0.33], [0.35, 0.35]];
        positions.forEach(([x, z], i) => {
          if (i === 3 && o.v < 0.5) return;
          const drum = add(new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, o.h, 14), std(colors[(i + Math.floor(o.v * 4)) % 4], 0.5, 0.5)));
          drum.position.set(x, o.h / 2, z);
        });
        break;
      }
    }
    return g;
  }
}
