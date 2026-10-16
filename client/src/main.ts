import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './style.css';
import logo from './logo.svg?raw';
import {
  CLOTH_COLORS, EMOTES, GAME, HAIR_COLORS, ITEMS, ITEM_LABEL, LIMITS, OUTFIT, OUTFIT_LABEL, PATTERNS, PATTERN_LABEL,
  PRINTS, PRINT_LABEL, SKIN_TONES, SLOTS, SLOT_LABEL, TEAMS, VIP,
  type Emote, type Slot, type TeamId,
} from '../../shared/config';
import { SNAP_STRIDE, type PlayerInfo, type ServerMsg } from '../../shared/protocol';
import { DEFAULT_LOOK, randomLook, sanitizeLook, teamClothColors, type Look } from '../../shared/look';
import { step } from '../../shared/physics';
import { Avatar } from './avatar';
import { loadCharacter } from './character';
import { buildWorld } from './world';
import { Graphics, QUALITY_LABEL, type Quality } from './graphics';
import { waveTime } from './wave';
import { Net } from './net';
import { Input, isTyping } from './input';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// Mostra erros na tela (em vez de uma tela vazia) para facilitar o diagnóstico.
function showFatal(msg: string) {
  let el = document.querySelector<HTMLElement>('#fatal');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'fatal';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99;margin:0;padding:12px;border-radius:10px;background:#3a1215;color:#ffd7d7;font:12px/1.4 monospace;white-space:pre-wrap;max-height:40vh;overflow:auto';
    document.body.append(el);
  }
  if (el.textContent!.length < 4000) el.textContent += `${msg}\n`;
}
addEventListener('error', (e) => showFatal(`Erro: ${e.message}`));
addEventListener('unhandledrejection', (e) => showFatal(`Erro: ${e.reason?.message ?? e.reason}`));

// ---------- Marca ----------
document.querySelectorAll('[data-logo]').forEach((el) => (el.innerHTML = logo));
document.querySelectorAll('[data-game-name]').forEach((el) => (el.textContent = GAME.name));
document.querySelectorAll('[data-tagline]').forEach((el) => (el.textContent = GAME.tagline));

// ---------- Perfil salvo (só conveniência local) ----------
interface Profile { name: string; team: TeamId; look: Look }
const PROFILE_KEY = 'multidao-profile';
function loadProfile(): Profile {
  const fallback: Profile = {
    name: '',
    team: Math.random() < 0.5 ? 0 : 1,
    look: { ...structuredClone(DEFAULT_LOOK), skin: Math.floor(Math.random() * SKIN_TONES.length) },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    if (!raw) return fallback;
    // sanitizeLook também converte perfis salvos em versões antigas.
    return { name: typeof raw.name === 'string' ? raw.name : '', team: raw.team === 1 ? 1 : 0, look: sanitizeLook(raw.look) };
  } catch {
    return fallback;
  }
}
function saveProfile() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {}
}
let profile = loadProfile();
const cloneProfile = (p: Profile): Profile => structuredClone(p);

await loadCharacter();

// ---------- Estado de tela ----------
// lobby: menu principal · playing: na avenida · menu: pausa (Esc) · editing: trocando visual em jogo
type Screen = 'lobby' | 'playing' | 'menu' | 'editing';
let screen: Screen = 'lobby';
const inGame = () => screen !== 'lobby';

// ---------- Renderização principal ----------
const canvas = $<HTMLCanvasElement>('#game');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
const gfx = new Graphics(canvas, scene, camera);
gfx.renderer.debug.onShaderError = (gl, _program, vs, fs) => {
  showFatal(`Erro de shader (${gl.getParameter(gl.RENDERER)}):\n${gl.getShaderInfoLog(vs) ?? ''}\n${gl.getShaderInfoLog(fs) ?? ''}`);
};
const world = buildWorld(scene);
world.setDetail(gfx.quality !== 'low');

// ---------- Prévia do avatar no lobby ----------
const previewCanvas = $<HTMLCanvasElement>('#preview');
const previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
previewRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
previewRenderer.debug.onShaderError = gfx.renderer.debug.onShaderError;
const previewScene = new THREE.Scene();
previewScene.environment = new THREE.PMREMGenerator(previewRenderer).fromScene(new RoomEnvironment(), 0.04).texture;
previewScene.environmentIntensity = 0.7;
const keyLight = new THREE.DirectionalLight('#fff4e6', 2.2);
keyLight.position.set(2, 4, 3);
const rimLight = new THREE.DirectionalLight('#b9d4ff', 1.4);
rimLight.position.set(-3, 2, -3);
previewScene.add(keyLight, rimLight);
const previewCam = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
let previewAvatar: Avatar | undefined;

