import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GAME, TEAMS, TRUCKS, WORLD } from '../../shared/config';
import { mat } from './avatar';
import { AmbientCrowd } from './crowd';
import {
  FACADE_CELL, asphaltTexture, facadeTexture, ledPanelTexture, paverTexture, rng, storefrontTexture,
  type FacadeStyle,
} from './textures';

const L = WORLD.halfLength;
const ROAD = WORLD.roadHalfWidth;
const SIDEWALK_W = WORLD.halfWidth - ROAD + 2; // calçada vai até a fachada dos prédios
const FRONT = ROAD + SIDEWALK_W; // z da fachada
const EXTENT = L + 140; // a cidade continua além das barreiras

export interface World {
  update(time: number, dt: number): void;
  setDetail(high: boolean): void;
}

export function buildWorld(scene: THREE.Scene): World {
  const rand = rng(1337);

  // ---------- Chão ----------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), mat('#6b6f68', 1));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  scene.add(ground);

  const asphalt = asphaltTexture();
  asphalt.repeat.set((EXTENT * 2) / 12, (ROAD * 2) / 12);
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(EXTENT * 2, ROAD * 2),
    new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  scene.add(road);

  const pavers = paverTexture();
  pavers.repeat.set((EXTENT * 2) / 4, SIDEWALK_W / 4);
  const sidewalkMat = new THREE.MeshStandardMaterial({ map: pavers, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(EXTENT * 2, 0.16, SIDEWALK_W), sidewalkMat);
    sw.position.set(0, 0.08, side * (ROAD + SIDEWALK_W / 2));
    sw.receiveShadow = true;
    const curb = new THREE.Mesh(new THREE.BoxGeometry(EXTENT * 2, 0.2, 0.3), mat('#d9d6cc', 0.8));
    curb.position.set(0, 0.1, side * (ROAD + 0.15));
    curb.receiveShadow = true;
    scene.add(sw, curb);
  }

  addRoadMarkings(scene);

  // ---------- Prédios ----------
  const styles: FacadeStyle[] = ['concrete', 'brick', 'office', 'glass'];
  const facades = styles.map((s, i) => facadeTexture(s, 100 + i));
  const facadeMats = styles.map((s, i) =>
    s === 'glass'
      ? new THREE.MeshStandardMaterial({ map: facades[i], metalness: 0.85, roughness: 0.12, envMapIntensity: 1.6 })
      : new THREE.MeshStandardMaterial({ map: facades[i], roughness: 0.85 }),
  );
  const roofMat = mat('#7a7d80', 0.95);
  const shops = Array.from({ length: 8 }, (_, i) => storefrontTexture(500 + i));
  const shopMats = shops.map((s) => new THREE.MeshStandardMaterial({ map: s.map, roughness: 0.4, emissive: '#ffffff', emissiveMap: s.map, emissiveIntensity: 0.12 }));

  for (const side of [-1, 1]) {
    let x = -EXTENT;
    while (x < EXTENT) {
      const w = 14 + rand() * 18;
      const d = 16 + rand() * 16;
      const roll = rand();
      const style = roll < 0.35 ? 0 : roll < 0.55 ? 1 : roll < 0.8 ? 2 : 3;
      const floors = style === 3 ? 14 + Math.floor(rand() * 12) : 4 + Math.floor(rand() * rand() * 16);
      const h = 4.5 + floors * 3.5;
      buildBuilding(scene, x + w / 2, side, w, d, h, facadeMats[style], roofMat, style !== 3 ? shopMats[Math.floor(rand() * shopMats.length)] : undefined, shops, rand);
      x += w + 0.6 + rand() * 2;
    }
  }

  // ---------- Árvores e postes ----------
  addTrees(scene, rand);
  addStreetLights(scene);

  // Barreiras nas pontas da avenida
  const barrierGeo = new RoundedBoxGeometry(0.5, 1.05, 2, 2, 0.08);
  for (const side of [-1, 1]) {
    for (let i = 0, z = -WORLD.halfWidth; z <= WORLD.halfWidth; i++, z += 2.2) {
      const barrier = new THREE.Mesh(barrierGeo, mat(i % 2 ? '#f2efe6' : '#e2574c', 0.6));
      barrier.position.set(side * (L + 0.5), 0.52, z);
      barrier.castShadow = barrier.receiveShadow = true;
      scene.add(barrier);
    }
  }

  const trucks = TRUCKS.map((t) => buildTruck(scene, t.x, t.z, TEAMS[t.team].color, TEAMS[t.team].accent));
  const crowd = new AmbientCrowd(scene, rand);
  const confetti = new Confetti(scene, rand);

  return {
    update(time, dt) {
      crowd.update(time);
      confetti.update(dt);
      for (const t of trucks) t.update(time);
    },
    setDetail(high) {
      confetti.mesh.visible = high;
    },
  };
}

