import { isMobile } from './polyfills'; // precisa vir primeiro
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './style.css';
import logo from './logo.svg?raw';
import {
  CLOTH_COLORS, EMOTES, GAME, HAIR_COLORS, ITEMS, ITEM_LABEL, LIMITS, OUTFIT, OUTFIT_LABEL, PATTERNS, PATTERN_LABEL,
  PRINTS, PRINT_LABEL, SKIN_TONES, SLOTS, SLOT_LABEL, TEAMS, VIP,
  AGGRESSION, JAIL, SOCIALS, SOCIAL_LABEL,
  type Emote, type Slot, type Social, type TeamId,
} from '../../shared/config';
import { SNAP_STRIDE, type AttackKind, type PlayerInfo, type RosterEntry, type ServerMsg } from '../../shared/protocol';
import { DEFAULT_LOOK, randomLook, sanitizeLook, teamClothColors, type Look } from '../../shared/look';
import { step } from '../../shared/physics';
import { Avatar } from './avatar';
import { loadCharacter } from './character';
import { MatchClient } from './match/matchClient';
import { playHurt, playShot, unlockAudio } from './match/sfx';
import { MATCH_SIZES, type MatchSize } from '../../shared/arena';
import { ROUND_OPTIONS } from '../../shared/protocol';
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
// events: escolhendo um evento · match: dentro de uma partida de evento
type Screen = 'lobby' | 'playing' | 'menu' | 'editing' | 'events' | 'match';
let screen: Screen = 'lobby';
const inGame = () => screen !== 'lobby';

// ---------- Renderização principal ----------
const canvas = $<HTMLCanvasElement>('#game');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
const gfx = new Graphics(canvas, scene, camera);
let shaderErrors = 0;
gfx.renderer.debug.onShaderError = (gl, program, vs, fs) => {
  if (gl.isContextLost()) return; // já avisado pelo evento abaixo
  if (shaderErrors++ > 2) return;
  const logs = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n').slice(0, 1500);
  showFatal(`Erro de shader (${gl.getParameter(gl.VERSION)}):\n${logs || '(sem detalhes)'}`);
};
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showFatal('A placa de vídeo reiniciou o WebGL (contexto perdido). Recarregue a página; se repetir, use Gráficos: Baixa no menu.');
});
const world = buildWorld(scene, isMobile);
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
  skip?: boolean; // anima em quadros alternados quando está longe
  acc: number;
}

const net = new Net();
const input = new Input(canvas, $('#joystick'));
input.active = () => screen === 'playing' && !match;
// Clique esquerdo bate, direito empurra (como o tiro no FPS).
input.onClick = (button) => {
  if (button === 0) doAttack('hit');
  else if (button === 2) doAttack('push');
};
const remotes = new Map<number, Remote>();
let selfId = 0;
let selfAvatar: Avatar | undefined;
let joinedAs: Profile | undefined; // perfil com que entramos (para saber se precisa reentrar)
let editBackup: Profile | undefined; // para "Voltar sem salvar"
const self = { x: 0, z: 0, yaw: 0, moving: 0 };
const serverSelf = { x: 0, z: 0, has: false };

