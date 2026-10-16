import { WebSocket } from 'ws';
import { RUN_SPEED, TEAMS, type TeamId } from '../shared/config';
import { randomLook, teamClothColors, type Look } from '../shared/look';
import { ROUND_OPTIONS, type ClientMsg, type EventMode, type MatchPhase, type MatchStat, type ProjKind, type ServerMsg } from '../shared/protocol';
import {
  MATCH_SIZES, STEP_HEIGHT, arenaMove, buildArena, lineOfSight, newMover, projStep, rayBody, rayObstacles,
  type Arena, type MatchSize, type Mover, type Vec3,
} from '../shared/arena';
import {
  ARMOR_ABSORB, ARMOR_MAX, ARMOR_PER_VEST, BODY_HEIGHT, CANNON, EYE_HEIGHT, FISTS, GRENADE, GRENADE_ID, HEADSHOT, MAX_HP, WEAPONS,
  aimDir, pickChestWeapon,
} from '../shared/weapons';

const COUNTDOWN_MS = 5000;
const ROUND_MS = 3 * 60 * 1000; // modo livre
const ROUND_LIMIT_MS = 150 * 1000; // tempo máximo de cada round
const ROUND_END_MS = 5000;
const ROUND_COUNTDOWN_MS = 4000;
const END_MS = 10000;
const RESPAWN_MS = 3000;
const SPAWN_PROTECT_MS = 2000;
const CHEST_RESPAWN_MS = 25000;
const QUEUE_BOT_FILL_MS = 20000; // depois disso a partida começa completando com bots
const KILL_SCORE = 100;

export interface Seat {
  ws: WebSocket;
  name: string;
  team: TeamId;
  look: Look;
}

interface MP extends Mover {
  id: number;
  name: string;
  team: TeamId;
  look: Look;
  bot: boolean;
  seat?: Seat;
  yaw: number;
  pitch: number;
  moving: number;
  hp: number;
  armor: number;
  nades: number;
  nextNade: number;
  alive: boolean;
  respawnAt: number;
  protectUntil: number;
  lastPosAt: number;
  input: { dx: number; dz: number; run: boolean; jump: boolean; ads: boolean };
  owned: boolean[];
  ammo: number[];
  reserve: number[];
  cur: number;
  nextFire: number;
  reloadUntil: number;
  stats: MatchStat;
  brain?: Brain;
}

interface Brain {
  nextThink: number;
  goal?: { x: number; z: number };
  target?: number;
  strafe: number;
  strafeUntil: number;
  reactAt: number;
  last: { x: number; z: number };
  detourUntil: number;
  detour: { x: number; z: number };
}

interface Projectile {
  rid: number;
  kind: ProjKind;
  owner: number;
  team: TeamId;
  pos: Vec3;
  vel: Vec3;
  born: number;
}

