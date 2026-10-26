import "./styles.css";
import { T_MAX, T_MIN, Z_MAX } from "./bench";
import { cabs, carg, discInv, hz, magHs, magHz, mapExact, plateInv, plateXZ, toWnZeta, discXZ } from "./bridge";
import { DEFAULTS, Model, type PresetId } from "./model";
import { Scene2D } from "./scene2d";
import { selfTest } from "./selftest";
import { fx, nice, sHeight, zHeight, type Anchors, type Layout, type V3, type View } from "./view";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const recording = params.get("record") === "1";
if (recording) document.documentElement.classList.add("ix-record");
// ?og=1: the social card — title, caption and the bench only
if (params.get("og") === "1") document.documentElement.classList.add("ix-og");
const force2d = params.get("renderer") === "2d";
const isPhone = () => innerWidth <= 760;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const model = new Model();
model.reducedMotion = reducedMotion;
const stage = $("stage");
let view: View;
let frames = 0;
let fps = 60;

// ───────────────────────── renderer selection ─────────────────────────

async function makeWebGL(): Promise<View> {
  const probe = document.createElement("canvas");
  const ctx = probe.getContext("webgl2") ?? probe.getContext("webgl");
  if (!ctx) throw new Error("WebGL unavailable");
  (ctx.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
  const { Scene3D } = await import("./scene3d");
  return new Scene3D(stage, { hq: recording });
}

function use2D(): void {
  view = new Scene2D(stage);
  $("badge").hidden = false;
  onResize();
  view.resetCamera();
}

function switchTo2D(reason: string): void {
  if (view?.kind === "2d") return;
  console.warn(`[s-to-z] using Canvas2D fallback: ${reason}`);
  try {
    view?.dispose();
  } catch {
    /* ignore */
  }
  stage.querySelectorAll("canvas").forEach((c) => c.remove());
  use2D();
}

async function boot(): Promise<void> {
  if (force2d) use2D();
  else {
    try {
      view = await makeWebGL();
      view.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        switchTo2D("webglcontextlost");
      });
      onResize();
      view.resetCamera();
      view.render(0, model); // compile now so init errors surface here
    } catch (err) {
      switchTo2D(`WebGL init failed: ${(err as Error)?.message ?? err}`);
    }
  }
  model.startWow();
  readyT = performance.now();
  window.__ixRecord.ready = true;
  requestAnimationFrame(loop);
}

// ───────────────────────── layout ─────────────────────────

const dock = $("dock");
const adv = $("adv");
const intro = $("intro");
const numbers = $("numbers");
const explain = $("explain");
const foot = document.querySelector(".credit-foot") as HTMLElement;

// the dock starts below the header, however tall it wraps (long title, big text), so they never overlap
function placeDock(): void {
  if (isPhone()) { dock.style.top = ""; return; }
  dock.style.top = `${Math.ceil(intro.getBoundingClientRect().bottom + 10)}px`;
}

function computeLayout(w: number, h: number): Layout {
  placeDock();
  if (isPhone()) {
    let top = Math.max(intro.getBoundingClientRect().bottom, foot.getBoundingClientRect().bottom) + 2;
    if (numbers.classList.contains("open")) top = Math.max(top, numbers.getBoundingClientRect().bottom + 2);
    const sheet = adv.hidden ? dock : adv;
    const bottom = Math.min(dock.getBoundingClientRect().top, sheet.getBoundingClientRect().top) - 2;
    return { x: 4, y: top, w: w - 8, h: Math.max(160, bottom - top), phone: true };
  }
  if (document.documentElement.classList.contains("ix-og")) return { x: 250, y: 30, w: w - 256, h: h - 34, phone: false };
  const left = dock.getBoundingClientRect().right + 4;
  const right = w - 6;
  const top = 8;
  const nb = numbers.getBoundingClientRect();
  const bottom = (nb.height > 0 ? nb.top : h) - 4;
  return { x: left, y: top, w: Math.max(240, right - left), h: Math.max(200, bottom - top), phone: false };
}

let layoutKey = "";
function onResize(): void {
  const L = computeLayout(innerWidth, innerHeight);
  layoutKey = `${innerWidth}|${innerHeight}|${Math.round(L.x)}|${Math.round(L.y)}|${Math.round(L.w)}|${Math.round(L.h)}`;
  view?.resize(innerWidth, innerHeight, L);
}
function checkLayout(): void {
  if (drag) return; // never re-frame the camera under a finger
  const L = computeLayout(innerWidth, innerHeight);
  const k = `${innerWidth}|${innerHeight}|${Math.round(L.x)}|${Math.round(L.y)}|${Math.round(L.w)}|${Math.round(L.h)}`;
  if (k !== layoutKey) onResize();
}
addEventListener("resize", () => onResize());
new ResizeObserver(() => onResize()).observe(intro);
document.fonts?.ready.then(() => onResize());

// ───────────────────────── dragging the knobs ─────────────────────────

type Grab = { kind: "s" | "z"; idx: number };
let drag: (Grab & { id: number; h: number }) | null = null;

