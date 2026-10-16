import { WebSocket } from 'ws';
import { TEAMS, type TeamId } from '../shared/config';
import { randomLook, teamClothColors, type Look } from '../shared/look';
import type { ClientMsg, EventMode, MatchPhase, MatchStat, ServerMsg } from '../shared/protocol';
import { MATCH_SIZES, arenaStep, buildArena, lineOfSight, rayBody, rayObstacles, type Arena, type MatchSize, type Vec3 } from '../shared/arena';
import { BODY_HEIGHT, EYE_HEIGHT, FISTS, HEADSHOT, MAX_HP, WEAPONS, aimDir, pickChestWeapon } from '../shared/weapons';

const COUNTDOWN_MS = 5000;
const ROUND_MS = 3 * 60 * 1000;
const END_MS = 10000;
const RESPAWN_MS = 3000;
const CHEST_RESPAWN_MS = 25000;
const QUEUE_BOT_FILL_MS = 20000; // depois disso a partida começa completando com bots
const KILL_SCORE = 100;

export interface Seat {
  ws: WebSocket;
  name: string;
  team: TeamId;
  look: Look;
}

interface MP {
  id: number;
  name: string;
  team: TeamId;
  look: Look;
  bot: boolean;
  seat?: Seat;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  moving: number;
  hp: number;
  alive: boolean;
  respawnAt: number;
  input: { dx: number; dz: number; run: boolean };
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

interface Rocket {
  rid: number;
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
  phaseEnds: number;
  teams: [number, number] = [0, 0];
  private chests: { open: boolean; reopenAt: number }[];
  private rockets: Rocket[] = [];
  private nextRocket = 1;
  private snapAcc = 0;
  finished = false;

  constructor(readonly mode: EventMode, readonly size: MatchSize, seats: Seat[], private newId: () => number, private onFinish: (m: Match) => void) {
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
      send(p.seat.ws, { t: 'match', mode, size, seed: this.seed, you: p.id, players, phase: this.phase, endsAt: this.phaseEnds, now, opened: [] });
      this.sendInv(p);
    }
  }

