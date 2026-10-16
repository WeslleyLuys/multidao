import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Armas low-poly feitas com primitivas. Origem na empunhadura, cano apontando para +Z (metros).
// Partes com nome: "mag" (carregador, anima na recarga), "slide" (ferrolho/corrediça, anima no tiro),
// "sight" (ponto da mira; a câmera se alinha a ele ao mirar).

const M = {
  steel: new THREE.MeshStandardMaterial({ color: '#30353c', roughness: 0.32, metalness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.45, metalness: 0.6 }),
  polymer: new THREE.MeshStandardMaterial({ color: '#1f2226', roughness: 0.8 }),
  tan: new THREE.MeshStandardMaterial({ color: '#8c7a5b', roughness: 0.75 }),
  wood: new THREE.MeshStandardMaterial({ color: '#7a4a26', roughness: 0.6 }),
  olive: new THREE.MeshStandardMaterial({ color: '#4b5320', roughness: 0.7 }),
  glass: new THREE.MeshStandardMaterial({ color: '#16303f', roughness: 0.05, metalness: 0.9 }),
  red: new THREE.MeshBasicMaterial({ color: '#ff2a2a' }),
  brass: new THREE.MeshStandardMaterial({ color: '#c9a640', roughness: 0.3, metalness: 0.9 }),
};

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, name = '') {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(0.006, w / 2.5, h / 2.5, d / 2.5)), m);
  mesh.position.set(x, y, z);
  mesh.name = name;
  return mesh;
}

function tube(r: number, len: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 14, r2 = r) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2), m);
  mesh.position.set(x, y, z + len / 2);
  return mesh;
}

export interface GunModel {
  group: THREE.Group;
  muzzle: THREE.Vector3; // ponta do cano (local)
  sight: THREE.Vector3; // ponto da mira (local)
  mag?: THREE.Object3D;
  slide?: THREE.Object3D;
}

