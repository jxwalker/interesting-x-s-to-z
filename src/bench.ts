/** Where everything sits on the bench (world units), for the wide and the portrait layouts. */
import type { Geo } from "./bridge";

/** Default snapshot interval, and the plate's ranges: σ ∈ [−4, 1], ω ∈ ±1.6π/T₀ (a little over one alias strip). */
export const T0 = 0.5;
export const T_MIN = 0.02;
export const T_MAX = 1.2;
export const SIG_MIN = -4;
export const SIG_MAX = 1;
export const W_MAX = (1.6 * Math.PI) / T0;
/** The glass track shows 0 ≤ t ≤ 8 s. */
export const TRACK_SECONDS = 8;
/** The disc shows |z| up to this. */
export const Z_MAX = 1.58;

export interface Bench {
  geo: Geo;
  /** Disc outer radius (world). */
  Rd: number;
  /** Track: left end (t = 0), length, z, base height, panel tilt (rad, back). */
  track: { x0: number; len: number; z: number; y: number; tilt: number; amp: number };
  spring: { x: number; z: number };
  dial: { x: number; z: number; rotY: number };
  /** Bench slab extents. */
  slab: { x0: number; x1: number; z0: number; z1: number };
  /** Points the camera must keep in frame. */
  frame: [number, number, number][];
  /** Default camera azimuth / elevation (rad). */
  az: number;
  el: number;
}

function make(phone: boolean): Bench {
  const geo: Geo = phone
    ? { plateX: 0, plateZ: -2.05, P: 3.0, plateTop: 0.24, sigMin: SIG_MIN, sigMax: SIG_MAX, wMax: W_MAX, discX: 0, discZ: 1.32, Ru: 0.95, discTop: 0.24, lift: 0.75 }
    : { plateX: -2.05, plateZ: -0.5, P: 3.0, plateTop: 0.24, sigMin: SIG_MIN, sigMax: SIG_MAX, wMax: W_MAX, discX: 2.05, discZ: -0.5, Ru: 0.95, discTop: 0.24, lift: 0.85 };
  const Rd = geo.Ru * Z_MAX;
  const track = phone ? { x0: -1.2, len: 3.3, z: 3.5, y: 0.06, tilt: 0.42, amp: 0.26 } : { x0: -2.2, len: 4.7, z: 1.85, y: 0.06, tilt: 0.32, amp: 0.3 };
  const spring = phone ? { x: -1.85, z: 3.5 } : { x: -2.95, z: 1.85 };
  const dial = phone ? { x: 1.95, z: 2.75, rotY: -0.25 } : { x: 3.2, z: 1.8, rotY: -0.18 };
  const slab = phone ? { x0: -2.55, x1: 2.55, z0: -3.85, z1: 4.15 } : { x0: -3.75, x1: 3.95, z0: -2.3, z1: 2.5 };
  const pad = 0.05;
  const frame: [number, number, number][] = phone
    ? [
        [-1.6, 0.24, -3.6],
        [1.6, 0.24, -3.6],
        [-1.6, 1.0, -0.5],
        [1.6, 1.0, -0.5],
        [-1.6, 0.2, 2.9],
        [1.6, 0.2, 2.9],
        [-2.2, 0.0, 3.8],
        [2.25, 0.0, 3.8],
        [-2.1, 1.3, 3.5],
        [2.1, 1.0, 3.5],
      ]
    : [
        [-3.75 - pad, 0, -2.3],
        [3.95 + pad, 0, -2.3],
        [-3.75 - pad, -0.2, 2.5],
        [3.95 + pad, -0.2, 2.5],
        [-0.5, 1.4, -2.0],
        [-3.0, 1.4, 1.85],
        [3.4, 1.0, 1.8],
      ];
  return {
    geo,
    Rd,
    track,
    spring,
    dial,
    slab,
    frame,
    az: phone ? 0 : 0.08,
    el: phone ? 0.98 : 0.78,
  };
}

export const BENCH = { wide: make(false), phone: make(true) };
