/** window.__bridgeSelfTest(): the maths checked against itself, live in the page. */
import { BENCH, SIG_MAX, SIG_MIN, W_MAX } from "./bench";
import {
  branchOf,
  cabs,
  carg,
  cx,
  discXZ,
  discrete,
  foldOmega,
  fromWnZeta,
  impulse,
  mapExact,
  mapInverse,
  morph,
  pairSys,
  plateXZ,
  realSys,
  sampled,
  stepResp,
  toWnZeta,
  tustin,
  tustinWarp,
  type Sys,
} from "./bridge";
import { Model } from "./model";

export interface Check {
  name: string;
  pass: boolean;
  worst: number;
  tol: number;
}

/** Deterministic PRNG so the test is repeatable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function selfTest(): { pass: boolean; checks: Check[] } {
  const r = rng(20261026);
  const U = (a: number, b: number) => a + (b - a) * r();
  const checks: Check[] = [];
  const add = (name: string, worst: number, tol: number, extra = true) => checks.push({ name, pass: extra && Number.isFinite(worst) && worst <= tol, worst, tol });

  // 1. the imaginary axis lands on the unit circle
  {
    let w = 0;
    for (let i = 0; i < 100; i++) {
      const T = U(0.02, 1.2), om = U(-60, 60);
      w = Math.max(w, Math.abs(cabs(mapExact(cx(0, om), T)) - 1));
    }
    add("exp map of the imaginary axis has |z| = 1 (100 ω)", w, 1e-12);
  }
  // 2. left half-plane → inside the circle (and right → outside)
  {
    let bad = 0;
    for (let i = 0; i < 200; i++) {
      const T = U(0.02, 1.2), s = cx(-U(1e-3, 8), U(-60, 60));
      if (!(cabs(mapExact(s, T)) < 1)) bad++;
      const q = cx(U(1e-3, 3), U(-60, 60));
      if (!(cabs(mapExact(q, T)) > 1)) bad++;
    }
    add("Re(s) < 0 ⇒ |z| < 1 (and Re(s) > 0 ⇒ |z| > 1), 200 random s", bad, 0);
  }
  // 3. snapshots of the smooth motion = the computer's own z^n output
  {
    let w = 0;
    for (let i = 0; i < 20; i++) {
      const T = U(0.05, 1.2);
      const sys: Sys = i % 4 === 3 ? realSys(-U(0.2, 3), -U(0.2, 3)) : pairSys(-U(0.05, 2.5), U(0.3, 12));
      for (const kind of ["impulse", "step"] as const) {
        const a = sampled(sys, T, 24, kind), b = discrete(sys, T, 24, kind);
        for (let n = 0; n < a.length; n++) w = Math.max(w, Math.abs(a[n] - b[n]));
      }
    }
    add("samples h(nT) equal the discrete response from z_p^n (20 stable systems, impulse + step)", w, 1e-9);
  }
  // 4. strips: s and s + 2πi/T are indistinguishable
  {
    let w = 0;
    for (let i = 0; i < 100; i++) {
      const T = U(0.02, 1.2), s = cx(U(-4, 1), U(-30, 30)), k = Math.round(U(-3, 3));
      const a = mapExact(s, T), b = mapExact(cx(s.re, s.im + (2 * Math.PI * k) / T), T);
      w = Math.max(w, cabs({ re: a.re - b.re, im: a.im - b.im }) / Math.max(1, cabs(a)));
    }
    add("s and s + 2πik/T map to the same z", w, 1e-9);
  }
  // 5. the aliasing fold is the angle of z
  {
    let w = 0;
    for (let i = 0; i < 200; i++) {
      const T = U(0.02, 1.2), om = U(-80, 80);
      const f = foldOmega(om, T), a = carg(mapExact(cx(0, om), T)) / T;
      let d = Math.abs(f - a);
      if (Math.abs(Math.abs(f) - Math.PI / T) < 1e-9) d = Math.min(d, Math.abs(Math.abs(f) - Math.abs(a))); // the ±π/T seam
      w = Math.max(w, d * T);
    }
    add("aliasing fold ((ω + π/T) mod 2π/T) − π/T matches arg z / T", w, 1e-9);
  }
  // 6. log with the right branch gives s back
  {
    let w = 0;
    for (let i = 0; i < 200; i++) {
      const T = U(0.02, 1.2), s = cx(U(-4, 1), U(-40, 40));
      const back = mapInverse(mapExact(s, T), T, branchOf(s.im, T));
      w = Math.max(w, Math.hypot(back.re - s.re, back.im - s.im) * T);
    }
    add("log map inverse with branch k recovers s", w, 1e-9);
  }
  // 7. Tustin: the axis still lands on the circle, but squeezed by the warping formula
  {
    let w = 0;
    for (let i = 0; i < 100; i++) {
      const T = U(0.02, 1.2), om = U(-50, 50);
      const z = tustin(cx(0, om), T);
      w = Math.max(w, Math.abs(cabs(z) - 1), Math.abs(carg(z) / T - tustinWarp(om, T)) * T);
      const zl = tustin(cx(-U(0.01, 5), om), T);
      if (!(cabs(zl) < 1)) w = Infinity;
    }
    add("Tustin maps iω to |z| = 1 at angle 2·atan(ωT/2), and stable → inside", w, 1e-12);
  }
  // 8. the unstable preset leaves the circle and the spring stays finite
  {
    const m = new Model();
    m.setPreset("unstable");
    for (let i = 0; i < 60; i++) m.step(1 / 30);
    let fin = m.finite();
    for (let t = 0; t <= 8; t += 0.05) fin &&= Number.isFinite(m.at(t).y);
    add("unstable preset gives |z| > 1 and no NaN in the spring", m.d.zMax > 1 ? 0 : 1, 0, fin && !m.d.stable);
  }
  // 9. edge cases: critical / over-damped / on the line / pole at 0 — no NaN, |z| = 1 on the axis
  {
    let fin = true;
    const systems = [fromWnZeta(3, 1), fromWnZeta(3, 1.6), fromWnZeta(3, 1 - 1e-9), pairSys(0, 3), realSys(0, -1), realSys(0, 0), pairSys(1, 10)];
    for (const s of systems) for (let t = 0; t <= 8; t += 0.1) fin &&= Number.isFinite(impulse(s, t)) && Number.isFinite(stepResp(s, t));
    for (const s of systems) fin &&= discrete(s, 0.5, 17).every(Number.isFinite) && discrete(s, 0.5, 17, "step").every(Number.isFinite);
    const onAxis = Math.abs(cabs(mapExact(pairSys(0, 3).p1, 0.37)) - 1);
    // critical: h(t) = ω_n² t e^(−ω_n t)
    const crit = Math.abs(impulse(fromWnZeta(3, 1), 0.7) - 9 * 0.7 * Math.exp(-2.1));
    add("critical, over-damped and boundary systems: finite, exact", Math.max(onAxis, crit), 1e-12, fin);
  }
  // 10. (ω_n, ζ) → poles → (ω_n, ζ)
  {
    let w = 0;
    for (let i = 0; i < 100; i++) {
      const wn = U(0.3, 12), z = U(-0.3, 2.5);
      const back = toWnZeta(fromWnZeta(wn, z));
      w = Math.max(w, Math.abs(back.wn - wn) / wn, Math.abs(back.zeta - z));
    }
    add("poles from (ω_n, ζ) and back", w, 1e-9);
  }
  // 11. the bend: b = 1 puts every vertex at exp(sT) on the disc, b = 0 on the plate
  {
    let w0 = 0, w1 = 0;
    for (const g of [BENCH.wide.geo, BENCH.phone.geo]) {
      for (const T of [0.02, 0.1, 0.5, 0.8, 1.2]) {
        for (let i = 0; i <= 24; i++) {
          for (let j = 0; j <= 48; j++) {
            const sg = SIG_MIN + ((SIG_MAX - SIG_MIN) * i) / 24, om = -W_MAX + (2 * W_MAX * j) / 48;
            const a = morph(g, sg, om, T, 1), [zx, zz] = discXZ(g, mapExact(cx(sg, om), T));
            w1 = Math.max(w1, Math.hypot(a[0] - zx, a[2] - zz));
            const b = morph(g, sg, om, T, 0), [px, pz] = plateXZ(g, sg, om);
            w0 = Math.max(w0, Math.hypot(b[0] - px, b[2] - pz));
          }
        }
      }
    }
    add("bend at b = 1 puts every grid vertex at the z-plane position of exp(sT)", w1, 1e-6);
    add("bend at b = 0 puts every grid vertex on the s-plane", w0, 1e-6);
  }
  return { pass: checks.every((c) => c.pass), checks };
}