export function buildGun(w: number): GunModel | null {
  const g = new THREE.Group();
  let muzzle = new THREE.Vector3();
  let sight = new THREE.Vector3();

  if (w === 1) {
    // Pistola
    const grip = box(0.032, 0.11, 0.05, M.polymer, 0, -0.045, -0.01);
    grip.rotation.x = 0.22;
    const frame = box(0.03, 0.03, 0.17, M.polymer, 0, 0.012, 0.055);
    const slide = box(0.034, 0.034, 0.19, M.steel, 0, 0.044, 0.06, 'slide');
    const guard = box(0.008, 0.03, 0.05, M.polymer, 0, -0.012, 0.045);
    const mag = box(0.026, 0.09, 0.04, M.dark, 0, -0.06, -0.015, 'mag');
    mag.rotation.x = 0.22;
    const front = box(0.006, 0.01, 0.01, M.steel, 0, 0.066, 0.145);
    const dot = box(0.005, 0.005, 0.004, M.red, 0, 0.069, 0.151);
    const rear = box(0.026, 0.01, 0.01, M.steel, 0, 0.066, -0.022);
    g.add(grip, frame, slide, guard, mag, front, dot, rear);
    muzzle = new THREE.Vector3(0, 0.044, 0.16);
    sight = new THREE.Vector3(0, 0.07, 0.0);
  } else if (w === 2) {
    // Submetralhadora
    g.add(box(0.045, 0.07, 0.3, M.polymer, 0, 0.03, 0.08));
    const grip = box(0.032, 0.1, 0.045, M.polymer, 0, -0.04, -0.01);
    grip.rotation.x = 0.2;
    g.add(grip);
    g.add(box(0.03, 0.17, 0.035, M.dark, 0, -0.07, 0.11, 'mag'));
    g.add(box(0.03, 0.03, 0.18, M.dark, 0, 0.0, -0.13)); // coronha retrátil
    g.add(tube(0.012, 0.12, M.steel, 0, 0.035, 0.23));
    g.add(box(0.02, 0.025, 0.06, M.dark, 0, 0.075, 0.02, 'slide'));
    g.add(box(0.028, 0.03, 0.05, M.dark, 0, 0.08, 0.08)); // mira holográfica
    g.add(box(0.004, 0.004, 0.003, M.red, 0, 0.083, 0.06));
    muzzle = new THREE.Vector3(0, 0.035, 0.36);
    sight = new THREE.Vector3(0, 0.083, 0.0);
  } else if (w === 3) {
    // Fuzil
    g.add(box(0.05, 0.075, 0.44, M.tan, 0, 0.03, 0.12));
    const grip = box(0.034, 0.11, 0.045, M.polymer, 0, -0.045, 0.0);
    grip.rotation.x = 0.25;
    g.add(grip);
    const mag = box(0.034, 0.14, 0.06, M.dark, 0, -0.045, 0.16, 'mag');
    mag.rotation.x = -0.15;
    g.add(mag);
    g.add(box(0.045, 0.085, 0.22, M.tan, 0, 0.015, -0.18)); // coronha
    g.add(box(0.028, 0.012, 0.3, M.dark, 0, 0.074, 0.12)); // trilho
    g.add(box(0.034, 0.045, 0.08, M.dark, 0, 0.1, 0.06)); // mira red dot
    g.add(box(0.004, 0.004, 0.003, M.red, 0, 0.103, 0.04));
    g.add(box(0.05, 0.05, 0.16, M.polymer, 0, 0.03, 0.38)); // guarda-mão
    g.add(tube(0.011, 0.24, M.steel, 0, 0.035, 0.46));
    g.add(tube(0.018, 0.05, M.dark, 0, 0.035, 0.7)); // quebra-chamas
    g.add(box(0.012, 0.02, 0.04, M.steel, 0.03, 0.05, 0.02, 'slide'));
    muzzle = new THREE.Vector3(0, 0.035, 0.76);
    sight = new THREE.Vector3(0, 0.103, -0.05);
  } else if (w === 4) {
    // Shotgun
    g.add(box(0.04, 0.11, 0.05, M.wood, 0, -0.045, 0.0));
    g.add(box(0.045, 0.06, 0.28, M.steel, 0, 0.03, 0.1));
    g.add(tube(0.017, 0.5, M.dark, 0, 0.05, 0.2));
    g.add(tube(0.014, 0.42, M.dark, 0, 0.015, 0.2)); // tubo de cartuchos
    g.add(Object.assign(tube(0.024, 0.16, M.wood, 0, 0.015, 0.3), { name: 'slide' })); // telha (pump)
    g.add(box(0.045, 0.085, 0.25, M.wood, 0, 0.0, -0.17)); // coronha
    g.add(box(0.006, 0.01, 0.01, M.brass, 0, 0.073, 0.69)); // massa de mira
    muzzle = new THREE.Vector3(0, 0.05, 0.7);
    sight = new THREE.Vector3(0, 0.075, 0.0);
  } else if (w === 5) {
    // Sniper
    g.add(box(0.05, 0.07, 0.5, M.olive, 0, 0.025, 0.1));
    const grip = box(0.034, 0.1, 0.045, M.polymer, 0, -0.04, 0.0);
    grip.rotation.x = 0.3;
    g.add(grip);
    g.add(box(0.045, 0.1, 0.3, M.olive, 0, 0.0, -0.25)); // coronha
    g.add(box(0.03, 0.06, 0.05, M.dark, 0, -0.035, 0.12, 'mag'));
    g.add(tube(0.013, 0.55, M.steel, 0, 0.035, 0.35));
    g.add(tube(0.022, 0.08, M.dark, 0, 0.035, 0.88)); // freio de boca
    g.add(tube(0.024, 0.3, M.dark, 0, 0.1, -0.06, 16)); // luneta
    g.add(tube(0.034, 0.06, M.dark, 0, 0.1, 0.22, 16, 0.024));
    g.add(tube(0.03, 0.05, M.dark, 0, 0.1, -0.1, 16, 0.024));
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), M.glass);
    lens.position.set(0, 0.1, 0.28);
    g.add(lens);
    const bolt = box(0.012, 0.012, 0.05, M.steel, 0.035, 0.05, -0.02, 'slide');
    g.add(bolt);
    // bípode dobrado
    g.add(box(0.008, 0.008, 0.18, M.dark, 0.02, -0.01, 0.42), box(0.008, 0.008, 0.18, M.dark, -0.02, -0.01, 0.42));
    muzzle = new THREE.Vector3(0, 0.035, 0.96);
    sight = new THREE.Vector3(0, 0.1, -0.1);
  } else if (w === 6) {
    // Canhão (lança-foguetes de ombro)
    g.add(tube(0.075, 1.0, M.olive, 0, 0.1, -0.35));
    g.add(tube(0.085, 0.08, M.dark, 0, 0.1, 0.6));
    g.add(tube(0.085, 0.08, M.dark, 0, 0.1, -0.38));
    g.add(box(0.035, 0.11, 0.05, M.polymer, 0, -0.02, 0.0));
    g.add(box(0.035, 0.11, 0.05, M.polymer, 0, -0.02, 0.25));
    g.add(box(0.05, 0.06, 0.1, M.dark, -0.085, 0.17, 0.05)); // mira lateral
    const warhead = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.16, 12).rotateX(Math.PI / 2), M.olive);
    warhead.position.set(0, 0.1, 0.74);
    warhead.name = 'mag';
    g.add(warhead);
    muzzle = new THREE.Vector3(0, 0.1, 0.68);
    sight = new THREE.Vector3(-0.085, 0.2, 0.05);
  } else return null;

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return { group: g, muzzle, sight, mag: g.getObjectByName('mag'), slide: g.getObjectByName('slide') };
}