function boxUV(geometry: THREE.BoxGeometry, w: number, h: number, d: number) {
  // Escala as UVs das faces laterais em metros / tamanho da célula da textura.
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const faceW = [d, d, w, w, w, w];
  for (let face = 0; face < 6; face++) {
    if (face === 2 || face === 3) continue;
    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i;
      uv.setXY(idx, (uv.getX(idx) * faceW[face]) / FACADE_CELL.w, (uv.getY(idx) * h) / FACADE_CELL.h);
    }
  }
  uv.needsUpdate = true;
}

function buildBuilding(
  scene: THREE.Scene, cx: number, side: number, w: number, d: number, h: number,
  facade: THREE.Material, roof: THREE.Material, shop: THREE.Material | undefined,
  shops: { awning: string }[], rand: () => number,
) {
  const g = new THREE.Group();
  const z = side * (FRONT + d / 2);
  g.position.set(cx, 0, z);

  const geo = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
  boxUV(geo, w, h, d);
  const body = new THREE.Mesh(geo, [facade, facade, roof, roof, facade, facade]);
  body.receiveShadow = true;
  body.castShadow = true;
  g.add(body);

  // Platibanda
  const parapet = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.6, d + 0.3), mat('#bdb8ad', 0.9));
  parapet.position.y = h + 0.3;
  g.add(parapet);

  // Térreo com vitrine e toldo, virado para a avenida
  const faceZ = -side * (d / 2 + 0.02);
  if (shop) {
    const front = new THREE.PlaneGeometry(w, 4.5);
    const uv = front.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * Math.max(1, Math.round(w / 8)));
    const shopTex = (shop as THREE.MeshStandardMaterial).map!;
    shopTex.wrapS = THREE.RepeatWrapping;
    const storefront = new THREE.Mesh(front, shop);
    storefront.position.set(0, 2.25, faceZ);
    if (side > 0) storefront.rotation.y = Math.PI;
    g.add(storefront);

    const awning = new THREE.Mesh(new THREE.BoxGeometry(w - 1, 0.08, 1.6), mat(shops[Math.floor(rand() * shops.length)].awning, 0.8));
    awning.position.set(0, 4.0, faceZ - side * 0.75);
    awning.rotation.x = side * 0.25;
    awning.castShadow = true;
    g.add(awning);
  } else {
    // Torres de vidro têm um saguão escuro no térreo
    const lobby = new THREE.Mesh(new THREE.PlaneGeometry(w, 5), mat('#2b3138', 0.2));
    lobby.position.set(0, 2.5, faceZ);
    if (side > 0) lobby.rotation.y = Math.PI;
    g.add(lobby);
  }

  // Telhado: caixa d'água e condensadoras
  if (rand() < 0.6) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2, 14), mat('#5c6f7d', 0.6));
    tank.position.set((rand() - 0.5) * w * 0.5, h + 1.6, (rand() - 0.5) * d * 0.4);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 2), mat('#55585c', 0.8));
    legs.position.set(tank.position.x, h + 0.3, tank.position.z);
    g.add(tank, legs);
  }
  const acCount = Math.floor(rand() * 4);
  for (let i = 0; i < acCount; i++) {
    const ac = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 0.8), mat('#c9ccce', 0.6));
    ac.position.set((rand() - 0.5) * (w - 2), h + 0.45, (rand() - 0.5) * (d - 2));
    g.add(ac);
  }

  scene.add(g);
}

