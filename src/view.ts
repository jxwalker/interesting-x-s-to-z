/** Renderer-agnostic view interface, palette, landscape heights and number formatting. */
import type { Bench } from "./bench";
import { logHs, logHz, type C } from "./bridge";
import type { Model } from "./model";

export const TEAL = "#1b8f8a";
export const MAGENTA = "#e0409a";
export const LIME = "#9bd83a";
export const AMBER = "#ffb23e";
export const VIOLET = "#8f7dff";

export type V3 = [number, number, number];

export interface Layout {
  /** Free rectangle (CSS px) the bench is framed into. */
  x: number;
  y: number;
  w: number;
  h: number;
  phone: boolean;
}

export type Anchor = { x: number; y: number; on: boolean };
export type Anchors = Record<string, Anchor | undefined>;

export interface View {
  readonly kind: "webgl" | "2d";
  readonly canvas: HTMLCanvasElement;
  bench: Bench;
  resize(w: number, h: number, layout: Layout): void;
  render(dt: number, model: Model): void;
  anchors(): Anchors;
  project(p: V3): Anchor;
  /** Screen point → the point on the horizontal plane y = h (world), or null. */
  onPlane(x: number, y: number, h: number): [number, number] | null;
  resetCamera(): void;
  poke(): void;
  dispose(): void;
}

// ───────────────────────── landscapes ─────────────────────────

/** log|H| range shown: below FLOOR is flat enamel, above CAP is the flat brass cap of a tent pole. */
export const L_FLOOR = 0.15;
export const L_CAP = 2.3;
/** World height of a full tent pole. */
export const H_MAX = 0.86;
/** Contour step (in log|H|). */
export const CONTOUR = 0.3;

/** 0 on the enamel … 1 at the cap; the 1.5 power keeps the poles reading as tent poles. */
export const unitH = (L: number) => Math.max(0, Math.min(1, (L - L_FLOOR) / (L_CAP - L_FLOOR))) ** 1.5;
export const sHeight = (m: Model, sigma: number, omega: number) => unitH(logHs(m.sys, { re: sigma, im: omega })) * H_MAX;
export const zHeight = (m: Model, z: C) => unitH(logHz(m.sys, m.T, z)) * H_MAX;

// ───────────────────────── formatting ─────────────────────────

/** Fixed decimals with a proper minus sign. */
export function fx(v: number, d = 2): string {
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "—";
  const r = Number(v.toFixed(d));
  if (Math.abs(r) < 0.5 * 10 ** -d) return (0).toFixed(d);
  return (r < 0 ? "−" : "") + Math.abs(r).toFixed(d);
}
/** Two significant-ish decimals for rates: 0.50, 1.3, 12. */
export function nice(v: number): string {
  const a = Math.abs(v);
  if (!Number.isFinite(a)) return "∞";
  if (a >= 10) return a.toFixed(0);
  if (a >= 1) return a.toFixed(1);
  return a.toFixed(2);
}
