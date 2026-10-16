import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AGGRESSION, BOTS_PER_TEAM, EMOTES, JAIL, JAIL_MS, LIMITS, MAX_PLAYERS, POLICE_LINE, SNAPSHOT_RATE, SOCIALS, SPAWN, TICK_RATE, TRUCKS, WORLD,
  type Social, type TeamId,
} from '../shared/config';
import type { ClientMsg, PlayerInfo, RosterEntry, ServerMsg } from '../shared/protocol';
import { cleanText, randomLook, sanitizeLook, teamClothColors } from '../shared/look';
import { clamp, resolve, step } from '../shared/physics';
import type { MatchSize } from '../shared/arena';
import { Matchmaker, type Seat } from './match';

const PORT = Number(process.env.PORT ?? 3001);
const DIST = resolvePath(fileURLToPath(new URL('.', import.meta.url)), '../dist');

interface Player extends PlayerInfo {
  ws?: WebSocket; // ausente nos bots
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  input: { dx: number; dz: number; run: boolean };
  lastChat: number;
  lastEmote: number;
  lastLook: number;
  brain?: Brain;
  role?: 'police';
  patrol?: Patrol;
  // Avenida: agressão, prisão e interações
  jail?: { where: 'cell' | 'outside'; until: number };
  knockUntil?: number;
  slide?: { vx: number; vz: number; until: number };
  hits?: number[];
  lastAttack?: number;
  social?: { with: number; kind: Social };
  ask?: { from: number; kind: Social; at: number };
  lastAsk?: number;
}

interface Conn {
  ws: WebSocket;
  ip: string;
  player?: Player;
  seat?: Seat; // presente quando está na fila ou numa partida de evento
  alive: boolean;
}

const players = new Map<number, Player>();
const conns = new Set<Conn>();
const ipCount = new Map<string, number>();
let nextId = 1;

// Eventos (FPS): ao começar a partida, o jogador sai da avenida; ao terminar, o cliente entra de novo.
const matchmaker = new Matchmaker(
  () => nextId++,
  (seats) => {
    for (const c of conns) if (c.seat && seats.includes(c.seat)) removePlayer(c);
  },
  () => broadcastAll(stats()),
);

// ---------- HTTP: serve o build do cliente em produção ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return void res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return void res.end('Servidor do jogo rodando. Em desenvolvimento, abra o Vite (npm run dev).');
  }
  const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
  if (file.startsWith(join(DIST, 'assets'))) headers['cache-control'] = 'public, max-age=31536000, immutable';
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

// HTTP e HTTPS na MESMA porta: o primeiro byte da conexão diz se é TLS (0x16) ou HTTP puro.
// Assim funciona tanto em http:// quanto em https:// (celulares que forçam HTTPS).
// Certificado: TLS_CERT/TLS_KEY ou credenciais do systemd (LoadCredential=cert/key).
const credDir = process.env.CREDENTIALS_DIRECTORY;
const certFile = process.env.TLS_CERT ?? (credDir ? join(credDir, 'cert') : '');
const keyFile = process.env.TLS_KEY ?? (credDir ? join(credDir, 'key') : '');
const http = createServer(serveStatic);
const https = certFile && keyFile && existsSync(certFile) && existsSync(keyFile)
  ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, serveStatic)
  : undefined;
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
};
http.on('upgrade', onUpgrade);
https?.on('upgrade', onUpgrade);
const front = createNetServer((socket) => {
  socket.on('error', () => socket.destroy());
  socket.once('data', (buf) => {
    socket.pause();
    socket.unshift(buf);
    (https && buf[0] === 0x16 ? https : http).emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
});

// ---------- Utilidades ----------
function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg, except?: number) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.ws && p.id !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function broadcastAll(msg: ServerMsg) {
  const data = JSON.stringify(msg);
  for (const c of conns) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
}

function info(p: Player): PlayerInfo {
  if (p.role) return { id: p.id, name: 'Polícia', team: p.team, look: p.look, bot: true, role: p.role };
  return p.bot ? { id: p.id, name: '', team: p.team, look: p.look, bot: true } : { id: p.id, name: p.name, team: p.team, look: p.look };
}

function humans() {
  let n = 0;
  for (const p of players.values()) if (!p.bot) n++;
  return n;
}

function stats(): ServerMsg {
  const teams: [number, number] = [0, 0];
  for (const p of players.values()) if (!p.bot) teams[p.team]++;
  return { t: 'stats', teams, online: teams[0] + teams[1] };
}

function spawnPoint(team: TeamId) {
  const zone = SPAWN[team];
  const b = { x: zone.minX + Math.random() * (zone.maxX - zone.minX), z: (Math.random() - 0.5) * 20 };
  resolve(b);
  return b;
}

// ---------- Conexões ----------
wss.on('connection', (ws, req) => {
  const ip = (req.headers['cf-connecting-ip'] as string) ?? (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '?';
  const count = ipCount.get(ip) ?? 0;
  if (count >= LIMITS.connectionsPerIp) {
    send(ws, { t: 'error', msg: 'Muitas conexões a partir do seu endereço.' });
    return ws.close();
  }
  ipCount.set(ip, count + 1);

  const conn: Conn = { ws, ip, alive: true };
  conns.add(conn);
  send(ws, stats());

  ws.on('pong', () => (conn.alive = true));
  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    handle(conn, msg);
  });
  ws.on('close', () => {
    conns.delete(conn);
    const n = (ipCount.get(ip) ?? 1) - 1;
    if (n <= 0) ipCount.delete(ip);
    else ipCount.set(ip, n);
    if (conn.seat) matchmaker.leave(conn.seat);
    removePlayer(conn);
  });
});