  private addPlayer(name: string, team: TeamId, look: Look, seat: Seat | undefined, lane: number) {
    const spawn = this.arena.spawns[team][(lane * 5) % this.arena.spawns[team].length];
    const p: MP = {
      id: this.newId(),
      name,
      team,
      look: { ...look, item: 'none' },
      bot: !seat,
      seat,
      x: spawn.x,
      z: spawn.z,
      yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
      pitch: 0,
      moving: 0,
      hp: MAX_HP,
      alive: true,
      respawnAt: 0,
      input: { dx: 0, dz: 0, run: false },
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
    if (p.seat) send(p.seat.ws, { t: 'inv', cur: p.cur, ammo: p.ammo, reserve: p.reserve.map((r, i) => (p.owned[i] ? r : -1)), reloading: p.reloadUntil > Date.now() });
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
        p.input = { dx: clamp1(msg.dx), dz: clamp1(msg.dz), run: !!msg.run };
        if (Number.isFinite(msg.yaw)) p.yaw = msg.yaw;
        if (Number.isFinite(msg.pitch)) p.pitch = Math.max(-1.4, Math.min(1.4, msg.pitch));
        break;
      case 'shoot':
        if (Number.isFinite(msg.yaw) && Number.isFinite(msg.pitch)) this.fire(p, msg.yaw, Math.max(-1.4, Math.min(1.4, msg.pitch)), now);
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
  private fire(p: MP, yaw: number, pitch: number, now: number) {
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
    const eye: Vec3 = { x: p.x, y: EYE_HEIGHT, z: p.z };

    if (p.cur === FISTS) {
      // Soco: o inimigo mais próximo à frente, dentro do alcance.
      let best: MP | undefined;
      let bestD = w.range;
      for (const o of this.players.values()) {
        if (o.team === p.team || !o.alive) continue;
        const dx = o.x - p.x;
        const dz = o.z - p.z;
        const d = Math.hypot(dx, dz);
        const ang = Math.abs(angleDiff(Math.atan2(dx, dz), yaw));
        if (d < bestD && ang < 0.7) {
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
      const rocket: Rocket = {
        rid: this.nextRocket++,
        owner: p.id,
        team: p.team,
        pos: { x: eye.x + d.x * 0.8, y: eye.y - 0.15 + d.y * 0.8, z: eye.z + d.z * 0.8 },
        vel: { x: d.x * w.projectile.speed, y: d.y * w.projectile.speed, z: d.z * w.projectile.speed },
        born: now,
      };
      this.rockets.push(rocket);
      this.broadcast({ t: 'rocket', rid: rocket.rid, id: p.id, pos: [r2(rocket.pos.x), r2(rocket.pos.y), r2(rocket.pos.z)], vel: [r2(rocket.vel.x), r2(rocket.vel.y), r2(rocket.vel.z)] });
    } else {
      const ends: [number, number, number][] = [];
      const hits = new Map<MP, { dmg: number; head: boolean }>();
      for (let i = 0; i < w.pellets; i++) {
        const d = aimDir(yaw + gauss() * w.spread, pitch + gauss() * w.spread);
        const wallT = rayObstacles(eye, d, w.range, this.arena);
        let hitT = wallT;
        let hit: { mp: MP; head: boolean } | undefined;
        for (const o of this.players.values()) {
          if (o === p || !o.alive) continue;
          const r = rayBody(eye, d, o.x, o.z);
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

  private reload(p: MP, now: number) {
    const w = WEAPONS[p.cur];
    if (w.mag === 0 || p.ammo[p.cur] >= w.mag || p.reserve[p.cur] <= 0 || now < p.reloadUntil) return;
    p.reloadUntil = now + w.reload;
    this.sendInv(p);
  }

  private damage(target: MP, dmg: number, by: MP, w: number, head: boolean, now: number) {
    if (!target.alive || this.phase !== 'live') return;
    dmg = Math.round(dmg);
    target.hp = Math.max(0, target.hp - dmg);
    by.stats.score += Math.min(dmg, target.hp + dmg);
    const hit: ServerMsg = { t: 'hit', target: target.id, by: by.id, dmg, hp: target.hp, head };
    send(target.seat?.ws, hit);
    if (by !== target) send(by.seat?.ws, hit);
    if (target.brain) target.brain.target = by.id; // bot revida
    if (target.hp > 0) return;

    target.alive = false;
    target.respawnAt = now + RESPAWN_MS;
    target.stats.deaths++;
    if (by !== target && by.team !== target.team) {
      by.stats.kills++;
      by.stats.score += KILL_SCORE;
      this.teams[by.team]++;
    }
    this.broadcast({ t: 'kill', killer: by.id, victim: target.id, w, head });
    this.broadcast({ t: 'score', teams: this.teams, stats: this.stats() });
  }

  private useChest(p: MP, now: number) {
    if (this.phase !== 'live' || !p.alive) return;
    let best = -1;
    let bestD = 2.4;
    this.arena.chests.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (!this.chests[i].open && d < bestD) {
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
    this.broadcast({ t: 'chest', id: this.arena.chests[best].id, open: true, by: p.id, w });
    this.sendInv(p);
  }

  private respawn(p: MP) {
    const spawns = this.arena.spawns[p.team];
    const s = spawns[Math.floor(Math.random() * spawns.length)];
    Object.assign(p, { x: s.x, z: s.z, hp: MAX_HP, alive: true, cur: FISTS, reloadUntil: 0, nextFire: 0 });
    p.owned = WEAPONS.map((_, i) => i === FISTS);
    p.ammo = WEAPONS.map(() => 0);
    p.reserve = WEAPONS.map(() => 0);
    this.broadcast({ t: 'respawn', id: p.id, x: r2(p.x), z: r2(p.z) });
    this.sendInv(p);
  }

  private explode(rk: Rocket, now: number) {
    const w = WEAPONS.find((x) => x.projectile)!;
    const owner = this.players.get(rk.owner);
    this.broadcast({ t: 'boom', rid: rk.rid, pos: [r2(rk.pos.x), r2(rk.pos.y), r2(rk.pos.z)] });
    if (!owner) return;
    for (const o of this.players.values()) {
      if (!o.alive || o.team === rk.team) continue;
      const d = Math.hypot(o.x - rk.pos.x, 0.9 - rk.pos.y, o.z - rk.pos.z);
      if (d < w.projectile!.radius) this.damage(o, w.dmg * (1 - d / w.projectile!.radius) + 10, owner, WEAPONS.indexOf(w), false, now);
    }
  }

  // ---------- Simulação ----------
  tick(dt: number, now: number) {
    if (this.finished) return;
    if (now >= this.phaseEnds) this.nextPhase(now);

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.phase === 'live' && now >= p.respawnAt) this.respawn(p);
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
      const canMove = this.phase === 'live';
      const moved = canMove && arenaStep(p, p.input.dx, p.input.dz, p.input.run, dt, this.arena);
      p.moving = moved ? (p.input.run ? 2 : 1) : 0;
    }

    // Projéteis do canhão
    for (const rk of [...this.rockets]) {
      const g = WEAPONS.find((x) => x.projectile)!.projectile!.gravity;
      rk.vel.y -= g * dt;
      const next = { x: rk.pos.x + rk.vel.x * dt, y: rk.pos.y + rk.vel.y * dt, z: rk.pos.z + rk.vel.z * dt };
      const len = Math.hypot(next.x - rk.pos.x, next.y - rk.pos.y, next.z - rk.pos.z);
      const dir = { x: (next.x - rk.pos.x) / len, y: (next.y - rk.pos.y) / len, z: (next.z - rk.pos.z) / len };
      let t = rayObstacles(rk.pos, dir, len, this.arena);
      for (const o of this.players.values()) {
        if (!o.alive || o.id === rk.owner) continue;
        const r = rayBody(rk.pos, dir, o.x, o.z);
        if (r && r.t < t) t = r.t;
      }
      const out = Math.abs(next.x) > this.arena.half + 5 || Math.abs(next.z) > this.arena.half + 5;
      if (t < len || out || now - rk.born > 6000) {
        rk.pos = { x: rk.pos.x + dir.x * t, y: rk.pos.y + dir.y * t, z: rk.pos.z + dir.z * t };
        this.rockets.splice(this.rockets.indexOf(rk), 1);
        this.explode(rk, now);
      } else rk.pos = next;
    }

    // Baús voltam a fechar (com arma nova) depois de um tempo.
    this.chests.forEach((c, i) => {
      if (c.open && now >= c.reopenAt) {
        c.open = false;
        this.broadcast({ t: 'chest', id: this.arena.chests[i].id, open: false });
      }
    });

    this.snapAcc += dt;
    if (this.snapAcc >= 1 / 15) {
      this.snapAcc = 0;
      const s: number[] = [];
      for (const p of this.players.values()) {
        s.push(p.id, r2(p.x), r2(p.z), r2(p.yaw), r2(p.pitch), p.moving, p.alive ? p.hp : 0, p.cur);
      }
      this.broadcast({ t: 'msnap', s });
    }
  }

  private nextPhase(now: number) {
    if (this.phase === 'countdown') {
      this.phase = 'live';
      this.phaseEnds = now + ROUND_MS;
    } else if (this.phase === 'live') {
      this.phase = 'ended';
      this.phaseEnds = now + END_MS;
      const winner = this.teams[0] === this.teams[1] ? -1 : this.teams[0] > this.teams[1] ? 0 : 1;
      this.broadcast({ t: 'matchEnd', teams: this.teams, winner, stats: this.stats() });
    } else {
      this.finish();
      return;
    }
    this.broadcast({ t: 'phase', phase: this.phase, endsAt: this.phaseEnds, now });
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
      const eye = { x: p.x, y: EYE_HEIGHT, z: p.z };

      // Alvo: inimigo visível mais próximo (ou quem acabou de atacar).
      let target: MP | undefined;
      let bestD = 45;
      for (const o of this.players.values()) {
        if (o.team === p.team || !o.alive) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if ((d < bestD || o.id === b.target) && lineOfSight(eye, { x: o.x, y: 1.2, z: o.z }, this.arena)) {
          target = o;
          bestD = d;
        }
      }
      if (target && target.id !== b.target) b.reactAt = now + 250 + Math.random() * 350;
      b.target = target?.id;

      // Melhor arma para a distância.
      const usable = (i: number) => p.owned[i] && i !== FISTS && p.ammo[i] + p.reserve[i] > 0;
      const prefs = !target ? [2, 1, 3, 4] : bestD < 9 ? [3, 2, 1, 4] : bestD > 22 ? [2, 4, 1, 3] : [2, 1, 3, 4];
      const best = prefs.find(usable) ?? FISTS;
      if (best !== p.cur) {
        p.cur = best;
        p.reloadUntil = 0;
      }
      const armed = p.cur !== FISTS;

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
        const ideal = !armed ? 1.2 : p.cur === 3 ? 5 : p.cur === 1 ? 13 : 18;
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

      // Preso? Desvia por um tempo.
      const movedSince = Math.hypot(p.x - b.last.x, p.z - b.last.z);
      if (p.moving && movedSince < 0.12 && now > b.detourUntil) {
        const a = Math.random() * Math.PI * 2;
        b.detour = { x: Math.cos(a), z: Math.sin(a) };
        b.detourUntil = now + 700;
      }
      b.last = { x: p.x, z: p.z };
    }

    // Movimento
    if (now < b.detourUntil) p.input = { dx: b.detour.x, dz: b.detour.z, run: true };
    else if (b.goal) {
      const dx = b.goal.x - p.x;
      const dz = b.goal.z - p.z;
      const d = Math.hypot(dx, dz);
      p.input = d > 0.4 ? { dx: dx / d, dz: dz / d, run: !b.target || d > 6 } : { dx: 0, dz: 0, run: false };
    }

    // Mira e tiro
    const target = b.target ? this.players.get(b.target) : undefined;
    if (target?.alive) {
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      p.yaw = Math.atan2(dx, dz);
      p.pitch = Math.atan2(1.15 - EYE_HEIGHT, d);
      const w = WEAPONS[p.cur];
      if (now >= b.reactAt && now >= p.nextFire && d <= w.range * 0.9) {
        const err = 0.03 + d * 0.0015;
        this.fire(p, p.yaw + gauss() * err, p.pitch + gauss() * err * 0.5, now);
      }
    } else if (p.moving) {
      p.yaw = Math.atan2(p.input.dx, p.input.dz);
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

  enqueue(seat: Seat, mode: EventMode, size: MatchSize, bots: boolean) {
    if (mode !== 'fps') return send(seat.ws, { t: 'error', msg: 'O modo Porrada chega em breve. Por enquanto, só o FPS está disponível.' });
    if (!(MATCH_SIZES as readonly number[]).includes(size)) return;
    this.dequeue(seat, false);
    const key = `${mode}:${size}`;
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
    const [mode, sizeStr] = key.split(':') as [EventMode, string];
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
      const match = new Match(mode, size, seats, this.newId, (m) => {
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
    for (const e of q) send(e.seat.ws, { t: 'queued', mode, size, teams, startsIn });
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
