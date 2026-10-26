/**
 * The maths of the bridge z = e^(sT), kept pure and renderer-free.
 *
 * System: a damped mass on a spring, H(s) = K / ((s − p1)(s − p2)), with K = |p1·p2| (= ω_n²) so H(0) = 1.
 * Poles are either a conjugate pair σ ± iω or two real poles (overdamped), including the double pole (critical).
 * Impulse invariance: the computer's system has poles z_i = e^(p_i T) and impulse response h_d[n] = h(nT).
 */

// ───────────────────────── complex numbers ─────────────────────────

export interface C {
  re: number;
  im: number;
}

export const cx = (re: number, im = 0): C => ({ re, im });
export const cadd = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
export const csub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
export const cmul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const cscale = (a: C, k: number): C => ({ re: a.re * k, im: a.im * k });
export const cconj = (a: C): C => ({ re: a.re, im: -a.im });
export const cabs = (a: C): number => Math.hypot(a.re, a.im);
export const carg = (a: C): number => Math.atan2(a.im, a.re);
export function cdiv(a: C, b: C): C {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
export function cexp(a: C): C {
  const m = Math.exp(a.re);
  return { re: m * Math.cos(a.im), im: m * Math.sin(a.im) };
}
/** Principal logarithm: imaginary part in (−π, π]. */
export function clog(a: C): C {
  return { re: Math.log(cabs(a)), im: carg(a) };
}
/** z^n by repeated multiplication (no logs, no exps): the honest discrete-time power. */
export function cpowInt(z: C, n: number): C {
  let r: C = { re: 1, im: 0 };
  let b = z;
  let k = Math.max(0, Math.floor(n));
  while (k > 0) {
    if (k & 1) r = cmul(r, b);
    b = cmul(b, b);
    k >>= 1;
  }
  return r;
}

/** (e^x − 1)/x, stable near 0. */
export function cexprel(x: C): C {
  if (cabs(x) < 1e-4) return cadd(cadd(cx(1), cscale(x, 0.5)), cscale(cmul(x, x), 1 / 6));
  return cdiv(csub(cexp(x), cx(1)), x);
}
/** sinh(x)/x, stable near 0. */
export function csinhc(x: C): C {
  if (cabs(x) < 1e-4) return cadd(cx(1), cscale(cmul(x, x), 1 / 6));
  const e = cexp(x), f = cexp(cscale(x, -1));
  return cdiv(cscale(csub(e, f), 0.5), x);
}
/** ∫₀¹ u·e^(xu) du = (e^x(x − 1) + 1)/x², stable near 0. */
function cramp(x: C): C {
  if (cabs(x) < 1e-3) return cadd(cadd(cx(0.5), cscale(x, 1 / 3)), cscale(cmul(x, x), 1 / 8));
  return cdiv(cadd(cmul(cexp(x), csub(x, cx(1))), cx(1)), cmul(x, x));
}

// ───────────────────────── the system ─────────────────────────

export interface Sys {
  /** Upper pole (im ≥ 0) or the right-hand real pole. */
  p1: C;
  /** Its partner: the conjugate, or the second real pole. */
  p2: C;
}

export const pairSys = (sigma: number, omega: number): Sys => ({ p1: cx(sigma, Math.abs(omega)), p2: cx(sigma, -Math.abs(omega)) });
export function realSys(a: number, b: number): Sys {
  return { p1: cx(Math.max(a, b)), p2: cx(Math.min(a, b)) };
}
export const isReal = (s: Sys) => Math.abs(s.p1.im) < 1e-12 && Math.abs(s.p2.im) < 1e-12;

/** Poles of s² + 2ζω_n s + ω_n²: under-, critically and over-damped. */
export function fromWnZeta(wn: number, zeta: number): Sys {
  if (Math.abs(zeta) < 1) return pairSys(-zeta * wn, wn * Math.sqrt(1 - zeta * zeta));
  const r = wn * Math.sqrt(zeta * zeta - 1);
  return realSys(-zeta * wn + r, -zeta * wn - r);
}

/** Inverse: ω_n = √|p1·p2| (= |p| for a pair), ζ = −(p1 + p2)/(2ω_n). */
export function toWnZeta(s: Sys): { wn: number; zeta: number } {
  const wn = Math.sqrt(cabs(cmul(s.p1, s.p2)));
  const zeta = wn > 1e-12 ? -(s.p1.re + s.p2.re) / (2 * wn) : 0;
  return { wn, zeta };
}

/** DC-normalising gain K = |p1 p2| (floored so a pole at 0 still gives a visible response). */
export const gain = (s: Sys) => Math.max(cabs(cmul(s.p1, s.p2)), 1e-4);

const half = (s: Sys) => ({ m: cscale(cadd(s.p1, s.p2), 0.5), d: cscale(csub(s.p1, s.p2), 0.5) });

/** Continuous impulse response h(t) = K·t·e^(mt)·sinh(dt)/(dt): the residue sum, exact for every damping. */
export function impulse(s: Sys, t: number): number {
  if (t < 0) return 0;
  const { m, d } = half(s);
  return gain(s) * t * cmul(cexp(cscale(m, t)), csinhc(cscale(d, t))).re;
}

/** Continuous step response ∫₀ᵗ h. */
export function stepResp(s: Sys, t: number): number {
  if (t <= 0) return 0;
  const K = gain(s);
  const [r1, r2] = residues(s);
  if (r1) {
    // Σ r_i (e^(p_i t) − 1)/p_i
    const a = cmul(r1, cscale(cexprel(cscale(s.p1, t)), t));
    const b = cmul(r2!, cscale(cexprel(cscale(s.p2, t)), t));
    return cadd(a, b).re;
  }
  return K * t * t * cramp(cscale(s.p1, t)).re;
}

/** Residues r_i = K/(p_i − p_j), or null for the (near-)double pole. */
export function residues(s: Sys): [C | null, C | null] {
  const dp = csub(s.p1, s.p2);
  if (cabs(dp) < 1e-6 * (1 + cabs(s.p1))) return [null, null];
  const K = gain(s);
  return [cdiv(cx(K), dp), cdiv(cx(K), cscale(dp, -1))];
}

export type Kind = "impulse" | "step";
export const response = (s: Sys, t: number, kind: Kind) => (kind === "step" ? stepResp(s, t) : impulse(s, t));

/** Snapshots of the smooth motion, h(nT). */
export function sampled(s: Sys, T: number, n: number, kind: Kind = "impulse"): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(response(s, k * T, kind));
  return out;
}

