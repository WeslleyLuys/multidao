// Teclado, mouse e toque. Produz um vetor de movimento relativo à câmera
// e acumula a rotação/zoom da câmera.
export class Input {
  move = { x: 0, y: 0 }; // x: direita, y: frente
  run = false;
  camYaw = 0;
  camPitch = 0.38;
  camDist = 9;
  enabled = true;

  private keys = new Set<string>();
  private stick = { x: 0, y: 0 };
  private dragId: number | null = null;
  private last = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement, joystick: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('pointerdown', (e) => {
      if (this.dragId !== null) return;
      this.dragId = e.pointerId;
      this.last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId) return;
      const k = e.pointerType === 'touch' ? 0.008 : 0.005;
      this.camYaw -= (e.clientX - this.last.x) * k;
      this.camPitch = Math.min(1.25, Math.max(0.05, this.camPitch + (e.clientY - this.last.y) * k));
      this.last = { x: e.clientX, y: e.clientY };
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.dragId) this.dragId = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDist = Math.min(22, Math.max(3.5, this.camDist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });

    this.bindJoystick(joystick);
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

export function isTyping(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