function addPlayer(p: PlayerInfo) {
  if (p.id === selfId || remotes.has(p.id)) return;
  const police = p.role === 'police';
  const avatar = new Avatar(p.team, p.look, police ? 'Polícia' : p.bot ? undefined : p.name, false, police ? '#5b8def' : undefined);
  if (police) avatar.setPatrol(3); // fuzil
  scene.add(avatar.root);
  remotes.set(p.id, { info: p, avatar, buf: [], acc: 0 });
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
  $('#events').hidden = next !== 'events';
  $('#hud').hidden = next === 'lobby' || next === 'match';
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
// Ao reconectar no meio do jogo, entra de novo automaticamente (a partida em andamento se perde).
net.onOpen = () => {
  if (match) exitMatch(false);
  else if (inGame()) join();
};

net.on((msg: ServerMsg) => {
  if (match?.onMessage(msg)) return;
  switch (msg.t) {
    case 'match':
      startMatch(msg);
      break;
    case 'queued':
      showQueue(msg);
      break;
    case 'unqueued':
      queueBar.hidden = true;
      break;
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

    // ----- Agressão, interações, prisão -----
    case 'attack': {
      const a = avatarOf(msg.id);
      a?.playAnim(msg.kind === 'push' ? 'shove' : a.hasItem ? 'hitItem' : 'hit');
      const at = a?.root.position;
      if (at) playShot(0, at.distanceTo(camera.position)); // som do impacto
      if (msg.target) {
        avatarOf(msg.target)?.playAnim(msg.knocked ? 'knockdown' : 'stagger');
        if (msg.target === selfId) {
          playHurt();
          if (msg.knocked) {
            knockUntil = performance.now() + AGGRESSION.knockMs;
            systemMessage('Você caiu! Levanta em alguns segundos…');
          }
        }
      }
      break;
    }
    case 'moved':
      // O servidor reposicionou você (empurrão, prisão, interação).
      self.x = serverSelf.x = msg.x;
      self.z = serverSelf.z = msg.z;
      if (msg.yaw !== undefined) {
        self.yaw = msg.yaw;
        if (selfAvatar) selfAvatar.root.rotation.y = msg.yaw;
      }
      if (selfAvatar) selfAvatar.root.position.set(self.x, 0, self.z);
      break;
    case 'jail':
      jailInfo = { until: performance.now() + (msg.until - msg.now), where: msg.where };
      selfAvatar?.playEmote('stop');
      systemMessage(`🚔 Você foi preso por 1 minuto: ${msg.reason}.`);
      updateJailBanner();
      break;
    case 'free':
      jailInfo = undefined;
      updateJailBanner();
      systemMessage('🔓 Você foi solto. Comporte-se!');
      break;
    case 'socialAsk':
      showAsk(msg.from, msg.kind);
      break;
    case 'socialStart': {
      const a = avatarOf(msg.a);
      const b = avatarOf(msg.b);
      // Mãos dadas: quem pediu tem o parceiro à direita.
      a?.playAnim(msg.kind, 'R');
      b?.playAnim(msg.kind, 'L');
      if (a && msg.a !== selfId) a.root.rotation.y = msg.ayaw;
      if (b && msg.b !== selfId) b.root.rotation.y = msg.byaw;
      break;
    }
    case 'socialEnd':
      for (const id of [msg.a, msg.b]) {
        const av = avatarOf(id);
        if (av && (['hug', 'kiss', 'hand'] as const).includes(av.currentEmote as Social)) av.playEmote('stop');
      }
      break;
    case 'notice':
      systemMessage(msg.text);
      break;
    case 'roster':
      renderRoster(msg.list);
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

// ---------- Eventos (FPS) ----------
let match: MatchClient | undefined;
let eventSize: MatchSize = 4;
let eventRounds = 5;
const queueBar = $('#queue-bar');

function renderEvents() {
  $('#event-sizes').replaceChildren(
    ...MATCH_SIZES.map((s) => button('chip', `${s}x${s}`, eventSize === s, () => {
      eventSize = s;
      renderEvents();
    })),
  );
  $('#event-rounds').replaceChildren(
    ...ROUND_OPTIONS.map((r) => button('chip', r ? `${r} ${r === 1 ? 'round' : 'rounds'}` : 'Livre (renasce)', eventRounds === r, () => {
      eventRounds = r;
      renderEvents();
    })),
  );
  $('#event-hint').textContent = eventRounds
    ? `Quem morre só volta no próximo round. Vence o round quem eliminar o outro lado (ou tiver mais gente viva em 2:30). Ganha a partida quem vencer ${Math.floor(eventRounds / 2) + 1} ${eventRounds === 1 ? 'round' : 'rounds'}.`
    : '3 minutos com renascimento. Cada abate vale 1 ponto para o seu lado e 100 para você.';
}
renderEvents();

function openEvents() {
  if (screen === 'match') return;
  setScreen('events');
}
function queueEvent(bots: boolean) {
  unlockAudio();
  net.send({ t: 'queue', mode: 'fps', size: eventSize, rounds: eventRounds, bots });
  setScreen('playing');
}
$('#menu-events').addEventListener('click', openEvents);
$('#hud-events').addEventListener('click', openEvents);
$('#event-close').addEventListener('click', () => setScreen('playing'));
$('#event-queue').addEventListener('click', () => queueEvent(false));
$('#event-bots').addEventListener('click', () => queueEvent(true));
$('#queue-cancel').addEventListener('click', () => net.send({ t: 'unqueue' }));
$('#queue-bots').addEventListener('click', () => net.send({ t: 'queue', mode: 'fps', size: eventSize, rounds: eventRounds, bots: true }));

function showQueue(msg: Extract<ServerMsg, { t: 'queued' }>) {
  eventSize = msg.size;
  eventRounds = msg.rounds;
  queueBar.hidden = false;
  const need = msg.size;
  $('#queue-text').textContent =
    `Procurando FPS ${need}x${need}${msg.rounds ? ` (${msg.rounds} rounds)` : ""} · ${TEAMS[0].name} ${msg.teams[0]}/${need} · ${TEAMS[1].name} ${msg.teams[1]}/${need}` +
    (msg.startsIn !== null ? ` · começa com bots em ${msg.startsIn}s` : '');
}

function startMatch(msg: Extract<ServerMsg, { t: 'match' }>) {
  queueBar.hidden = true;
  match?.dispose();
  // Sai da avenida (o servidor já nos removeu de lá).
  clearPlayers();
  selfId = 0;
  setScreen('match');
  match = new MatchClient(msg, net, gfx, canvas, () => exitMatch(true));
  gfx.setTimeOfDay(0.62); // arena: sempre fim de tarde, boa visibilidade
}

function exitMatch(rejoin: boolean) {
  if (!match) return;
  match.dispose();
  match = undefined;
  gfx.setScene(scene, camera);
  lastClock = -Infinity; // volta para a hora real no próximo quadro
  setScreen('playing');
  join();
  if (rejoin) systemMessage('De volta à avenida. Esc → Eventos para jogar de novo.');
}

// ---------- Avenida: agressão, interações, prisão e lista de online ----------
const socialMenu = $('#social-menu');
const socialAsk = $('#social-ask');
const jailBanner = $('#jail-banner');
let jailInfo: { until: number; where: 'cell' | 'outside' } | undefined;
let knockUntil = 0;
let lastAttack = 0;
let socialTarget = 0;
let askFrom = 0;
let askTimer = 0;

function avatarOf(id: number) {
  return id === selfId ? selfAvatar : remotes.get(id)?.avatar;
}

function doAttack(kind: AttackKind) {
  const now = performance.now();
  if (now - lastAttack < AGGRESSION.intervalMs || jailInfo || now < knockUntil) return;
  lastAttack = now;
  net.send({ t: 'attack', kind });
}

/** Jogador (ou bot) mais próximo de frente para mim, até `range` metros. */
function personInFront(range = 2.6) {
  let best: { id: number; r: Remote } | undefined;
  let bestD = range;
  for (const [id, r] of remotes) {
    const p = r.avatar.root.position;
    const dx = p.x - self.x;
    const dz = p.z - self.z;
    const d = Math.hypot(dx, dz);
    let ang = Math.atan2(dx, dz) - self.yaw;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
    if (d < bestD && Math.abs(ang) < 0.9) {
      best = { id, r };
      bestD = d;
    }
  }
  return best;
}

function openSocialMenu() {
  if (jailInfo) return systemMessage('Preso não pode interagir. 🚔');
  const found = personInFront();
  if (!found) return systemMessage('Chegue perto de alguém e fique de frente para interagir (T).');
  socialTarget = found.id;
  const who = found.r.info.role === 'police' ? 'o policial' : found.r.info.bot ? 'esta pessoa' : found.r.info.name;
  const title = document.createElement('p');
  title.textContent = `Interagir com ${who}`;
  const row = document.createElement('div');
  row.className = 'row';
  SOCIALS.forEach((k, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${i + 1} ${SOCIAL_LABEL[k]}`;
    b.addEventListener('click', () => chooseSocial(k));
    row.append(b);
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Cancelar (Esc)';
  close.addEventListener('click', closeSocialMenu);
  socialMenu.replaceChildren(title, row, close);
  socialMenu.hidden = false;
}

function closeSocialMenu() {
  socialMenu.hidden = true;
}

function chooseSocial(kind: Social) {
  closeSocialMenu();
  if (socialTarget) net.send({ t: 'social', kind, target: socialTarget });
}

function showAsk(from: number, kind: Social) {
  askFrom = from;
  const name = remotes.get(from)?.info.name ?? 'Alguém';
  const p = document.createElement('p');
  p.textContent = `${name} quer: ${SOCIAL_LABEL[kind]}`;
  const row = document.createElement('div');
  row.className = 'row';
  const yes = document.createElement('button');
  yes.className = 'yes';
  yes.textContent = 'Aceitar (Y)';
  yes.addEventListener('click', () => answerAsk(true));
  const no = document.createElement('button');
  no.textContent = 'Recusar (N)';
  no.addEventListener('click', () => answerAsk(false));
  row.append(yes, no);
  socialAsk.replaceChildren(p, row);
  socialAsk.hidden = false;
  clearTimeout(askTimer);
  askTimer = window.setTimeout(() => answerAsk(false), 15000);
}

function answerAsk(accept: boolean) {
  if (socialAsk.hidden) return;
  socialAsk.hidden = true;
  clearTimeout(askTimer);
  net.send({ t: 'socialReply', from: askFrom, accept });
}

function updateJailBanner() {
  if (!jailInfo) {
    jailBanner.hidden = true;
    return;
  }
  const s = Math.max(0, Math.ceil((jailInfo.until - performance.now()) / 1000));
  jailBanner.hidden = false;
  jailBanner.textContent = `🚔 ${jailInfo.where === 'outside' ? 'Preso fora da avenida' : 'Prisão preventiva'} — ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(updateJailBanner, 250);

function renderRoster(list: RosterEntry[]) {
  const box = $('#roster-list');
  const WHERE: Record<RosterEntry['where'], string> = { avenida: 'na avenida', evento: '🎯 em evento', fila: '⏳ na fila', preso: '🚔 preso' };
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Ninguém online agora.';
    return box.replaceChildren(empty);
  }
  box.replaceChildren(
    ...list.map((r) => {
      const row = document.createElement('div');
      row.className = 'row';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = TEAMS[r.team].color;
      const name = document.createElement('b');
      name.textContent = r.name;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = `${TEAMS[r.team].name} · ${WHERE[r.where]}`;
      row.append(dot, name, where);
      return row;
    }),
  );
}
$('#hud-online').addEventListener('click', () => {
  net.send({ t: 'who' });
  $('#roster').hidden = false;
});
$('#roster-close').addEventListener('click', () => ($('#roster').hidden = true));
$('#roster').addEventListener('click', (e) => e.target === e.currentTarget && ($('#roster').hidden = true));
$('#street-actions').querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
  b.addEventListener('click', () => (b.dataset.act === 'social' ? openSocialMenu() : doAttack(b.dataset.act as AttackKind))),
);

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
    if (!socialMenu.hidden) return closeSocialMenu();
    if (!$('#roster').hidden) return ($('#roster').hidden = true);
    if (screen === 'playing') setScreen('menu');
    else if (screen === 'menu') setScreen('playing');
    else if (screen === 'editing') cancelEdit();
    else if (screen === 'events') setScreen('playing');
    return; // na partida, o Esc é tratado pelo MatchClient
  }
  if (screen !== 'playing' || isTyping(e.target)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    chatInput.focus();
    return;
  }
  if (e.repeat) return;
  if (e.code === 'Space') {
    e.preventDefault();
    doEmote('jump');
    return;
  }
  if (e.code === 'KeyC') return doEmote('crouch');
  if (e.code === 'KeyV') return setView(!input.firstPerson);
  if (e.code === 'KeyF') return doAttack('hit');
  if (e.code === 'KeyG') return doAttack('push');
  if (e.code === 'KeyT') return openSocialMenu();
  if (!socialAsk.hidden && (e.code === 'KeyY' || e.code === 'KeyN')) return answerAsk(e.code === 'KeyY');
  // Com o menu de interação aberto, 1–3 escolhem a interação.
  if (!socialMenu.hidden) {
    const i = Number(e.key) - 1;
    if (i >= 0 && i < SOCIALS.length) chooseSocial(SOCIALS[i]);
    return;
  }
  // 1–9 e 0 = as 10 ações da barra
  const idx = e.key === '0' ? 9 : Number(e.key) - 1;
  if (idx >= 0 && idx < ACTIONS.length) doEmote(ACTIONS[idx]);
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
// Ações da avenida: ficam em loop até andar; clicar de novo na mesma ação encerra.
const ACTIONS = EMOTES.filter((e) => e !== 'stop');
const EMOTE_ICON: Record<Exclude<Emote, 'stop'>, [string, string]> = {
  wave: ['👋', 'Acenar'], jump: ['⬆️', 'Pular (Espaço)'], dance: ['💃', 'Dançar'], clap: ['👏', 'Aplaudir'],
  point: ['👉', 'Apontar'], crouch: ['🧎', 'Agachar (C)'], lie: ['🛌', 'Deitar'], drink: ['🍺', 'Beber'],
  smoke: ['🚬', 'Fumar'], pee: ['💦', 'Mijar na rua'],
};
let lastEmote = 0;
function doEmote(e: Emote) {
  const now = performance.now();
  if (now - lastEmote < LIMITS.emoteIntervalMs) return;
  lastEmote = now;
  if (e !== 'jump' && selfAvatar?.currentEmote === e) e = 'stop';
  selfAvatar?.playEmote(e);
  net.send({ t: 'emote', e });
  renderEmoteBar();
}
function renderEmoteBar() {
  const active = selfAvatar?.currentEmote;
  $('#emotes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.e === active));
}
$('#emotes').replaceChildren(
  ...ACTIONS.map((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.e = e;
    b.title = EMOTE_ICON[e][1];
    b.innerHTML = `<kbd>${(i + 1) % 10}</kbd>`;
    b.append(EMOTE_ICON[e][0]);
    b.addEventListener('click', () => doEmote(e));
    return b;
  }),
);
// Ao andar, a ação acaba; a barra acompanha.
setInterval(renderEmoteBar, 300);

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

let lastSentYaw = 0;
function sendInput(dx: number, dz: number, run: boolean, now: number) {
  // Também envia quando só a direção do olhar muda (o servidor usa para mirar golpes/interações).
  let yawDiff = Math.abs(self.yaw - lastSentYaw) % (Math.PI * 2);
  if (yawDiff > Math.PI) yawDiff = Math.PI * 2 - yawDiff;
  const changed = Math.abs(dx - lastSent.dx) > 0.02 || Math.abs(dz - lastSent.dz) > 0.02 || run !== lastSent.run || yawDiff > 0.08;
  if (changed) lastSentYaw = self.yaw;
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
  // Caído no chão: não anda.
  if (now < knockUntil) dx = dz = 0;

  const moved = step(self, dx, dz, input.run, dt, jailInfo ? JAIL[jailInfo.where] : undefined);
  self.moving = moved ? (input.run ? 2 : 1) : 0;
  // Em primeira pessoa o corpo olha para onde a câmera mira (golpes e interações vão nessa direção).
  if (input.firstPerson) self.yaw = input.camYaw + Math.PI;
  else if (moved) self.yaw = Math.atan2(dx, dz);
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

  if (input.firstPerson) {
    // Primeira pessoa: câmera nos olhos, olhando para onde o mouse mira.
    const emote = selfAvatar?.currentEmote;
    const eye = emote === 'lie' || emote === 'knockdown' ? 0.45 : emote === 'crouch' ? 1.1 : 1.62;
    const bob = self.moving ? Math.sin(now / (self.moving === 2 ? 70 : 110)) * 0.03 : 0;
    camera.position.set(self.x + Math.sin(self.yaw) * 0.12, eye + bob, self.z + Math.cos(self.yaw) * 0.12);
    camera.rotation.set(input.lookPitch, input.camYaw, 0, 'YXZ');
    camTarget.set(self.x, 0, self.z);
    if (selfAvatar) selfAvatar.root.visible = false;
    return;
  }
  if (selfAvatar) selfAvatar.root.visible = true;

  // Câmera em terceira pessoa
  camTarget.set(self.x, 1.6, self.z);
  const d = input.camDist;
  const p = input.camPitch;
  camera.position.set(
    camTarget.x + Math.sin(input.camYaw) * Math.cos(p) * d,
    camTarget.y + Math.sin(p) * d,
    camTarget.z + Math.cos(input.camYaw) * Math.cos(p) * d,
  );
  camera.rotation.order = 'XYZ';
  camera.lookAt(camTarget);
}

// ---------- Primeira / terceira pessoa ----------
const VIEW_KEY = 'multidao-view';
function setView(first: boolean) {
  input.setFirstPerson(first);
  try {
    localStorage.setItem(VIEW_KEY, first ? 'first' : 'third');
  } catch {}
  $('#menu-view').textContent = `Câmera: ${first ? '1ª pessoa' : '3ª pessoa'} (V)`;
  $('#fp-cross').hidden = !first;
  if (first && screen === 'playing') systemMessage('Primeira pessoa: clique para travar o mouse e mirar. V volta para terceira pessoa.');
}
try {
  setView(localStorage.getItem(VIEW_KEY) === 'first');
} catch {
  setView(false);
}
$('#menu-view').addEventListener('click', () => setView(!input.firstPerson));

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
    // Economia: longe da câmera some; a meia distância anima em quadros alternados.
    const dist = root.position.distanceTo(camera.position);
    root.visible = dist < AVATAR_FAR;
    if (!root.visible) continue;
    r.skip = dist > AVATAR_FAR * 0.5 && !r.skip;
    if (!r.skip) r.avatar.update(r.acc + dt, b.mv);
    r.acc = r.skip ? r.acc + dt : 0;
  }
}
const AVATAR_FAR = isMobile ? 45 : 90;

// ---------- Dia e noite ----------
// Um dia inteiro a cada 16 minutos, derivado do relógio: todo mundo vê a mesma hora.
const DAY_CYCLE_S = 16 * 60;
let lastClock = -Infinity;
function updateClock(now: number) {
  lastClock = now;
  // ?hora=22 na URL fixa a hora (útil para testar a noite).
  const forced = Number(new URLSearchParams(location.search).get('hora'));
  const t = Number.isFinite(forced) && location.search.includes('hora=') ? (forced / 24) % 1 : (Date.now() / 1000 / DAY_CYCLE_S) % 1;
  gfx.setTimeOfDay(t);
  world.setNight(gfx.night);
  const mins = Math.floor(t * 24 * 60);
  const label = `${gfx.night > 0.5 ? '🌙' : '☀️'} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const el = $('#hud-clock');
  if (el.textContent !== label) el.textContent = label;
}

let lastT = performance.now();
function renderFrame(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const t = now / 1000;
  waveTime.value = t;

  if (match) {
    match.update(dt, now);
    gfx.render(now);
    return;
  }
  if (now - lastClock > 500) updateClock(now);

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
(window as any).__gameStarted = true;

// Latência (útil para depuração no console)
setInterval(() => net.send({ t: 'ping', ts: performance.now() }), 5000);