function rebuildPreview() {
  if (previewAvatar) {
    previewScene.remove(previewAvatar.root);
    previewAvatar.dispose();
  }
  previewAvatar = new Avatar(profile.team, profile.look);
  previewScene.add(previewAvatar.root);
}
new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = previewCanvas;
  if (!w || !h) return;
  previewRenderer.setSize(w, h, false);
  previewCam.aspect = w / h;
  previewCam.position.set(0, 1.75, w / h > 1 ? 6.2 : 7.4);
  previewCam.lookAt(0, 1.35, 0);
  previewCam.updateProjectionMatrix();
}).observe(previewCanvas);

// ---------- Lobby / personalização ----------
const lobby = $('#lobby');
const nameInput = $<HTMLInputElement>('#name');
const signInput = $<HTMLInputElement>('#sign');
const enterBtn = $<HTMLButtonElement>('#enter');
const backBtn = $<HTMLButtonElement>('#back');
const onlineEl = $('#online');
const lobbyError = $('#lobby-error');
let teamCounts: [number, number] = [0, 0];

nameInput.maxLength = LIMITS.name;
signInput.maxLength = LIMITS.sign;

function syncInputs() {
  nameInput.value = profile.name;
  signInput.value = profile.look.sign;
}
syncInputs();

function button(cls: string, label: string, pressed: boolean, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

let slot: Slot = 'torso';

// Chip com selo "VIP" quando o item é exclusivo.
function chip(id: string, label: string, pressed: boolean, onClick: () => void) {
  const b = button('chip', label, pressed, onClick);
  if (VIP.has(id)) {
    const badge = document.createElement('span');
    badge.className = 'vip';
    badge.textContent = 'VIP';
    b.append(badge);
  }
  return b;
}

function swatches(el: HTMLElement, colors: readonly string[], current: number, set: (i: number) => void) {
  el.replaceChildren(
    ...colors.map((c, i) => {
      const b = button('swatch', '', current === i, () => update(() => set(i)));
      b.style.background = c;
      b.setAttribute('aria-label', `Cor ${i + 1}`);
      return b;
    }),
  );
}

$('#randomize').addEventListener('click', () =>
  update(() => {
    const keep = { item: profile.look.item, sign: profile.look.sign };
    profile.look = { ...randomLook(Math.random, teamClothColors(profile.team)), ...keep };
  }),
);

function renderLobby() {
  const teams = $('#teams');
  teams.replaceChildren(
    ...TEAMS.map((t) => {
      const b = button('team', '', profile.team === t.id, () => update(() => (profile.team = t.id)));
      b.style.setProperty('--team', t.color);
      const title = document.createElement('strong');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = t.accent === '#ffffff' ? t.color : `linear-gradient(135deg, ${t.color} 50%, ${t.accent} 50%)`;
      title.append(dot, t.name);
      const small = document.createElement('small');
      small.textContent = `${teamCounts[t.id]} na avenida`;
      b.append(title, small);
      return b;
    }),
  );

  swatches($('#skins'), SKIN_TONES, profile.look.skin, (i) => (profile.look.skin = i));
  swatches($('#hairs'), HAIR_COLORS, profile.look.hair, (i) => (profile.look.hair = i));

  // Abas Cabeça / Tronco / Pernas / Pés
  $('#slot-tabs').replaceChildren(
    ...SLOTS.map((s) => {
      const b = button('tab', SLOT_LABEL[s], false, () => {
        slot = s;
        renderLobby();
      });
      b.removeAttribute('aria-pressed');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(slot === s));
      return b;
    }),
  );
  const piece = profile.look[slot];
  $('#piece-style').replaceChildren(...OUTFIT[slot].map((name, i) => button('chip', OUTFIT_LABEL[name], piece.s === i, () => update(() => (profile.look[slot].s = i)))));
  swatches($('#piece-color'), CLOTH_COLORS, piece.c, (i) => (profile.look[slot].c = i));
  $('#piece-pattern').replaceChildren(...PATTERNS.map((p, i) => button('chip', PATTERN_LABEL[p], piece.p === i, () => update(() => (profile.look[slot].p = i)))));
  swatches($('#piece-accent'), CLOTH_COLORS, piece.a, (i) => (profile.look[slot].a = i));
  $('#print-row').hidden = slot !== 'torso';
  $('#piece-print').replaceChildren(...PRINTS.map((p, i) => chip(p, PRINT_LABEL[p], profile.look.print === i, () => update(() => (profile.look.print = i)))));

  $('#items').replaceChildren(...ITEMS.map((it) => chip(it, ITEM_LABEL[it], profile.look.item === it, () => update(() => (profile.look.item = it)))));
  $('#sign-field').hidden = profile.look.item !== 'sign';
}