function addRoadMarkings(scene: THREE.Scene) {
  const white = new THREE.MeshStandardMaterial({ color: '#efece4', roughness: 0.7 });
  const yellow = new THREE.MeshStandardMaterial({ color: '#e9b632', roughness: 0.7 });
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const crossings = [-120, -10, 100];
  const nearCrossing = (x: number, pad: number) => crossings.some((c) => Math.abs(x - c) < pad);

  // Faixas tracejadas entre as pistas
  const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(3, 0.18), white, 400);
  let n = 0;
  for (const z of [-ROAD * 0.66, -ROAD * 0.33, ROAD * 0.33, ROAD * 0.66]) {
    for (let x = -EXTENT; x < EXTENT && n < 400; x += 9) {
      if (nearCrossing(x, 6)) continue;
      dashes.setMatrixAt(n++, m.compose(new THREE.Vector3(x, 0.012, z), q, one));
    }
  }
  dashes.count = n;
  dashes.receiveShadow = true;

  // Linha dupla amarela no centro
  const center = new THREE.InstancedMesh(new THREE.PlaneGeometry(EXTENT * 2, 0.14), yellow, 2);
  center.setMatrixAt(0, m.compose(new THREE.Vector3(0, 0.012, -0.15), q, one));
  center.setMatrixAt(1, m.compose(new THREE.Vector3(0, 0.012, 0.15), q, one));
  center.receiveShadow = true;

  // Faixas de pedestre
  const stripes = new THREE.InstancedMesh(new THREE.PlaneGeometry(4, 0.55), white, 120);
  n = 0;
  for (const x of crossings) {
    for (let z = -ROAD + 0.8; z < ROAD - 0.5; z += 1.1) {
      stripes.setMatrixAt(n++, m.compose(new THREE.Vector3(x, 0.014, z), q, one));
    }
  }
  stripes.count = n;
  stripes.receiveShadow = true;
  scene.add(dashes, center, stripes);
}

function addTrees(scene: THREE.Scene, rand: () => number) {
  const positions: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (let x = -EXTENT + 8; x < EXTENT; x += 15 + rand() * 6) {
      if (Math.abs(((x % 30) + 30) % 30) < 3) continue; // não colide com os postes
      positions.push(new THREE.Vector3(x, 0.16, side * (ROAD + 2.6)));
    }
  }
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.22, 3.4, 8).translate(0, 1.7, 0), mat('#5a4434', 0.9), positions.length);
  const canopyGeo = new THREE.IcosahedronGeometry(1.8, 1);
  // Deforma um pouco a copa para não parecer uma bola perfeita.
  const p = canopyGeo.attributes.position as THREE.BufferAttribute;
  const r = rng(99);
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    const s = seen.get(key) ?? 0.85 + r() * 0.3;
    seen.set(key, s);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.85, p.getZ(i) * s);
  }
  canopyGeo.computeVertexNormals();
  const canopies = new THREE.InstancedMesh(canopyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), positions.length * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  positions.forEach((pos, i) => {
    trunks.setMatrixAt(i, m.compose(pos, q, s.set(1, 1, 1)));
    for (let k = 0; k < 2; k++) {
      const size = 0.8 + rand() * 0.5;
      q.setFromEuler(new THREE.Euler(0, rand() * Math.PI, 0));
      const at = pos.clone().add(new THREE.Vector3((rand() - 0.5) * 1.4, 4.3 + k * 0.9, (rand() - 0.5) * 1.4));
      canopies.setMatrixAt(i * 2 + k, m.compose(at, q, s.set(size, size, size)));
      canopies.setColorAt(i * 2 + k, c.setHSL(0.26 + rand() * 0.08, 0.45, 0.28 + rand() * 0.1));
    }
  });
  trunks.castShadow = canopies.castShadow = true;
  canopies.receiveShadow = true;
  scene.add(trunks, canopies);
}

