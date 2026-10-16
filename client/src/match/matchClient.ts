import * as THREE from 'three';
import { SKIN_TONES, TEAMS, type TeamId } from '../../../shared/config';
import { arenaMove, buildArena, newMover, projStep, rayBody, rayObstacles, type Arena, type Mover, type Proj } from '../../../shared/arena';
import { CANNON, EYE_HEIGHT, FISTS, GRENADE, MAX_HP, WEAPONS, aimDir, killWeaponName } from '../../../shared/weapons';
import { MSNAP_STRIDE, type MatchPhase, type MatchPlayerInfo, type MatchStat, type ProjKind, type ServerMsg } from '../../../shared/protocol';
import { Avatar } from '../avatar';
import type { Graphics } from '../graphics';
import type { Net } from '../net';
import { ArenaScene } from './arenaScene';
import { buildGun, type GunModel } from './guns';
import { playBounce, playChest, playClick, playExplosion, playHitmarker, playHurt, playShot, playThrow, playZoom, unlockAudio } from './sfx';

type MatchMsg = Extract<ServerMsg, { t: 'match' }>;

interface Remote {
  info: MatchPlayerInfo;
  avatar: Avatar;
  buf: { t: number; x: number; z: number; y: number; yaw: number; pitch: number; mv: number }[];
  hp: number;
  alive: boolean;
  w: number;
}

const INTERP_DELAY = 100;
const SENS = 0.0022;
const BASE_FOV = 75;
const coarse = matchMedia('(pointer: coarse)').matches;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

