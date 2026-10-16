import * as THREE from 'three';
import { CLOTH_COLORS, HAIR_COLORS, SKIN_TONES, SPAWN, TEAMS, TRUCKS, WORLD, type TeamId } from '../../shared/config';
import type { Look } from '../../shared/look';
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
  team: TeamId;
  look: Look; // visual equivalente, para virar um personagem completo quando apanha
  hidden?: boolean;
}

// Multidão de fundo: centenas de pessoas com o mesmo modelo dos jogadores, mas em pose fixa
// e desenhadas com InstancedMesh (poucos draw calls). Os bots animados ficam por conta do servidor.
// Quando alguém da multidão apanha, ela some daqui e vira um Avatar completo (ver world.ts).
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

  constructor(scene: THREE.Scene, rand: () => number, perTeam = 200) {
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
      const teamColors = [TEAMS[team].color, TEAMS[team].accent].filter((c) => c !== '#ffffff').map((c) => CLOTH_COLORS.indexOf(c));
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

        // Cores como índices das paletas, para o visual equivaler a um Look de verdade.
        const skin = Math.floor(rand() * SKIN_TONES.length);
        const hair = Math.floor(rand() * HAIR_COLORS.length);
        const shirt = rand() < 0.65 ? pick(teamColors) : Math.floor(rand() * CLOTH_COLORS.length);
        const pants = pick([10, 1, 2, 13]);
        const shoes = pick([1, 0, 13, 3]);
        const headS = pick([0, 0, 0, 1, 3]);
        const look: Look = {
          skin,
          hair,
          head: { s: headS, c: shirt, a: 0, p: 0 },
          torso: { s: 0, c: shirt, a: 0, p: 0 },
          legs: { s: 0, c: pants, a: 0, p: 0 },
          feet: { s: 0, c: shoes, a: 0, p: 0 },
          print: 0,
          item: hasFlag ? 'flag' : 'none',
          sign: '',
        };
        this.people.push({ x, z, yaw, phase: rand() * Math.PI * 2, amp: 0.02 + rand() * 0.1, h: 0.94 + rand() * 0.12, variant, slot: variantCount[variant]++, team, look });
        if (hasFlag) this.flagOwners[team].push(idx);

        const a = attrs[variant];
        a.skin.push(...color.set(SKIN_TONES[skin]).toArray());
        a.hair.push(...color.set(HAIR_COLORS[hair]).toArray());
        a.c1.push(...color.set(CLOTH_COLORS[shirt]).toArray());
        a.c2.push(...color.set(CLOTH_COLORS[pants]).toArray());
        a.c3.push(...color.set(CLOTH_COLORS[shoes]).toArray());
        a.head.push(headS);
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
      if (p.hidden) s.set(0, 0, 0); // virou personagem completo (apanhou): some da multidão
      else s.set(p.h, p.h, p.h);
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
        const sc = p.hidden ? 0 : 1;
        v.set(p.x + ox, 0.55 * p.h + bob, p.z + oz);
        this.poles.setMatrixAt(poleIdx++, m.compose(v, q.identity(), s.set(sc, sc, sc)));
        v.y += 2.0;
        q.setFromAxisAngle(this.up, p.yaw + Math.PI / 2 + Math.sin(time * 0.7 + p.phase) * 0.4);
        this.flags[team].setMatrixAt(k, m.compose(v, q, s));
      }
      this.flags[team].instanceMatrix.needsUpdate = true;
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.poles.instanceMatrix.needsUpdate = true;
  }

  /** Pessoa da multidão à frente de (x, z) olhando para yaw, até range metros; -1 se ninguém. */
  findInFront(x: number, z: number, yaw: number, range: number) {
    let best = -1;
    let bestD = range;
    this.people.forEach((p, i) => {
      if (p.hidden) return;
      const dx = p.x - x;
      const dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d >= bestD) return;
      let ang = Math.atan2(dx, dz) - yaw;
      while (ang > Math.PI) ang -= Math.PI * 2;
      while (ang < -Math.PI) ang += Math.PI * 2;
      if (Math.abs(ang) < 0.9) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  person(i: number) {
    return this.people[i];
  }

  setHidden(i: number, hidden: boolean) {
    this.people[i].hidden = hidden;
  }
}
