/** State, presets, the auto-played wow sequence and everything derived from the current system. */
import { SIG_MAX, SIG_MIN, T0, T_MAX, T_MIN, TRACK_SECONDS, W_MAX } from "./bench";
import {
  apparent,
  cabs,
  carg,
  discrete,
  foldOmega,
  isAliased,
  isReal,
  mapExact,
  mapInverse,
  pairSys,
  realSys,
  response,
  tustin,
  tustinWarp,
  type C,
  type Kind,
  type Sys,
} from "./bridge";

export type Poles = { kind: "pair"; sigma: number; omega: number } | { kind: "real"; a: number; b: number };
export type PresetId = "ring" | "unstable" | "alias";

export const EXAMPLE: Poles = { kind: "pair", sigma: -0.5, omega: Math.PI };
export const PRESETS: Record<PresetId, { poles: Poles; T: number }> = {
  ring: { poles: EXAMPLE, T: T0 },
  unstable: { poles: { kind: "pair", sigma: 0.12, omega: Math.PI }, T: T0 },
  alias: { poles: { kind: "pair", sigma: -0.3, omega: 2 * Math.PI * 0.95 }, T: 0.8 },
};

export const DEFAULTS = { T: T0, bend: 0, strips: false, tustin: false, step: false } as const;

/** How close to the real axis a dragged pair collapses onto it (rad/s). */
const SNAP = 0.35;
/** Soft limit for the display (track half-height units). */
export const LIMIT = 1.35;
const softClip = (x: number) => LIMIT * Math.tanh(x / LIMIT);

/** Wow timeline (seconds). */
export const WOW = {
  fade: [0, 1],
  draw: [1, 3],
  bend: [3, 5.6],
  blow: [5.6, 7.6],
  alias: [7.6, 9.6],
  unbend: [9.6, 10.4],
  end: 10.4,
} as const;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const phase = (t: number, [a, b]: readonly [number, number]) => clamp((t - a) / (b - a), 0, 1);

export function toSys(p: Poles): Sys {
  return p.kind === "pair" ? pairSys(p.sigma, p.omega) : realSys(p.a, p.b);
}

export interface Derived {
  sys: Sys;
  z1: C;
  z2: C;
  /** Biggest twin size |z|. */
  zMax: number;
  stable: boolean;
  boundary: boolean;
  aliased: boolean;
  /** Folded wobble speed (rad/s) of the upper pole, and its branch. */
  aliasW: number;
  /** Continuous trace (normalised, soft-limited) at N+1 points over 0…8 s. */
  trace: Float32Array;
  /** Fake slow wave through the beads (only when aliased). */
  fake: Float32Array | null;
  /** Snapshot times, beads (= h(nT)) and the computer's own z^n output, normalised. */
  beadT: number[];
  beads: number[];
  ghost: number[];
  /** Raw (unnormalised) first samples for the info hook. */
  raw: { samples: number[]; discrete: number[] };
  /** Normalisation: display = raw / peak. */
  peak: number;
  /** How far past the soft limit the trace goes (0 = fine). */
  over: number;
  tz1: C;
  tz2: C;
  warpW: number;
}

export const TRACE_N = 480;

export class Model {
  poles: Poles = { ...EXAMPLE };
  T: number = T0;
  /** Bend shown (0 flat … 1 rolled into the disc). */
  bend = 0;
  /** Linear progress of the bend animation (bend = ease(bendLin)). */
  private bendLin = 0;
  bendTarget = 0;
  /** Slider scrubbing holds the bend where the user put it. */
  bendHeld = false;
  preset: PresetId | "custom" | "random" = "ring";
  strips = false;
  tustin = false;
  stepMode = false;
  time = 0;
  /** Playhead along the track (s). */
  playT = 0;
  /** Trace reveal 0…1 (draws in during the wow). */
  reveal = 1;
  dragging = false;
  dragDir: "left" | "right" | "up" | "down" | "" = "";
  /** Which pole a real-axis drag moves (0 → a, 1 → b). */
  private realIdx = 0;
  /** z-drag keeps its branch so a twin dragged round the circle doesn't jump strips. */
  private zBranch = 0;
  ev = { drag: -99, rate: -99, bend: -99, preset: -99, random: -99, reset: -99, strips: -99, tustin: -99, step: -99, back: -99 };
  version = 0;
  wowActive = false;
  wowT = 0;
  reducedMotion = false;
  d!: Derived;
  private anim: { from: Poles; to: Poles; T0: number; T1: number; t: number; dur: number } | null = null;
  private key = "";

  constructor() {
    this.derive();
  }

  get sys(): Sys {
    return this.d.sys;
  }
  get kind(): Kind {
    return this.stepMode ? "step" : "impulse";
  }

