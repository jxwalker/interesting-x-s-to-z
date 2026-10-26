/**
 * Canvas2D fallback: the same bench in a flat oblique drawing (x right, z into the page, y up).
 * Landscapes become shaded heat-maps with contour lines; the sheet, beads and spring use the same maths.
 */
import { BENCH, TRACK_SECONDS, Z_MAX, type Bench } from "./bench";
import { cexp, cx, discXZ, logHs, logHz, mapExact, morph, plateXZ } from "./bridge";
import { LIMIT, TRACE_N, WOW, type Model } from "./model";
import { AMBER, CONTOUR, LIME, L_CAP, L_FLOOR, MAGENTA, VIOLET, unitH, type Anchor, type Anchors, type Layout, type V3, type View } from "./view";

const CY = 0.62; // z foreshortening
const SY = 0.85; // height lift

export class Scene2D implements View {
  readonly kind = "2d" as const;
  readonly canvas: HTMLCanvasElement;
  bench: Bench = BENCH.wide;
  private g: CanvasRenderingContext2D;
  private W = 1;
  private H = 1;
  private dpr = 1;
  private s = 60;
  private ox = 0;
  private oy = 0;
  private layout: Layout = { x: 0, y: 0, w: 1, h: 1, phone: false };
  private ver = -1;
  private plateImg = document.createElement("canvas");
  private discImg = document.createElement("canvas");
  private anchorPts: Record<string, V3 | null> = {};

  constructor(host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    host.appendChild(this.canvas);
    this.g = this.canvas.getContext("2d")!;
    this.plateImg.width = this.plateImg.height = 128;
    this.discImg.width = this.discImg.height = 160;
  }

  resize(w: number, h: number, layout: Layout): void {
    this.W = w;
    this.H = h;
    this.layout = layout;
    this.bench = layout.phone ? BENCH.phone : BENCH.wide;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.resetCamera();
    this.ver = -1;
  }

  resetCamera(): void {
    const B = this.bench;
    const pts: [number, number][] = [];
    for (const [x, y, z] of B.frame) pts.push([x, z * CY - y * SY]);
    pts.push([B.slab.x0, B.slab.z0 * CY], [B.slab.x1, B.slab.z1 * CY]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const L = this.layout;
    this.s = Math.min((L.w * 0.96) / (x1 - x0), (L.h * 0.96) / (y1 - y0));
    this.ox = L.x + L.w / 2 - ((x0 + x1) / 2) * this.s;
    this.oy = L.y + L.h / 2 - ((y0 + y1) / 2) * this.s;
  }
  poke(): void {}
  dispose(): void {
    this.canvas.remove();
  }

  private P(x: number, y: number, z: number): [number, number] {
    return [this.ox + x * this.s, this.oy + (z * CY - y * SY) * this.s];
  }
  project(p: V3): Anchor {
    const [x, y] = this.P(p[0], p[1], p[2]);
    return { x, y, on: true };
  }
  onPlane(x: number, y: number, h: number): [number, number] | null {
    const X = (x - this.ox) / this.s;
    const Z = ((y - this.oy) / this.s + h * SY) / CY;
    return [X, Z];
  }

  private paintMaps(m: Model): void {
    const B = this.bench, gg = B.geo;
    // plate heat-map
    {
      const c = this.plateImg.getContext("2d")!;
      const im = c.createImageData(128, 128);
      for (let j = 0; j < 128; j++)
        for (let i = 0; i < 128; i++) {
          const sg = gg.sigMin + ((i + 0.5) / 128) * (gg.sigMax - gg.sigMin);
          const om = gg.wMax - ((j + 0.5) / 128) * 2 * gg.wMax;
          const L = logHs(m.sys, { re: sg, im: om });
          const [r, g, b] = shade(L, sg > 0 ? [245, 200, 194] : [212, 234, 210], m.strips ? strip(om, m.T) : null);
          const k = (j * 128 + i) * 4;
          im.data[k] = r;
          im.data[k + 1] = g;
          im.data[k + 2] = b;
          im.data[k + 3] = 255;
        }
      c.putImageData(im, 0, 0);
    }
    // disc heat-map
    {
      const N = 160;
      const c = this.discImg.getContext("2d")!;
      const im = c.createImageData(N, N);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const zr = ((i + 0.5) / N) * 2 * Z_MAX - Z_MAX, zi = Z_MAX - ((j + 0.5) / N) * 2 * Z_MAX;
          const r = Math.hypot(zr, zi);
          const k = (j * N + i) * 4;
          if (r > Z_MAX) {
            im.data[k + 3] = 0;
            continue;
          }
          const L = logHz(m.sys, m.T, cx(zr, zi));
          const [a, g, b] = shade(L, r > 1 ? [244, 205, 200] : [222, 232, 214], null);
          im.data[k] = a;
          im.data[k + 1] = g;
          im.data[k + 2] = b;
          im.data[k + 3] = 255;
        }
      c.putImageData(im, 0, 0);
    }
  }