/** World positions of the s-knobs and z-twins. */
function knobWorld(): { s: V3[]; z: (V3 | null)[] } {
  const g = view.bench.geo;
  const ks = model.knobS();
  const s: V3[] = [], z: (V3 | null)[] = [];
  for (let i = 0; i < 2; i++) {
    const [x, zz] = plateXZ(g, ks[i].re, ks[i].im);
    s.push([x, 0.24 + sHeight(model, ks[i].re, ks[i].im) + 0.06, zz]);
    const zp = model.poles.kind === "real" ? mapExact(ks[i], model.T) : i === 0 ? model.d.z1 : model.d.z2;
    if (cabs(zp) > Z_MAX) z.push(null);
    else {
      const [tx, tz] = discXZ(g, zp);
      z.push([tx, 0.24 + zHeight(model, zp) + 0.04, tz]);
    }
  }
  return { s, z };
}

function pick(e: PointerEvent): (Grab & { h: number }) | null {
  if (!view) return null;
  const touch = e.pointerType === "touch";
  const R = touch ? 34 : 22;
  const w = knobWorld();
  let best: (Grab & { h: number }) | null = null;
  let bd = R;
  const test = (p: V3 | null, kind: "s" | "z", idx: number) => {
    if (!p) return;
    const a = view.project(p);
    const d = Math.hypot(e.clientX - a.x, e.clientY - a.y);
    if (a.on && d < bd) {
      bd = d;
      best = { kind, idx, h: p[1] - (kind === "s" ? 0.06 : 0.04) };
    }
  };
  for (let i = 0; i < 2; i++) {
    test(w.s[i], "s", i);
    test(w.z[i], "z", i);
  }
  return best;
}

function dragTo(x: number, y: number): void {
  if (!drag) return;
  const hit = view.onPlane(x, y, drag.h);
  if (!hit) return;
  const g = view.bench.geo;
  if (drag.kind === "s") {
    const q = plateInv(g, hit[0], hit[1]);
    model.dragS(q.sigma, q.omega);
  } else model.dragZ(discInv(g, hit[0], hit[1]), drag.idx);
}

stage.addEventListener(
  "pointerdown",
  (e) => {
    view?.poke();
    const h = pick(e);
    if (!h) return;
    model.beginDrag(h.idx, h.kind === "z");
    drag = { ...h, id: e.pointerId };
    stage.classList.add("dragging");
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    e.stopPropagation();
    e.preventDefault();
  },
  { capture: true },
);
addEventListener("pointermove", (e) => {
  if (drag && e.pointerId === drag.id) {
    dragTo(e.clientX, e.clientY);
    e.preventDefault();
    return;
  }
  if (!e.buttons && view) stage.classList.toggle("over-knob", !!pick(e));
});
function endPointer(e: PointerEvent): void {
  if (drag && e.pointerId === drag.id) {
    drag = null;
    model.endDrag();
    stage.classList.remove("dragging");
  }
}
addEventListener("pointerup", endPointer);
addEventListener("pointercancel", endPointer);

// ───────────────────────── controls ─────────────────────────

const rate = $<HTMLInputElement>("rate");
const bendIn = $<HTMLInputElement>("bend");
const chkStrips = $<HTMLInputElement>("show-strips");
const chkTustin = $<HTMLInputElement>("show-tustin");
const chkStep = $<HTMLInputElement>("show-step");
const L_RANGE = Math.log(T_MAX / T_MIN);
const tFromSlider = (v: number) => T_MIN * Math.exp((v / 1000) * L_RANGE);
const sliderFromT = (T: number) => Math.round((Math.log(T / T_MIN) / L_RANGE) * 1000);
let rating = false, bendScrub = false;

rate.addEventListener("pointerdown", () => (rating = true));
rate.addEventListener("input", () => model.setT(tFromSlider(+rate.value)));
bendIn.addEventListener("pointerdown", () => (bendScrub = true));
bendIn.addEventListener("input", () => model.scrubBend(+bendIn.value));
bendIn.addEventListener("change", () => {
  bendScrub = false;
  model.releaseBend();
});
addEventListener("pointerup", () => {
  rating = false;
  if (bendScrub) {
    bendScrub = false;
    model.releaseBend();
  }
});
$("btn-bend").addEventListener("click", () => model.toggleBend());
$("btn-random").addEventListener("click", () => model.random());
$("btn-random-back").addEventListener("click", () => model.backToExample());
for (const p of ["ring", "unstable", "alias"] as PresetId[]) $(`preset-${p}`).addEventListener("click", () => model.setPreset(p));
chkStrips.addEventListener("change", () => model.setStrips(chkStrips.checked));
chkTustin.addEventListener("change", () => model.setTustin(chkTustin.checked));
chkStep.addEventListener("change", () => model.setStep(chkStep.checked));
$("btn-reset").addEventListener("click", () => {
  model.reset();
  view?.resetCamera();
  setAdv(false);
  setNumbers(false);
  setSheet(false);
  syncControls(true);
});