/**
 * The computer's own output, built only from its z-poles: Re(Σ c_i·z_i^n) with z_i = e^(p_i T)
 * and z_i^n by repeated multiplication. Equal to h(nT): that is the bridge.
 */
export function discrete(s: Sys, T: number, n: number, kind: Kind = "impulse"): number[] {
  const z1 = mapExact(s.p1, T), z2 = mapExact(s.p2, T);
  const [r1, r2] = residues(s);
  const out: number[] = [];
  const K = gain(s);
  for (let k = 0; k < n; k++) {
    const a = cpowInt(z1, k), b = cpowInt(z2, k);
    if (r1 && r2) {
      if (kind === "impulse") out.push(cadd(cmul(r1, a), cmul(r2, b)).re);
      // step: Σ (r_i/p_i)(z_i^n − 1), with the p_i → 0 limit r_i·nT
      else {
        const term = (r: C, p: C, zn: C) => (cabs(p) < 1e-9 ? cscale(r, k * T) : cmul(cdiv(r, p), csub(zn, cx(1))));
        out.push(cadd(term(r1, s.p1, a), term(r2, s.p2, b)).re);
      }
    } else {
      // double pole: h[n] = K·nT·z^n
      if (kind === "impulse") out.push(K * k * T * a.re);
      else out.push(K * (k * T) ** 2 * cramp(cscale(s.p1, k * T)).re);
    }
  }
  return out;
}

/**
 * The slowest smooth wave that passes through the same snapshots: replace each pole by the principal
 * branch log(z_i)/T. When nothing is aliased it is the real motion; when it is, it's the fake slow wave.
 */
