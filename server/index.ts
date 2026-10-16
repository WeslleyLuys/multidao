import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BOTS_PER_TEAM, EMOTES, LIMITS, MAX_PLAYERS, SNAPSHOT_RATE, SPAWN, TICK_RATE, TRUCKS, WORLD,
  type TeamId,
} from '../shared/config';
import type { ClientMsg, PlayerInfo, ServerMsg } from '../shared/protocol';
import { cleanText, randomLook, sanitizeLook, teamClothColors } from '../shared/look';
import { clamp, resolve, step } from '../shared/physics';

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
}

interface Conn {
  ws: WebSocket;
  ip: string;
  player?: Player;
  alive: boolean;
}

const players = new Map<number, Player>();
const conns = new Set<Conn>();
const ipCount = new Map<string, number>();
let nextId = 1;

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

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });

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
    removePlayer(conn);
  });
});

function removePlayer(conn: Conn) {
  if (!conn.player) return;
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
      if (p) return;
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
      break;
    }

    case 'input': {
      if (!p) return;
      p.input = { dx: clamp(Number(msg.dx) || 0, -1, 1), dz: clamp(Number(msg.dz) || 0, -1, 1), run: !!msg.run };
      break;
    }

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
      removePlayer(conn);
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

function thinkBot(p: Player, now: number) {
  const b = p.brain!;
  if (b.state === 'idle') {
    p.input = { dx: 0, dz: 0, run: false };
    if (now > b.nextTurn) {
      p.yaw += (Math.random() - 0.5) * 2;
      b.nextTurn = now + 2000 + Math.random() * 5000;
    }
    if (now > b.nextEmote) {
      broadcast({ t: 'emote', id: p.id, e: EMOTES[Math.floor(Math.random() * EMOTES.length)] });
      b.nextEmote = now + 6000 + Math.random() * 16000;
      b.until = Math.max(b.until, now + 2600); // termina o gesto antes de sair andando
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
    if (p.brain) thinkBot(p, now);
    // Bots não colidem entre si; normalizamos a direção do input dos bots aqui.
    const len = Math.hypot(p.input.dx, p.input.dz);
    const dx = p.brain && len > 0 ? p.input.dx / len : p.input.dx;
    const dz = p.brain && len > 0 ? p.input.dz / len : p.input.dz;
    p.moving = step(p, dx, dz, p.input.run, dt);
    if (p.moving) p.yaw = Math.atan2(dx, dz);
  }
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
http.listen(PORT, () => console.log(`[multidao] servidor em http://localhost:${PORT} (ws: /ws) · ${BOTS_PER_TEAM * 2} bots`));