  render(_dt: number, m: Model): void {
    const g = this.g;
    const B = this.bench, gg = B.geo;
    if (m.version !== this.ver) {
      this.ver = m.version;
      this.paintMaps(m);
    }
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const fade = m.wowActive ? Math.min(1, m.wowT / WOW.fade[1]) : 1;
    const bg = g.createLinearGradient(0, 0, 0, this.H);
    bg.addColorStop(0, "#0c1426");
    bg.addColorStop(1, "#08090e");
    g.fillStyle = bg;
    g.fillRect(0, 0, this.W, this.H);
    g.globalAlpha = 0.1 + 0.9 * fade;

    // bench
    const quad = (pts: [number, number][], fill: string, stroke?: string) => {
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = 1.5;
        g.stroke();
      }
    };
    const S = B.slab;
    quad([this.P(S.x0, 0, S.z0), this.P(S.x1, 0, S.z0), this.P(S.x1, 0, S.z1), this.P(S.x0, 0, S.z1)], "#4a2f1e", "#c79b4a");

    // plate
    const P2 = gg.P / 2;
    const [ax, ay] = this.P(gg.plateX - P2, 0.24, gg.plateZ - P2);
    const [bx, by] = this.P(gg.plateX + P2, 0.24, gg.plateZ + P2);
    g.fillStyle = "#c79b4a";
    g.fillRect(ax - 6, ay - 6, bx - ax + 12, by - ay + 12);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.plateImg, ax, ay, bx - ax, by - ay);
    // grid
    g.strokeStyle = "rgba(25,30,32,0.28)";
    g.lineWidth = 1;
    for (let sg = gg.sigMin; sg <= gg.sigMax + 1e-9; sg += 0.5) {
      const [x0, y0] = this.P(...pt(plateXZ(gg, sg, gg.wMax), 0.24));
      const [x1, y1] = this.P(...pt(plateXZ(gg, sg, -gg.wMax), 0.24));
      line(g, x0, y0, x1, y1);
    }
    for (let om = -Math.floor(gg.wMax); om <= gg.wMax; om += 1) {
      const [x0, y0] = this.P(...pt(plateXZ(gg, gg.sigMin, om), 0.24));
      const [x1, y1] = this.P(...pt(plateXZ(gg, gg.sigMax, om), 0.24));
      line(g, x0, y0, x1, y1);
    }
    // amber axis
    g.save();
    g.strokeStyle = AMBER;
    g.shadowColor = AMBER;
    g.shadowBlur = 12;
    g.lineWidth = 2.4;
    {
      const [x0, y0] = this.P(...pt(plateXZ(gg, 0, gg.wMax), 0.24));
      const [x1, y1] = this.P(...pt(plateXZ(gg, 0, -gg.wMax), 0.24));
      line(g, x0, y0, x1, y1);
    }
    g.restore();

    // disc
    const R = B.Rd;
    const [dcx, dcy] = this.P(gg.discX, 0.24, gg.discZ);
    g.fillStyle = "#c79b4a";
    g.beginPath();
    g.ellipse(dcx, dcy, (R + 0.12) * this.s, (R + 0.12) * this.s * CY, 0, 0, Math.PI * 2);
    g.fill();
    const rz = gg.Ru * Z_MAX * this.s;
    g.drawImage(this.discImg, dcx - rz, dcy - rz * CY, 2 * rz, 2 * rz * CY);
    // σ circles and ω spokes (the image of the plate grid)
    g.strokeStyle = "rgba(25,30,32,0.25)";
    for (let sg = gg.sigMin; sg <= gg.sigMax + 1e-9; sg += 0.5) {
      const r = Math.exp(sg * m.T);
      if (r > Z_MAX || r < 0.05) continue;
      g.beginPath();
      g.ellipse(dcx, dcy, r * gg.Ru * this.s, r * gg.Ru * this.s * CY, 0, 0, Math.PI * 2);
      g.stroke();
    }
    for (let om = 0; om * m.T < Math.PI * 2 && om < 400; om += 1) {
      const a = om * m.T;
      const [x1, y1] = this.P(...pt(discXZ(gg, cx(Z_MAX * Math.cos(a), Z_MAX * Math.sin(a))), 0.24));
      line(g, dcx, dcy, x1, y1);
    }
    g.save();
    g.strokeStyle = AMBER;
    g.shadowColor = AMBER;
    g.shadowBlur = 14;
    g.lineWidth = 2.6;
    g.beginPath();
    g.ellipse(dcx, dcy, gg.Ru * this.s, gg.Ru * this.s * CY, 0, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    // knobs and twins
    const ks = m.knobS();
    for (let i = 0; i < 2; i++) {
      const [x, y] = this.P(...pt(plateXZ(gg, ks[i].re, ks[i].im), 0.24));
      brassDot(g, x, y, 9, m.dragging);
      const zp = m.poles.kind === "real" ? mapExact(ks[i], m.T) : i === 0 ? m.d.z1 : m.d.z2;
      if (Math.hypot(zp.re, zp.im) <= Z_MAX) {
        const [tx, ty] = this.P(...pt(discXZ(gg, zp), 0.24));
        brassDot(g, tx, ty, 7, false);
        if (i === 0) this.anchorPts.twin = [...pt(discXZ(gg, zp), 0.24)];
      }
      if (m.tustin) {
        const tz = i === 0 ? m.d.tz1 : m.d.tz2;
        const [ux, uy] = this.P(...pt(discXZ(gg, tz), 0.24));
        g.strokeStyle = VIOLET;
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(ux, uy, 7, 0, Math.PI * 2);
        g.stroke();
      }
      if (i === 0) this.anchorPts.knob = [...pt(plateXZ(gg, ks[i].re, ks[i].im), 0.24)];
    }

    // the rolling sheet
    const b = m.bend;
    if (b > 0.003) {
      const M = (sg: number, om: number) => {
        const p = morph(gg, sg, om, m.T, b);
        return this.P(p[0], p[1], p[2]);
      };
      g.strokeStyle = m.strips ? "rgba(120,170,255,0.55)" : "rgba(210,228,245,0.5)";
      g.lineWidth = 1;
      for (let sg = gg.sigMin; sg <= gg.sigMax + 1e-9; sg += 0.5) {
        g.beginPath();
        for (let k = 0; k <= 160; k++) {
          const [x, y] = M(sg, -gg.wMax + (2 * gg.wMax * k) / 160);
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
      for (let om = -Math.floor(gg.wMax); om <= gg.wMax; om += 1) {
        g.beginPath();
        for (let k = 0; k <= 24; k++) {
          const [x, y] = M(gg.sigMin + ((gg.sigMax - gg.sigMin) * k) / 24, om);
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
      g.save();
      g.strokeStyle = AMBER;
      g.shadowColor = AMBER;
      g.shadowBlur = 10;
      g.lineWidth = 2.2;
      g.beginPath();
      for (let k = 0; k <= 240; k++) {
        const [x, y] = M(0, -gg.wMax + (2 * gg.wMax * k) / 240);
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      g.restore();
    }

    // track
    const T = B.track, A = T.amp;
    const yc = 0.14 + A * LIMIT;
    const TP = (t: number, v: number) => this.P(T.x0 + (t / TRACK_SECONDS) * T.len, T.y + yc + v * A, T.z);
    {
      const [x0, y0] = TP(0, LIMIT + 0.25);
      const [x1, y1] = TP(TRACK_SECONDS, -LIMIT - 0.25);
      g.fillStyle = "rgba(232,238,243,0.92)";
      g.strokeStyle = "#c79b4a";
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(x0 - 10, y0, x1 - x0 + 20, y1 - y0, 6);
      g.fill();
      g.stroke();
      const [z0x, z0y] = TP(0, 0), [z1x] = TP(TRACK_SECONDS, 0);
      g.strokeStyle = "#5d6470";
      g.lineWidth = 1;
      line(g, z0x, z0y, z1x, z0y);
    }
    const d = m.d;
    const shownT = m.reveal * TRACK_SECONDS;
    if (d.fake && m.reveal >= 1) {
      g.strokeStyle = "#4f8a1a";
      g.lineWidth = 1.6;
      g.setLineDash([5, 4]);
      g.beginPath();
      for (let i = 0; i <= TRACE_N; i++) {
        const [x, y] = TP((i / TRACE_N) * TRACK_SECONDS, d.fake[i]);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    }
    g.strokeStyle = MAGENTA;
    g.lineWidth = 2.6;
    g.beginPath();
    for (let i = 0; i <= TRACE_N * m.reveal; i++) {
      const [x, y] = TP((i / TRACE_N) * TRACK_SECONDS, d.trace[i]);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const br = Math.max(1.5, Math.min(5, ((m.T / TRACK_SECONDS) * T.len * this.s) * 0.4));
    for (let i = 0; i < d.beadT.length && i < 420; i++) {
      if (d.beadT[i] > shownT + 0.01) break;
      const [x, y] = TP(d.beadT[i], d.beads[i]);
      const [, y0] = TP(d.beadT[i], 0);
      g.strokeStyle = "rgba(74,80,90,0.8)";
      g.lineWidth = 1;
      line(g, x, y0, x, y);
      const [, gy] = TP(d.beadT[i], d.ghost[i]);
      g.strokeStyle = "#1d5f5b";
      g.beginPath();
      g.arc(x, gy, br * 1.8, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = LIME;
      g.strokeStyle = "#14180e";
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(x, y, br, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    const bi = Math.min(d.beadT.length - 1, Math.round(1.6 / m.T));
    this.anchorPts.beads = [T.x0 + (d.beadT[bi] / TRACK_SECONDS) * T.len, T.y + yc + d.beads[bi] * A + 0.05, T.z];
    let best = 0;
    for (let i = 0; i <= TRACE_N * 0.4; i++) if (Math.abs(d.trace[i]) > Math.abs(d.trace[best])) best = i;
    this.anchorPts.trace = [T.x0 + (best / TRACE_N) * T.len, T.y + yc + d.trace[best] * A, T.z];

    // spring
    const t = m.playT;
    const v = t <= TRACK_SECONDS ? m.at(t) : { y: d.trace[TRACE_N], raw: 0 };
    const [sx, sy0] = this.P(B.spring.x, 0.07, B.spring.z);
    const my = 0.72 + v.y * 0.24;
    const [, sy1] = this.P(B.spring.x, my - 0.085, B.spring.z);
    const blown = !d.stable && Math.abs(v.raw) > 1.05;
    g.strokeStyle = blown ? "#ff5a3a" : "#d4a955";
    g.lineWidth = 2;
    g.beginPath();
    for (let k = 0; k <= 36; k++) {
      const y = sy0 + ((sy1 - sy0) * k) / 36;
      const x = sx + (k % 2 ? 1 : -1) * 0.085 * this.s * (k === 0 || k === 36 ? 0 : 1);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const [mx, myy] = this.P(B.spring.x, my, B.spring.z);
    g.fillStyle = "#d4a955";
    g.fillRect(mx - 0.15 * this.s, myy - 0.085 * this.s * SY, 0.3 * this.s, 0.17 * this.s * SY);
    this.anchorPts.spring = [B.spring.x + 0.15, my, B.spring.z];
    if (t <= TRACK_SECONDS) {
      const [px, py] = TP(t, v.y);
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(px, py, 4, 0, Math.PI * 2);
      g.fill();
    }

    // dial
    const [qx, qy] = this.P(B.dial.x, 0.66, B.dial.z);
    const rr = 0.26 * this.s;
    g.fillStyle = "#d4a955";
    g.beginPath();
    g.arc(qx, qy, rr + 3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#f1e9d6";
    g.beginPath();
    g.arc(qx, qy, rr, 0, Math.PI * 2);
    g.fill();
    const ang = (val: number) => Math.PI * (0.75 + val);
    g.lineWidth = 4;
    g.strokeStyle = "#3f9a5a";
    g.beginPath();
    g.arc(qx, qy, rr * 0.78, ang(0), ang(1));
    g.stroke();
    g.strokeStyle = "#c83a2c";
    g.beginPath();
    g.arc(qx, qy, rr * 0.78, ang(1), ang(1.5));
    g.stroke();
    const a = ang(Math.min(1.6, d.zMax));
    g.strokeStyle = "#c4281f";
    g.lineWidth = 2.4;
    line(g, qx, qy, qx + Math.cos(a) * rr * 0.85, qy + Math.sin(a) * rr * 0.85);
    g.globalAlpha = 1;
  }

  anchors(): Anchors {
    const gg = this.bench.geo;
    const pts: Record<string, V3 | null> = {
      plate: [...pt(plateXZ(gg, -3.2, gg.wMax * 0.98), 0.24)],
      disc: [gg.discX - this.bench.Rd * 0.55, 0.24, gg.discZ - this.bench.Rd * 0.85],
      axis: [...pt(plateXZ(gg, 0, gg.wMax * 0.9), 0.24)],
      circle: [...pt(discXZ(gg, cexp(cx(0, -0.75))), 0.24)],
      ...this.anchorPts,
    };
    const out: Anchors = {};
    for (const [k, p] of Object.entries(pts)) out[k] = p ? this.project(p) : undefined;
    return out;
  }
}

function pt([x, z]: [number, number], y: number): [number, number, number] {
  return [x, y, z];
}
function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}
function brassDot(g: CanvasRenderingContext2D, x: number, y: number, r: number, hot: boolean): void {
  const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
  grd.addColorStop(0, "#fff0c0");
  grd.addColorStop(0.5, "#d4a955");
  grd.addColorStop(1, "#7a5a22");
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  if (hot) {
    g.strokeStyle = "#ffd27a";
    g.lineWidth = 2;
    g.stroke();
  }
}
function strip(om: number, T: number): [number, number, number] {
  const P = (2 * Math.PI) / T;
  const k = Math.floor((om + P / 2) / P);
  return Math.abs(k) % 2 ? [178, 204, 247] : [252, 214, 158];
}
/** Matte teal by height, contour lines, cream below the floor, brass at the cap. */
function shade(L: number, cream: [number, number, number], tint: [number, number, number] | null): [number, number, number] {
  const h = unitH(L);
  let c: [number, number, number] = tint ? [(cream[0] + tint[0]) / 2, (cream[1] + tint[1]) / 2, (cream[2] + tint[2]) / 2] : cream;
  if (h > 0.004) {
    const k = Math.min(1, h / 0.05);
    const tl: [number, number, number] = [19 + 88 * h, 107 + 97 * h, 102 + 87 * h];
    c = [c[0] + (tl[0] - c[0]) * k, c[1] + (tl[1] - c[1]) * k, c[2] + (tl[2] - c[2]) * k];
    const f = Math.abs((((Math.max(L_FLOOR, Math.min(L_CAP, L)) / CONTOUR) % 1) + 1) % 1 - 0.5);
    if (f > 0.44 && h < 0.985) c = [c[0] * 0.35, c[1] * 0.35, c[2] * 0.35];
    if (h >= 0.985) c = [199, 153, 77];
  }
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}