function update(fn: () => void) {
  fn();
  if (screen === 'lobby') saveProfile();
  renderLobby();
  rebuildPreview();
}

let signTimer = 0;
signInput.addEventListener('input', () => {
  profile.look.sign = signInput.value;
  clearTimeout(signTimer);
  signTimer = window.setTimeout(rebuildPreview, 250);
});
nameInput.addEventListener('input', () => (profile.name = nameInput.value));

renderLobby();
rebuildPreview();

// ---------- Estado do jogo ----------
interface Remote {
  info: PlayerInfo;
  avatar: Avatar;
  buf: { t: number; x: number; z: number; yaw: number; mv: number }[];
}

const net = new Net();
const input = new Input(canvas, $('#joystick'));
const remotes = new Map<number, Remote>();
let selfId = 0;
let selfAvatar: Avatar | undefined;
let joinedAs: Profile | undefined; // perfil com que entramos (para saber se precisa reentrar)
let editBackup: Profile | undefined; // para "Voltar sem salvar"
const self = { x: 0, z: 0, yaw: 0, moving: 0 };
const serverSelf = { x: 0, z: 0, has: false };

function addPlayer(p: PlayerInfo) {
  if (p.id === selfId || remotes.has(p.id)) return;
  const avatar = new Avatar(p.team, p.look, p.bot ? undefined : p.name);
  scene.add(avatar.root);
  remotes.set(p.id, { info: p, avatar, buf: [] });
}

function removePlayer(id: number) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.avatar.root);
  r.avatar.dispose();
  remotes.delete(id);
}

function replaceAvatar(old: Avatar, next: Avatar) {
  next.root.position.copy(old.root.position);
  next.root.rotation.copy(old.root.rotation);
  scene.remove(old.root);
  old.dispose();
  scene.add(next.root);
  return next;
}

function buildSelfAvatar() {
  const next = new Avatar(profile.team, profile.look, profile.name || 'Você', true);
  if (selfAvatar) selfAvatar = replaceAvatar(selfAvatar, next);
  else {
    selfAvatar = next;
    scene.add(next.root);
  }
}

function clearPlayers() {
  for (const id of [...remotes.keys()]) removePlayer(id);
  if (selfAvatar) {
    scene.remove(selfAvatar.root);
    selfAvatar.dispose();
    selfAvatar = undefined;
  }
}

function join() {
  profile.name = nameInput.value.trim().slice(0, LIMITS.name);
  profile.look.sign = signInput.value.trim().slice(0, LIMITS.sign);
  saveProfile();
  joinedAs = cloneProfile(profile);
  net.send({ t: 'join', name: profile.name, team: profile.team, look: profile.look });
}

function setScreen(next: Screen) {
  screen = next;
  lobby.hidden = next !== 'lobby' && next !== 'editing';
  $('#menu').hidden = next !== 'menu';
  $('#hud').hidden = next === 'lobby';
  input.enabled = next === 'playing' && document.activeElement !== chatInput;
  if (next !== 'playing') chatInput.blur();

  const editing = next === 'editing';
  enterBtn.textContent = editing ? 'Salvar e voltar' : 'Entrar na avenida';
  backBtn.hidden = !editing;
  if (next === 'lobby') enterBtn.disabled = !net.ready;
  if (next === 'editing') enterBtn.disabled = false;
  if (next === 'menu') $('#menu-resume').focus();
}

