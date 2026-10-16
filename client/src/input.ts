// Teclado, mouse e toque. Produz um vetor de movimento relativo à câmera
// e acumula a rotação/zoom da câmera.
//
// Dois modos de câmera na avenida:
// - terceira pessoa: arrastar gira a câmera; um clique rápido (sem arrastar) golpeia;
// - primeira pessoa: o mouse fica travado (pointer lock) e mira; clique golpeia.
// Clique esquerdo = bater, clique direito = empurrar.
export class Input {
  move = { x: 0, y: 0 }; // x: direita, y: frente
  run = false;
  camYaw = 0;
  camPitch = 0.38; // terceira pessoa: inclinação da órbita
  lookPitch = 0; // primeira pessoa: olhar para cima/baixo
  camDist = 9;
  enabled = true;
  firstPerson = false;
  /** Golpe pedido pelo mouse: 0 = esquerdo (bater), 2 = direito (empurrar). */
  onClick: (button: number) => void = () => {};
  /** Só reage quando a avenida está na tela (não no lobby, menu ou evento). */
  active: () => boolean = () => true;

  private keys = new Set<string>();
  private stick = { x: 0, y: 0 };
  private dragId: number | null = null;
  private last = { x: 0, y: 0 };
  private down = { x: 0, y: 0, t: 0, moved: 0 };

  constructor(private canvas: HTMLCanvasElement, joystick: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('contextmenu', (e) => this.active() && e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active()) return;
      if (this.firstPerson && e.pointerType === 'mouse') {
        // Primeira pessoa: primeiro clique trava o mouse; depois cada clique golpeia.
        if (!this.locked) void canvas.requestPointerLock();
        else this.onClick(e.button);
        return;
      }
      if (this.dragId !== null) return;
      this.dragId = e.pointerId;
      this.last = { x: e.clientX, y: e.clientY };
      this.down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // falha com o ponteiro travado; a captura é só uma conveniência
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId) return;
      const k = e.pointerType === 'touch' ? 0.008 : 0.005;
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.down.moved += Math.abs(dx) + Math.abs(dy);
      this.camYaw -= dx * k;
      if (this.firstPerson) this.lookPitch = clampPitch(this.lookPitch - dy * k);
      else this.camPitch = Math.min(1.25, Math.max(0.05, this.camPitch + dy * k));
      this.last = { x: e.clientX, y: e.clientY };
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.dragId) return;
      this.dragId = null;
      // Clique rápido sem arrastar = golpe (só mouse; no celular há botões).
      if (e.type === 'pointerup' && e.pointerType === 'mouse' && this.down.moved < 6 && performance.now() - this.down.t < 350) this.onClick(e.button);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    // Primeira pessoa com mouse travado: o movimento do mouse mira.
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.firstPerson) return;
      this.camYaw -= e.movementX * 0.0022;
      this.lookPitch = clampPitch(this.lookPitch - e.movementY * 0.0022);
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.active()) return;
      e.preventDefault();
      if (this.firstPerson) return;
      this.camDist = Math.min(22, Math.max(3.5, this.camDist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });

    this.bindJoystick(joystick);
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  setFirstPerson(on: boolean) {
    this.firstPerson = on;
    if (!on && this.locked) document.exitPointerLock();
  }

  private bindJoystick(el: HTMLElement) {
    const knob = el.querySelector<HTMLElement>('.knob')!;
    let id: number | null = null;
    const update = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const radius = r.width / 2;
      let dx = (e.clientX - (r.left + radius)) / radius;
      let dy = (e.clientY - (r.top + radius)) / radius;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      this.stick = { x: dx, y: -dy };
      knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
    };
    el.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      el.setPointerCapture(e.pointerId);
      update(e);
    });
    el.addEventListener('pointermove', (e) => e.pointerId === id && update(e));
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      this.stick = { x: 0, y: 0 };
      knob.style.transform = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  pressed(code: string) {
    return this.keys.has(code);
  }

  update() {
    if (!this.enabled) {
      this.move = { x: 0, y: 0 };
      this.run = false;
      return;
    }
    const k = (a: string, b: string) => (this.keys.has(a) || this.keys.has(b) ? 1 : 0);
    let x = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
    let y = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
    let run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (this.stick.x || this.stick.y) {
      x = this.stick.x;
      y = this.stick.y;
      run = Math.hypot(x, y) > 0.85;
    }
    this.move = { x, y };
    this.run = run;
  }
}

function clampPitch(v: number) {
  return Math.max(-1.35, Math.min(1.35, v));
}

export function isTyping(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