  // ───────────────────────── stepping ─────────────────────────

  step(dt: number): void {
    this.time += dt;
    if (this.wowActive) this.stepWow(dt);
    else {
      if (this.anim) {
        const a = this.anim;
        a.t += dt;
        const k = ease(a.t / a.dur);
        this.T = Math.exp(Math.log(a.T0) + (Math.log(a.T1) - Math.log(a.T0)) * k);
        if (a.from.kind === "pair" && a.to.kind === "pair") {
          this.poles = { kind: "pair", sigma: a.from.sigma + (a.to.sigma - a.from.sigma) * k, omega: a.from.omega + (a.to.omega - a.from.omega) * k };
        } else this.poles = { ...a.to };
        if (a.t >= a.dur) {
          this.poles = { ...a.to };
          this.T = a.T1;
          this.anim = null;
        }
      }
      if (!this.bendHeld) {
        const sp = dt / 1.6;
        const L = this.bendLin;
        this.bendLin = this.bendTarget > L ? Math.min(this.bendTarget, L + sp) : Math.max(this.bendTarget, L - sp);
        this.bend = this.reducedMotion ? this.bendTarget : ease(this.bendLin);
        if (this.reducedMotion) this.bendLin = this.bendTarget;
      }
      this.playT += dt;
      if (this.playT > TRACK_SECONDS + 0.8) this.playT = 0;
    }
    this.derive();
  }

  get bending(): boolean {
    if (this.wowActive) return this.wowT > WOW.bend[0] && this.wowT < WOW.bend[1];
    return !this.bendHeld && Math.abs(this.bendLin - this.bendTarget) > 1e-4;
  }

  startWow(): void {
    this.wowActive = true;
    this.wowT = 0;
    this.reveal = 0;
    this.playT = 0;
  }

  private stepWow(dt: number): void {
    this.wowT += dt;
    const t = this.wowT;
    const draw = phase(t, WOW.draw);
    this.reveal = draw;
    if (t < WOW.draw[1]) this.playT = draw * TRACK_SECONDS;
    else this.playT = (this.playT + dt) % (TRACK_SECONDS + 0.8);
    const bendUp = ease(phase(t, WOW.bend));
    const bendDown = ease(phase(t, WOW.unbend));
    this.bend = bendUp * (1 - bendDown);
    this.bendLin = invEase(this.bend);
    this.bendTarget = 0;
    // knob slides right across the line and back
    const [b0, b1] = WOW.blow;
    const out = ease(clamp((t - b0) / 0.8, 0, 1)), back = ease(clamp((t - (b1 - 0.6)) / 0.6, 0, 1));
    const sigma = EXAMPLE.kind === "pair" ? EXAMPLE.sigma : 0;
    this.poles = { kind: "pair", sigma: sigma + (0.15 - sigma) * out * (1 - back), omega: Math.PI };
    // rate slides slower, then back
    const [a0, a1] = WOW.alias;
    const slow = ease(clamp((t - a0) / 0.9, 0, 1)), ret = ease(clamp((t - (a1 - 0.6)) / 0.6, 0, 1));
    this.T = Math.exp(Math.log(T0) + (Math.log(1.15) - Math.log(T0)) * slow * (1 - ret));
    if (t >= WOW.end) this.endWow();
  }

  private endWow(): void {
    this.wowActive = false;
    this.poles = { ...EXAMPLE };
    this.T = T0;
    this.bend = this.bendLin = 0;
    this.bendTarget = 0;
    this.reveal = 1;
  }

  /** Any user action stops the auto-play and starts from the example. */
  interrupt(): void {
    if (!this.wowActive) return;
    this.endWow();
    this.playT = 0;
  }

  // ───────────────────────── actions ─────────────────────────

  private to(poles: Poles, T: number, dur = 0.7): void {
    this.anim = { from: { ...this.poles }, to: { ...poles }, T0: this.T, T1: T, t: 0, dur: this.reducedMotion ? 0.001 : dur };
  }

  setPreset(id: PresetId): void {
    this.interrupt();
    this.preset = id;
    this.to(PRESETS[id].poles, PRESETS[id].T);
    this.ev.preset = this.time;
    this.playT = 0;
  }

  setT(T: number): void {
    this.interrupt();
    this.anim = null;
    this.T = clamp(T, T_MIN, T_MAX);
    this.ev.rate = this.time;
  }

