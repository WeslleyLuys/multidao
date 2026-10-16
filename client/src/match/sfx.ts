// Efeitos sonoros sintetizados com WebAudio (sem arquivos de áudio).

let ctx: AudioContext | undefined;
let noise: AudioBuffer | undefined;
let master: GainNode | undefined;

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Desbloqueia o áudio (precisa de um gesto do usuário). */
export function unlockAudio() {
  audio();
}

function burst(opts: { dur: number; freq: number; q?: number; type?: BiquadFilterType; vol: number; pitchDrop?: number; tone?: number }) {
  const a = audio();
  const t = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = noise!;
  const filter = a.createBiquadFilter();
  filter.type = opts.type ?? 'lowpass';
  filter.frequency.setValueAtTime(opts.freq, t);
  if (opts.pitchDrop) filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freq * opts.pitchDrop), t + opts.dur);
  filter.Q.value = opts.q ?? 0.7;
  const gain = a.createGain();
  gain.gain.setValueAtTime(opts.vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
  src.connect(filter).connect(gain).connect(master!);
  src.start(t, Math.random() * 0.5, opts.dur + 0.05);
  if (opts.tone) {
    // "Corpo" grave do disparo
    const osc = a.createOscillator();
    osc.frequency.setValueAtTime(opts.tone, t);
    osc.frequency.exponentialRampToValueAtTime(opts.tone * 0.4, t + opts.dur * 0.6);
    const g2 = a.createGain();
    g2.gain.setValueAtTime(opts.vol * 0.6, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + opts.dur * 0.6);
    osc.connect(g2).connect(master!);
    osc.start(t);
    osc.stop(t + opts.dur);
  }
}

const SHOTS: Record<number, Parameters<typeof burst>[0]> = {
  0: { dur: 0.12, freq: 600, vol: 0.5, tone: 90 }, // soco
  1: { dur: 0.18, freq: 3200, vol: 0.55, pitchDrop: 0.2, tone: 160 }, // pistola
  2: { dur: 0.1, freq: 5200, vol: 0.38, pitchDrop: 0.3, tone: 190 }, // submetralhadora
  3: { dur: 0.14, freq: 4200, vol: 0.45, pitchDrop: 0.25, tone: 130 }, // fuzil
  4: { dur: 0.35, freq: 2200, vol: 0.8, pitchDrop: 0.15, tone: 80 }, // shotgun
  5: { dur: 0.6, freq: 3600, vol: 0.9, pitchDrop: 0.08, tone: 70 }, // sniper
  6: { dur: 0.4, freq: 900, vol: 0.6, pitchDrop: 0.3, tone: 60 }, // canhão
};

export function playThrow() {
  burst({ dur: 0.15, freq: 900, vol: 0.2, type: 'bandpass', q: 1.5 });
}

export function playBounce(dist = 0) {
  const k = 1 / (1 + dist / 10);
  burst({ dur: 0.06, freq: 2500, vol: 0.25 * k, type: 'bandpass', q: 3 });
}

export function playZoom() {
  burst({ dur: 0.05, freq: 6000, vol: 0.08, type: 'highpass' });
}

/** `dist` em metros: atenua sons distantes. */
export function playShot(w: number, dist = 0) {
  const base = SHOTS[w] ?? SHOTS[1];
  const k = 1 / (1 + dist / 12);
  if (k < 0.04) return;
  burst({ ...base, vol: base.vol * k, freq: base.freq * (dist > 30 ? 0.5 : 1) });
}

export function playExplosion(dist = 0) {
  const k = 1 / (1 + dist / 25);
  burst({ dur: 1.2, freq: 700, vol: 1.1 * k, pitchDrop: 0.08, tone: 50 });
}

export function playHitmarker(head: boolean) {
  const a = audio();
  const t = a.currentTime;
  const osc = a.createOscillator();
  osc.type = 'square';
  osc.frequency.value = head ? 1800 : 1200;
  const g = a.createGain();
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(g).connect(master!);
  osc.start(t);
  osc.stop(t + 0.08);
}

export function playHurt() {
  burst({ dur: 0.18, freq: 300, vol: 0.4, type: 'bandpass', q: 2 });
}

export function playClick() {
  burst({ dur: 0.04, freq: 5000, vol: 0.15, type: 'highpass' });
}

export function playChest() {
  const a = audio();
  const t = a.currentTime;
  [523, 659, 784].forEach((f, i) => {
    const osc = a.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t + i * 0.07);
    g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.07 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.25);
    osc.connect(g).connect(master!);
    osc.start(t + i * 0.07);
    osc.stop(t + i * 0.07 + 0.3);
  });
}
