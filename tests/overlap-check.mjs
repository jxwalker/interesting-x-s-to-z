// node overlap-check.mjs <url> <prefix> [engines] [shotdir]  -> exits 1 on any overlap
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, webkit } = require("playwright");
const [url, prefix, engines = "webkit,chromium", OUT = "/tmp"] = process.argv.slice(2);
const args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const sizes = (process.env.SIZES ? JSON.parse(process.env.SIZES) : [[390, 844], [375, 667], [430, 932], [844, 390], [667, 375], [932, 430], [768, 1024], [1280, 800]]);
const SEL = ["h1", ".intro .sub", ".intro .hint", "#btn-help", "#btn-numbers", "#caption", ".rate-ctl", "#btn-sheet", ".credit-foot", "#badge"];
let bad = 0;
const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
for (const br of engines.split(",")) {
  const browser = br === "webkit" ? await webkit.launch() : await chromium.launch({ args });
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1000, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(url + (url.includes("?") ? "&" : "?") + "intro=0", { timeout: 120000 });
    await page.waitForTimeout(4000);
    const tag = `${prefix}-${br}-${w}x${h}`;
    await page.screenshot({ path: `${OUT}/${tag}.png` });
    const m = await page.evaluate((SEL) => {
      const vis = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === "none" || s.visibility === "hidden" || e.hidden) return false; } return true; };
      const o = {};
      for (const s of SEL) { const el = document.querySelector(s); if (!el || !vis(el)) continue; const b = el.getBoundingClientRect(); if (b.width && b.height) o[s] = { l: b.left, t: b.top, r: b.right, b: b.bottom }; }
      return o;
    }, SEL);
    const ks = Object.keys(m); const errs = [];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const a = ks[i], b = ks[j];
      if ((a === "#caption" || a === ".rate-ctl") && (b === "#caption" || b === ".rate-ctl" || b === "#btn-sheet")) continue;
      if (hit(m[a], m[b])) errs.push(`${a} x ${b}`);
    }
    for (const k of ks) if (m[k].r > w + 1 || m[k].l < -1) errs.push(`${k} offscreen`);
    console.log(tag, errs.length ? "OVERLAP " + errs.join(", ") : "ok");
    bad += errs.length; await ctx.close();
  }
  await browser.close();
}
console.log("overlaps", bad); process.exit(bad ? 1 : 0);