function removePlayer(conn: Conn) {
  if (!conn.player) return;
  endSocial(conn.player);
  players.delete(conn.player.id);
  broadcast({ t: 'remove', id: conn.player.id });
  conn.player = undefined;
  broadcastAll(stats());
}

function handle(conn: Conn, msg: ClientMsg) {
  const p = conn.player;
  const now = Date.now();
  switch (msg?.t) {
    case 'ping':
      send(conn.ws, { t: 'pong', ts: Number(msg.ts) || 0 });
      break;

    case 'join': {
      if (p || (conn.seat && matchmaker.matchOf(conn.seat))) return;
      if (humans() >= MAX_PLAYERS) return send(conn.ws, { t: 'error', msg: 'A avenida está lotada. Tente de novo em instantes.' });
      const team: TeamId = msg.team === 1 ? 1 : 0;
      const at = spawnPoint(team);
      const player: Player = {
        id: nextId++,
        name: cleanText(msg.name, LIMITS.name) || `Manifestante${Math.floor(Math.random() * 900 + 100)}`,
        team,
        look: sanitizeLook(msg.look),
        ws: conn.ws,
        ...at,
        yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
        moving: false,
        input: { dx: 0, dz: 0, run: false },
        lastChat: 0,
        lastEmote: 0,
        lastLook: 0,
      };
      conn.player = player;
      players.set(player.id, player);
      send(conn.ws, { t: 'welcome', id: player.id, x: player.x, z: player.z, players: [...players.values()].map(info) });
      broadcast({ t: 'add', p: info(player) }, player.id);
      broadcastAll(stats());
      // Sair e entrar de novo não tira ninguém da cadeia (a pena fica guardada por IP).
      const pending = jailByIp.get(conn.ip);
      if (pending && pending.until > now) putInJail(player, pending.where, 'cumprindo o resto da pena', now, pending.until);
      break;
    }

    case 'input': {
      if (!p) return;
      if ((p.knockUntil ?? 0) > now) return; // caído no chão
      p.input = { dx: clamp(Number(msg.dx) || 0, -1, 1), dz: clamp(Number(msg.dz) || 0, -1, 1), run: !!msg.run };
      // Parado, vale a direção para onde o jogador olha (primeira pessoa / golpes e interações).
      if (!p.input.dx && !p.input.dz && Number.isFinite(msg.yaw)) p.yaw = Number(msg.yaw);
      break;
    }

    // ----- Agressão (F bate, G empurra) -----
    case 'attack': {
      if (!p || p.jail || (p.knockUntil ?? 0) > now || now - (p.lastAttack ?? 0) < AGGRESSION.intervalMs) return;
      p.lastAttack = now;
      attack(p, msg.kind === 'push' ? 'push' : 'hit', now, conn, !!msg.ambient);
      break;
    }

    // ----- Interações em dupla (T) -----
    case 'social': {
      if (!p || p.jail || !(SOCIALS as readonly string[]).includes(msg.kind)) return;
      const target = players.get(Number(msg.target));
      if (!target || target === p || target.jail || Math.hypot(target.x - p.x, target.z - p.z) > 2.8) {
        return send(conn.ws, { t: 'notice', text: 'Chegue mais perto e fique de frente para a pessoa.' });
      }
      // Discutir não precisa de aceite (é bate-boca): começa na hora; quem não quiser, sai andando.
      if (msg.kind === 'argue') {
        if (target.role === 'police') startSocial(target, p, 'argue', now);
        else startSocial(p, target, 'argue', now);
        if (target.ws) send(target.ws, { t: 'notice', text: `😠 ${p.name} começou uma discussão com você. Ande para sair.` });
        return;
      }
      if (target.bot) {
        // Bots e policiais aceitam quase sempre. O policial fica no posto: quem se posiciona é você.
        const police = target.role === 'police';
        if (Math.random() < (police ? 0.75 : 0.85)) {
          if (police) startSocial(target, p, msg.kind, now);
          else startSocial(p, target, msg.kind, now);
        } else send(conn.ws, { t: 'notice', text: police ? 'O policial recusou. 👮' : 'A pessoa recusou. 🙅' });
        return;
      }
      if (now - (p.lastAsk ?? 0) < 3000) return;
      p.lastAsk = now;
      target.ask = { from: p.id, kind: msg.kind, at: now };
      if (target.ws) send(target.ws, { t: 'socialAsk', from: p.id, kind: msg.kind });
      send(conn.ws, { t: 'notice', text: `Pedido enviado para ${target.name}. Aguardando resposta…` });
      break;
    }

    case 'socialReply': {
      if (!p?.ask || p.ask.from !== Number(msg.from) || now - p.ask.at > 15000) return;
      const { kind } = p.ask;
      p.ask = undefined;
      const from = players.get(Number(msg.from));
      if (!from) return;
      if (msg.accept && !from.jail && !p.jail && Math.hypot(from.x - p.x, from.z - p.z) < 4) startSocial(from, p, kind, now);
      else if (from.ws) send(from.ws, { t: 'notice', text: `${p.name} recusou.` });
      break;
    }

    case 'who':
      send(conn.ws, { t: 'roster', list: roster() });
      break;

    case 'chat': {
      if (!p || now - p.lastChat < LIMITS.chatIntervalMs) return;
      const text = cleanText(msg.text, LIMITS.chat);
      if (!text) return;
      p.lastChat = now;
      broadcast({ t: 'chat', id: p.id, text });
      break;
    }

    case 'emote': {
      if (!p || now - p.lastEmote < LIMITS.emoteIntervalMs) return;
      if (!(EMOTES as readonly string[]).includes(msg.e)) return;
      p.lastEmote = now;
      broadcast({ t: 'emote', id: p.id, e: msg.e });
      break;
    }

    case 'look': {
      if (!p || now - p.lastLook < LIMITS.lookIntervalMs) return;
      p.lastLook = now;
      p.look = sanitizeLook(msg.look);
      broadcast({ t: 'look', id: p.id, look: p.look });
      break;
    }

    case 'leave':
      if (conn.seat) matchmaker.dequeue(conn.seat, false);
      removePlayer(conn);
      break;

    // ----- Eventos -----
    case 'queue': {
      if (!p) return send(conn.ws, { t: 'error', msg: 'Entre na avenida antes de procurar um evento.' });
      if (p.jail) return send(conn.ws, { t: 'notice', text: 'Você está preso. Espere a pena acabar para entrar em eventos.' });
      if (conn.seat && matchmaker.matchOf(conn.seat)) return;
      conn.seat = { ws: conn.ws, name: p.name, team: p.team, look: p.look };
      matchmaker.enqueue(conn.seat, msg.mode, Number(msg.size) as MatchSize, Number(msg.rounds) || 0, !!msg.bots);
      break;
    }
    case 'unqueue':
      if (conn.seat) matchmaker.dequeue(conn.seat);
      break;
    case 'quitMatch':
      if (conn.seat) matchmaker.leave(conn.seat);
      break;
    case 'minput':
    case 'shoot':
    case 'reload':
    case 'use':
    case 'switch':
      if (conn.seat) matchmaker.handle(conn.seat, msg);
      break;
  }
}