function addStreetLights(scene: THREE.Scene) {
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.13, 8, 8).translate(0, 4, 0);
  const armGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6).rotateX(Math.PI / 2);
  const lampGeo = new RoundedBoxGeometry(0.45, 0.16, 0.9, 2, 0.05);
  const metal = mat('#3f454d', 0.5);
  const lampMat = new THREE.MeshStandardMaterial({ color: '#fff6d0', emissive: '#fff1b0', emissiveIntensity: 0.5 });
  const count = Math.floor((EXTENT * 2) / 30) * 2 + 2;
  const poles = new THREE.InstancedMesh(poleGeo, metal, count);
  const arms = new THREE.InstancedMesh(armGeo, metal, count);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  let n = 0;
  for (let x = -EXTENT; x <= EXTENT && n < count; x += 30) {
    for (const side of [-1, 1]) {
      const z = side * (ROAD + 0.9);
      poles.setMatrixAt(n, m.compose(new THREE.Vector3(x, 0, z), q, one));
      arms.setMatrixAt(n, m.compose(new THREE.Vector3(x, 7.9, z - side * 1.05), q, one));
      lamps.setMatrixAt(n, m.compose(new THREE.Vector3(x, 7.85, z - side * 2.1), q, one));
      n++;
    }
  }
  poles.count = arms.count = lamps.count = n;
  poles.castShadow = arms.castShadow = lamps.castShadow = true;
  scene.add(poles, arms, lamps);
}

function buildTruck(scene: THREE.Scene, x: number, z: number, color: string, accent: string) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2 });
  const white = new THREE.MeshStandardMaterial({ color: '#f2efe6', roughness: 0.3, metalness: 0.15 });
  const black = mat('#16181b', 0.6);
  const glass = new THREE.MeshStandardMaterial({ color: '#1e2b36', roughness: 0.05, metalness: 0.9 });

  const chassis = new THREE.Mesh(new RoundedBoxGeometry(10, 0.5, 2.8, 2, 0.1), black);
  chassis.position.y = 0.95;
  const cargo = new THREE.Mesh(new RoundedBoxGeometry(7, 2.5, 3, 3, 0.12), paint);
  cargo.position.set(-1.4, 2.45, 0);
  const cab = new THREE.Mesh(new RoundedBoxGeometry(2.5, 2.3, 3, 3, 0.25), white);
  cab.position.set(3.75, 2.35, 0);
  const windshield = new THREE.Mesh(new RoundedBoxGeometry(0.1, 1, 2.6, 2, 0.04), glass);
  windshield.position.set(5.0, 2.85, 0);
  const grille = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.7, 2.4, 2, 0.04), black);
  grille.position.set(5.0, 1.65, 0);
  g.add(chassis, cargo, cab, windshield, grille);
  for (const side of [-1, 1]) {
    const win = new THREE.Mesh(new RoundedBoxGeometry(1.3, 0.9, 0.08, 2, 0.03), glass);
    win.position.set(4.0, 2.85, side * 1.5);
    const light = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 14).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#fffbe6', emissive: '#fff4c0', emissiveIntensity: 1 }));
    light.position.set(5.05, 1.6, side * 1.0);
    g.add(win, light);
  }

  // Painel de LED com o nome do jogo nas laterais
  const panelMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffffff', emissiveMap: ledPanelTexture(GAME.name.toUpperCase(), accent), emissiveIntensity: 1.1, roughness: 0.4 });
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 1.55), panelMat);
    panel.position.set(-1.4, 2.5, side * 1.52);
    if (side < 0) panel.rotation.y = Math.PI;
    g.add(panel);
  }

  // Grade no teto e caixas de som
  const rail = mat('#2a2d31', 0.5);
  for (const side of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 7, 6).rotateZ(Math.PI / 2), rail);
    r.position.set(-1.4, 4.4, side * 1.45);
    g.add(r);
  }
  const speakerGeo = new RoundedBoxGeometry(1.1, 1.4, 0.9, 2, 0.06);
  const coneGeo = new THREE.CylinderGeometry(0.32, 0.22, 0.08, 20).rotateX(Math.PI / 2);
  const tweeterGeo = new THREE.CylinderGeometry(0.1, 0.07, 0.06, 12).rotateX(Math.PI / 2);
  const cones: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    for (const side of [-1, 1]) {
      const s = new THREE.Mesh(speakerGeo, black);
      s.position.set(-3.8 + i * 2.4, 4.4, side * 0.75);
      s.rotation.y = side > 0 ? 0.2 : Math.PI - 0.2;
      const cone = new THREE.Mesh(coneGeo, mat('#4c535d', 0.4));
      cone.position.set(0, -0.2, 0.46);
      const tweeter = new THREE.Mesh(tweeterGeo, mat('#7b838e', 0.3));
      tweeter.position.set(0, 0.42, 0.46);
      s.add(cone, tweeter);
      cones.push(cone);
      g.add(s);
    }
  }

  const wheelGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.42, 20).rotateX(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.44, 12).rotateX(Math.PI / 2);
  for (const wx of [-3.9, -2.6, 3.7]) {
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, mat('#111317', 0.85));
      w.position.set(wx, 0.56, side * 1.35);
      const hub = new THREE.Mesh(hubGeo, mat('#9aa1a8', 0.3));
      hub.position.copy(w.position);
      g.add(w, hub);
    }
  }

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
  });
  scene.add(g);

  return {
    // Os cones dos alto-falantes pulsam no ritmo.
    update(time: number) {
      const beat = Math.pow(Math.max(0, Math.sin(time * Math.PI * 2 * 2)), 8);
      for (const c of cones) c.scale.set(1 + beat * 0.12, 1 + beat * 0.12, 1 + beat * 1.5);
    },
  };
}