const advBtn = $("btn-advanced");
function setAdv(open: boolean): void {
  adv.hidden = !open;
  advBtn.setAttribute("aria-expanded", String(open));
  advBtn.classList.toggle("on", open);
  document.documentElement.classList.toggle("adv-open", open);
  onResize();
}
advBtn.addEventListener("click", () => setAdv(adv.hidden));
$("btn-adv-close").addEventListener("click", () => setAdv(false));

const sheetBtn = $("btn-sheet");
function setSheet(open: boolean): void {
  dock.classList.toggle("collapsed-phone", !open);
  sheetBtn.setAttribute("aria-expanded", String(open));
  setText($("sheet-label"), open ? "Fewer controls" : "More controls");
  onResize();
}
sheetBtn.addEventListener("click", () => setSheet(dock.classList.contains("collapsed-phone")));

const numBtn = $("btn-numbers");
function setNumbers(open: boolean): void {
  numbers.classList.toggle("open", open);
  numBtn.setAttribute("aria-expanded", String(open));
  numBtn.classList.toggle("on", open);
  onResize();
}
numBtn.addEventListener("click", () => setNumbers(!numbers.classList.contains("open")));

function syncControls(force = false): void {
  if (!rating || force) {
    const v = String(sliderFromT(model.T));
    if (rate.value !== v) rate.value = v;
  }
  if (!bendScrub || force) {
    const v = String(Math.round(model.bend * 1000) / 1000);
    if (bendIn.value !== v) bendIn.value = v;
  }
  setText($("bend-val"), model.bend.toFixed(2));
  setText($("rate-val"), `${nice(1 / model.T)} / s`);
  setText($("rate-desc"), `A snapshot every ${fx(model.T)} s: it can follow wobbles up to ${nice(1 / (2 * model.T))} a second.`);
  chkStrips.checked = model.strips;
  chkTustin.checked = model.tustin;
  chkStep.checked = model.stepMode;
  const bent = model.bendTarget > 0.5;
  const bb = $("btn-bend");
  setText(bb, bent ? "Unbend" : "Bend into the z-plane");
  bb.setAttribute("aria-pressed", String(bent));
  for (const p of ["ring", "unstable", "alias"]) $(`preset-${p}`).classList.toggle("on", model.preset === p && !model.wowActive);
  $("btn-random-back").classList.toggle("dim", model.preset === "ring");
  if (force) setAdv(!adv.hidden);
}

// ───────────────────────── intro card ─────────────────────────

const helpBtn = $("btn-help");
const INTRO_KEY = "s-to-z:intro-seen";
let introPending = false;

function setExplain(open: boolean, remember = true): void {
  if (explain.hidden === !open) return;
  explain.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
  if (open) $("btn-explain-ok").focus({ preventScroll: true });
  else if (remember) {
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* private mode */
    }
  }
}
helpBtn.addEventListener("click", () => setExplain(explain.hidden));
$("btn-explain-x").addEventListener("click", () => setExplain(false));
$("btn-explain-ok").addEventListener("click", () => setExplain(false));
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !explain.hidden) setExplain(false);
});
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target as Node;
    if (!explain.hidden && !explain.contains(t) && !helpBtn.contains(t)) setExplain(false);
  },
  true,
);
{
  let seen = false;
  try {
    seen = localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    /* ignore */
  }
  // phones: the card would cover the opening roll-up, so it waits until that has played
  if (!seen && !recording && params.get("intro") !== "0") {
    if (isPhone()) introPending = true;
    else setExplain(true, false);
  }
}

// ───────────────────────── labels next to the objects ─────────────────────────

interface LabelDef {
  id: string;
  anchor: string;
  cls: string;
  dir: [number, number];
  /** Shown on phones too (at most three). */
  phone?: boolean;
  text: () => string | null;
}

const labelDefs: LabelDef[] = [
  { id: "plate", anchor: "plate", cls: "", dir: [-0.4, -1], phone: true, text: () => "Smooth-time map <small>(s-plane)</small>" },
  { id: "disc", anchor: "disc", cls: "", dir: [0.2, -1], phone: true, text: () => "Computer's map <small>(z-plane)</small>" },
  { id: "knob", anchor: "knob", cls: "brass", dir: [-1, -0.7], phone: true, text: () => (model.bend > 0.5 ? null : isPhone() ? "This spring's motion" : "This spring's motion <small>(drag me)</small>") },
  { id: "axis", anchor: "axis", cls: "amber", dir: [1, -0.5], text: () => "Never-fading wobbles" },
  { id: "circle", anchor: "circle", cls: "amber", dir: [1, 0.6], text: () => "The circle (size 1)" },
  { id: "beads", anchor: "beads", cls: "lime", dir: [0.5, -1], text: () => "Snapshots" },
  { id: "trace", anchor: "trace", cls: "magenta", dir: [-0.3, -1], text: () => (model.d.fake ? "The real motion <small>(green: the fake one)</small>" : "The real motion") },
];