enterBtn.addEventListener('click', () => {
  lobbyError.hidden = true;
  if (screen === 'editing') return saveEdit();
  enterBtn.disabled = true;
  join();
});
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && enterBtn.click());
backBtn.addEventListener('click', cancelEdit);

function openEdit() {
  editBackup = cloneProfile(profile);
  syncInputs();
  renderLobby();
  rebuildPreview();
  setScreen('editing');
}

function cancelEdit() {
  if (editBackup) profile = editBackup;
  editBackup = undefined;
  syncInputs();
  setScreen('playing');
}

function saveEdit() {
  profile.name = nameInput.value.trim().slice(0, LIMITS.name);
  profile.look.sign = signInput.value.trim().slice(0, LIMITS.sign);
  saveProfile();
  editBackup = undefined;
  if (!joinedAs || profile.name !== joinedAs.name || profile.team !== joinedAs.team) {
    // Nome ou lado mudou: reentra (nasce na zona do novo lado).
    net.send({ t: 'leave' });
    join();
    systemMessage(profile.team !== joinedAs?.team ? `Indo para o lado ${TEAMS[profile.team].name}…` : 'Atualizando seu nome…');
  } else {
    net.send({ t: 'look', look: profile.look });
    joinedAs = cloneProfile(profile);
    buildSelfAvatar();
  }
  setScreen('playing');
}

function exitToLobby() {
  net.send({ t: 'leave' });
  clearPlayers();
  selfId = 0;
  joinedAs = undefined;
  chatLog.replaceChildren();
  syncInputs();
  renderLobby();
  rebuildPreview();
  setScreen('lobby');
}

net.onStatus = (online) => {
  $('#hud-status').hidden = online || !inGame();
  if (screen === 'lobby') {
    enterBtn.disabled = !online;
    if (!online) onlineEl.textContent = 'Conectando…';
  }
};
// Ao reconectar no meio do jogo, entra de novo automaticamente.
net.onOpen = () => inGame() && join();

net.on((msg: ServerMsg) => {
  switch (msg.t) {
    case 'stats': {
      teamCounts = msg.teams;
      onlineEl.textContent = `${msg.online} ${msg.online === 1 ? 'pessoa' : 'pessoas'} na avenida agora`;
      $('#hud-online').textContent = `${msg.online} online`;
      if (screen === 'lobby') renderLobby();
      break;
    }
    case 'welcome': {
      clearPlayers();
      selfId = msg.id;
      self.x = msg.x;
      self.z = msg.z;
      self.yaw = profile.team === 0 ? Math.PI / 2 : -Math.PI / 2;
      serverSelf.has = false;
      buildSelfAvatar();
      selfAvatar!.root.position.set(self.x, 0, self.z);
      selfAvatar!.root.rotation.y = self.yaw;
      for (const p of msg.players) addPlayer(p);
      input.camYaw = profile.team === 0 ? -Math.PI / 2 : Math.PI / 2;
      if (screen === 'lobby') {
        setScreen('playing');
        systemMessage(`Você entrou na ${GAME.street} pelo lado ${TEAMS[profile.team].name}. Enter para conversar, Esc para o menu.`);
      }
      break;
    }
    case 'add':
      addPlayer(msg.p);
      if (!msg.p.bot && remotes.size < 120) systemMessage(`${msg.p.name} chegou (${TEAMS[msg.p.team].name}).`);
      break;
    case 'remove':
      removePlayer(msg.id);
      break;
    case 'look': {
      const r = remotes.get(msg.id);
      if (!r) return;
      r.info.look = msg.look;
      r.avatar = replaceAvatar(r.avatar, new Avatar(r.info.team, msg.look, r.info.bot ? undefined : r.info.name));
      break;
    }
    case 'snap': {
      const now = performance.now();
      for (let i = 0; i < msg.s.length; i += SNAP_STRIDE) {
        const [id, x, z, yaw, mv] = msg.s.slice(i, i + SNAP_STRIDE);
        if (id === selfId) {
          serverSelf.x = x;
          serverSelf.z = z;
          serverSelf.has = true;
          continue;
        }
        const r = remotes.get(id);
        if (!r) continue;
        r.buf.push({ t: now, x, z, yaw, mv });
        if (r.buf.length > 12) r.buf.shift();
      }
      break;
    }
    case 'chat': {
      const info = msg.id === selfId ? { name: profile.name || 'Você', team: profile.team } : remotes.get(msg.id)?.info;
      if (!info) return;
      chatMessage(info.name, TEAMS[info.team].color, msg.text);
      (msg.id === selfId ? selfAvatar : remotes.get(msg.id)?.avatar)?.say(msg.text);
      break;
    }
    case 'emote':
      if (msg.id !== selfId) remotes.get(msg.id)?.avatar.playEmote(msg.e);
      break;
    case 'error':
      if (inGame()) systemMessage(msg.msg);
      else {
        lobbyError.textContent = msg.msg;
        lobbyError.hidden = false;
        enterBtn.disabled = false;
      }
      break;
  }
});