// ---------- Bots ----------
// Andam pela zona do seu lado (mais perto do carro de som), param, olham em volta e fazem gestos.
// Não falam e não aparecem na contagem de pessoas online.
interface Brain {
  state: 'idle' | 'walk';
  until: number;
  tx: number;
  tz: number;
  run: boolean;
  nextEmote: number;
  nextTurn: number;
}

function botTarget(p: Player) {
  const truck = TRUCKS.find((t) => t.team === p.team)!;
  const zone = SPAWN[p.team];
  // 60%: em volta do carro de som; 40%: um passeio mais longo pela zona do lado.
  const near = Math.random() < 0.6;
  const x = near ? truck.x + (Math.random() - 0.5) * 50 : p.x + (Math.random() - 0.5) * 60;
  const z = near ? (Math.random() - 0.5) * 2 * (WORLD.halfWidth - 2) : p.z + (Math.random() - 0.5) * 20;
  return { x: clamp(x, zone.minX - 15, zone.maxX + 15), z: clamp(z, -WORLD.halfWidth + 1, WORLD.halfWidth - 1) };
}

function spawnBots() {
  for (const team of [0, 1] as const) {
    const teamColors = teamClothColors(team);
    for (let i = 0; i < BOTS_PER_TEAM; i++) {
      const truck = TRUCKS.find((t) => t.team === team)!;
      const b = { x: truck.x + (Math.random() - 0.5) * 60, z: (Math.random() - 0.5) * 2 * (WORLD.halfWidth - 2) };
      resolve(b);
      const now = Date.now();
      const bot: Player = {
        id: nextId++,
        name: '',
        team,
        look: randomLook(Math.random, teamColors),
        bot: true,
        ...b,
        yaw: Math.random() * Math.PI * 2,
        moving: false,
        input: { dx: 0, dz: 0, run: false },
        lastChat: 0,
        lastEmote: 0,
        lastLook: 0,
        brain: { state: 'idle', until: now + Math.random() * 6000, tx: 0, tz: 0, run: false, nextEmote: now + 3000 + Math.random() * 15000, nextTurn: now + Math.random() * 4000 },
      };
      players.set(bot.id, bot);
    }
  }
}