function send(ws: WebSocket | undefined, msg: ServerMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class Match {
  readonly arena: Arena;
  readonly seed = Math.floor(Math.random() * 1e9);
  readonly players = new Map<number, MP>();
  phase: MatchPhase = 'countdown';
  round = 1;
  phaseEnds: number;
  teams: [number, number] = [0, 0];
  private chests: { open: boolean; reopenAt: number }[];
  private projs: Projectile[] = [];
  private nextProj = 1;
  private snapAcc = 0;
  finished = false;

  constructor(readonly mode: EventMode, readonly size: MatchSize, readonly rounds: number, seats: Seat[], private newId: () => number, private onFinish: (m: Match) => void) {
    this.arena = buildArena(size, this.seed);
    this.chests = this.arena.chests.map(() => ({ open: false, reopenAt: 0 }));
    const now = Date.now();
    this.phaseEnds = now + COUNTDOWN_MS;

    const counts: [number, number] = [0, 0];
    for (const s of seats) this.addPlayer(s.name, s.team, s.look, s, counts[s.team]++);
    for (const team of [0, 1] as const) {
      for (let i = counts[team]; i < size; i++) {
        this.addPlayer(`Bot ${TEAMS[team].name} ${i + 1}`, team, randomLook(Math.random, teamClothColors(team)), undefined, i);
      }
    }

    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, look: p.look, bot: p.bot }));
    for (const p of this.players.values()) {
      if (!p.seat) continue;
      send(p.seat.ws, { t: 'match', mode, size, rounds, round: this.round, seed: this.seed, you: p.id, players, phase: this.phase, endsAt: this.phaseEnds, now, opened: [] });
      this.sendInv(p);
    }
  }

  private addPlayer(name: string, team: TeamId, look: Look, seat: Seat | undefined, lane: number) {
    const spawn = this.arena.spawns[team][(lane * 5) % this.arena.spawns[team].length];
    const p: MP = {
      ...newMover(spawn.x, spawn.z),
      id: this.newId(),
      name,
      team,
      look: { ...look, item: 'none' },
      bot: !seat,
      seat,
      yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
      pitch: 0,
      moving: 0,
      hp: MAX_HP,
      armor: 0,
      nades: 0,
      nextNade: 0,
      alive: true,
      respawnAt: 0,
      protectUntil: 0,
      lastPosAt: Date.now(),
      input: { dx: 0, dz: 0, run: false, jump: false, ads: false },
      owned: WEAPONS.map((_, i) => i === FISTS),
      ammo: WEAPONS.map(() => 0),
      reserve: WEAPONS.map(() => 0),
      cur: FISTS,
      nextFire: 0,
      reloadUntil: 0,
      stats: { id: 0, kills: 0, deaths: 0, score: 0 },
    };
    p.stats.id = p.id;
    if (!seat) {
      p.brain = { nextThink: 0, strafe: 1, strafeUntil: 0, reactAt: 0, last: { x: p.x, z: p.z }, detourUntil: 0, detour: { x: 0, z: 0 } };
    }
    this.players.set(p.id, p);
  }

  // ---------- Mensagens ----------
  broadcast(msg: ServerMsg, except?: number) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.seat && p.id !== except && p.seat.ws.readyState === WebSocket.OPEN) p.seat.ws.send(data);
    }
  }

  private sendInv(p: MP) {
    if (!p.seat) return;
    send(p.seat.ws, {
      t: 'inv',
      cur: p.cur,
      ammo: p.ammo,
      reserve: p.reserve.map((r, i) => (p.owned[i] ? r : -1)),
      reloading: p.reloadUntil > Date.now(),
      armor: Math.round(p.armor),
      nades: p.nades,
    });
  }

  private stats() {
    return [...this.players.values()].map((p) => p.stats);
  }

  handle(seat: Seat, msg: ClientMsg) {
    const p = [...this.players.values()].find((x) => x.seat === seat);
    if (!p) return;
    const now = Date.now();
    switch (msg.t) {
      case 'minput':
        p.input = { dx: clamp1(msg.dx), dz: clamp1(msg.dz), run: !!msg.run, jump: !!msg.jump, ads: !!msg.ads };
        if (Number.isFinite(msg.yaw)) p.yaw = msg.yaw;
        if (Number.isFinite(msg.pitch)) p.pitch = Math.max(-1.4, Math.min(1.4, msg.pitch));
        this.acceptPosition(p, Number(msg.x), Number(msg.z), Number(msg.y), now);
        break;
      case 'shoot':
        if (Number.isFinite(msg.yaw) && Number.isFinite(msg.pitch)) this.fire(p, msg.yaw, Math.max(-1.4, Math.min(1.4, msg.pitch)), !!msg.ads, now);
        break;
      case 'throw':
        if (Number.isFinite(msg.yaw) && Number.isFinite(msg.pitch)) this.throwNade(p, msg.yaw, Math.max(-1.4, Math.min(1.4, msg.pitch)), now);
        break;
      case 'reload':
        this.reload(p, now);
        break;
      case 'switch':
        if (p.owned[msg.w] && p.cur !== msg.w) {
          p.cur = msg.w;
          p.reloadUntil = 0;
          p.nextFire = Math.max(p.nextFire, now + 250);
          this.sendInv(p);
        }
        break;
      case 'use':
        this.useChest(p, now);
        break;
    }
  }

  /**
   * Movimento dos humanos: o cliente simula (fica fluido) e o servidor valida cada posição.
   * Rejeita velocidade acima do possível, atravessar obstáculos, sair do mapa e altura impossível.
   */
  private acceptPosition(p: MP, x: number, z: number, y: number, now: number) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) return;
    const elapsed = Math.min(0.5, (now - p.lastPosAt) / 1000);
    const reject = () => {
      p.lastPosAt = now;
      send(p.seat?.ws, { t: 'correct', x: r2(p.x), z: r2(p.z), y: r2(p.y) });
    };
    if (!p.alive || this.phase !== 'live') {
      if (Math.hypot(x - p.x, z - p.z) > 0.6) reject();
      return;
    }
    const maxDist = RUN_SPEED * 1.35 * elapsed + 0.35;
    const lim = this.arena.half - 0.3;
    const inside = this.arena.obstacles.some((o) => Math.abs(x - o.x) < o.hx - 0.12 && Math.abs(z - o.z) < o.hz - 0.12 && y < o.h - STEP_HEIGHT - 0.1);
    if (Math.hypot(x - p.x, z - p.z) > maxDist || Math.abs(x) > lim || Math.abs(z) > lim || y < -0.1 || y > 7 || inside) return reject();
    if (elapsed > 0) {
      p.vx = (x - p.x) / elapsed;
      p.vz = (z - p.z) / elapsed;
    }
    p.grounded = Math.abs(y - p.y) < 0.03; // sem variação vertical = no chão (usado no espalhamento)
    p.x = x;
    p.z = z;
    p.y = y;
    p.lastPosAt = now;
  }

  /** Jogador humano saiu (desconectou ou voltou à avenida). */
  removeSeat(seat: Seat) {
    for (const p of this.players.values()) {
      if (p.seat === seat) {
        this.players.delete(p.id);
        this.broadcast({ t: 'remove', id: p.id });
      }
    }
    if (![...this.players.values()].some((p) => p.seat)) this.finish();
  }

  // ---------- Combate ----------
  private eye(p: MP): Vec3 {
    return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
  }

  private fire(p: MP, yaw: number, pitch: number, ads: boolean, now: number) {
    if (this.phase !== 'live' || !p.alive) return;
    const w = WEAPONS[p.cur];
    if (now < p.nextFire - 40 || now < p.reloadUntil) return;
    if (w.mag > 0 && p.ammo[p.cur] <= 0) {
      this.reload(p, now);
      return;
    }
    p.nextFire = now + w.interval;
    p.yaw = yaw;
    p.pitch = pitch;
    if (w.mag > 0) p.ammo[p.cur]--;
    const eye = this.eye(p);

    if (p.cur === FISTS) {
      // Soco: o inimigo mais próximo à frente, dentro do alcance.
      let best: MP | undefined;
      let bestD = w.range;
      for (const o of this.players.values()) {
        if (o.team === p.team || !o.alive || Math.abs(o.y - p.y) > 1.2) continue;
        const dx = o.x - p.x;
        const dz = o.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < bestD && Math.abs(angleDiff(Math.atan2(dx, dz), yaw)) < 0.7) {
          best = o;
          bestD = d;
        }
      }
      this.broadcast({ t: 'shot', id: p.id, w: FISTS, from: [r2(eye.x), r2(eye.y), r2(eye.z)], to: [] }, p.id);
      if (best) this.damage(best, w.dmg, p, FISTS, false, now);
      return;
    }

    if (w.projectile) {
      const d = aimDir(yaw, pitch);
      this.spawnProj(p, 'rocket', { x: eye.x + d.x * 0.8, y: eye.y - 0.15 + d.y * 0.8, z: eye.z + d.z * 0.8 }, { x: d.x * w.projectile.speed, y: d.y * w.projectile.speed, z: d.z * w.projectile.speed }, now);
    } else {
      // Mirar (ADS) reduz o espalhamento; andar/pular aumenta.
      const moveK = p.grounded ? 1 + Math.hypot(p.vx, p.vz) * 0.08 : 2;
      const spread = w.spread * (ads ? w.adsSpread : 1) * moveK;
      const ends: [number, number, number][] = [];
      const hits = new Map<MP, { dmg: number; head: boolean }>();
      for (let i = 0; i < w.pellets; i++) {
        const d = aimDir(yaw + gauss() * spread, pitch + gauss() * spread);
        let hitT = rayObstacles(eye, d, w.range, this.arena);
        let hit: { mp: MP; head: boolean } | undefined;
        for (const o of this.players.values()) {
          if (o === p || !o.alive) continue;
          const r = rayBody(eye, d, o.x, o.z, o.y);
          if (r && r.t < hitT) {
            hitT = r.t;
            hit = { mp: o, head: r.y > BODY_HEIGHT - 0.32 };
          }
        }
        ends.push([r2(eye.x + d.x * hitT), r2(eye.y + d.y * hitT), r2(eye.z + d.z * hitT)]);
        if (hit && hit.mp.team !== p.team) {
          const prev = hits.get(hit.mp) ?? { dmg: 0, head: false };
          hits.set(hit.mp, { dmg: prev.dmg + w.dmg * (hit.head ? HEADSHOT : 1), head: prev.head || hit.head });
        }
      }
      this.broadcast({ t: 'shot', id: p.id, w: p.cur, from: [r2(eye.x), r2(eye.y), r2(eye.z)], to: ends }, p.id);
      for (const [o, h] of hits) this.damage(o, h.dmg, p, p.cur, h.head, now);
    }

    if (w.mag > 0 && p.ammo[p.cur] <= 0) this.reload(p, now);
    this.sendInv(p);
  }

  private throwNade(p: MP, yaw: number, pitch: number, now: number) {
    if (this.phase !== 'live' || !p.alive || p.nades <= 0 || now < p.nextNade) return;
    p.nades--;
    p.nextNade = now + GRENADE.interval;
    const d = aimDir(yaw, pitch + 0.18); // arremesso levemente para cima
    const eye = this.eye(p);
    this.spawnProj(p, 'nade', { x: eye.x + d.x * 0.5, y: eye.y - 0.1, z: eye.z + d.z * 0.5 }, { x: d.x * GRENADE.speed + p.vx * 0.5, y: d.y * GRENADE.speed + 1.5, z: d.z * GRENADE.speed + p.vz * 0.5 }, now);
    this.sendInv(p);
  }

  private spawnProj(p: MP, kind: ProjKind, pos: Vec3, vel: Vec3, now: number) {
    const pr: Projectile = { rid: this.nextProj++, kind, owner: p.id, team: p.team, pos, vel, born: now };
    this.projs.push(pr);
    this.broadcast({ t: 'proj', rid: pr.rid, id: p.id, kind, pos: [r2(pos.x), r2(pos.y), r2(pos.z)], vel: [r2(vel.x), r2(vel.y), r2(vel.z)] });
  }

  private reload(p: MP, now: number) {
    const w = WEAPONS[p.cur];
    if (w.mag === 0 || p.ammo[p.cur] >= w.mag || p.reserve[p.cur] <= 0 || now < p.reloadUntil) return;
    p.reloadUntil = now + w.reload;
    this.sendInv(p);
  }

  private damage(target: MP, dmg: number, by: MP, w: number, head: boolean, now: number) {
    if (!target.alive || this.phase !== 'live' || now < target.protectUntil) return;
    dmg = Math.round(dmg);
    // O colete absorve parte do dano.
    const absorbed = Math.min(target.armor, dmg * ARMOR_ABSORB);
    target.armor -= absorbed;
    const hpLoss = Math.round(dmg - absorbed);
    by.stats.score += Math.min(dmg, target.hp + absorbed);
    target.hp = Math.max(0, target.hp - hpLoss);
    const hit: ServerMsg = { t: 'hit', target: target.id, by: by.id, dmg, hp: target.hp, head };
    send(target.seat?.ws, hit);
    if (by !== target) send(by.seat?.ws, hit);
    if (absorbed > 0) this.sendInv(target);
    if (target.brain) target.brain.target = by.id; // bot revida
    if (target.hp > 0) return;

    target.alive = false;
    target.respawnAt = now + RESPAWN_MS;
    target.stats.deaths++;
    if (by !== target && by.team !== target.team) {
      by.stats.kills++;
      by.stats.score += KILL_SCORE;
      if (!this.rounds) this.teams[by.team]++; // modo livre: placar = abates; rounds: placar = rounds vencidos
    }
    this.broadcast({ t: 'kill', killer: by.id, victim: target.id, w, head });
    this.broadcast({ t: 'score', teams: this.teams, stats: this.stats() });

    // Rounds: se um lado inteiro foi eliminado, o round acaba.
    if (this.rounds) {
      const alive: [number, number] = [0, 0];
      for (const p of this.players.values()) if (p.alive) alive[p.team]++;
      if (!alive[0] || !alive[1]) this.endRound(!alive[0] && !alive[1] ? -1 : alive[0] ? 0 : 1, now);
    }
  }

  // ---------- Rounds ----------
  private endRound(winner: TeamId | -1, now: number) {
    if (this.phase !== 'live') return;
    if (winner !== -1) this.teams[winner as TeamId]++;
    this.phase = 'roundEnd';
    this.phaseEnds = now + ROUND_END_MS;
    this.projs = [];
    this.broadcast({ t: 'score', teams: this.teams, stats: this.stats() });
    this.broadcastPhase(now, winner);
  }

  private matchDecided() {
    const need = Math.floor(this.rounds / 2) + 1;
    return this.teams[0] >= need || this.teams[1] >= need || this.round >= this.rounds;
  }

  /** Novo round: todos renascem na base, só com o soco; baús fecham com armas novas. */
  private startRound(now: number) {
    this.round++;
    for (const p of this.players.values()) {
      this.respawn(p);
      p.protectUntil = 0;
    }
    this.chests.forEach((c, i) => {
      if (c.open) this.broadcast({ t: 'chest', id: this.arena.chests[i].id, open: false });
      c.open = false;
    });
    this.phase = 'countdown';
    this.phaseEnds = now + ROUND_COUNTDOWN_MS;
    this.broadcastPhase(now);
  }

  private broadcastPhase(now: number, roundWinner?: TeamId | -1) {
    this.broadcast({ t: 'phase', phase: this.phase, endsAt: this.phaseEnds, now, round: this.round, wins: this.teams, roundWinner });
  }

  private endMatch(now: number) {
    this.phase = 'ended';
    this.phaseEnds = now + END_MS;
    const winner = this.teams[0] === this.teams[1] ? -1 : this.teams[0] > this.teams[1] ? 0 : 1;
    this.broadcast({ t: 'matchEnd', teams: this.teams, winner, stats: this.stats() });
    this.broadcastPhase(now);
  }

  private useChest(p: MP, now: number) {
    if (this.phase !== 'live' || !p.alive) return;
    let best = -1;
    let bestD = 2.4;
    this.arena.chests.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (!this.chests[i].open && d < bestD && p.y < 1.5) {
        best = i;
        bestD = d;
      }
    });
    if (best < 0) return;
    const w = pickChestWeapon(Math.random);
    this.chests[best] = { open: true, reopenAt: now + CHEST_RESPAWN_MS };
    p.owned[w] = true;
    p.ammo[w] = WEAPONS[w].mag;
    p.reserve[w] += WEAPONS[w].reserve;
    p.cur = w;
    p.reloadUntil = 0;
    // Extras: colete e/ou granadas.
    const armor = Math.random() < 0.4 ? ARMOR_PER_VEST : 0;
    const nades = Math.random() < 0.45 ? 2 : 0;
    p.armor = Math.min(ARMOR_MAX, p.armor + armor);
    p.nades = Math.min(GRENADE.max, p.nades + nades);
    this.broadcast({ t: 'chest', id: this.arena.chests[best].id, open: true, by: p.id, w, armor, nades });
    this.sendInv(p);
  }

  private respawn(p: MP) {
    const spawns = this.arena.spawns[p.team];
    const s = spawns[Math.floor(Math.random() * spawns.length)];
    Object.assign(p, newMover(s.x, s.z), { hp: MAX_HP, armor: 0, nades: 0, alive: true, cur: FISTS, reloadUntil: 0, nextFire: 0, protectUntil: Date.now() + SPAWN_PROTECT_MS, lastPosAt: Date.now() });
    p.owned = WEAPONS.map((_, i) => i === FISTS);
    p.ammo = WEAPONS.map(() => 0);
    p.reserve = WEAPONS.map(() => 0);
    this.broadcast({ t: 'respawn', id: p.id, x: r2(p.x), z: r2(p.z) });
    this.sendInv(p);
  }

  private explode(pr: Projectile, now: number) {
    const owner = this.players.get(pr.owner);
    this.broadcast({ t: 'boom', rid: pr.rid, kind: pr.kind, pos: [r2(pr.pos.x), r2(pr.pos.y), r2(pr.pos.z)] });
    if (!owner) return;
    const isNade = pr.kind === 'nade';
    const radius = isNade ? GRENADE.radius : WEAPONS[CANNON].projectile!.radius;
    const dmg = isNade ? GRENADE.dmg : WEAPONS[CANNON].dmg;
    for (const o of this.players.values()) {
      if (!o.alive) continue;
      if (o.team === pr.team && o !== owner) continue; // sem fogo amigo
      const d = Math.hypot(o.x - pr.pos.x, o.y + 0.9 - pr.pos.y, o.z - pr.pos.z);
      if (d >= radius) continue;
      // Cobertura protege: precisa de linha de visão até o corpo.
      if (!lineOfSight({ x: pr.pos.x, y: pr.pos.y + 0.3, z: pr.pos.z }, { x: o.x, y: o.y + 1, z: o.z }, this.arena)) continue;
      const self = o === owner ? 0.5 : 1;
      this.damage(o, (dmg * (1 - d / radius) + 8) * self, owner, isNade ? GRENADE_ID : CANNON, false, now);
    }
  }

  // ---------- Simulação ----------
  tick(dt: number, now: number) {
    if (this.finished) return;
    if (now >= this.phaseEnds) this.nextPhase(now);

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (!this.rounds && this.phase === 'live' && now >= p.respawnAt) this.respawn(p);
        continue;
      }
      if (p.brain && this.phase === 'live') this.think(p, now);
      if (p.reloadUntil && now >= p.reloadUntil) {
        const w = WEAPONS[p.cur];
        const take = Math.min(w.mag - p.ammo[p.cur], p.reserve[p.cur]);
        p.ammo[p.cur] += take;
        p.reserve[p.cur] -= take;
        p.reloadUntil = 0;
        this.sendInv(p);
      }
      if (p.brain) {
        const input = this.phase === 'live' ? p.input : { dx: 0, dz: 0, run: false, jump: false };
        p.moving = arenaMove(p, input, dt, this.arena);
      } else {
        // Humanos: posição vem do cliente (validada); aqui só o estado de animação.
        const speed = now - p.lastPosAt < 200 ? Math.hypot(p.vx, p.vz) : 0;
        p.moving = speed < 0.4 ? 0 : speed > 5.5 ? 2 : 1;
      }
    }

    // Projéteis: foguete explode no contato; granada quica e explode no pavio.
    for (const pr of [...this.projs]) {
      let boom = false;
      if (pr.kind === 'rocket') {
        const g = WEAPONS[CANNON].projectile!.gravity;
        const from = { ...pr.pos };
        boom = projStep(pr, dt, this.arena, g, 0) || now - pr.born > 6000;
        // Acerto direto em jogador no caminho
        if (!boom) {
          const dx = pr.pos.x - from.x;
          const dy = pr.pos.y - from.y;
          const dz = pr.pos.z - from.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          for (const o of this.players.values()) {
            if (!o.alive || o.id === pr.owner) continue;
            const r = rayBody(from, { x: dx / len, y: dy / len, z: dz / len }, o.x, o.z, o.y);
            if (r && r.t <= len) {
              pr.pos = { x: from.x + (dx / len) * r.t, y: from.y + (dy / len) * r.t, z: from.z + (dz / len) * r.t };
              boom = true;
              break;
            }
          }
        }
      } else {
        projStep(pr, dt, this.arena, GRENADE.gravity, GRENADE.bounce);
        boom = now - pr.born >= GRENADE.fuse;
      }
      if (boom) {
        this.projs.splice(this.projs.indexOf(pr), 1);
        this.explode(pr, now);
      }
    }

    // Baús voltam a fechar (com arma nova) depois de um tempo.
    this.chests.forEach((c, i) => {
      if (c.open && now >= c.reopenAt) {
        c.open = false;
        this.broadcast({ t: 'chest', id: this.arena.chests[i].id, open: false });
      }
    });

    this.snapAcc += dt;
    if (this.snapAcc >= 1 / 20) {
      this.snapAcc = 0;
      const s: number[] = [];
      for (const p of this.players.values()) {
        s.push(p.id, r2(p.x), r2(p.z), r2(p.y), r2(p.yaw), r2(p.pitch), p.moving, p.alive ? p.hp : 0, p.cur, Math.round(p.armor));
      }
      this.broadcast({ t: 'msnap', s });
    }
  }

  private nextPhase(now: number) {
    if (this.phase === 'countdown') {
      this.phase = 'live';
      this.phaseEnds = now + (this.rounds ? ROUND_LIMIT_MS : ROUND_MS);
      this.broadcastPhase(now);
    } else if (this.phase === 'live') {
      if (!this.rounds) return this.endMatch(now);
      // Tempo do round esgotado: vence quem tem mais gente viva (desempate: vida somada).
      const alive: [number, number] = [0, 0];
      const hp: [number, number] = [0, 0];
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        alive[p.team]++;
        hp[p.team] += p.hp;
      }
      const winner = alive[0] !== alive[1] ? (alive[0] > alive[1] ? 0 : 1) : hp[0] !== hp[1] ? (hp[0] > hp[1] ? 0 : 1) : -1;
      this.endRound(winner, now);
    } else if (this.phase === 'roundEnd') {
      if (this.matchDecided()) this.endMatch(now);
      else this.startRound(now);
    } else {
      this.finish();
    }
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.onFinish(this);
  }

  seats() {
    return [...this.players.values()].flatMap((p) => (p.seat ? [p.seat] : []));
  }

  // ---------- Bots ----------
  private think(p: MP, now: number) {
    const b = p.brain!;
    if (now >= b.nextThink) {
      b.nextThink = now + 180 + Math.random() * 120;
      const eye = this.eye(p);

      // Alvo: inimigo visível mais próximo (ou quem acabou de atacar).
      let target: MP | undefined;
      let bestD = 50;
      for (const o of this.players.values()) {
        if (o.team === p.team || !o.alive) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if ((d < bestD || o.id === b.target) && lineOfSight(eye, { x: o.x, y: o.y + 1.2, z: o.z }, this.arena)) {
          target = o;
          bestD = d;
        }
      }
      if (target && target.id !== b.target) b.reactAt = now + 450 + Math.random() * 500;
      b.target = target?.id;

      // Melhor arma para a distância (índices: 1 pistola, 2 sub, 3 fuzil, 4 shotgun, 5 sniper, 6 canhão).
      const usable = (i: number) => p.owned[i] && i !== FISTS && p.ammo[i] + p.reserve[i] > 0;
      const prefs = !target ? [3, 2, 1, 4, 5, 6] : bestD < 9 ? [4, 2, 3, 1, 6, 5] : bestD > 28 ? [5, 3, 6, 1, 2, 4] : [3, 2, 1, 4, 5, 6];
      const best = prefs.find(usable) ?? FISTS;
      if (best !== p.cur) {
        p.cur = best;
        p.reloadUntil = 0;
      }
      const armed = p.cur !== FISTS;

      // Granada de vez em quando, em alvos a média distância.
      if (target && p.nades > 0 && bestD > 8 && bestD < 22 && Math.random() < 0.06) {
        const pitch = Math.atan2(target.y - p.y, bestD) + 0.25 + bestD * 0.012;
        this.throwNade(p, Math.atan2(target.x - p.x, target.z - p.z), pitch, now);
      }

      if (!armed && (!target || bestD > 6)) {
        // Desarmado: vai ao baú fechado mais próximo.
        let chest = -1;
        let cd = Infinity;
        this.arena.chests.forEach((c, i) => {
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if (!this.chests[i].open && d < cd) {
            chest = i;
            cd = d;
          }
        });
        if (chest >= 0) {
          b.goal = { x: this.arena.chests[chest].x, z: this.arena.chests[chest].z };
          if (cd < 2) this.useChest(p, now);
        }
      } else if (target) {
        const ideal = !armed ? 1.2 : p.cur === 4 ? 5 : p.cur === 5 ? 30 : p.cur === 1 || p.cur === 2 ? 12 : 18;
        const dx = target.x - p.x;
        const dz = target.z - p.z;
        const k = bestD > ideal + 3 ? 1 : bestD < ideal - 3 ? -1 : 0;
        if (now > b.strafeUntil) {
          b.strafe = Math.random() < 0.5 ? -1 : 1;
          b.strafeUntil = now + 700 + Math.random() * 1200;
        }
        b.goal = { x: p.x + (dx / bestD) * k * 4 + (-dz / bestD) * b.strafe * 3, z: p.z + (dz / bestD) * k * 4 + (dx / bestD) * b.strafe * 3 };
      } else if (!b.goal || Math.hypot(b.goal.x - p.x, b.goal.z - p.z) < 2) {
        // Patrulha em direção ao lado inimigo.
        const enemySide = p.team === 0 ? 1 : -1;
        b.goal = { x: enemySide * Math.random() * this.arena.half * 0.8, z: (Math.random() * 2 - 1) * this.arena.half * 0.8 };
      }

      // Preso? Pula ou desvia por um tempo.
      const movedSince = Math.hypot(p.x - b.last.x, p.z - b.last.z);
      if (b.goal && Math.hypot(b.goal.x - p.x, b.goal.z - p.z) > 1 && movedSince < 0.15 && now > b.detourUntil) {
        const a = Math.random() * Math.PI * 2;
        b.detour = { x: Math.cos(a), z: Math.sin(a) };
        b.detourUntil = now + 700;
        p.input.jump = Math.random() < 0.5;
      }
      b.last = { x: p.x, z: p.z };
    }

    // Movimento
    const jump = now < b.detourUntil && p.input.jump && p.grounded;
    if (now < b.detourUntil) p.input = { dx: b.detour.x, dz: b.detour.z, run: true, jump, ads: false };
    else if (b.goal) {
      const dx = b.goal.x - p.x;
      const dz = b.goal.z - p.z;
      const d = Math.hypot(dx, dz);
      p.input = d > 0.4 ? { dx: dx / d, dz: dz / d, run: !b.target || d > 6, jump: false, ads: false } : { dx: 0, dz: 0, run: false, jump: false, ads: false };
    }

    // Mira e tiro
    const target = b.target ? this.players.get(b.target) : undefined;
    if (target?.alive) {
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      p.yaw = Math.atan2(dx, dz);
      p.pitch = Math.atan2(target.y + 1.15 - (p.y + EYE_HEIGHT), d);
      const w = WEAPONS[p.cur];
      if (now >= b.reactAt && now >= p.nextFire && d <= w.range * 0.9) {
        const err = 0.055 + d * 0.002; // bots erram um pouco, para dar chance a quem está começando
        this.fire(p, p.yaw + gauss() * err, p.pitch + gauss() * err * 0.5, p.cur === 5, now);
      }
    } else if (p.moving) {
      p.yaw = Math.atan2(p.vx, p.vz);
      p.pitch = 0;
    }
  }
}