  toggleBend(): void {
    this.interrupt();
    this.bendHeld = false;
    this.bendTarget = this.bendTarget > 0.5 ? 0 : 1;
    this.ev.bend = this.time;
  }
  scrubBend(b: number): void {
    this.interrupt();
    this.bendHeld = true;
    this.bend = clamp(b, 0, 1);
    this.bendLin = invEase(this.bend);
    this.bendTarget = this.bendLin;
    this.ev.bend = this.time;
  }
  /** The slider keeps the bend where you left it; Bend / Unbend takes it from there. */
  releaseBend(): void {
    this.bendHeld = false;
    this.bendTarget = this.bendLin;
  }

  random(): void {
    this.interrupt();
    let p: Poles;
    const r = Math.random;
    if (r() < 0.2) {
      const a = -0.3 - r() * 2.4, b = a - 0.2 - r() * 1.2;
      p = { kind: "real", a, b };
    } else {
      const unstable = r() < 0.18;
      p = { kind: "pair", sigma: unstable ? 0.05 + r() * 0.2 : -0.12 - r() * 1.8, omega: 0.8 + r() * 8.6 };
    }
    this.preset = "random";
    this.to(p, this.T);
    this.ev.random = this.time;
    this.playT = 0;
  }

  backToExample(): void {
    this.interrupt();
    this.preset = "ring";
    this.to(EXAMPLE, T0);
    this.ev.back = this.time;
    this.playT = 0;
  }

  reset(): void {
    this.wowActive = false;
    this.anim = null;
    this.poles = { ...EXAMPLE };
    this.T = DEFAULTS.T;
    this.bend = this.bendLin = DEFAULTS.bend;
    this.bendTarget = 0;
    this.bendHeld = false;
    this.strips = DEFAULTS.strips;
    this.tustin = DEFAULTS.tustin;
    this.stepMode = DEFAULTS.step;
    this.preset = "ring";
    this.reveal = 1;
    this.playT = 0;
    this.dragging = false;
    this.ev.reset = this.time;
    this.derive();
  }

  setStrips(on: boolean): void {
    this.interrupt();
    this.strips = on;
    this.ev.strips = this.time;
  }
  setTustin(on: boolean): void {
    this.interrupt();
    this.tustin = on;
    this.ev.tustin = this.time;
  }
  setStep(on: boolean): void {
    this.interrupt();
    this.stepMode = on;
    this.ev.step = this.time;
    this.playT = 0;
  }

  // ───────────────────────── dragging ─────────────────────────

  /** Knob index: 0 = upper (or right-hand real) pole, 1 = its twin. */
  beginDrag(idx: number, onDisc: boolean): void {
    this.interrupt();
    this.anim = null;
    this.dragging = true;
    this.preset = "custom";
    this.realIdx = idx;
    if (onDisc && this.poles.kind === "pair") this.zBranch = Math.round((this.poles.omega - foldOmega(this.poles.omega, this.T)) / ((2 * Math.PI) / this.T));
    this.ev.drag = this.time;
  }
  endDrag(): void {
    this.dragging = false;
    this.ev.drag = this.time;
  }

  /** Move the dragged knob to s = σ + iω on the plate; its twin mirrors. */
  dragS(sigma: number, omega: number): void {
    sigma = clamp(sigma, SIG_MIN, SIG_MAX);
    omega = clamp(omega, -W_MAX, W_MAX);
    const before = this.poles;
    const bs = before.kind === "pair" ? before.sigma : this.realIdx === 0 ? before.a : before.b;
    const bw = before.kind === "pair" ? before.omega : 0;
    if (Math.abs(omega) >= SNAP) this.poles = { kind: "pair", sigma, omega: Math.abs(omega) };
    else if (before.kind === "pair") this.poles = { kind: "real", a: sigma, b: sigma };
    else this.poles = this.realIdx === 0 ? { kind: "real", a: sigma, b: before.b } : { kind: "real", a: before.a, b: sigma };
    const dw = Math.abs(omega) - Math.abs(bw), ds = sigma - bs;
    if (Math.abs(ds) > 1e-4 || Math.abs(dw) > 1e-3) {
      // compare in plate distances (σ spans 5 units, ω spans 2·W_MAX across the same width)
      this.dragDir = Math.abs(ds) / (SIG_MAX - SIG_MIN) > Math.abs(dw) / (2 * W_MAX) ? (ds < 0 ? "left" : "right") : dw > 0 ? "up" : "down";
    }
    this.ev.drag = this.time;
    this.derive();
  }

  /** Drag a twin on the disc: back through the log, staying on the branch we started on. */
  dragZ(z: C, idx: number): void {
    if (cabs(z) < 1e-4) return;
    if (this.poles.kind === "real") {
      const s = mapInverse({ re: Math.max(1e-4, Math.abs(z.re)), im: 0 }, this.T, 0);
      if (Math.abs(z.im) * 1 > 0.08) {
        const q = mapInverse(z, this.T, 0);
        this.dragS(q.re, q.im);
      } else this.dragS(s.re, 0);
      return;
    }
    const sign = idx === 0 ? 1 : -1;
    const q = mapInverse({ re: z.re, im: sign * z.im }, this.T, this.zBranch);
    this.dragS(q.re, q.im);
  }

