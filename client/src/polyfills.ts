// Compatibilidade com navegadores de celular mais antigos (iOS 15, Chrome antigo).

if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, 'at', {
    value(this: unknown[], i: number) {
      const n = Math.trunc(i) || 0;
      return this[n < 0 ? this.length + n : n];
    },
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.structuredClone !== 'function') {
  (globalThis as any).structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
}

// CanvasRenderingContext2D.roundRect só existe no Safari 16+.
const ctxProto = (globalThis as any).CanvasRenderingContext2D?.prototype;
if (ctxProto && !ctxProto.roundRect) {
  ctxProto.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[] = 0) {
    const rad = Math.min(Array.isArray(r) ? r[0] ?? 0 : r, w / 2, h / 2);
    this.moveTo(x + rad, y);
    this.arcTo(x + w, y, x + w, y + h, rad);
    this.arcTo(x + w, y + h, x, y + h, rad);
    this.arcTo(x, y + h, x, y, rad);
    this.arcTo(x, y, x + w, y, rad);
    this.closePath();
  };
}

export const isMobile = matchMedia('(pointer: coarse)').matches;