// ---------- Avenida: agressão, prisão e interações ----------
const jailByIp = new Map<string, { where: 'cell' | 'outside'; until: number }>();
const r2 = (v: number) => Math.round(v * 100) / 100;

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Quem está logo à frente (dentro do alcance e do ângulo). */
function facingTarget(p: Player, range: number, maxAngle = 0.85): Player | undefined {
  let best: Player | undefined;
  let bestD = range;
  for (const o of players.values()) {
    if (o === p || o.jail) continue;
    const dx = o.x - p.x;
    const dz = o.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD && Math.abs(angleDiff(Math.atan2(dx, dz), p.yaw)) < maxAngle) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function jailRect(p: Player) {
  return p.jail ? JAIL[p.jail.where] : undefined;
}

function attack(p: Player, kind: 'hit' | 'push', now: number, conn: Conn, ambient = false) {
  const target = facingTarget(p, AGGRESSION.range);
  if (!target) {
    broadcast({ t: 'attack', id: p.id, target: 0, kind, knocked: false }); // golpe no ar (ou na multidão de fundo)
    // Acertou alguém da multidão de fundo (detectado no cliente): também é agressão para a polícia.
    if (ambient && policeSees(p)) arrest(p, 'cell', kind === 'push' ? 'empurrou uma pessoa' : 'agrediu uma pessoa', now, conn);
    return;
  }
  endSocial(p);
  endSocial(target);
  const dx = target.x - p.x;
  const dz = target.z - p.z;
  const d = Math.hypot(dx, dz) || 1;
  // Quem apanha desliza para trás (policial não sai do lugar); quem bate dá um passo à frente.
  const dist = target.role === 'police' ? 0 : kind === 'push' ? AGGRESSION.push : 0.5;
  startSlide(target, (dx / d) * dist, (dz / d) * dist, kind === 'push' ? 320 : 200, now);
  startSlide(p, (dx / d) * 0.3, (dz / d) * 0.3, 150, now);
  let knocked = false;
  if (kind === 'hit') {
    target.hits = (target.hits ?? []).filter((t) => now - t < 10_000);
    target.hits.push(now);
    if (target.hits.length >= AGGRESSION.knockHits) {
      knocked = true;
      target.hits = [];
      target.knockUntil = now + AGGRESSION.knockMs;
      target.input = { dx: 0, dz: 0, run: false };
    }
  }
  broadcast({ t: 'attack', id: p.id, target: target.id, kind, knocked });
  if (target.brain) {
    // Bot leva um susto e fica parado um instante.
    Object.assign(target.brain, { state: 'idle', until: now + (knocked ? AGGRESSION.knockMs : 1500) });
    target.input = { dx: 0, dz: 0, run: false };
  }

  if (target.role === 'police') return arrest(p, 'outside', 'agrediu um policial', now, conn);
  if (policeSees(p)) arrest(p, 'cell', kind === 'push' ? 'empurrou uma pessoa' : 'agrediu uma pessoa', now, conn);
}

/** Deslize suave (em vez de teletransporte): aplicado no servidor e repetido pelo cliente do próprio jogador. */
function startSlide(p: Player, dx: number, dz: number, ms: number, now: number) {
  if (!dx && !dz) return;
  const s = ms / 1000;
  p.slide = { vx: dx / s, vz: dz / s, until: now + ms };
  if (p.ws) send(p.ws, { t: 'slide', vx: r2(dx / s), vz: r2(dz / s), ms });
}

/** Algum policial viu? Perto ele percebe sempre; mais longe, só se estiver olhando para o lado. */
function policeSees(p: Player) {
  for (const o of players.values()) {
    if (o.role !== 'police') continue;
    const dx = p.x - o.x;
    const dz = p.z - o.z;
    const d = Math.hypot(dx, dz);
    if (d < AGGRESSION.policeHear || (d < AGGRESSION.policeSight && Math.abs(angleDiff(Math.atan2(dx, dz), o.yaw)) < 1.1)) {
      o.yaw = Math.atan2(dx, dz); // o policial que viu se vira para quem agrediu
      return true;
    }
  }
  return false;
}

function arrest(p: Player, where: 'cell' | 'outside', reason: string, now: number, conn: Conn) {
  const until = now + JAIL_MS;
  jailByIp.set(conn.ip, { where, until });
  putInJail(p, where, reason, now, until);
  broadcast({ t: 'notice', text: `🚔 ${p.name} foi preso(a) ${where === 'outside' ? 'e levado(a) para fora da avenida' : 'na prisão preventiva'}: ${reason}.` });
}

function putInJail(p: Player, where: 'cell' | 'outside', reason: string, now: number, until: number) {
  endSocial(p);
  p.jail = { where, until };
  const r = JAIL[where];
  p.x = r.x + (Math.random() - 0.5) * r.halfX;
  p.z = r.z + (Math.random() - 0.5) * r.halfZ;
  p.input = { dx: 0, dz: 0, run: false };
  if (p.ws) {
    send(p.ws, { t: 'jail', until, now, where, reason });
    send(p.ws, { t: 'moved', x: r2(p.x), z: r2(p.z) });
  }
}

function release(p: Player) {
  p.jail = undefined;
  const at = spawnPoint(p.team);
  p.x = at.x;
  p.z = at.z;
  if (p.ws) {
    send(p.ws, { t: 'free' });
    send(p.ws, { t: 'moved', x: r2(p.x), z: r2(p.z) });
  }
  broadcast({ t: 'notice', text: `🔓 ${p.name} foi solto(a).` });
}

/** Posiciona a dupla (de frente para abraçar/beijar, lado a lado para dar as mãos) e avisa todos. */
function startSocial(a: Player, b: Player, kind: Social, now: number) {
  endSocial(a);
  endSocial(b);
  const fx = Math.sin(a.yaw);
  const fz = Math.cos(a.yaw);
  if (kind === 'hand') {
    // à direita de quem pediu, olhando para o mesmo lado
    b.x = a.x - fz * 0.5;
    b.z = a.z + fx * 0.5;
    b.yaw = a.yaw;
  } else {
    // Abraço/beijo: perto o bastante para os corpos se encostarem; discussão: cara a cara, a um passo.
    const dist = kind === 'argue' ? 1.0 : kind === 'kiss' ? 0.33 : 0.32;
    b.x = a.x + fx * dist;
    b.z = a.z + fz * dist;
    b.yaw = a.yaw + Math.PI;
  }
  a.social = { with: b.id, kind };
  b.social = { with: a.id, kind };
  for (const p of [a, b]) {
    p.input = { dx: 0, dz: 0, run: false };
    if (p.brain) Object.assign(p.brain, { state: 'idle', until: now + 8000 + Math.random() * 6000 });
    if (p.ws) send(p.ws, { t: 'moved', x: r2(p.x), z: r2(p.z), yaw: r2(p.yaw) });
  }
  broadcast({ t: 'socialStart', a: a.id, b: b.id, kind, ayaw: r2(a.yaw), byaw: r2(b.yaw) });
}

function endSocial(p: Player) {
  if (!p.social) return;
  const other = players.get(p.social.with);
  p.social = undefined;
  if (other?.social?.with === p.id) other.social = undefined;
  broadcast({ t: 'socialEnd', a: p.id, b: other?.id ?? 0 });
}

function roster(): RosterEntry[] {
  const list: RosterEntry[] = [];
  for (const c of conns) {
    if (c.player) list.push({ name: c.player.name, team: c.player.team, where: c.player.jail ? 'preso' : c.seat && matchmaker.isQueued(c.seat) ? 'fila' : 'avenida' });
    else if (c.seat && matchmaker.matchOf(c.seat)) list.push({ name: c.seat.name, team: c.seat.team, where: 'evento' });
  }
  return list.sort((a, b) => a.team - b.team || a.name.localeCompare(b.name));
}

// ---------- Polícia ----------
// Duplas patrulham a avenida de ponta a ponta, lado a lado, parando nos pontos de checagem.
interface Patrol {
  leader: Player;
  lane: number; // z da dupla
  dir: 1 | -1;
  tx: number;
  state: 'walk' | 'stop';
  until: number;
  nextTurn: number;
  solo?: boolean; // policial avulso: anda por toda a avenida, inclusive calçadas
}

const POLICE_PAIRS = 6;
// Farda: boné, manga longa e calça azul-marinho, coturno preto (índices de CLOTH_COLORS).
const POLICE_LOOK = (skin: number) =>
  sanitizeLook({
    skin,
    hair: 1,
    head: { s: 2, c: 10, a: 1, p: 0 },
    torso: { s: 2, c: 10, a: 1, p: 0 },
    legs: { s: 0, c: 10, a: 0, p: 0 },
    feet: { s: 1, c: 1, a: 1, p: 0 },
    print: 0,
    item: 'none',
  });

function spawnPolice() {
  for (let i = 0; i < POLICE_PAIRS; i++) {
    const lane = (i % 2 ? 1 : -1) * (3 + Math.random() * 6);
    const x = -150 + (300 / POLICE_PAIRS) * i + Math.random() * 20;
    const dir: 1 | -1 = i % 2 ? 1 : -1;
    let leader: Player | undefined;
    for (let k = 0; k < 2; k++) {
      const p: Player = {
        id: nextId++,
        name: 'Polícia',
        team: 0,
        look: POLICE_LOOK(Math.floor(Math.random() * 6)),
        bot: true,
        role: 'police',
        x: x + (k ? -1 : 0) * 0.4,
        z: lane + k * 1.4,
        yaw: dir > 0 ? Math.PI / 2 : -Math.PI / 2,
        moving: false,
        input: { dx: 0, dz: 0, run: false },
        lastChat: 0,
        lastEmote: 0,
        lastLook: 0,
      };
      if (!leader) leader = p;
      p.patrol = { leader, lane, dir, tx: x + dir * 50, state: 'walk', until: 0, nextTurn: 0 };
      if (k) p.patrol = leader.patrol; // o parceiro compartilha a mesma patrulha
      players.set(p.id, p);
    }
  }
}

/** Policiais avulsos andando pela avenida toda (calçadas incluídas), parando de vez em quando. */
function spawnSoloPolice() {
  for (let i = 0; i < 8; i++) {
    const x = -160 + (320 / 8) * i + Math.random() * 20;
    const z = (Math.random() * 2 - 1) * (WORLD.halfWidth - 2);
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const p: Player = {
      id: nextId++,
      name: 'Polícia',
      team: 0,
      look: POLICE_LOOK(Math.floor(Math.random() * 6)),
      bot: true,
      role: 'police',
      x,
      z,
      yaw: dir > 0 ? Math.PI / 2 : -Math.PI / 2,
      moving: false,
      input: { dx: 0, dz: 0, run: false },
      lastChat: 0,
      lastEmote: 0,
      lastLook: 0,
    };
    p.patrol = { leader: p, lane: z, dir, tx: x + dir * 30, state: 'walk', until: 0, nextTurn: 0, solo: true };
    players.set(p.id, p);
  }
}

/** Barreira: duas fileiras paradas no meio da avenida, uma virada para cada lado. */
function spawnPoliceLine() {
  for (const row of [-1, 1]) {
    for (let z = -POLICE_LINE.halfZ + 0.8; z <= POLICE_LINE.halfZ - 0.6; z += 2.4) {
      const p: Player = {
        id: nextId++,
        name: 'Polícia',
        team: 0,
        look: POLICE_LOOK(Math.floor(Math.random() * 6)),
        bot: true,
        role: 'police',
        x: POLICE_LINE.x + row * 0.8,
        z: z + (row > 0 ? 1.2 : 0),
        yaw: row > 0 ? Math.PI / 2 : -Math.PI / 2, // fileira da direita olha para +x, da esquerda para -x
        moving: false,
        input: { dx: 0, dz: 0, run: false },
        lastChat: 0,
        lastEmote: 0,
        lastLook: 0,
      };
      players.set(p.id, p);
    }
  }
}

function thinkPolice(p: Player, now: number) {
  const pt = p.patrol!;
  // Durante uma interação, o policial (e a dupla dele) para; depois retoma a ronda.
  const partnerBusy = [...players.values()].some((o) => o.patrol === pt && o.social);
  if (p.social || partnerBusy || (p.knockUntil ?? 0) > now) {
    p.input = { dx: 0, dz: 0, run: false };
    if (pt.leader === p) pt.until = Math.max(pt.until, now + 2000);
    return;
  }
  const isLeader = pt.leader === p;
  if (isLeader) {
    if (pt.state === 'walk') {
      const dx = pt.tx - p.x;
      const dz = pt.lane - p.z;
      if (Math.abs(dx) < 1) {
        Object.assign(pt, { state: 'stop', until: now + 3000 + Math.random() * 6000 });
      }
      p.input = { dx: Math.sign(dx), dz: clamp(dz * 0.3, -0.4, 0.4), run: false };
    } else {
      p.input = { dx: 0, dz: 0, run: false };
      if (now > pt.nextTurn) {
        p.yaw += (Math.random() - 0.5) * 2.4; // olha em volta
        pt.nextTurn = now + 1500 + Math.random() * 2500;
      }
      if (now > pt.until) {
        // Próximo ponto de checagem; inverte nas pontas da avenida.
        let nx = p.x + pt.dir * (40 + Math.random() * 50);
        if (Math.abs(nx) > WORLD.halfLength - 12) {
          pt.dir = pt.dir > 0 ? -1 : 1;
          nx = p.x + pt.dir * (40 + Math.random() * 40);
        }
        pt.lane = pt.solo ? (Math.random() * 2 - 1) * (WORLD.halfWidth - 2) : clamp(pt.lane + (Math.random() - 0.5) * 6, -WORLD.halfWidth + 3, WORLD.halfWidth - 3);
        Object.assign(pt, { tx: nx, state: 'walk' });
      }
    }
  } else {
    // Parceiro: anda ao lado do líder (1,4 m para o lado), mesmo ritmo.
    const L = pt.leader;
    const side = { x: -Math.cos(L.yaw) * 1.4, z: Math.sin(L.yaw) * 1.4 };
    const dx = L.x + side.x - p.x;
    const dz = L.z + side.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.4) p.input = { dx, dz, run: d > 4 };
    else {
      p.input = { dx: 0, dz: 0, run: false };
      p.yaw = L.yaw + (pt.state === 'stop' ? 0.8 : 0); // parado, vigia o outro lado
    }
  }
}