const labelsBox = $("labels");
const leaders = document.getElementById("leaders") as unknown as SVGSVGElement;
const labelEls = new Map<string, { el: HTMLElement; html: string; w: number; h: number; line: SVGLineElement; dot: SVGCircleElement }>();
for (const d of labelDefs) {
  const el = document.createElement("div");
  el.className = `lbl3d ${d.cls}`;
  labelsBox.appendChild(el);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", d.cls);
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("r", "2.5");
  dot.setAttribute("class", d.cls);
  leaders.append(line, dot);
  labelEls.set(d.id, { el, html: "", w: 0, h: 0, line, dot });
}

function obstacles(): DOMRect[] {
  const r: DOMRect[] = [];
  for (const el of [dock, adv, intro, explain, numbers, $("badge"), foot]) if (!el.hidden && el.offsetParent !== null && getComputedStyle(el).display !== "none") r.push(el.getBoundingClientRect());
  return r;
}

function hide(rec: { el: HTMLElement; line: SVGLineElement; dot: SVGCircleElement }): void {
  rec.el.style.display = "none";
  rec.line.style.display = rec.dot.style.display = "none";
}

function layoutLabels(a: Anchors): void {
  const W = innerWidth, H = innerHeight;
  const phone = isPhone();
  const obs = obstacles();
  const top = phone ? Math.max(intro.getBoundingClientRect().bottom, foot.getBoundingClientRect().bottom) + 2 : 4;
  type B = { id: string; x: number; y: number; w: number; h: number; ax: number; ay: number };
  const boxes: B[] = [];
  let phoneCount = 0;
  // no labels while the bench fades in, or when phone sheets leave only a sliver of bench
  const free = computeLayout(W, H);
  const fadeIn = (model.wowActive && model.wowT < 1.2) || (phone && free.h < 280);
  for (const d of labelDefs) {
    const rec = labelEls.get(d.id)!;
    const an = a[d.anchor];
    if (fadeIn || (phone && (!d.phone || phoneCount >= 3))) {
      hide(rec);
      continue;
    }
    const inside = an && an.on && an.x > 2 && an.x < W - 2 && an.y > top && an.y < H - 2 && !obs.some((r) => an.x > r.left && an.x < r.right && an.y > r.top && an.y < r.bottom);
    const txt = inside ? d.text() : null;
    if (!txt) {
      hide(rec);
      continue;
    }
    if (phone) phoneCount++;
    rec.el.style.display = "";
    if (txt !== rec.html) {
      rec.el.innerHTML = txt;
      rec.html = txt;
      rec.w = rec.el.offsetWidth;
      rec.h = rec.el.offsetHeight;
    }
    let [dx, dy] = d.dir;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    const off = phone ? 14 : 22;
    let x = an!.x + dx * off, y = an!.y + dy * off;
    x -= dx > 0.35 ? 0 : dx < -0.35 ? rec.w : rec.w / 2;
    y -= dy > 0.35 ? 0 : dy < -0.35 ? rec.h : rec.h / 2;
    boxes.push({ id: d.id, x, y, w: rec.w, h: rec.h, ax: an!.x, ay: an!.y });
  }
  const pad = 4;
  for (let it = 0; it < 40; it++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const p = boxes[i];
      for (let j = i + 1; j < boxes.length; j++) {
        const q = boxes[j];
        const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) + pad;
        const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) + pad;
        if (ox > 0 && oy > 0) {
          moved = true;
          if (oy < ox) {
            const s = p.y + p.h / 2 < q.y + q.h / 2 ? -1 : 1;
            p.y += s * oy * 0.5;
            q.y -= s * oy * 0.5;
          } else {
            const s = p.x + p.w / 2 < q.x + q.w / 2 ? -1 : 1;
            p.x += s * ox * 0.5;
            q.x -= s * ox * 0.5;
          }
        }
      }
      for (const r of obs) {
        const ox = Math.min(p.x + p.w, r.right) - Math.max(p.x, r.left) + pad;
        const oy = Math.min(p.y + p.h, r.bottom) - Math.max(p.y, r.top) + pad;
        if (ox > 0 && oy > 0) {
          moved = true;
          const opts = [
            { d: r.right + pad - p.x, ax: "x" },
            { d: r.left - pad - (p.x + p.w), ax: "x" },
            { d: r.bottom + pad - p.y, ax: "y" },
            { d: r.top - pad - (p.y + p.h), ax: "y" },
          ].sort((u, v) => Math.abs(u.d) - Math.abs(v.d));
          const fits = (o: { d: number; ax: string }) => (o.ax === "x" ? p.x + o.d >= 4 && p.x + o.d <= W - p.w - 4 : p.y + o.d >= top && p.y + o.d <= H - p.h - 4);
          const o = opts.find(fits) ?? opts[0];
          if (o.ax === "x") p.x += o.d;
          else p.y += o.d;
        }
      }
      p.x = Math.max(4, Math.min(W - p.w - 4, p.x));
      p.y = Math.max(top, Math.min(H - p.h - 4, p.y));
    }
    if (!moved) break;
  }
  const hit = (b: B, x: number, y: number, w: number, h: number) => b.x < x + w - 2 && x < b.x + b.w - 2 && b.y < y + h - 2 && y < b.y + b.h - 2;
  const kept: B[] = [];
  for (const b of boxes) {
    const rec = labelEls.get(b.id)!;
    if (obs.some((r) => hit(b, r.left, r.top, r.width, r.height)) || kept.some((k) => hit(b, k.x, k.y, k.w, k.h))) {
      hide(rec);
      continue;
    }
    kept.push(b);
    rec.el.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    const cx = Math.max(b.x, Math.min(b.x + b.w, b.ax)), cy = Math.max(b.y, Math.min(b.y + b.h, b.ay));
    const far = Math.hypot(cx - b.ax, cy - b.ay) > 6;
    rec.line.style.display = far ? "" : "none";
    rec.dot.style.display = "";
    rec.line.setAttribute("x1", b.ax.toFixed(1));
    rec.line.setAttribute("y1", b.ay.toFixed(1));
    rec.line.setAttribute("x2", cx.toFixed(1));
    rec.line.setAttribute("y2", cy.toFixed(1));
    rec.dot.setAttribute("cx", b.ax.toFixed(1));
    rec.dot.setAttribute("cy", b.ay.toFixed(1));
  }
}