export function apparent(s: Sys, T: number, t: number, kind: Kind = "impulse"): number {
  const a = principal(s.p1, T), b = principal(s.p2, T);
  const [r1, r2] = residues(s);
  if (!r1 || !r2) return response(s, t, kind);
  if (kind === "impulse") return cadd(cmul(r1, cexp(cscale(a, t))), cmul(r2, cexp(cscale(b, t)))).re;
  // step on the same branch: the beads are Σ (r_i/p_i)(z_i^n − 1); keep the coefficients, swap the exponent
  const term = (r: C, p: C, q: C) => (cabs(p) < 1e-9 ? cscale(r, t) : cmul(cdiv(r, p), csub(cexp(cscale(q, t)), cx(1))));
  return cadd(term(r1, s.p1, a), term(r2, s.p2, b)).re;
}

/** log|H(s)/H(0)|: the s-plane landscape. */
export function logHs(s: Sys, q: C): number {
  const a = Math.max(cabs(csub(q, s.p1)), 1e-9), b = Math.max(cabs(csub(q, s.p2)), 1e-9);
  return Math.log(gain(s)) - Math.log(a) - Math.log(b);
}

/** H(iω) magnitude (for the plot up the amber axis). */
export const magHs = (s: Sys, w: number) => Math.exp(logHs(s, cx(0, w)));

/**
 * log|H_d(z)/H_d(1)| for the impulse-invariant system H_d(z) = N·z/((z − z1)(z − z2)).
 * Normalised by its own DC value so it's comparable with the s-plane; robust when N = 0.
 */
export function logHz(s: Sys, T: number, z: C): number {
  const z1 = mapExact(s.p1, T), z2 = mapExact(s.p2, T);
  const one = cx(1);
  const lz = Math.log(Math.max(cabs(z), 1e-9));
  const a = Math.max(cabs(csub(z, z1)), 1e-9), b = Math.max(cabs(csub(z, z2)), 1e-9);
  const n = Math.max(cabs(csub(one, z1)) * cabs(csub(one, z2)), 1e-9);
  return lz - Math.log(a) - Math.log(b) + Math.log(n);
}
/** |H_d(e^{iθ})| / |H_d(1)|: the plot round the unit circle. */
export const magHz = (s: Sys, T: number, theta: number) => Math.exp(logHz(s, T, cx(Math.cos(theta), Math.sin(theta))));

// ───────────────────────── the bridge itself ─────────────────────────

/** z = e^(sT). */
export const mapExact = (s: C, T: number): C => cexp(cscale(s, T));

/** s = log(z)/T + i·2πk/T: every alias k ∈ ℤ lands on the same z. */
export function mapInverse(z: C, T: number, k = 0): C {
  const l = clog(z);
  return { re: l.re / T, im: (l.im + 2 * Math.PI * k) / T };
}
/** Principal branch, angle in (−π/T, π/T]. */
export const principal = (s: C, T: number): C => mapInverse(mapExact(s, T), T, 0);
/** Which strip (branch) a point sits in. */
export const branchOf = (omega: number, T: number) => Math.round((omega - foldOmega(omega, T)) / ((2 * Math.PI) / T));

/** Aliasing: ω_alias = ((ω + π/T) mod 2π/T) − π/T. */
export function foldOmega(omega: number, T: number): number {
  const P = (2 * Math.PI) / T;
  const r = (omega + Math.PI / T) % P;
  return (r < 0 ? r + P : r) - Math.PI / T;
}
/** Too fast to see? (strictly beyond half the snapshot rate) */
export const isAliased = (omega: number, T: number) => Math.abs(omega) > Math.PI / T + 1e-12;

/** Tustin (bilinear) shortcut: z = (1 + sT/2)/(1 − sT/2). */
export function tustin(s: C, T: number): C {
  const h = cscale(s, T / 2);
  const den = csub(cx(1), h);
  if (cabs(den) < 1e-12) return cx(1e12, 0);
  return cdiv(cadd(cx(1), h), den);
}
/** Where Tustin puts a pure wobble ω: ω_d = (2/T)·atan(ωT/2). */
export const tustinWarp = (omega: number, T: number) => (2 / T) * Math.atan((omega * T) / 2);