// ---------- Menu de pausa ----------
const qualityBtn = $<HTMLButtonElement>('#menu-quality');
const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const renderQuality = () => (qualityBtn.textContent = `Gráficos: ${QUALITY_LABEL[gfx.quality]}`);
renderQuality();
qualityBtn.addEventListener('click', () => {
  gfx.setQuality(QUALITIES[(QUALITIES.indexOf(gfx.quality) + 1) % QUALITIES.length]);
  world.setDetail(gfx.quality !== 'low');
  renderQuality();
});
$('#menu-resume').addEventListener('click', () => setScreen('playing'));
$('#menu-look').addEventListener('click', openEdit);
$('#menu-exit').addEventListener('click', exitToLobby);
$('#menu-btn').addEventListener('click', () => setScreen(screen === 'menu' ? 'playing' : 'menu'));
$('#menu').addEventListener('click', (e) => e.target === e.currentTarget && setScreen('playing'));

// ---------- Chat ----------
const chatLog = $('#chat-log');
const chatInput = $<HTMLInputElement>('#chat-input');
chatInput.maxLength = LIMITS.chat;

function pushLog(li: HTMLLIElement) {
  chatLog.append(li);
  while (chatLog.children.length > 60) chatLog.firstElementChild!.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}
function chatMessage(name: string, color: string, text: string) {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.style.color = color;
  b.textContent = name;
  li.append(b, text);
  pushLog(li);
}
function systemMessage(text: string) {
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  pushLog(li);
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.activeElement === chatInput) return; // o próprio chat trata (só fecha o campo)
    if (screen === 'playing') setScreen('menu');
    else if (screen === 'menu') setScreen('playing');
    else if (screen === 'editing') cancelEdit();
    return;
  }
  if (screen !== 'playing' || isTyping(e.target)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    chatInput.focus();
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= EMOTES.length) doEmote(EMOTES[n - 1]);
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text) net.send({ t: 'chat', text });
    chatInput.value = '';
    chatInput.blur();
  } else if (e.key === 'Escape') chatInput.blur();
});
chatInput.addEventListener('focus', () => (input.enabled = false));
chatInput.addEventListener('blur', () => (input.enabled = screen === 'playing'));

// ---------- Emotes ----------
const EMOTE_ICON: Record<Emote, [string, string]> = {
  wave: ['👋', 'Acenar'], jump: ['⬆️', 'Pular'], dance: ['💃', 'Dançar'], clap: ['👏', 'Aplaudir'],
};
let lastEmote = 0;
function doEmote(e: Emote) {
  const now = performance.now();
  if (now - lastEmote < LIMITS.emoteIntervalMs) return;
  lastEmote = now;
  selfAvatar?.playEmote(e);
  net.send({ t: 'emote', e });
}
$('#emotes').replaceChildren(
  ...EMOTES.map((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = EMOTE_ICON[e][1];
    b.innerHTML = `<kbd>${i + 1}</kbd>`;
    b.append(EMOTE_ICON[e][0]);
    b.addEventListener('click', () => doEmote(e));
    return b;
  }),
);

// ---------- Loop ----------
const INTERP_DELAY = 130;
let lastSent = { dx: 0, dz: 0, run: false, t: 0 };
const camTarget = new THREE.Vector3();

