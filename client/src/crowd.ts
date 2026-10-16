import * as THREE from 'three';
import { CLOTH_COLORS, HAIR_COLORS, SKIN_TONES, SPAWN, TEAMS, TRUCKS, WORLD } from '../../shared/config';
import { flagMaterial } from './avatar';
import { bakePose, crowdMaterial } from './character';
import { flagGeometry } from './wave';

interface Person {
  x: number;
  z: number;
  yaw: number;
  phase: number;
  amp: number;
  h: number;
  variant: number;
  slot: number; // índice dentro da malha da variante
}

// Multidão de fundo: centenas de pessoas com o mesmo modelo dos jogadores, mas em pose fixa
// e desenhadas com InstancedMesh (poucos draw calls). Os bots animados ficam por conta do servidor.
export class AmbientCrowd {
  private meshes: THREE.InstancedMesh[] = [];
  private poles: THREE.InstancedMesh;
  private flags: THREE.InstancedMesh[];
  private people: Person[] = [];
  private flagOwners: number[][] = [[], []];
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, rand: () => number) {
    const perTeam = 200;

    // Duas poses: braços ao lado do corpo e um braço erguido (punho para cima).
    const poses = [
      bakePose((r) => {
        r.rotate('upperarm.L', 0, 0, -0.62);
        r.rotate('upperarm.R', 0, 0, 0.62);
        r.rotate('lowerarm.L', -0.25, 0, 0);
        r.rotate('lowerarm.R', -0.25, 0, 0);
      }),
      bakePose((r) => {
        r.rotate('upperarm.L', 0, 0, -0.62);
        r.rotate('upperarm.R', -0.25, 0, -1.9);
        r.rotate('lowerarm.L', -0.25, 0, 0);
        r.rotate('lowerarm.R', 0, 0, -0.4);
      }),
    ];

    const color = new THREE.Color();
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
    const variantCount = [0, 0];
    const attrs: { skin: number[]; hair: number[]; c1: number[]; c2: number[]; c3: number[]; head: number[] }[] = poses.map(() => ({ skin: [], hair: [], c1: [], c2: [], c3: [], head: [] }));

    for (const team of [0, 1] as const) {
      const truck = TRUCKS.find((t) => t.team === team)!;
      const zone = SPAWN[team];
      for (let i = 0; i < perTeam; i++) {
        // ~55% em volta do carro de som; o resto espalhado nas calçadas da zona do lado.
        let x: number, z: number;
        if (i < perTeam * 0.55) {
          const a = rand() * Math.PI * 2;
          const r = 7 + rand() * 16;
          x = truck.x + Math.cos(a) * r * 1.4;
          z = Math.max(-WORLD.halfWidth + 1, Math.min(WORLD.halfWidth - 1, truck.z + Math.sin(a) * r * 0.6));
        } else {
          x = zone.minX + rand() * (zone.maxX - zone.minX);
          z = (rand() < 0.5 ? -1 : 1) * (WORLD.roadHalfWidth + 3.6 + rand() * 4.4);
        }
        const yaw = Math.atan2(truck.x - x, truck.z - z) + (rand() - 0.5) * 0.8;
        const variant = rand() < 0.22 ? 1 : 0;
        const idx = this.people.length;
        const hasFlag = variant === 0 && rand() < 0.14;
        this.people.push({ x, z, yaw, phase: rand() * Math.PI * 2, amp: 0.02 + rand() * 0.1, h: 0.94 + rand() * 0.12, variant, slot: variantCount[variant]++ });
        if (hasFlag) this.flagOwners[team].push(idx);

        const a = attrs[variant];
        a.skin.push(...color.set(pick(SKIN_TONES)).toArray());
        a.hair.push(...color.set(pick(HAIR_COLORS)).toArray());
        const teamShirt = TEAMS[team].accent === '#ffffff' ? TEAMS[team].color : pick([TEAMS[team].color, TEAMS[team].accent]);
        a.c1.push(...color.set(rand() < 0.65 ? teamShirt : pick(CLOTH_COLORS)).toArray());
        a.c2.push(...color.set(pick(['#2d3440', '#3b4a63', '#1f2226', '#5b5f66', '#6b5a45', '#1d3a8a'])).toArray());
        a.c3.push(...color.set(pick(['#1d2129', '#ffffff', '#8d6e63', '#e63946'])).toArray());
        a.head.push(pick([0, 0, 0, 1, 3]));
      }
    }

    const material = crowdMaterial();
    poses.forEach((g, vi) => {
      const geo = g.clone();
      const a = attrs[vi];
      geo.setAttribute('iSkin', new THREE.InstancedBufferAttribute(new Float32Array(a.skin), 3));
      geo.setAttribute('iHair', new THREE.InstancedBufferAttribute(new Float32Array(a.hair), 3));
      geo.setAttribute('iC1', new THREE.InstancedBufferAttribute(new Float32Array(a.c1), 3));
      geo.setAttribute('iC2', new THREE.InstancedBufferAttribute(new Float32Array(a.c2), 3));
      geo.setAttribute('iC3', new THREE.InstancedBufferAttribute(new Float32Array(a.c3), 3));
      geo.setAttribute('iHeadS', new THREE.InstancedBufferAttribute(new Float32Array(a.head), 1));
      const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, variantCount[vi]));
      mesh.count = variantCount[vi];
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    });

    // Mastros e bandeiras (uma malha instanciada por lado, para usar a textura de cada um).
    const totalFlags = this.flagOwners[0].length + this.flagOwners[1].length;
    this.poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.02, 2.4, 5).translate(0, 1.2, 0), new THREE.MeshStandardMaterial({ color: '#c9a979', roughness: 0.6 }), Math.max(1, totalFlags));
    this.poles.count = totalFlags;
    this.poles.castShadow = true;
    this.poles.frustumCulled = false;
    this.flags = ([0, 1] as const).map((team) => {
      const mesh = new THREE.InstancedMesh(flagGeometry(1.0, 0.64), flagMaterial(team), Math.max(1, this.flagOwners[team].length));
      mesh.count = this.flagOwners[team].length;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
    scene.add(this.poles);
    this.update(0);
  }

  update(time: number) {
    const { m, v, q, s } = this;
    for (const p of this.people) {
      const bob = Math.max(0, Math.sin(time * 4 + p.phase)) * p.amp;
      q.setFromAxisAngle(this.up, p.yaw + Math.sin(time * 1.3 + p.phase) * 0.15);
      s.set(p.h, p.h, p.h);
      this.meshes[p.variant].setMatrixAt(p.slot, m.compose(v.set(p.x, bob, p.z), q, s));
    }
    let poleIdx = 0;
    for (const team of [0, 1] as const) {
      const owners = this.flagOwners[team];
      for (let k = 0; k < owners.length; k++) {
        const p = this.people[owners[k]];
        const bob = Math.max(0, Math.sin(time * 4 + p.phase)) * p.amp;
        // Mastro ao lado do corpo, na altura da mão direita.
        const ox = -Math.cos(p.yaw) * 0.42;
        const oz = Math.sin(p.yaw) * 0.42;
        v.set(p.x + ox, 0.55 * p.h + bob, p.z + oz);
        this.poles.setMatrixAt(poleIdx++, m.compose(v, q.identity(), s.set(1, 1, 1)));
        v.y += 2.0;
        q.setFromAxisAngle(this.up, p.yaw + Math.PI / 2 + Math.sin(time * 0.7 + p.phase) * 0.4);
        this.flags[team].setMatrixAt(k, m.compose(v, q, s));
      }
      this.flags[team].instanceMatrix.needsUpdate = true;
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.poles.instanceMatrix.needsUpdate = true;
  }
}