// ───────────────────────── the bend: s-plate → z-disc, per vertex ─────────────────────────

export interface Geo {
  /** s-plate centre (world x, z), side length, top height. */
  plateX: number;
  plateZ: number;
  P: number;
  plateTop: number;
  sigMin: number;
  sigMax: number;
  wMax: number;
  /** z-disc centre, unit-circle radius (world), top height. */
  discX: number;
  discZ: number;
  Ru: number;
  discTop: number;
  /** Arc height of the bridge. */
  lift: number;
}

/** s-plane point → world (x, z) on the flat plate (σ right, ω away from the viewer). */
export function plateXZ(g: Geo, sigma: number, omega: number): [number, number] {
  const sx = g.P / (g.sigMax - g.sigMin), sz = g.P / (2 * g.wMax);
  return [g.plateX + (sigma - (g.sigMin + g.sigMax) / 2) * sx, g.plateZ - omega * sz];
}
export function plateInv(g: Geo, x: number, z: number): { sigma: number; omega: number } {
  const sx = g.P / (g.sigMax - g.sigMin), sz = g.P / (2 * g.wMax);
  return { sigma: (x - g.plateX) / sx + (g.sigMin + g.sigMax) / 2, omega: -(z - g.plateZ) / sz };
}
/** z-plane point → world (x, z) on the disc. */
export const discXZ = (g: Geo, z: C): [number, number] => [g.discX + g.Ru * z.re, g.discZ - g.Ru * z.im];
export const discInv = (g: Geo, x: number, z: number): C => cx((x - g.discX) / g.Ru, -(z - g.discZ) / g.Ru);

const smooth = (b: number) => b * b * (3 - 2 * b);

/**
 * The rubber sheet at bend b ∈ [0, 1]. With u = sT the shape is f_b(u) = (e^(bu) − 1)/b:
 * f_0 = u (the flat map), f_1 = e^(sT) − 1 (the disc, shifted so s = 0 ↦ z = 1).
 * Lines of constant σ curl into circles of radius e^(bσT)/b, lines of constant ω fan into spokes
 * at angle bωT; at b = 1 they are |z| = e^(σT) and arg z = ωT. The per-axis scale eases from the
 * plate's to the disc's (gathered in mid-flight), the sheet rides an arc between them, and repeated
 * turns stack slightly upward so overlapping copies (aliases) never fight.
 */
export function morph(g: Geo, sigma: number, omega: number, T: number, b: number): [number, number, number] {
  const u = cx(sigma * T, omega * T);
  let f: C;
  if (b < 1e-6) f = cadd(u, cscale(cmul(u, u), b / 2));
  else f = cscale(csub(cexp(cscale(u, b)), cx(1)), 1 / b);
  const dx0 = g.P / ((g.sigMax - g.sigMin) * T), dz0 = g.P / (2 * g.wMax * T);
  // ease the per-axis scale from the plate's to the disc's, and gather the sheet in mid-flight so it stays compact
  const k = 1 - 0.45 * Math.sin(Math.PI * b);
  const dx = k * dx0 ** (1 - b) * g.Ru ** b, dz = k * dz0 ** (1 - b) * g.Ru ** b;
  const c0x = g.plateX - ((g.sigMin + g.sigMax) / 2) * (g.P / (g.sigMax - g.sigMin));
  const c1x = g.discX + g.Ru;
  const e = smooth(b);
  const x = c0x + (c1x - c0x) * e + dx * f.re;
  const z = g.plateZ + (g.discZ - g.plateZ) * e - dz * f.im;
  const turns = Math.abs(b * omega * T) / (2 * Math.PI);
  const y = g.plateTop + (g.discTop - g.plateTop) * e + 0.006 + g.lift * Math.sin(Math.PI * b) + 0.045 * b * b * turns;
  return [x, y, z];
}

// ───────────────────────── plain-English helpers ─────────────────────────

/** Wobbles per second (Hz) from rad/s. */
export const hz = (omega: number) => Math.abs(omega) / (2 * Math.PI);