function thinkBot(p: Player, now: number) {
  const b = p.brain!;
  if (b.state === 'idle') {
    p.input = { dx: 0, dz: 0, run: false };
    if (now > b.nextTurn) {
      p.yaw += (Math.random() - 0.5) * 2;
      b.nextTurn = now + 2000 + Math.random() * 5000;
    }
    if (now > b.nextEmote) {
      // Ações ficam em loop até o bot voltar a andar; então ele fica parado um tempo fazendo a ação.
      const actions = EMOTES.filter((e) => e !== 'stop');
      const e = actions[Math.floor(Math.random() * actions.length)];
      broadcast({ t: 'emote', id: p.id, e });
      b.nextEmote = now + 9000 + Math.random() * 16000;
      b.until = Math.max(b.until, now + (e === 'jump' ? 1200 : 5000 + Math.random() * 7000));
    }
    if (now > b.until) {
      const t = botTarget(p);
      Object.assign(b, { state: 'walk', tx: t.x, tz: t.z, run: Math.random() < 0.12, until: now + 25000 });
    }
  } else {
    const dx = b.tx - p.x;
    const dz = b.tz - p.z;
    if (Math.hypot(dx, dz) < 1 || now > b.until) {
      Object.assign(b, { state: 'idle', until: now + 2000 + Math.random() * 9000 });
      p.input = { dx: 0, dz: 0, run: false };
    } else {
      p.input = { dx, dz, run: b.run };
    }
  }
}