// ---------- Fila de eventos ----------
interface QueueEntry {
  seat: Seat;
  bots: boolean;
  since: number;
}

export class Matchmaker {
  private queues = new Map<string, QueueEntry[]>();
  readonly matches = new Set<Match>();
  private bySeat = new Map<Seat, Match>();
  private lastNotify = new Map<string, number>();

  constructor(private newId: () => number, private onMatchStart: (seats: Seat[]) => void, private onMatchEnd: (seats: Seat[]) => void) {}

  matchOf(seat: Seat) {
    return this.bySeat.get(seat);
  }

  isQueued(seat: Seat) {
    return [...this.queues.values()].some((q) => q.some((e) => e.seat === seat));
  }

  enqueue(seat: Seat, mode: EventMode, size: MatchSize, rounds: number, bots: boolean) {
    if (!(ROUND_OPTIONS as readonly number[]).includes(rounds)) rounds = 0;
    if (mode !== 'fps') return send(seat.ws, { t: 'error', msg: 'Modo de evento indisponível.' });
    if (!(MATCH_SIZES as readonly number[]).includes(size)) return;
    this.dequeue(seat, false);
    const key = `${mode}:${size}:${rounds}`;
    const q = this.queues.get(key) ?? [];
    q.push({ seat, bots, since: Date.now() });
    this.queues.set(key, q);
    this.lastNotify.delete(key); // avisa o status na hora
    this.tryStart(key, Date.now());
  }