// ───────────────────────── caption ─────────────────────────

const captionText = $("caption-text");
const caption = $("caption");
let captionState = "idle";

const setText = (e: HTMLElement, s: string) => {
  if (e.textContent !== s) e.textContent = s;
};

function idleLine(): [string, string] {
  const d = model.d, s = d.sys;
  if (model.poles.kind === "real") {
    const z1 = cabs(mapExact({ re: model.poles.a, im: 0 }, model.T)), z2 = cabs(mapExact({ re: model.poles.b, im: 0 }, model.T));
    const crit = Math.abs(model.poles.a - model.poles.b) < 1e-9;
    const where = d.stable ? "inside the circle, so it settles" : d.boundary ? "one on the circle, so it never quite returns" : "outside the circle, so it runs away";
    if (crit) return ["overdamped", `Just too stiff to ring (critically damped): one double pole, so it creeps back without wobbling. On the computer's map its twin sits on the line through the centre at size ${fx(z1)}, ${where}.`];
    return ["overdamped", `Too stiff to ring (overdamped): two real poles, so it creeps back without wobbling. On the computer's map both twins sit on the line through the centre (sizes ${fx(Math.max(z1, z2))} and ${fx(Math.min(z1, z2))}), ${where}.`];
  }
  return ["idle", `This spring rings ${nice(hz(s.p1.im))} times a second and fades in about ${nice(1 / Math.abs(s.p1.re))} s. On the computer's map it sits at size ${fx(d.zMax)}, inside the circle, so it settles.`];
}
const BENDING = "Rolling the map up: each fading speed becomes a circle, each wobble speed becomes a spoke, and the glowing line becomes the circle of size 1.";
function unstableLine(): string {
  return `Past the line: the motion grows instead of fading, and its twin is outside the circle (size ${fx(model.d.zMax)}). It blows up.`;
}
function aliasLine(): string {
  const T = model.T;
  return `Too fast to see: snapshots every ${fx(T)} s can only follow ${nice(1 / (2 * T))} wobbles a second, so this ${nice(hz(model.sys.p1.im))}-a-second ring looks like ${nice(hz(model.d.aliasW))} a second.`;
}
function stripsLine(): string {
  return `Every band this tall (2π/T = ${nice((2 * Math.PI) / model.T)} rad/s, or ${nice(1 / model.T)} wobbles a second) wraps onto the same disc. That's why the computer can't tell these motions apart.`;
}
function tustinLine(): string {
  return `The engineers' shortcut keeps stable things stable but squeezes high wobbles: ${nice(hz(model.sys.p1.im))} becomes ${nice(hz(model.d.warpW))} wobbles a second.`;
}