function angleLerp(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function sendInput(dx: number, dz: number, run: boolean, now: number) {
  const changed = Math.abs(dx - lastSent.dx) > 0.02 || Math.abs(dz - lastSent.dz) > 0.02 || run !== lastSent.run;
  if ((changed && now - lastSent.t > 50) || now - lastSent.t > 500) {
    net.send({ t: 'input', dx, dz, run, yaw: self.yaw });
    lastSent = { dx, dz, run, t: now };
  }
}

function updateSelf(dt: number, now: number) {
  input.update(); // com o menu aberto, input.enabled = false e o personagem para
  const { x: mx, y: my } = input.move;
  const fx = -Math.sin(input.camYaw);
  const fz = -Math.cos(input.camYaw);
  const rx = Math.cos(input.camYaw);
  const rz = -Math.sin(input.camYaw);
  let dx = fx * my + rx * mx;
  let dz = fz * my + rz * mx;
  const len = Math.hypot(dx, dz);
  if (len > 1) {
    dx /= len;
    dz /= len;
  }

  const moved = step(self, dx, dz, input.run, dt);
  self.moving = moved ? (input.run ? 2 : 1) : 0;
  if (moved) self.yaw = Math.atan2(dx, dz);
  sendInput(Math.round(dx * 100) / 100, Math.round(dz * 100) / 100, input.run, now);

  // Reconciliação suave com a posição autoritativa do servidor.
  if (serverSelf.has) {
    const ex = serverSelf.x - self.x;
    const ez = serverSelf.z - self.z;
    const err = Math.hypot(ex, ez);
    if (err > 4) {
      self.x = serverSelf.x;
      self.z = serverSelf.z;
    } else if (!moved && err > 0.02) {
      const k = 1 - Math.exp(-dt * 6);
      self.x += ex * k;
      self.z += ez * k;
    }
  }

  if (selfAvatar) {
    selfAvatar.root.position.set(self.x, 0, self.z);
    selfAvatar.root.rotation.y = angleLerp(selfAvatar.root.rotation.y, self.yaw, 1 - Math.exp(-dt * 14));
    selfAvatar.update(dt, self.moving);
  }

  // Câmera em terceira pessoa
  camTarget.set(self.x, 1.6, self.z);
  const d = input.camDist;
  const p = input.camPitch;
  camera.position.set(
    camTarget.x + Math.sin(input.camYaw) * Math.cos(p) * d,
    camTarget.y + Math.sin(p) * d,
    camTarget.z + Math.cos(input.camYaw) * Math.cos(p) * d,
  );
  camera.lookAt(camTarget);
}

function updateRemotes(dt: number, now: number) {
  const renderT = now - INTERP_DELAY;
  for (const r of remotes.values()) {
    const buf = r.buf;
    if (!buf.length) continue;
    let a = buf[0];
    let b = buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderT) {
        a = buf[i];
        b = buf[i + 1] ?? buf[i];
        break;
      }
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;
    const root = r.avatar.root;
    root.position.set(a.x + (b.x - a.x) * k, 0, a.z + (b.z - a.z) * k);
    root.rotation.y = angleLerp(root.rotation.y, angleLerp(a.yaw, b.yaw, k), 1 - Math.exp(-dt * 14));
    r.avatar.update(dt, b.mv);
  }
}

let lastT = performance.now();
function renderFrame(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const t = now / 1000;
  waveTime.value = t;

  if (inGame() && selfAvatar) {
    updateSelf(dt, now);
  } else {
    // Câmera passeando pela avenida atrás do lobby.
    camTarget.set(Math.sin(t * 0.05) * 120 - 20, 2, 0);
    camera.position.set(Math.sin(t * 0.05) * 120, 16, 30);
    camera.lookAt(camTarget);
  }
  gfx.follow(camTarget);

  if ((screen === 'lobby' || screen === 'editing') && previewAvatar) {
    previewAvatar.root.rotation.y = Math.sin(t * 0.6) * 0.7;
    previewAvatar.update(dt, 0);
    previewRenderer.render(previewScene, previewCam);
  }

  updateRemotes(dt, now);
  world.update(t, dt);
  gfx.render(now);
}

// Um erro num quadro não pode parar o loop; o primeiro é mostrado na tela.
let frameErrorShown = false;
function frame(now: number) {
  requestAnimationFrame(frame);
  try {
    renderFrame(now);
  } catch (err) {
    if (!frameErrorShown) showFatal(`Erro no quadro: ${(err as Error)?.stack ?? err}`);
    frameErrorShown = true;
  }
}
requestAnimationFrame(frame);

// Latência (útil para depuração no console)
setInterval(() => net.send({ t: 'ping', ts: performance.now() }), 5000);