  dequeue(seat: Seat, notify = true) {
    for (const q of this.queues.values()) {
      const i = q.findIndex((e) => e.seat === seat);
      if (i >= 0) q.splice(i, 1);
    }
    if (notify) send(seat.ws, { t: 'unqueued' });
  }

  leave(seat: Seat) {
    this.dequeue(seat, false);
    const m = this.bySeat.get(seat);
    if (m) {
      this.bySeat.delete(seat);
      m.removeSeat(seat);
    }
  }

  handle(seat: Seat, msg: ClientMsg) {
    this.bySeat.get(seat)?.handle(seat, msg);
  }

  tick(dt: number, now: number) {
    for (const key of this.queues.keys()) this.tryStart(key, now);
    for (const m of this.matches) m.tick(dt, now);
  }

  private tryStart(key: string, now: number) {
    const q = this.queues.get(key);
    if (!q?.length) return;
    const [mode, sizeStr, roundsStr] = key.split(':') as [EventMode, string, string];
    const rounds = Number(roundsStr);
    const size = Number(sizeStr) as MatchSize;
    const byTeam: [QueueEntry[], QueueEntry[]] = [q.filter((e) => e.seat.team === 0), q.filter((e) => e.seat.team === 1)];
    const full = byTeam[0].length >= size && byTeam[1].length >= size;
    const oldest = Math.min(...q.map((e) => e.since));
    const fill = q.some((e) => e.bots) || now - oldest >= QUEUE_BOT_FILL_MS;

    if (full || fill) {
      const chosen = [...byTeam[0].slice(0, size), ...byTeam[1].slice(0, size)];
      for (const e of chosen) q.splice(q.indexOf(e), 1);
      const seats = chosen.map((e) => e.seat);
      this.onMatchStart(seats);
      const match = new Match(mode, size, rounds, seats, this.newId, (m) => {
        this.matches.delete(m);
        const left = m.seats().filter((s) => this.bySeat.get(s) === m);
        for (const s of left) this.bySeat.delete(s);
        this.onMatchEnd(left);
      });
      this.matches.add(match);
      for (const s of seats) this.bySeat.set(s, match);
      return;
    }

    if (now - (this.lastNotify.get(key) ?? 0) < 1000) return;
    this.lastNotify.set(key, now);
    const teams: [number, number] = [byTeam[0].length, byTeam[1].length];
    const startsIn = Math.max(0, Math.ceil((QUEUE_BOT_FILL_MS - (now - oldest)) / 1000));
    for (const e of q) send(e.seat.ws, { t: 'queued', mode, size, rounds, teams, startsIn });
  }
}

function clamp1(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
}

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}