function captionNow(): [string, string] {
  const m = model, d = m.d, t = m.time, ev = m.ev;
  const pair = m.poles.kind === "pair";
  if (m.wowActive) {
    const w = m.wowT;
    if (m.bending || (w > 9.6 && w < 10.4)) return ["bending", BENDING];
    if (!d.stable && !d.boundary) return ["unstable", unstableLine()];
    if (d.aliased) return ["aliasing", aliasLine()];
    return idleLine();
  }
  if (m.bending) return ["bending", BENDING];
  const recent = (x: number, s = 5) => t - x < s;
  const lastOther = Math.max(ev.drag, ev.rate, ev.preset, ev.random, ev.strips, ev.tustin, ev.step, ev.back, ev.bend);
  if (recent(ev.reset, 2.2) && lastOther < ev.reset) return ["reset", "Back to the example: a gentle ring, two snapshots a second, map flat."];
  if (m.tustin && recent(ev.tustin) && pair) return ["tustin", tustinLine()];
  if (m.strips && recent(ev.strips) && pair) return ["strips", stripsLine()];
  if (m.stepMode && recent(ev.step, 4)) return ["step", "Step instead of tap: the spring is pushed and held, so it settles at a new rest point. The snapshots still equal the computer's own z-pole output."];
  if (!d.stable && !d.boundary) return ["unstable", unstableLine()];
  if (d.boundary) return ["boundary", "On the line: the motion never fades and never grows. Its twin sits exactly on the circle (size 1.00)."];
  if (d.aliased) return ["aliasing", aliasLine()];
  if (pair && (m.dragging || recent(ev.drag, 2.2))) {
    const ang = Math.abs(carg(d.z1));
    if (m.dragDir === "left") return ["drag", `Further left, faster fade: its twin moves toward the centre (size ${fx(d.zMax)}).`];
    if (m.dragDir === "right") return ["drag", `Further right, slower fade: its twin moves out toward the circle (size ${fx(d.zMax)}).`];
    if (m.dragDir === "up") return ["drag", `Faster wobble: its twin swings further round the circle (angle ωT = ${fx(ang)} rad).`];
    if (m.dragDir === "down") return ["drag", `Slower wobble: its twin swings back toward the right (angle ωT = ${fx(ang)} rad).`];
  }
  if (pair && recent(ev.rate, 3)) return ["rate", `A snapshot every ${fx(m.T)} s (${nice(1 / m.T)} a second): the twin's angle is ωT = ${fx(Math.abs(m.sys.p1.im * m.T))} rad. Slower snapshots swing it further round.`];
  if (pair && m.bend > 0.999 && recent(ev.bend, 5)) return ["bent", `Rolled up: this spring's twin sits at size ${fx(d.zMax)} and angle ${fx(Math.abs(carg(d.z1)))} rad. Fading speeds became circles, wobble speeds became spokes.`];
  if (m.tustin && pair) return ["tustin", tustinLine()];
  if (m.strips && pair) return ["strips", stripsLine()];
  return idleLine();
}

// ───────────────────────── readouts ─────────────────────────

// dial ticks: 0 … 1.5, green under 1, red over
const DIAL_MAX = 1.5;
function dialAngle(v: number): number {
  return ((Math.max(0, Math.min(DIAL_MAX, v)) / DIAL_MAX) * 2 - 1) * (Math.PI / 2) * 0.92;
}
{
  const g = $("g-ticks") as unknown as SVGGElement;
  const ns = "http://www.w3.org/2000/svg";
  for (let k = 0; k <= 15; k++) {
    const v = k / 10;
    const a = dialAngle(v);
    const major = k % 5 === 0;
    const r0 = major ? 38 : 42, r1 = 47;
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", (60 + Math.sin(a) * r0).toFixed(2));
    l.setAttribute("y1", (66 - Math.cos(a) * r0).toFixed(2));
    l.setAttribute("x2", (60 + Math.sin(a) * r1).toFixed(2));
    l.setAttribute("y2", (66 - Math.cos(a) * r1).toFixed(2));
    l.setAttribute("class", major ? "tick major" : "tick");
    g.appendChild(l);
    if (major) {
      const tx = document.createElementNS(ns, "text");
      const side = Math.abs(Math.sin(a)) > 0.5, r = side ? 52 : 56;
      tx.setAttribute("x", (60 + Math.sin(a) * r).toFixed(2));
      tx.setAttribute("y", (66 - Math.cos(a) * r + 4).toFixed(2));
      if (side) tx.style.textAnchor = a < 0 ? "end" : "start";
      tx.setAttribute("class", "tick-lbl");
      tx.textContent = v.toFixed(1);
      g.appendChild(tx);
    }
  }
  const arc = (v0: number, v1: number) => {
    const a0 = dialAngle(v0), a1 = dialAngle(v1), R = 48;
    return `M${60 + Math.sin(a0) * R} ${66 - Math.cos(a0) * R} A${R} ${R} 0 0 1 ${60 + Math.sin(a1) * R} ${66 - Math.cos(a1) * R}`;
  };
  $("g-ok").setAttribute("d", arc(0, 1));
  $("g-bad").setAttribute("d", arc(1, DIAL_MAX));
}