  /** Knob s-positions [upper/right, twin]. */
  knobS(): [C, C] {
    const p = this.poles;
    if (p.kind === "pair") return [{ re: p.sigma, im: p.omega }, { re: p.sigma, im: -p.omega }];
    return [{ re: p.a, im: 0 }, { re: p.b, im: 0 }];
  }

  // ───────────────────────── derived ─────────────────────────

  private derive(): void {
    const k = `${this.poles.kind === "pair" ? `${this.poles.sigma}|${this.poles.omega}` : `${this.poles.a}|${this.poles.b}`}|${this.T}|${this.stepMode}`;
    if (k === this.key && this.d) return;
    this.key = k;
    this.version++;
    const sys = toSys(this.poles);
    const T = this.T;
    const kind = this.kind;
    const z1 = mapExact(sys.p1, T), z2 = mapExact(sys.p2, T);
    const zMax = Math.max(cabs(z1), cabs(z2));
    const maxRe = Math.max(sys.p1.re, sys.p2.re);
    const stable = maxRe < -1e-12;
    const boundary = Math.abs(maxRe) <= 1e-12;
    const real = isReal(sys);
    const aliased = !real && isAliased(sys.p1.im, T);
    const aliasW = foldOmega(sys.p1.im, T);

    // normalise on the first 8 s (stable) or first 3 s (growing), so growth shows as growth
    const tRef = maxRe > 0 ? 3 : TRACK_SECONDS;
    let peak = 0;
    for (let i = 0; i <= 240; i++) peak = Math.max(peak, Math.abs(response(sys, (i / 240) * tRef, kind)));
    if (!(peak > 1e-12) || !Number.isFinite(peak)) peak = 1;

    const trace = new Float32Array(TRACE_N + 1);
    let over = 0;
    for (let i = 0; i <= TRACE_N; i++) {
      const v = response(sys, (i / TRACE_N) * TRACK_SECONDS, kind) / peak;
      over = Math.max(over, Math.abs(v) - 1);
      trace[i] = softClip(v);
    }
    let fake: Float32Array | null = null;
    if (aliased) {
      fake = new Float32Array(TRACE_N + 1);
      for (let i = 0; i <= TRACE_N; i++) fake[i] = softClip(apparent(sys, T, (i / TRACE_N) * TRACK_SECONDS, kind) / peak);
    }
    const n = Math.floor(TRACK_SECONDS / T + 1e-9) + 1;
    const beadT: number[] = [];
    for (let i = 0; i < n; i++) beadT.push(i * T);
    const samp = beadT.map((t) => response(sys, t, kind));
    const disc = discrete(sys, T, n, kind);
    const tz1 = tustin(sys.p1, T), tz2 = tustin(sys.p2, T);
    this.d = {
      sys,
      z1,
      z2,
      zMax,
      stable,
      boundary,
      aliased,
      aliasW,
      trace,
      fake,
      beadT,
      beads: samp.map((v) => softClip(v / peak)),
      ghost: disc.map((v) => softClip(v / peak)),
      raw: { samples: samp.slice(0, 10), discrete: disc.slice(0, 10) },
      peak,
      over: Math.max(0, over),
      tz1,
      tz2,
      warpW: tustinWarp(sys.p1.im, T),
    };
  }

  /** Display value of the motion at time t (normalised, soft-limited) and how far past the limit it is. */
  at(t: number): { y: number; raw: number } {
    const raw = response(this.d.sys, t, this.kind) / this.d.peak;
    return { y: softClip(raw), raw };
  }

  /** Angle of the upper twin on the disc (rad, (−π, π]). */
  get zArg(): number {
    return carg(this.d.z1);
  }

  finite(): boolean {
    const d = this.d;
    const nums = [d.sys.p1.re, d.sys.p1.im, d.sys.p2.re, d.sys.p2.im, d.z1.re, d.z1.im, d.z2.re, d.z2.im, d.peak, this.T, this.bend];
    if (!nums.every(Number.isFinite)) return false;
    for (const v of d.trace) if (!Number.isFinite(v)) return false;
    return d.beads.every(Number.isFinite) && d.ghost.every(Number.isFinite);
  }
}

/** Inverse of the smoothstep (so handing the slider back to the animation doesn't jump). */
function invEase(y: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * clamp(y, 0, 1)) / 3);
}