export class MatchClient {
  readonly arena: Arena;
  readonly view: ArenaScene;
  readonly scene: THREE.Scene;
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 1200);
  private me: Mover & { id: number; team: TeamId; yaw: number; pitch: number; alive: boolean; hp: number };
  private remotes = new Map<number, Remote>();
  private names = new Map<number, MatchPlayerInfo>();
  private phase: MatchPhase;
  private phaseEnds: number;
  private clockOffset: number;
  private inv = { cur: FISTS, ammo: WEAPONS.map(() => 0), reserve: WEAPONS.map(() => -1), reloading: false, armor: 0, nades: 0 };
  private nextFire = 0;
  private nextNade = 0;
  private keys = new Set<string>();
  private mouseDown = false;
  private ads = false;
  private adsK = 0; // 0..1 (animação da mira)
  private locked = false;
  private paused = false;
  private ended = false;
  private lastSent = 0;
  private moving = 0;
  private bob = 0;
  private recoil = 0;
  private shake = 0;
  private switchT = 0;
  private reloadT = 0;
  private teams: [number, number] = [0, 0];
  private rounds: number;
  private round: number;
  private spectating = -1;
  private specCam = new THREE.Vector3();
  private stats = new Map<number, MatchStat>();

  // Arma em primeira pessoa: cena própria, desenhada por cima do mundo.
  private vmScene = new THREE.Scene();
  private vmCamera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 10);
  private viewmodel = new THREE.Group();
  private gun?: GunModel;
  private fists?: THREE.Group;
  private punchT = 0;

  // Efeitos
  private fxObjects: { obj: THREE.Object3D; life: number; max: number; update?: (k: number) => void }[] = [];
  private lights: THREE.PointLight[] = [];
  private lightIdx = 0;
  // p é um objeto simples (não Vector3): o projStep compartilhado substitui p.pos a cada passo.
  private projs = new Map<number, { kind: ProjKind; mesh: THREE.Object3D; p: Proj; smokeAcc: number }>();
  private unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  private puffGeo = new THREE.IcosahedronGeometry(0.12, 0);

  // HUD
  private hud: HTMLElement;
  private ui: Record<string, HTMLElement> = {};
  private stick = { x: 0, y: 0 };
  private touchJump = false;
  private disposers: (() => void)[] = [];

  constructor(msg: MatchMsg, private net: Net, private gfx: Graphics, private canvas: HTMLCanvasElement, private onExit: () => void) {
    this.arena = buildArena(msg.size, msg.seed);
    this.view = new ArenaScene(this.arena, msg.seed);
    this.scene = this.view.scene;
    this.phase = msg.phase;
    this.phaseEnds = msg.endsAt;
    this.clockOffset = msg.now - Date.now();
    this.rounds = msg.rounds;
    this.round = msg.round;

    const meInfo = msg.players.find((p) => p.id === msg.you)!;
    const lane = msg.players.filter((p) => p.team === meInfo.team).findIndex((p) => p.id === msg.you);
    const spawns = this.arena.spawns[meInfo.team];
    const spawn = spawns[(lane * 5) % spawns.length];
    this.me = { ...newMover(spawn.x, spawn.z), id: msg.you, team: meInfo.team, yaw: meInfo.team === 0 ? Math.PI / 2 : -Math.PI / 2, pitch: 0, alive: true, hp: MAX_HP };
    for (const p of msg.players) {
      this.names.set(p.id, p);
      this.stats.set(p.id, { id: p.id, kills: 0, deaths: 0, score: 0 });
      if (p.id !== msg.you) this.addRemote(p);
    }
    for (const id of msg.opened) this.view.setChest(id, true);

    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight('#ffb35c', 0, 12, 2);
      this.lights.push(l);
      this.scene.add(l);
    }

    // Iluminação da cena da arma
    this.vmScene.add(new THREE.HemisphereLight('#e8f0ff', '#4a4236', 1.6));
    const key = new THREE.DirectionalLight('#fff1dc', 2.2);
    key.position.set(1, 2, 1);
    this.vmScene.add(key, this.viewmodel);
    this.vmScene.environment = this.scene.environment;
    this.buildFists(meInfo.look.skin);
    this.setViewWeapon(FISTS, false);

    this.hud = this.buildHud();
    this.bindInput();
    gfx.aoEnabled = false;
    gfx.setScene(this.scene, this.camera);
    gfx.overlay = { scene: this.vmScene, camera: this.vmCamera };
    this.vmScene.environment = gfx.scene.environment;
    const onResize = () => {
      this.vmCamera.aspect = innerWidth / innerHeight;
      this.vmCamera.updateProjectionMatrix();
    };
    addEventListener('resize', onResize);
    this.disposers.push(() => removeEventListener('resize', onResize));
    this.updateHud();
  }

  // ---------------------------------------------------------------------------
  // Jogadores
  // ---------------------------------------------------------------------------
  private addRemote(p: MatchPlayerInfo) {
    const avatar = new Avatar(p.team, p.look, p.name);
    avatar.setWeapon(FISTS);
    this.scene.add(avatar.root);
    this.remotes.set(p.id, { info: p, avatar, buf: [], hp: MAX_HP, alive: true, w: FISTS });
  }

  private removeRemote(id: number) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.avatar.root);
    r.avatar.dispose();
    this.remotes.delete(id);
  }

  private name(id: number) {
    return this.names.get(id)?.name ?? '?';
  }

  // ---------------------------------------------------------------------------
  // Mensagens do servidor
  // ---------------------------------------------------------------------------
  onMessage(msg: ServerMsg) {
    const now = performance.now();
    switch (msg.t) {
      case 'msnap':
        for (let i = 0; i < msg.s.length; i += MSNAP_STRIDE) {
          const [id, x, z, y, yaw, pitch, mv, hp, w, armor] = msg.s.slice(i, i + MSNAP_STRIDE);
          if (id === this.me.id) {
            if (hp > 0) this.me.hp = hp;
            continue;
          }
          const r = this.remotes.get(id);
          if (!r) continue;
          r.buf.push({ t: now, x, z, y, yaw, pitch, mv });
          if (r.buf.length > 14) r.buf.shift();
          r.hp = hp;
          r.alive = hp > 0;
          r.avatar.setArmor(armor > 0);
          if (w !== r.w) {
            r.w = w;
            r.avatar.setWeapon(w);
          }
        }
        break;
      case 'correct':
        // O servidor recusou nossa posição: volta para a dele.
        Object.assign(this.me, { x: msg.x, z: msg.z, y: msg.y, vx: 0, vz: 0, vy: 0 });
        break;
      case 'phase':
        this.phase = msg.phase;
        this.phaseEnds = msg.endsAt;
        this.clockOffset = msg.now - Date.now();
        this.round = msg.round;
        this.teams = msg.wins;
        if (msg.phase === 'live') this.flashCenter(this.rounds ? `ROUND ${this.round} — VALENDO!` : 'VALENDO!', 1400);
        else if (msg.phase === 'countdown' && this.rounds) this.flashCenter(`Round ${this.round} de ${this.rounds}`, 3000);
        else if (msg.phase === 'roundEnd') {
          const w = msg.roundWinner;
          const text = w === undefined || w === -1 ? 'Round empatado' : w === this.me.team ? `Seu lado venceu o round! 🏆` : `${TEAMS[w as TeamId].name} venceu o round`;
          this.flashCenter(`${text}\n${TEAMS[0].name} ${msg.wins[0]} × ${msg.wins[1]} ${TEAMS[1].name}`, 4500);
        }
        break;
      case 'inv': {
        const prevCur = this.inv.cur;
        const wasReloading = this.inv.reloading;
        this.inv = { cur: msg.cur, ammo: msg.ammo, reserve: msg.reserve, reloading: msg.reloading, armor: msg.armor, nades: msg.nades };
        if (msg.cur !== prevCur) this.setViewWeapon(msg.cur, true);
        if (msg.reloading && !wasReloading) this.reloadT = 0;
        break;
      }
      case 'shot': {
        const r = this.remotes.get(msg.id);
        const from = new THREE.Vector3(...msg.from);
        playShot(msg.w, from.distanceTo(this.camera.position));
        if (msg.w === FISTS) r?.avatar.punch();
        else {
          // a boca da arma fica à frente e um pouco à direita dos olhos
          const yaw = r?.buf.at(-1)?.yaw ?? 0;
          const muzzle = from.clone().add(new THREE.Vector3(-Math.cos(yaw) * 0.22, -0.22, Math.sin(yaw) * 0.22)).addScaledVector(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), 0.7);
          this.flash(muzzle, 0.6);
          for (const to of msg.to) {
            const end = new THREE.Vector3(...to);
            this.tracer(muzzle, end);
            this.impact(end);
          }
        }
        break;
      }
      case 'proj':
        this.spawnProj(msg.rid, msg.kind, new THREE.Vector3(...msg.pos), new THREE.Vector3(...msg.vel));
        if (msg.id !== this.me.id) {
          const d = new THREE.Vector3(...msg.pos).distanceTo(this.camera.position);
          if (msg.kind === 'rocket') playShot(CANNON, d);
          else playThrow();
        }
        break;
      case 'boom':
        this.explode(msg.rid, msg.kind, new THREE.Vector3(...msg.pos));
        break;
      case 'hit':
        if (msg.target === this.me.id) {
          this.me.hp = msg.hp;
          this.damageFlash();
          playHurt();
        }
        if (msg.by === this.me.id && msg.target !== this.me.id) {
          this.hitmarker(msg.head);
          playHitmarker(msg.head);
        }
        break;
      case 'kill':
        this.killfeed(msg.killer, msg.victim, msg.w, msg.head);
        if (msg.victim === this.me.id) {
          this.me.alive = false;
          this.me.hp = 0;
          this.ads = false;
          this.flashCenter(`Eliminado por ${this.name(msg.killer)}\n${this.rounds ? 'Você volta no próximo round' : 'Renascendo…'}`, 3000);
        } else {
          const r = this.remotes.get(msg.victim);
          if (r) {
            r.alive = false;
            r.avatar.setDead(true);
          }
          if (msg.killer === this.me.id) this.flashCenter(msg.head ? '+100  NA CABEÇA!' : '+100', 1200);
        }
        break;
      case 'respawn':
        if (msg.id === this.me.id) {
          Object.assign(this.me, newMover(msg.x, msg.z), { alive: true, hp: MAX_HP });
          this.ui.center.textContent = '';
        } else {
          const r = this.remotes.get(msg.id);
          if (r) {
            r.alive = true;
            r.buf = [];
            r.avatar.setDead(false);
            r.avatar.setArmor(false);
            r.avatar.root.position.set(msg.x, 0, msg.z);
          }
        }
        break;
      case 'chest':
        this.view.setChest(msg.id, msg.open);
        if (msg.open && msg.by === this.me.id && msg.w !== undefined) {
          playChest();
          const extras = [msg.armor ? 'Colete' : '', msg.nades ? `${msg.nades} granadas` : ''].filter(Boolean);
          this.flashCenter(`Você pegou: ${WEAPONS[msg.w].name}${extras.length ? ` + ${extras.join(' + ')}` : ''}`, 1800);
        }
        break;
      case 'score':
        this.teams = msg.teams;
        for (const s of msg.stats) this.stats.set(s.id, s);
        if (!this.ui.board.hidden && !this.ended) this.renderBoard();
        break;
      case 'matchEnd':
        this.teams = msg.teams;
        for (const s of msg.stats) this.stats.set(s.id, s);
        this.showEnd(msg.winner);
        break;
      case 'remove':
        this.removeRemote(msg.id);
        break;
      default:
        return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Entrada
  // ---------------------------------------------------------------------------
  private bindInput() {
    const on = (target: Window | Document | HTMLElement, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.disposers.push(() => target.removeEventListener(type, fn, opts));
    };

    on(window, 'keydown', (e: KeyboardEvent) => {
      if (this.ended) return;
      if (e.code === 'Escape') {
        if (this.paused) this.resume();
        return;
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        this.ui.board.hidden = false;
        this.renderBoard();
        return;
      }
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
      if (this.paused || e.repeat) return;
      if (e.code === 'KeyR') this.net.send({ t: 'reload' });
      if (e.code === 'KeyE') this.net.send({ t: 'use' });
      if (e.code === 'KeyG') this.throwNade(performance.now());
      const n = Number(e.key);
      if (n >= 1 && n <= WEAPONS.length) this.switchTo(n - 1);
      if (e.code === 'KeyQ') this.cycle(-1);
    });
    on(window, 'keyup', (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab' && !this.ended) this.ui.board.hidden = true;
    });
    on(window, 'blur', () => {
      this.keys.clear();
      this.mouseDown = false;
      this.ads = false;
    });
    on(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());

    on(this.canvas, 'mousedown', (e: MouseEvent) => {
      unlockAudio();
      if (coarse || this.ended) return;
      if (!this.locked) {
        if (!this.paused) void this.canvas.requestPointerLock();
        return;
      }
      if (!this.me.alive && this.rounds) {
        // Espectador: clique troca de jogador assistido
        const ids = [...this.remotes.entries()].filter(([, r]) => r.alive).map(([id]) => id);
        if (ids.length) this.spectating = ids[(ids.indexOf(this.spectating) + 1) % ids.length];
        return;
      }
      if (e.button === 0) {
        this.mouseDown = true;
        this.tryFire(performance.now());
      } else if (e.button === 2) this.setAds(true);
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.setAds(false);
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked) return;
      const k = SENS / this.zoom();
      this.me.yaw -= e.movementX * k;
      this.me.pitch = Math.max(-1.4, Math.min(1.4, this.me.pitch - e.movementY * k));
    });
    on(this.canvas, 'wheel', (e: WheelEvent) => {
      if (this.locked) this.cycle(Math.sign(e.deltaY));
    }, { passive: true });
    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked && !this.ended && !coarse) this.pause();
      this.ui.clickToPlay.hidden = this.locked || this.paused || this.ended || coarse;
    });

    if (coarse) this.bindTouch(on);
  }

  private bindTouch(on: (t: any, type: string, fn: (e: any) => void, o?: AddEventListenerOptions) => void) {
    // Metade direita da tela: arrastar para mirar.
    let lookId: number | null = null;
    let last = { x: 0, y: 0 };
    on(this.canvas, 'pointerdown', (e: PointerEvent) => {
      if (e.clientX < innerWidth * 0.4 || lookId !== null) return;
      lookId = e.pointerId;
      last = { x: e.clientX, y: e.clientY };
    });
    on(this.canvas, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== lookId) return;
      const k = 0.005 / this.zoom();
      this.me.yaw -= (e.clientX - last.x) * k;
      this.me.pitch = Math.max(-1.4, Math.min(1.4, this.me.pitch - (e.clientY - last.y) * k));
      last = { x: e.clientX, y: e.clientY };
    });
    const end = (e: PointerEvent) => e.pointerId === lookId && (lookId = null);
    on(this.canvas, 'pointerup', end);
    on(this.canvas, 'pointercancel', end);

    const joy = this.ui.joy;
    const knob = joy.firstElementChild as HTMLElement;
    let joyId: number | null = null;
    const move = (e: PointerEvent) => {
      const r = joy.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      this.stick = { x: dx, y: -dy };
      knob.style.transform = `translate(${dx * 30}px, ${dy * 30}px)`;
    };
    on(joy, 'pointerdown', (e: PointerEvent) => {
      joyId = e.pointerId;
      joy.setPointerCapture(e.pointerId);
      move(e);
    });
    on(joy, 'pointermove', (e: PointerEvent) => e.pointerId === joyId && move(e));
    const stop = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return;
      joyId = null;
      this.stick = { x: 0, y: 0 };
      knob.style.transform = '';
    };
    on(joy, 'pointerup', stop);
    on(joy, 'pointercancel', stop);

    const hold = (btn: HTMLElement, down: () => void, up: () => void = () => {}) => {
      on(btn, 'pointerdown', () => {
        unlockAudio();
        down();
      });
      on(btn, 'pointerup', up);
      on(btn, 'pointercancel', up);
    };
    hold(this.ui.fireBtn, () => {
      this.mouseDown = true;
      this.tryFire(performance.now());
    }, () => (this.mouseDown = false));
    hold(this.ui.adsBtn, () => this.setAds(!this.ads));
    hold(this.ui.jumpBtn, () => (this.touchJump = true), () => (this.touchJump = false));
    hold(this.ui.nadeBtn, () => this.throwNade(performance.now()));
    on(this.ui.useBtn, 'click', () => this.net.send({ t: 'use' }));
    on(this.ui.reloadBtn, 'click', () => this.net.send({ t: 'reload' }));
    on(this.ui.swapBtn, 'click', () => this.cycle(1));
    on(this.ui.pauseBtn, 'click', () => this.pause());
  }

  private owned(i: number) {
    return i === FISTS || this.inv.reserve[i] >= 0;
  }

  private switchTo(i: number) {
    if (!this.owned(i) || i === this.inv.cur) return;
    this.inv.cur = i;
    this.inv.reloading = false;
    this.setViewWeapon(i, true);
    this.net.send({ t: 'switch', w: i });
  }

  private cycle(dir: number) {
    for (let k = 1; k <= WEAPONS.length; k++) {
      const i = (((this.inv.cur + dir * k) % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
      if (this.owned(i)) return this.switchTo(i);
    }
  }

  private setAds(on: boolean) {
    if (on && (this.inv.cur === FISTS || !this.me.alive)) on = false;
    if (on !== this.ads && on) playZoom();
    this.ads = on;
  }

  private zoom() {
    return 1 + (WEAPONS[this.inv.cur].zoom - 1) * this.adsK;
  }

  private pause() {
    if (this.ended) return;
    this.paused = true;
    this.mouseDown = false;
    this.ads = false;
    this.keys.clear();
    this.ui.pause.hidden = false;
    this.ui.clickToPlay.hidden = true;
  }

  private resume() {
    this.paused = false;
    this.ui.pause.hidden = true;
    if (!coarse) void this.canvas.requestPointerLock();
  }

  quit() {
    this.net.send({ t: 'quitMatch' });
    this.onExit();
  }

  // ---------------------------------------------------------------------------
  // Tiro e granada
  // ---------------------------------------------------------------------------
  private eye() {
    return new THREE.Vector3(this.me.x, this.me.y + EYE_HEIGHT, this.me.z);
  }

  private tryFire(now: number) {
    if (!this.me.alive || this.phase !== 'live' || this.paused || this.ended || this.switchT > 0.4) return;
    const i = this.inv.cur;
    const w = WEAPONS[i];
    if (now < this.nextFire || this.inv.reloading) return;
    if (w.mag > 0 && this.inv.ammo[i] <= 0) {
      playClick();
      this.net.send({ t: 'reload' });
      this.nextFire = now + 300;
      return;
    }
    this.nextFire = now + w.interval;
    if (w.mag > 0) this.inv.ammo[i]--;
    const adsNow = this.adsK > 0.6;
    this.net.send({ t: 'shoot', yaw: this.me.yaw, pitch: this.me.pitch, ads: adsNow });
    playShot(i);

    if (i === FISTS) {
      this.punchT = 0.25;
      return;
    }
    // Coice: visual + um pequeno salto real da mira (menor mirando).
    this.recoil = Math.min(1.2, this.recoil + w.recoil);
    this.me.pitch = Math.min(1.4, this.me.pitch + w.recoil * (adsNow ? 0.008 : 0.014));
    this.me.yaw += (Math.random() - 0.5) * w.recoil * 0.006;
    this.shake = Math.max(this.shake, w.recoil * 0.35);
    if (this.gun?.slide) this.gun.slide.position.z -= 0.035;
    const muzzle = this.muzzleWorld();
    this.flash(muzzle, 1);
    if (w.projectile) return; // o foguete aparece quando o servidor confirma

    const eye = this.eye();
    const moveK = this.me.grounded ? 1 + Math.hypot(this.me.vx, this.me.vz) * 0.08 : 2;
    const spread = w.spread * (adsNow ? w.adsSpread : 1) * moveK;
    for (let p = 0; p < w.pellets; p++) {
      const d = aimDir(this.me.yaw + (Math.random() - 0.5) * 2 * spread, this.me.pitch + (Math.random() - 0.5) * 2 * spread);
      let t = rayObstacles(eye, d, w.range, this.arena);
      for (const r of this.remotes.values()) {
        if (!r.alive) continue;
        const pos = r.avatar.root.position;
        const hit = rayBody(eye, d, pos.x, pos.z, pos.y);
        if (hit && hit.t < t) t = hit.t;
      }
      const end = eye.clone().add(new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(t));
      this.tracer(muzzle, end);
      if (t < w.range - 0.01) this.impact(end);
    }
  }

  private throwNade(now: number) {
    if (!this.me.alive || this.phase !== 'live' || this.paused || this.inv.nades <= 0 || now < this.nextNade) return;
    this.nextNade = now + GRENADE.interval;
    this.inv.nades--;
    this.net.send({ t: 'throw', yaw: this.me.yaw, pitch: this.me.pitch });
    playThrow();
    this.switchT = 0.5; // abaixa a arma rapidamente, como quem arremessa
  }

  private muzzleWorld() {
    // Ponto da boca no espaço da câmera da arma -> mundo (pela câmera principal).
    this.viewmodel.updateMatrixWorld(true);
    const local = this.gun ? this.gun.group.localToWorld(this.gun.muzzle.clone()) : new THREE.Vector3(0.15, -0.15, -0.6);
    this.camera.updateMatrixWorld(true);
    return this.camera.localToWorld(local);
  }

  // ---------------------------------------------------------------------------
  // Arma em primeira pessoa
  // ---------------------------------------------------------------------------
  private buildFists(skin: number) {
    const m = new THREE.MeshStandardMaterial({ color: SKIN_TONES[skin] ?? SKIN_TONES[0], roughness: 0.6 });
    const g = new THREE.Group();
    for (const side of [-1, 1]) {
      const fist = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.09), m);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.22), m);
      arm.position.z = 0.15;
      const f = new THREE.Group();
      f.add(fist, arm);
      f.position.set(side * 0.16, -0.19, -0.52);
      f.rotation.x = 0.25;
      f.name = side > 0 ? 'R' : 'L';
      g.add(f);
    }
    this.fists = g;
  }

  private setViewWeapon(w: number, animate: boolean) {
    this.viewmodel.clear();
    this.gun = undefined;
    if (w === FISTS) {
      if (this.fists) this.viewmodel.add(this.fists);
    } else {
      const gun = buildGun(w);
      if (gun) {
        gun.group.rotation.y = Math.PI; // modelos apontam para +Z; a câmera olha para -Z
        this.viewmodel.add(gun.group);
        this.gun = gun;
      }
    }
    if (animate) this.switchT = 0.45;
    if (w === FISTS) this.ads = false;
    this.updateWeaponHud();
  }

  private updateViewmodel(dt: number) {
    const w = WEAPONS[this.inv.cur];
    this.switchT = Math.max(0, this.switchT - dt);
    if (this.inv.reloading) this.reloadT += dt;
    const reloadK = this.inv.reloading ? Math.sin(Math.min(1, this.reloadT / (w.reload / 1000)) * Math.PI) : 0;
    const bobAmp = 1 - this.adsK * 0.85;
    const bobX = Math.sin(this.bob) * 0.012 * bobAmp;
    const bobY = (this.moving ? Math.abs(Math.cos(this.bob)) * -0.012 : 0) * bobAmp;
    const sw = this.switchT > 0 ? Math.sin((this.switchT / 0.45) * Math.PI) * 0.25 : 0;
    const air = this.me.grounded ? 0 : -0.02;

    if (this.gun) {
      // Quadril: canto inferior direito. Mirando: alinha a mira ao centro da tela.
      const s = this.gun.sight;
      const hip = new THREE.Vector3(0.17, -0.19, -0.36);
      const aim = new THREE.Vector3(s.x, -s.y, -0.3 + s.z);
      this.gun.group.position.lerpVectors(hip, aim, this.adsK);
      this.gun.group.position.x += bobX;
      this.gun.group.position.y += bobY - sw + air - reloadK * 0.08;
      this.gun.group.position.z += this.recoil * 0.05 * (1 - this.adsK * 0.6);
      this.gun.group.rotation.set(-this.recoil * 0.12 * (1 - this.adsK * 0.7) - reloadK * 0.5 - sw, Math.PI, reloadK * 0.5);
      if (this.gun.mag) this.gun.mag.position.y += ((reloadK > 0.3 ? -0.12 : 0) - (this.gun.mag.position.y - (this.gun.mag.userData.y0 ??= this.gun.mag.position.y))) * Math.min(1, dt * 12);
      if (this.gun.slide) {
        const z0 = (this.gun.slide.userData.z0 ??= this.gun.slide.position.z + 0.035);
        this.gun.slide.position.z += (z0 - this.gun.slide.position.z) * Math.min(1, dt * 18);
      }
      // Sniper mirando: some a arma e aparece a luneta.
      this.viewmodel.visible = this.me.alive && !(this.inv.cur === 5 && this.adsK > 0.85);
    } else {
      this.viewmodel.visible = this.me.alive;
    }
    if (this.fists && this.inv.cur === FISTS) {
      this.punchT = Math.max(0, this.punchT - dt);
      const jab = Math.sin((this.punchT / 0.25) * Math.PI);
      this.fists.position.set(bobX, bobY - sw + air, 0);
      this.fists.getObjectByName('R')!.position.z = -0.52 - jab * 0.25;
    }
    this.ui.scope.hidden = !(this.inv.cur === 5 && this.adsK > 0.85 && this.me.alive);
  }

  // ---------------------------------------------------------------------------
  // Efeitos
  // ---------------------------------------------------------------------------
  private flash(at: THREE.Vector3, strength: number) {
    const l = this.lights[this.lightIdx++ % this.lights.length];
    l.position.copy(at);
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09 * strength + 0.04, 0), new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, depthWrite: false }));
    s.position.copy(at);
    this.addFx(s, 0.06, (k) => {
      (s.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      l.intensity = 30 * strength * (1 - k);
    });
  }

  private tracer(from: THREE.Vector3, to: THREE.Vector3) {
    const len = from.distanceTo(to);
    if (len < 0.5) return;
    const m = new THREE.Mesh(this.unitBox, new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0.85, depthWrite: false }));
    m.position.copy(from);
    m.lookAt(to);
    m.scale.set(0.018, 0.018, len);
    this.addFx(m, 0.09, (k) => ((m.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k)));
  }

  private impact(at: THREE.Vector3) {
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(this.puffGeo, new THREE.MeshBasicMaterial({ color: '#cbbfa9', transparent: true, depthWrite: false }));
      p.position.copy(at);
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2);
      this.addFx(p, 0.4, (k) => {
        p.position.addScaledVector(v, 0.016);
        p.scale.setScalar(1 + k * 2);
        (p.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
      });
    }
  }

  private spawnProj(rid: number, kind: ProjKind, pos: THREE.Vector3, vel: THREE.Vector3) {
    const g = new THREE.Group();
    if (kind === 'rocket') {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#4b5320' }));
      const fire = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffb347' }));
      fire.position.z = -0.38;
      g.add(body, fire);
    } else {
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), new THREE.MeshStandardMaterial({ color: '#3d4a2c', roughness: 0.5, metalness: 0.4 }));
      body.scale.y = 1.25;
      const pin = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 6, 10), new THREE.MeshStandardMaterial({ color: '#c9a640', metalness: 0.8 }));
      pin.position.y = 0.1;
      g.add(body, pin);
    }
    g.position.copy(pos);
    this.scene.add(g);
    this.projs.set(rid, { kind, mesh: g, p: { pos: { x: pos.x, y: pos.y, z: pos.z }, vel: { x: vel.x, y: vel.y, z: vel.z } }, smokeAcc: 0 });
  }

  private explode(rid: number, kind: ProjKind, at: THREE.Vector3) {
    const r = this.projs.get(rid);
    if (r) {
      this.scene.remove(r.mesh);
      this.projs.delete(rid);
    }
    const size = kind === 'nade' ? 1.15 : 1;
    const dist = at.distanceTo(this.camera.position);
    playExplosion(dist);
    this.shake = Math.max(this.shake, Math.max(0, 1.3 - dist / 18));
    const l = this.lights[this.lightIdx++ % this.lights.length];
    l.position.copy(at).setY(Math.max(1, at.y + 0.5));
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: '#ff9a3c', transparent: true, depthWrite: false }));
    ball.position.copy(at);
    this.addFx(ball, 0.45, (k) => {
      ball.scale.setScalar((0.5 + k * 4) * size);
      const m = ball.material as THREE.MeshBasicMaterial;
      m.opacity = 1 - k;
      m.color.setHSL(0.08 - k * 0.06, 1, 0.6 - k * 0.3);
      l.intensity = 140 * (1 - k);
    });
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), new THREE.MeshStandardMaterial({ color: '#3a3632', transparent: true, depthWrite: false }));
      s.position.copy(at);
      const v = new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6);
      this.addFx(s, 1.5, (k) => {
        s.position.addScaledVector(v, 0.016 * (1 - k));
        s.scale.setScalar((0.6 + k * 2.5) * size);
        (s.material as THREE.MeshStandardMaterial).opacity = 0.7 * (1 - k);
      });
    }
  }

  private addFx(obj: THREE.Object3D, life: number, update?: (k: number) => void) {
    this.scene.add(obj);
    this.fxObjects.push({ obj, life, max: life, update });
  }

  private updateFx(dt: number) {
    for (let i = this.fxObjects.length - 1; i >= 0; i--) {
      const f = this.fxObjects[i];
      f.life -= dt;
      const k = 1 - Math.max(0, f.life) / f.max;
      f.update?.(k);
      if (f.life <= 0) {
        this.scene.remove(f.obj);
        f.obj.traverse((o) => {
          if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
        });
        this.fxObjects.splice(i, 1);
      }
    }
    for (const r of this.projs.values()) {
      if (r.kind === 'rocket') {
        projStep(r.p, dt, this.arena, WEAPONS[CANNON].projectile!.gravity, 0);
        r.mesh.lookAt(r.p.pos.x + r.p.vel.x, r.p.pos.y + r.p.vel.y, r.p.pos.z + r.p.vel.z);
        r.smokeAcc += dt;
        if (r.smokeAcc > 0.03) {
          r.smokeAcc = 0;
          const s = new THREE.Mesh(this.puffGeo, new THREE.MeshBasicMaterial({ color: '#d8d2c8', transparent: true, depthWrite: false }));
          s.position.set(r.p.pos.x, r.p.pos.y, r.p.pos.z);
          this.addFx(s, 0.8, (k) => {
            s.scale.setScalar(1 + k * 4);
            (s.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k);
          });
        }
      } else {
        const vy = r.p.vel.y;
        projStep(r.p, dt, this.arena, GRENADE.gravity, GRENADE.bounce);
        if (vy < -2 && r.p.vel.y >= 0) playBounce(this.camera.position.distanceTo(new THREE.Vector3(r.p.pos.x, r.p.pos.y, r.p.pos.z)));
        r.mesh.rotation.x += dt * 8;
      }
      r.mesh.position.set(r.p.pos.x, r.p.pos.y, r.p.pos.z);
    }
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------
  update(dt: number, now: number) {
    const live = this.phase === 'live' && this.me.alive && !this.paused && !this.ended;
    if (this.mouseDown && WEAPONS[this.inv.cur].auto) this.tryFire(now);

    // Movimento relativo ao olhar
    let mx = 0;
    let my = 0;
    let run = false;
    let jump = false;
    if (live) {
      const k = (a: string, b: string) => (this.keys.has(a) || this.keys.has(b) ? 1 : 0);
      mx = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
      my = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
      run = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) && !this.ads;
      jump = this.keys.has('Space') || this.touchJump;
      if (this.stick.x || this.stick.y) {
        mx = this.stick.x;
        my = this.stick.y;
        run = Math.hypot(mx, my) > 0.85 && !this.ads;
      }
    }
    const fx = Math.sin(this.me.yaw);
    const fz = Math.cos(this.me.yaw);
    const dx = fx * my - fz * mx;
    const dz = fz * my + fx * mx;
    // Mirando anda mais devagar
    const slow = this.ads ? 0.55 : 1;
    if (this.phase === 'live' && this.me.alive) this.moving = arenaMove(this.me, { dx: dx * slow, dz: dz * slow, run, jump }, dt, this.arena);
    else this.moving = 0;

    // Envia estado (~30 Hz): posição simulada aqui, validada no servidor.
    if (now - this.lastSent > 33) {
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      this.net.send({ t: 'minput', dx: r3(dx), dz: r3(dz), run, jump, ads: this.ads, yaw: r3(this.me.yaw), pitch: r3(this.me.pitch), x: r3(this.me.x), z: r3(this.me.z), y: r3(this.me.y) });
      this.lastSent = now;
    }

    // Mira (zoom)
    this.adsK += ((this.ads && this.me.alive ? 1 : 0) - this.adsK) * Math.min(1, dt * 14);
    const fov = BASE_FOV / this.zoom();
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // Câmera em primeira pessoa
    this.bob += dt * (this.moving === 2 ? 13 : this.moving ? 9 : 0) * (this.me.grounded ? 1 : 0);
    const bobY = this.moving && this.me.grounded ? Math.sin(this.bob * 2) * 0.03 * (1 - this.adsK * 0.8) : 0;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sh = this.shake * 0.04;
    const deadDrop = this.me.alive ? 0 : 1.1;
    this.camera.position.set(this.me.x + (Math.random() - 0.5) * sh, this.me.y + EYE_HEIGHT + bobY - deadDrop, this.me.z + (Math.random() - 0.5) * sh);
    this.camera.rotation.set(this.me.pitch + this.recoil * 0.02 + (Math.random() - 0.5) * sh, this.me.yaw + Math.PI, this.me.alive ? 0 : 0.5);
    this.gfx.follow(new THREE.Vector3(this.me.x, 0, this.me.z));

    // Rounds: morto assiste um companheiro vivo em terceira pessoa (clique troca).
    if (!this.me.alive && this.rounds && this.phase !== 'ended') {
      const alive = [...this.remotes.entries()].filter(([, r]) => r.alive);
      const mates = alive.filter(([, r]) => r.info.team === this.me.team);
      const pool = mates.length ? mates : alive;
      let target = pool.find(([id]) => id === this.spectating);
      if (!target && pool.length) target = pool[0];
      if (target) {
        this.spectating = target[0];
        const pos = target[1].avatar.root.position;
        const yaw = target[1].avatar.root.rotation.y;
        const want = new THREE.Vector3(pos.x - Math.sin(yaw) * 3.6, pos.y + 2.3, pos.z - Math.cos(yaw) * 3.6);
        this.specCam.lerp(want, 1 - Math.exp(-dt * 6));
        this.camera.position.copy(this.specCam);
        this.camera.lookAt(pos.x, pos.y + 1.4, pos.z);
        this.ui.spectate.textContent = `Assistindo: ${target[1].info.name} · clique para trocar`;
        this.gfx.follow(pos);
      }
    } else this.specCam.copy(this.camera.position);
    this.ui.spectate.hidden = this.me.alive || !this.rounds || this.phase === 'ended';

    this.updateViewmodel(dt);
    this.updateRemotes(dt, now);
    this.view.update(dt, now / 1000);
    this.updateFx(dt);
    this.updateHud();
  }

  private updateRemotes(dt: number, now: number) {
    const renderT = now - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const buf = r.buf;
      if (buf.length) {
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
        r.avatar.root.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
        let dy = b.yaw - a.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        r.avatar.root.rotation.y = a.yaw + dy * k;
        r.avatar.setAim(a.pitch + (b.pitch - a.pitch) * k);
        r.avatar.update(dt, r.alive ? b.mv : 0);
      } else r.avatar.update(dt, 0);
      r.avatar.setDead(!r.alive);
    }
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  private buildHud() {
    const hud = el('div', 'mhud');
    document.body.append(hud);
    this.ui.scope = el('div', 'm-scope', hud);
    this.ui.scope.hidden = true;
    const top = el('div', 'm-top', hud);
    for (const t of [0, 1] as const) {
      const box = el('div', `m-team${t === this.me.team ? ' mine' : ''}`, top);
      box.style.setProperty('--c', TEAMS[t].color);
      const name = el('span', '', box);
      name.textContent = TEAMS[t].name;
      this.ui[`score${t}`] = el('b', '', box);
      if (t === 0) this.ui.timer = el('div', 'm-timer', top);
    }
    this.ui.feed = el('div', 'm-feed', hud);
    const cross = el('div', 'm-cross', hud);
    for (let i = 0; i < 4; i++) el('i', '', cross);
    this.ui.cross = cross;
    this.ui.hit = el('div', 'm-hitmark', hud);
    this.ui.dmg = el('div', 'm-dmg', hud);
    this.ui.prompt = el('div', 'm-prompt', hud);
    this.ui.center = el('div', 'm-center', hud);
    this.ui.spectate = el('div', 'm-spectate', hud);
    this.ui.spectate.hidden = true;
    this.ui.alive = el('div', 'm-alive', hud);

    const vitals = el('div', 'm-hp', hud);
    const hpRow = el('div', 'm-row', vitals);
    el('span', 'm-ico', hpRow).textContent = '✚';
    const bar = el('div', 'm-hpbar', hpRow);
    this.ui.hpFill = el('div', '', bar);
    this.ui.hpText = el('b', '', hpRow);
    const arRow = el('div', 'm-row', vitals);
    el('span', 'm-ico', arRow).textContent = '⛨';
    const abar = el('div', 'm-hpbar m-armorbar', arRow);
    this.ui.armorFill = el('div', '', abar);
    this.ui.armorText = el('b', '', arRow);

    const wbox = el('div', 'm-weapon', hud);
    this.ui.wname = el('div', 'm-wname', wbox);
    this.ui.ammo = el('div', 'm-ammo', wbox);
    this.ui.nades = el('div', 'm-nades', wbox);
    this.ui.slots = el('div', 'm-slots', wbox);

    this.ui.board = el('div', 'm-board', hud);
    this.ui.board.hidden = true;

    this.ui.clickToPlay = el('div', 'm-click', hud);
    this.ui.clickToPlay.textContent =
      'Clique para jogar · WASD anda · Espaço pula · Shift corre · clique atira · botão direito mira · G granada · E baú · R recarrega · 1–7 armas · Tab placar';
    this.ui.clickToPlay.hidden = coarse;

    const pause = el('div', 'm-pause', hud);
    pause.hidden = true;
    const card = el('div', 'menu-card', pause);
    el('h2', '', card).textContent = 'Pausa';
    const resume = el('button', 'btn-primary', card);
    resume.textContent = 'Continuar';
    resume.addEventListener('click', () => this.resume());
    const quit = el('button', 'btn-secondary danger', card);
    quit.textContent = 'Sair do evento';
    quit.addEventListener('click', () => this.quit());
    this.ui.pause = pause;

    if (coarse) {
      const touch = el('div', 'm-touch', hud);
      this.ui.joy = el('div', 'joystick m-joy', touch);
      el('div', 'knob', this.ui.joy);
      const btn = (key: string, cls: string, text: string) => {
        this.ui[key] = el('button', `m-btn ${cls}`, touch);
        this.ui[key].textContent = text;
      };
      btn('fireBtn', 'm-fire', 'ATIRAR');
      btn('adsBtn', 'm-adsbtn', 'MIRA');
      btn('jumpBtn', 'm-jump', 'PULO');
      btn('nadeBtn', 'm-nade', 'G');
      btn('useBtn', 'm-use', 'ABRIR');
      btn('reloadBtn', 'm-reload', 'R');
      btn('swapBtn', 'm-swap', '⇄');
      btn('pauseBtn', 'm-pausebtn', '☰');
    }
    return hud;
  }

  private updateWeaponHud() {
    if (!this.ui.wname) return;
    const i = this.inv.cur;
    const w = WEAPONS[i];
    this.ui.wname.textContent = w.name;
    this.ui.ammo.textContent = this.inv.reloading ? 'Recarregando…' : w.mag ? `${this.inv.ammo[i]} / ${Math.max(0, this.inv.reserve[i])}` : '';
    this.ui.nades.textContent = `💣 ${this.inv.nades}  (G)`;
    this.ui.nades.style.opacity = this.inv.nades > 0 ? '1' : '0.35';
    const slots = WEAPONS.map((wp, k) => `${k + 1} ${wp.name}`).join('|');
    if (this.ui.slots.dataset.key !== `${slots}${i}${WEAPONS.map((_, k) => this.owned(k)).join()}`) {
      this.ui.slots.dataset.key = `${slots}${i}${WEAPONS.map((_, k) => this.owned(k)).join()}`;
      this.ui.slots.replaceChildren(
        ...WEAPONS.map((wp, k) => {
          const s = document.createElement('span');
          s.textContent = `${k + 1} ${wp.name}`;
          s.className = `${this.owned(k) ? 'own' : ''} ${k === i ? 'cur' : ''}`;
          return s;
        }),
      );
    }
  }

  private updateHud() {
    const remaining = Math.max(0, this.phaseEnds - (Date.now() + this.clockOffset));
    const s = Math.ceil(remaining / 1000);
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const roundTag = this.rounds ? `R${this.round}/${this.rounds} · ` : '';
    this.ui.timer.textContent =
      this.phase === 'countdown' ? `${roundTag}Começa em ${s}` : this.phase === 'ended' ? 'Fim' : this.phase === 'roundEnd' ? `${roundTag}Próximo em ${s}` : `${roundTag}${clock}`;
    // Rounds: quantos ainda estão vivos de cada lado (bolinhas)
    if (this.rounds) {
      const alive: [number, number] = [0, 0];
      const total: [number, number] = [0, 0];
      for (const r of this.remotes.values()) {
        total[r.info.team]++;
        if (r.alive) alive[r.info.team]++;
      }
      total[this.me.team]++;
      if (this.me.alive) alive[this.me.team]++;
      const dots = (t: 0 | 1) => '●'.repeat(alive[t]) + '○'.repeat(total[t] - alive[t]);
      const key = `${dots(0)}|${dots(1)}`;
      if (this.ui.alive.dataset.k !== key) {
        this.ui.alive.dataset.k = key;
        this.ui.alive.replaceChildren(
          ...([0, 1] as const).map((t) => {
            const sp = document.createElement('span');
            sp.textContent = dots(t);
            sp.style.color = TEAMS[t].color;
            return sp;
          }),
        );
      }
    }
    this.ui.timer.classList.toggle('low', this.phase === 'live' && s <= 30);
    this.ui.score0.textContent = String(this.teams[0]);
    this.ui.score1.textContent = String(this.teams[1]);
    const hp = Math.max(0, this.me.hp);
    this.ui.hpText.textContent = String(hp);
    this.ui.hpFill.style.width = `${hp}%`;
    this.ui.hpFill.style.background = hp > 50 ? '#2ec27e' : hp > 25 ? '#ffd23f' : '#e63946';
    this.ui.armorText.textContent = String(this.inv.armor);
    this.ui.armorFill.style.width = `${this.inv.armor}%`;
    this.updateWeaponHud();

    // Mira abre com o espalhamento/movimento e fecha ao mirar
    const w = WEAPONS[this.inv.cur];
    const spread = w.spread * (this.adsK > 0.6 ? w.adsSpread : 1) * 400 + (this.moving ? 6 : 0) + (this.me.grounded ? 0 : 10) + this.recoil * 10 + 4;
    this.ui.cross.style.setProperty('--gap', `${spread}px`);
    this.ui.cross.hidden = !this.me.alive || (this.adsK > 0.7 && this.inv.cur !== FISTS);

    // Aviso de baú
    let prompt = '';
    if (this.me.alive && this.phase === 'live') {
      for (const c of this.arena.chests) {
        if (!this.view.chests[c.id]?.open && Math.hypot(c.x - this.me.x, c.z - this.me.z) < 2.3 && this.me.y < 1.5) {
          prompt = coarse ? 'Toque em ABRIR para pegar uma arma' : 'Pressione E para abrir o baú';
          break;
        }
      }
      if (!prompt && this.inv.cur === FISTS && !this.inv.reserve.some((r) => r >= 0)) prompt = 'Procure os baús brilhando para pegar armas, colete e granadas';
    }
    if (this.phase === 'countdown') prompt = 'Prepare-se!';
    this.ui.prompt.textContent = prompt;
  }

  private centerTimer = 0;
  private flashCenter(text: string, ms: number) {
    this.ui.center.textContent = text;
    clearTimeout(this.centerTimer);
    this.centerTimer = window.setTimeout(() => {
      if (this.me.alive || this.ended) this.ui.center.textContent = '';
    }, ms);
  }

  private hitTimer = 0;
  private hitmarker(head: boolean) {
    this.ui.hit.className = `m-hitmark show${head ? ' head' : ''}`;
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => (this.ui.hit.className = 'm-hitmark'), 160);
  }

  private damageFlash() {
    this.ui.dmg.classList.remove('show');
    void this.ui.dmg.offsetWidth;
    this.ui.dmg.classList.add('show');
  }

  private killfeed(killer: number, victim: number, w: number, head: boolean) {
    const row = el('div', 'm-kill', this.ui.feed);
    const k = el('b', '', row);
    k.textContent = this.name(killer);
    k.style.color = TEAMS[this.names.get(killer)?.team ?? 0].color;
    const wpn = el('span', '', row);
    wpn.textContent = ` [${killWeaponName(w)}${head ? ' 🎯' : ''}] `;
    const v = el('b', '', row);
    v.textContent = this.name(victim);
    v.style.color = TEAMS[this.names.get(victim)?.team ?? 0].color;
    if (killer === this.me.id || victim === this.me.id) row.classList.add('me');
    while (this.ui.feed.children.length > 6) this.ui.feed.firstElementChild!.remove();
    setTimeout(() => row.remove(), 6000);
  }

  private renderBoard(title?: string) {
    const b = this.ui.board;
    b.replaceChildren();
    if (title) el('h2', '', b).textContent = title;
    const cols = el('div', 'm-board-cols', b);
    for (const t of [0, 1] as const) {
      const col = el('div', '', cols);
      const head = el('h3', '', col);
      head.textContent = `${TEAMS[t].name} — ${this.teams[t]}`;
      head.style.color = TEAMS[t].color;
      const table = el('table', '', col);
      const hr = el('tr', '', table);
      for (const c of ['Jogador', 'Abates', 'Mortes', 'Pontos']) el('th', '', hr).textContent = c;
      const rows = [...this.names.values()].filter((p) => p.team === t).map((p) => ({ p, s: this.stats.get(p.id)! })).sort((a, b2) => b2.s.score - a.s.score);
      for (const { p, s } of rows) {
        const tr = el('tr', p.id === this.me.id ? 'me' : '', table);
        el('td', '', tr).textContent = p.name + (p.bot ? ' 🤖' : '');
        el('td', '', tr).textContent = String(s.kills);
        el('td', '', tr).textContent = String(s.deaths);
        el('td', '', tr).textContent = String(s.score);
      }
    }
  }

  private showEnd(winner: TeamId | -1) {
    this.ended = true;
    this.mouseDown = false;
    this.ads = false;
    if (document.pointerLockElement) document.exitPointerLock();
    const title = winner === -1 ? 'Empate!' : winner === this.me.team ? `Vitória da ${TEAMS[winner].name}! 🏆` : `Vitória da ${TEAMS[winner].name}`;
    this.renderBoard(title);
    const all = [...this.stats.values()].sort((a, b) => b.score - a.score);
    if (all[0]) el('p', 'm-mvp', this.ui.board).textContent = `Destaque: ${this.name(all[0].id)} — ${all[0].kills} abates, ${all[0].score} pontos`;
    const back = el('button', 'btn-primary', this.ui.board);
    let left = 10;
    back.textContent = `Voltar para a avenida (${left})`;
    back.addEventListener('click', () => this.onExit());
    const timer = window.setInterval(() => {
      left--;
      back.textContent = `Voltar para a avenida (${left})`;
      if (left <= 0) {
        clearInterval(timer);
        this.onExit();
      }
    }, 1000);
    this.disposers.push(() => clearInterval(timer));
    this.ui.board.hidden = false;
    this.ui.pause.hidden = true;
    this.ui.clickToPlay.hidden = true;
  }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.remove();
    for (const r of this.remotes.values()) r.avatar.dispose();
    this.gfx.aoEnabled = true;
    this.gfx.overlay = undefined;
    this.camera.fov = BASE_FOV;
  }
}