// Papel picado caindo em volta dos carros de som.
class Confetti {
  readonly mesh: THREE.InstancedMesh;
  private p: { x: number; y: number; z: number; vy: number; rx: number; ry: number; spin: number; truck: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(scene: THREE.Scene, private rand: () => number) {
    const count = 900;
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.09, 0.14), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6 }), count);
    const c = new THREE.Color();
    const palette = [...TEAMS.flatMap((t) => [t.color, t.accent]), '#ffffff'];
    for (let i = 0; i < count; i++) {
      const truck = i % TRUCKS.length;
      this.p.push({ x: 0, y: 0, z: 0, vy: 0, rx: 0, ry: 0, spin: 0, truck });
      this.reset(i, true);
      const team = TRUCKS[truck].team;
      this.mesh.setColorAt(i, c.set(rand() < 0.55 ? TEAMS[team].color : palette[Math.floor(rand() * palette.length)]));
    }
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  private reset(i: number, anywhere = false) {
    const p = this.p[i];
    const t = TRUCKS[p.truck];
    const a = this.rand() * Math.PI * 2;
    const r = this.rand() * 14;
    p.x = t.x + Math.cos(a) * r * 1.3;
    p.z = t.z + Math.sin(a) * r * 0.7;
    p.y = anywhere ? this.rand() * 9 : 7 + this.rand() * 3;
    p.vy = 0.6 + this.rand() * 0.8;
    p.rx = this.rand() * Math.PI;
    p.ry = this.rand() * Math.PI;
    p.spin = 2 + this.rand() * 5;
  }

  update(dt: number) {
    if (!this.mesh.visible) return;
    for (let i = 0; i < this.p.length; i++) {
      const p = this.p[i];
      p.y -= p.vy * dt;
      p.x += Math.sin(p.rx) * dt * 0.4;
      p.rx += p.spin * dt;
      p.ry += p.spin * 0.6 * dt;
      if (p.y < 0.05) this.reset(i);
      this.q.setFromEuler(this.e.set(p.rx, p.ry, 0));
      this.mesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.one));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