// frequency-response plots
const plot = $<HTMLCanvasElement>("plot");
let plotCursor = -1;
plot.addEventListener("pointermove", (e) => {
  const r = plot.getBoundingClientRect();
  plotCursor = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
});
plot.addEventListener("pointerleave", () => (plotCursor = -1));
let plotKey = "";
function drawPlot(): void {
  const r = plot.getBoundingClientRect();
  if (r.width < 10) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (plot.width !== W || plot.height !== H) {
    plot.width = W;
    plot.height = H;
  }
  const cur = plotCursor >= 0 ? plotCursor : 0.5 + 0.5 * Math.sin(model.time * 0.6 - Math.PI / 2);
  const key = `${model.version}|${W}|${H}|${cur.toFixed(3)}`;
  if (key === plotKey) return;
  plotKey = key;
  const g = plot.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height;
  g.clearRect(0, 0, w, h);
  const sys = model.sys, T = model.T;
  const rows = [
    { f: (th: number) => magHs(sys, th / T), col: "#c22f84", name: "up the glowing line" },
    { f: (th: number) => magHz(sys, T, th), col: "#156f6b", name: "round the circle" },
  ];
  const ph = (h - 14) / 2;
  const lo = Math.log(0.05), hi = Math.log(20);
  const Y = (v: number, i: number) => i * (ph + 4) + ph - ((Math.max(lo, Math.min(hi, Math.log(Math.max(v, 1e-9)))) - lo) / (hi - lo)) * (ph - 4) - 2;
  for (let i = 0; i < 2; i++) {
    const y0 = i * (ph + 4);
    g.fillStyle = "rgba(60,45,20,0.06)";
    g.fillRect(0, y0, w, ph);
    // level 1 (= DC)
    g.strokeStyle = "rgba(60,45,20,0.3)";
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, Y(1, i));
    g.lineTo(w, Y(1, i));
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = rows[i].col;
    g.lineWidth = 1.8;
    g.beginPath();
    for (let k = 0; k <= 160; k++) {
      const th = (k / 160) * Math.PI;
      const y = Y(rows[i].f(th), i);
      const x = (k / 160) * w;
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  // shared cursor
  const cx = cur * w, th = cur * Math.PI;
  g.strokeStyle = "rgba(29,25,18,0.6)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx, 0);
  g.lineTo(cx, h - 12);
  g.stroke();
  for (let i = 0; i < 2; i++) {
    g.fillStyle = rows[i].col;
    g.beginPath();
    g.arc(cx, Y(rows[i].f(th), i), 3.2, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#5b5040";
  g.font = "11px ui-monospace, Menlo, monospace";
  g.textBaseline = "bottom";
  g.textAlign = "left";
  g.fillText("0", 1, h);
  g.textAlign = "right";
  g.fillText(`${nice(1 / (2 * T))} wobbles/s`, w - 1, h);
  g.textAlign = cx > w / 2 ? "right" : "left";
  g.textBaseline = "top";
  g.fillStyle = "#1d1912";
  g.fillText(`${nice(th / (2 * Math.PI * T))} /s`, cx + (cx > w / 2 ? -4 : 4), 1);
}

let needleA = 0;
function updateHud(dt: number): void {
  const m = model, d = m.d, s = d.sys;
  const pair = m.poles.kind === "pair";
  if (pair) {
    setText($("n-pole"), `s = ${fx(s.p1.re)} ± ${fx(s.p1.im)}i`);
    const tau = 1 / Math.abs(s.p1.re);
    const fade = d.boundary ? "never fades" : d.stable ? `dies away by e every ${nice(tau)} s` : `grows by e every ${nice(tau)} s`;
    setText($("n-pole-m"), `${fade}, wobbles ${nice(hz(s.p1.im))} times a second`);
    setText($("n-z"), `z = ${fx(cabs(d.z1))} ∠ ±${fx(Math.abs(carg(d.z1)))} rad`);
  } else {
    setText($("n-pole"), `s = ${fx(s.p1.re)} and ${fx(s.p2.re)}`);
    const slow = Math.max(s.p1.re, s.p2.re);
    setText($("n-pole-m"), `no wobble: ${slow < 0 ? `the slow part dies away by e every ${nice(1 / Math.abs(slow))} s` : "it creeps away"} (ω_n ${fx(toWnZeta(s).wn)}, ζ ${fx(toWnZeta(s).zeta)})`);
    setText($("n-z"), `z = ${fx(d.z1.re)} and ${fx(d.z2.re)}`);
  }
  setText($("n-z-m"), d.boundary ? `size ${fx(d.zMax)} (on the circle = rings forever)` : d.stable ? `size ${fx(d.zMax)} (under 1 = settles)` : `size ${fx(d.zMax)} (over 1 = blows up)`);
  setText($("n-T"), `T = ${fx(m.T)} s`);
  setText($("n-T-m"), `${nice(1 / m.T)} snapshots a second; fastest wobble it can see: ${nice(1 / (2 * m.T))} a second`);
  $("n-alias").hidden = !d.aliased;
  if (d.aliased) setText($("n-alias-m"), `Too fast to see: it looks like ${nice(hz(d.aliasW))} wobbles a second instead of ${nice(hz(s.p1.im))}.`);
  $("n-tustin").hidden = !m.tustin;
  if (m.tustin) {
    const tz = d.tz1;
    setText($("n-tz"), pair ? `z = ${fx(cabs(tz))} ∠ ±${fx(Math.abs(carg(tz)))} rad` : `z = ${fx(d.tz1.re)} and ${fx(d.tz2.re)}`);
    setText($("n-tz-m"), pair ? `exact: ${fx(cabs(d.z1))} ∠ ±${fx(Math.abs(carg(d.z1)))}. Its wobble reads as ${nice(hz(d.warpW))} a second instead of ${nice(hz(s.p1.im))}: ω_d = (2/T)·atan(ωT/2).` : "on the real line, like the exact twins");
  }
  drawPlot();
  const target = dialAngle(d.zMax);
  needleA += (target - needleA) * Math.min(1, dt * 12 || 1);
  const needle = $("needle");
  needle.setAttribute("x2", (60 + Math.sin(needleA) * 40).toFixed(2));
  needle.setAttribute("y2", (66 - Math.cos(needleA) * 40).toFixed(2));
  setText($("d-z"), fx(d.zMax));
  $("dial").classList.toggle("broken", !d.stable && !d.boundary);

  const [state, full] = captionNow();
  captionState = state;
  if (captionText.textContent !== full) {
    captionText.textContent = full;
    caption.classList.remove("pulse");
    void caption.offsetWidth;
    caption.classList.add("pulse");
  }
  caption.dataset.state = state;
}

// ───────────────────────── loop ─────────────────────────

let last = performance.now();
let fpsT = 0, fpsN = 0;
let stepped = false;
let readyT = Infinity;

function loop(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  // In record mode the clock waits for the recorder's fixed-dt steps (or starts on its own 3 s after ready).
  if (!stepped) frame(recording && now - readyT < 3000 ? 0 : dt);
  requestAnimationFrame(loop);
}

function frame(dt: number, draw = true): void {
  model.step(dt);
  if (introPending && !model.wowActive && !stepped) {
    introPending = false;
    setExplain(true, false);
  }
  syncControls();
  if (draw && view) {
    try {
      view.render(dt, model);
    } catch (err) {
      if (view.kind === "webgl") switchTo2D(`render error: ${(err as Error)?.message ?? err}`);
      else throw err;
    }
    layoutLabels(view.anchors());
  }
  updateHud(dt);
  if (frames % 10 === 0) checkLayout();
  frames++;
  const now = performance.now();
  if (!fpsT) fpsT = now;
  fpsN++;
  if (now - fpsT >= 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
}

// ───────────────────────── hooks ─────────────────────────

declare global {
  interface Window {
    __bridgeInfo: () => Record<string, unknown>;
    __bridgeSelfTest: () => ReturnType<typeof selfTest>;
    __bridgeAdvance: (seconds: number) => Record<string, unknown>;
    __bridgeAnchors: () => Anchors;
    __bridgeKnobs: () => { s: ({ x: number; y: number } | null)[]; z: ({ x: number; y: number } | null)[] };
    __ixRecord: { ready: boolean; setStepped: (on: boolean) => void; stepFrame: (dt: number) => void };
  }
}
const r9 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e9) / 1e9 : x);
window.__bridgeInfo = () => {
  const m = model, d = m.d, s = d.sys;
  const { wn, zeta } = toWnZeta(s);
  return {
    T: r9(m.T),
    poles: [s.p1, s.p2].map((p) => ({ re: r9(p.re), im: r9(p.im) })),
    zPoles: [d.z1, d.z2].map((z) => ({ re: r9(z.re), im: r9(z.im), abs: r9(cabs(z)), arg: r9(carg(z)) })),
    wn: r9(wn),
    zeta: r9(zeta),
    stable: d.stable,
    boundary: d.boundary,
    aliased: d.aliased,
    aliasFreq: r9(hz(d.aliasW)),
    aliasOmega: r9(d.aliasW),
    bend: r9(m.bend),
    mode: m.stepMode ? "step" : "impulse",
    captionState,
    caption: captionText.textContent ?? "",
    samples: d.raw.samples.map(r9),
    discrete: d.raw.discrete.map(r9),
    tustin: m.tustin ? [d.tz1, d.tz2].map((z) => ({ re: r9(z.re), im: r9(z.im) })) : null,
    strips: m.strips,
    preset: m.preset,
    renderer: view?.kind ?? "webgl",
    wow: m.wowActive,
    wowT: r9(m.wowT),
    playT: r9(m.playT),
    version: m.version,
    defaults: { ...DEFAULTS, poles: { sigma: -0.5, omega: Math.PI } },
    frames,
    fps: Math.round(fps * 10) / 10,
    nan: !m.finite(),
  };
};
window.__bridgeSelfTest = () => selfTest();
window.__bridgeAnchors = () => view?.anchors() ?? {};
window.__bridgeKnobs = () => {
  const w = knobWorld();
  const p = (v: V3 | null) => (v ? view.project(v) : null);
  return { s: w.s.map(p), z: w.z.map(p) };
};
window.__bridgeAdvance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 30) frame(1 / 30, false);
  return window.__bridgeInfo();
};
// Deterministic fixed-dt stepping for scripts/record-demo.mjs ("capture": "frames").
window.__ixRecord = {
  ready: false,
  setStepped(on: boolean) {
    stepped = on;
    if (on) {
      introPending = false;
      setExplain(false, false);
    }
  },
  stepFrame(dt: number) {
    frame(Math.min(0.1, Math.max(1 / 240, dt || 1 / 30)));
  },
};

syncControls(true);
void boot();