// ---------- Simulação ----------
const dt = 1 / TICK_RATE;
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (p.jail && now >= p.jail.until) release(p);
    const knocked = (p.knockUntil ?? 0) > now;
    if (p.brain && !knocked) thinkBot(p, now);
    else if (p.patrol) thinkPolice(p, now);
    if (knocked) p.input = { dx: 0, dz: 0, run: false };
    // Bots não colidem entre si; normalizamos a direção do input dos bots aqui.
    const len = Math.hypot(p.input.dx, p.input.dz);
    const dx = p.brain && len > 0 ? p.input.dx / len : p.input.dx;
    const dz = p.brain && len > 0 ? p.input.dz / len : p.input.dz;
    p.moving = step(p, dx, dz, p.input.run, dt, jailRect(p));
    if (p.slide) {
      if (now >= p.slide.until) p.slide = undefined;
      else {
        p.x += p.slide.vx * dt;
        p.z += p.slide.vz * dt;
        resolve(p, jailRect(p));
      }
    }
    if (p.moving) {
      p.yaw = Math.atan2(dx, dz);
      if (p.social) endSocial(p); // andou: a interação acaba para os dois
    }
  }
  matchmaker.tick(dt, now);
}, 1000 / TICK_RATE);

setInterval(() => {
  if (!humans()) return;
  const s: number[] = [];
  for (const p of players.values()) {
    s.push(p.id, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100, Math.round(p.yaw * 100) / 100, p.moving ? (p.input.run ? 2 : 1) : 0);
  }
  broadcast({ t: 'snap', s });
}, 1000 / SNAPSHOT_RATE);

// Derruba conexões mortas.
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 15000);

spawnBots();
spawnPolice();
spawnPoliceLine();
spawnSoloPolice();
front.listen(PORT, () =>
  console.log(`[multidao] servidor na porta ${PORT} (${https ? 'http + https' : 'só http'}, ws em /ws) · ${BOTS_PER_TEAM * 2} bots`),
);
