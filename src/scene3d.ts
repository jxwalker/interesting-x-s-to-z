/**
 * WebGL view: a walnut-and-brass signal bench at night.
 * Matte enamel data surfaces with crisp contour and grid lines, PBR brass, RoomEnvironment reflections,
 * soft shadows, ACES, bloom kept to the amber axis / unit circle.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BENCH, SIG_MAX, SIG_MIN, TRACK_SECONDS, W_MAX, Z_MAX, type Bench } from "./bench";
import { cexp, cx, discXZ, logHs, logHz, mapExact, morph, plateXZ, type C } from "./bridge";
import { LIMIT, TRACE_N, WOW, type Model } from "./model";
import { AMBER, CONTOUR, H_MAX, LIME, L_CAP, L_FLOOR, MAGENTA, VIOLET, sHeight, unitH, zHeight, type Anchor, type Anchors, type Layout, type V3, type View } from "./view";

const EXPOSURE = 1.0;
const FOV = 30;

// ───────────────────────── procedural textures ─────────────────────────

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function walnutTex(): THREE.CanvasTexture {
  const t = canvasTex(1024, 512, (g) => {
    g.fillStyle = "#3b2416";
    g.fillRect(0, 0, 1024, 512);
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 260; i++) {
      const y = rnd() * 512;
      const a = 0.04 + rnd() * 0.1;
      g.strokeStyle = rnd() < 0.5 ? `rgba(20,10,5,${a})` : `rgba(120,72,40,${a * 0.8})`;
      g.lineWidth = 0.6 + rnd() * 2.6;
      g.beginPath();
      const amp = 2 + rnd() * 6, f = 0.004 + rnd() * 0.01, ph = rnd() * 6;
      for (let x = 0; x <= 1024; x += 16) g.lineTo(x, y + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.1 + ph) * amp * 0.3);
      g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function backdropTex(): THREE.CanvasTexture {
  return canvasTex(16, 256, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, "#0c1426");
    grd.addColorStop(0.55, "#141c2c");
    grd.addColorStop(1, "#08090e");
    g.fillStyle = grd;
    g.fillRect(0, 0, 16, 256);
  });
}

function dialFaceTex(): THREE.CanvasTexture {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = "#f1e9d6";
    g.beginPath();
    g.arc(128, 128, 128, 0, Math.PI * 2);
    g.fill();
    const ang = (v: number) => Math.PI * (0.75 + (v / 1.5) * 1.5);
    g.lineWidth = 18;
    g.strokeStyle = "#3f9a5a";
    g.beginPath();
    g.arc(128, 128, 96, ang(0), ang(1));
    g.stroke();
    g.strokeStyle = "#c83a2c";
    g.beginPath();
    g.arc(128, 128, 96, ang(1), ang(1.5));
    g.stroke();
    g.strokeStyle = "#2a2116";
    for (let k = 0; k <= 15; k++) {
      const a = ang(k / 10);
      const r0 = k % 5 === 0 ? 68 : 80;
      g.lineWidth = k % 5 === 0 ? 4 : 2;
      g.beginPath();
      g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
      g.lineTo(128 + Math.cos(a) * 106, 128 + Math.sin(a) * 106);
      g.stroke();
    }
    g.fillStyle = "#2a2116";
    g.font = "bold 26px ui-monospace, Menlo, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const v of [0, 1]) {
      const a = ang(v);
      g.fillText(v.toFixed(0), 128 + Math.cos(a) * 46, 128 + Math.sin(a) * 46);
    }
    g.font = "600 22px Georgia, serif";
    g.fillText("size |z|", 128, 190);
  });
}

// ───────────────────────── shaders for the matte data surfaces ─────────────────────────

const LINE_GLSL = /* glsl */ `
  // anti-aliased line at integer values of v; fw = screen-space change of v; w = width in px
  float aaLine(float v, float fw, float w) {
    float d = abs(fract(v + 0.5) - 0.5);
    float fade = 1.0 - smoothstep(0.12, 0.3, fw); // lines too dense to read fade out
    return (1.0 - smoothstep(fw * w * 0.5, fw * (w * 0.5 + 1.0), d)) * fade;
  }
`;

interface LandUniforms {
  uT: { value: number };
  uStrips: { value: number };
  uSheet: { value: number };
}

/**
 * Landscape / sheet material: MeshStandardMaterial (matte, shadows, env) with grid lines, contours,
 * stability tints and alias-strip tints printed in the fragment shader.
 * mode 0 = s-plate (aSW = (σ, ω)), 1 = z-disc (aZ = z), 2 = the rolling sheet (aSW, translucent).
 */
function landMaterial(mode: 0 | 1 | 2, u: LandUniforms): THREE.MeshStandardMaterial {
  const sheet = mode === 2;
  const mat = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: sheet ? 0.55 : 0.93,
    metalness: 0,
    envMapIntensity: sheet ? 0.6 : 0.25,
    transparent: sheet,
    depthWrite: !sheet,
    emissive: sheet ? "#5b7fb0" : "#000000",
    emissiveIntensity: sheet ? 0.35 : 0,
    side: sheet ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uT = u.uT;
    sh.uniforms.uStrips = u.uStrips;
    sh.uniforms.uSheet = u.uSheet;
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute vec2 aP; attribute float aH; attribute float aL; attribute float aA;
         varying vec2 vP; varying float vH; varying float vLg; varying float vA;`,
      )
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n vP = aP; vH = aH; vLg = aL; vA = aA;`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uT; uniform float uStrips; uniform float uSheet;
         varying vec2 vP; varying float vH; varying float vLg; varying float vA;
         ${LINE_GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float sg; float om; float fs; float fo;
          ${
            mode === 1
              ? `float r = max(length(vP), 1e-4);
                 sg = log(r) / uT; om = atan(vP.y, vP.x) / uT;
                 float fwp = length(fwidth(vP));
                 fs = fwp / (r * uT); fo = fwp / (r * uT);`
              : `sg = vP.x; om = vP.y; fs = fwidth(sg); fo = fwidth(om);`
          }
          vec3 cream = vec3(0.93, 0.89, 0.80);
          ${
            mode === 1
              ? `float outside = smoothstep(0.995, 1.01, r);
                 cream = mix(cream, vec3(0.95, 0.80, 0.78), outside * 0.85);
                 cream = mix(cream, vec3(0.84, 0.92, 0.82), (1.0 - outside) * 0.35);`
              : `cream = mix(cream, sg > 0.0 ? vec3(0.96, 0.78, 0.76) : vec3(0.83, 0.92, 0.82), ${sheet ? "0.0" : "0.6"});`
          }
          ${
            mode !== 1
              ? `if (uStrips > 0.5) {
                   float P = 6.2831853 / uT;
                   float k = floor((om + P * 0.5) / P);
                   float odd = mod(k, 2.0);
                   cream = mix(cream, odd > 0.5 ? vec3(0.70, 0.80, 0.97) : vec3(0.99, 0.84, 0.62), 0.55);
                 }`
              : ""
          }
          // matte teal, lighter toward the peaks; flat brass cap where the pole is clipped
          vec3 teal = mix(vec3(0.05, 0.36, 0.34), vec3(0.22, 0.66, 0.60), smoothstep(0.0, 1.0, vH));
          float land = smoothstep(0.0005, 0.012, vH);
          vec3 col = mix(cream, teal, land * ${sheet ? "0.0" : "1.0"});
          col = mix(col, vec3(0.78, 0.60, 0.30), smoothstep(0.985, 0.999, vH));
          ${sheet ? "col = mix(vec3(0.74, 0.84, 0.98), cream, uStrips * 0.8);" : ""}
          // grid printed on top: σ every 0.5 (darker at integers), ω every 1 rad/s
          float g = 0.0;
          ${
            sheet
              ? `g = max(g, aaLine(sg, fs, 1.6));
                 g = max(g, aaLine(om / 2.0, fo / 2.0, 1.4) * 0.85);`
              : `g = max(g, aaLine(sg * 2.0, fs * 2.0, 0.9) * 0.45);
                 g = max(g, aaLine(sg, fs, 1.3) * 0.7);
                 g = max(g, aaLine(om, fo, 0.9) * 0.45);
                 g = max(g, aaLine(om / 5.0, fo / 5.0, 1.3) * 0.6);`
          }
          ${mode === 1 ? "g *= smoothstep(0.03, 0.12, r);" : ""}
          if (uStrips > 0.5) {
            float P = 6.2831853 / uT;
            g = max(g, aaLine((om + P * 0.5) / P, fo / P, 2.4) * 0.95);
          }
          // contour lines every equal step of log-height, only on the landscape
          float c = aaLine(vLg / ${CONTOUR.toFixed(3)}, fwidth(vLg) / ${CONTOUR.toFixed(3)}, 1.2) * land * step(vH, 0.985);
          vec3 ink = ${sheet ? "vec3(0.03, 0.14, 0.36)" : "vec3(0.10, 0.12, 0.13)"};
          col = mix(col, ink, max(g * (1.0 - land * 0.45), c * 0.75));
          diffuseColor.rgb = col;
          ${sheet ? "diffuseColor.a = vA * mix(0.34, 1.0, clamp(g * 1.8, 0.0, 1.0));" : ""}
        }`,
      );
  };
  mat.customProgramCacheKey = () => `land${mode}`;
  return mat;
}

/** Glowing core + soft halo, for the amber axis / unit circle. */
function glowMats(): { core: THREE.Material; halo: THREE.Material } {
  return {
    core: new THREE.MeshBasicMaterial({ color: new THREE.Color(AMBER).multiplyScalar(4.2) }),
    halo: new THREE.MeshBasicMaterial({ color: new THREE.Color(AMBER).multiplyScalar(1.1), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
  };
}

class PolyCurve extends THREE.Curve<THREE.Vector3> {
  pts: THREE.Vector3[];
  constructor(pts: THREE.Vector3[]) {
    super();
    this.pts = pts;
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const n = this.pts.length - 1;
    const x = Math.max(0, Math.min(1, t)) * n;
    const i = Math.min(n - 1, Math.floor(x));
    return target.copy(this.pts[i]).lerp(this.pts[i + 1], x - i);
  }
}

function tube(pts: THREE.Vector3[], r: number, radial = 6, closed = false): THREE.BufferGeometry {
  return new THREE.TubeGeometry(new PolyCurve(pts), Math.max(2, pts.length - 1), r, radial, closed);
}

function knobGeo(r: number): THREE.BufferGeometry {
  const prof: [number, number][] = [
    [0, 0], [r * 1.12, 0], [r * 1.12, r * 0.18], [r * 0.92, r * 0.26], [r * 0.92, r * 0.62], [r * 1.0, r * 0.7], [r * 1.0, r * 0.82], [r * 0.85, r * 0.95], [r * 0.55, r * 1.12], [0, r * 1.18],
  ];
  return new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a, b)), 40);
}

// ───────────────────────── the view ─────────────────────────

const SN = 128; // s-plate landscape grid
const ZR = 80, ZA = 200; // disc landscape (rings × spokes)
const SHS = 40, SHW = 240; // rolling sheet

export class Scene3D implements View {
  readonly kind = "webgl" as const;
  readonly canvas: HTMLCanvasElement;
  bench: Bench = BENCH.wide;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private W = 1;
  private H = 1;
  private layout: Layout = { x: 0, y: 0, w: 1, h: 1, phone: false };
  private fitDist = 12;
  private idle = 0;
  private time = 0;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private uni: LandUniforms = { uT: { value: 0.5 }, uStrips: { value: 0 }, uSheet: { value: 0 } };

  private root = new THREE.Group();
  private benchGroup = new THREE.Group();
  private plateGroup = new THREE.Group();
  private discGroup = new THREE.Group();
  private sLand: THREE.Mesh;
  private zLand: THREE.Mesh;
  private sheet: THREE.Mesh;
  private axisS: { core: THREE.Mesh; halo: THREE.Mesh };
  private axisZ: { core: THREE.Mesh; halo: THREE.Mesh };
  private axisSheet: { core: THREE.Mesh; halo: THREE.Mesh };
  private knobs: THREE.Mesh[] = [];
  private twins: THREE.Mesh[] = [];
  private sheetBeads: THREE.Mesh[] = [];
  private tustinRings: THREE.Mesh[] = [];
  private aliasRings: THREE.InstancedMesh;
  private knobGlow: THREE.Mesh[] = [];
  private brass: THREE.MeshStandardMaterial;

  // track + spring + dial
  private track = new THREE.Group();
  private traceMesh: THREE.Mesh;
  private fakeMesh: THREE.Mesh;
  private beads: THREE.InstancedMesh;
  private beadOut: THREE.InstancedMesh;
  private ghosts: THREE.InstancedMesh;
  private stems: THREE.LineSegments;
  private playhead: THREE.Group;
  private spring = new THREE.Group();
  private coil: THREE.Mesh;
  private coilMat: THREE.MeshStandardMaterial;
  private mass: THREE.Group;
  private dial = new THREE.Group();
  private needle: THREE.Mesh;
  private needleA = 0;

  private ver = -1;
  private sheetKey = "";
  private layoutKey = "";
  private beadKey = "";
  private anchorPts: Record<string, V3 | null> = {};

  constructor(host: HTMLElement, opts: { hq?: boolean } = {}) {
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    this.canvas = canvas;
    const mobile = Math.min(innerWidth, innerHeight) < 600;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false, preserveDrawingBuffer: !!opts.hq });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.6 : 2));

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = 0.3;
    this.controls.maxPolarAngle = 1.35;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.6;
    this.controls.addEventListener("start", () => this.poke());

    const webkitOnly = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent);
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: webkitOnly ? 0 : mobile ? 2 : 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.35, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const scene = this.scene;
    scene.background = backdropTex();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    scene.environmentIntensity = 0.5;
    room.dispose?.();
    pmrem.dispose();

    const key = new THREE.DirectionalLight("#ffe2b8", 2.1);
    key.position.set(-5, 8, 4);
    key.castShadow = true;
    const sm = opts.hq ? 2048 : mobile ? 1024 : 1536;
    key.shadow.mapSize.set(sm, sm);
    const sc = key.shadow.camera;
    sc.left = -6;
    sc.right = 6;
    sc.top = 6;
    sc.bottom = -6;
    sc.near = 2;
    sc.far = 24;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight("#8fb4ff", 1.3);
    rim.position.set(3, 4, -7);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight("#a9bbe0", "#2a1a10", 0.45));
    scene.add(this.root);

    // materials
    this.brass = new THREE.MeshStandardMaterial({ color: "#d4a955", metalness: 1, roughness: 0.28 });
    const brassDark = new THREE.MeshStandardMaterial({ color: "#9a7535", metalness: 1, roughness: 0.38 });
    const enamel = new THREE.MeshPhysicalMaterial({ color: "#efe6d2", roughness: 0.42, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3 });

    // the bench
    const wood = walnutTex();
    wood.repeat.set(1.6, 1);
    this.root.add(this.benchGroup);
    this.benchMats = { walnut: new THREE.MeshStandardMaterial({ map: wood, roughness: 0.5, metalness: 0, color: "#a07a5e" }), trim: new THREE.MeshStandardMaterial({ color: "#c79b4a", metalness: 1, roughness: 0.32 }) };

    // s-plate: enamel slab + brass plinth; landscape is its top
    const P = BENCH.wide.geo.P;
    const slab = new THREE.Mesh(new RoundedBoxGeometry(P + 0.16, 0.2, P + 0.16, 3, 0.04), enamel);
    slab.position.y = 0.24 - 0.1 - 0.001;
    slab.castShadow = slab.receiveShadow = true;
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(P + 0.34, 0.07, P + 0.34, 2, 0.025), this.brass);
    plinth.position.y = 0.035;
    plinth.receiveShadow = plinth.castShadow = true;
    this.plateGroup.add(slab, plinth);
    const sGeo = new THREE.PlaneGeometry(P, P, SN, SN).rotateX(-Math.PI / 2);
    const nS = sGeo.attributes.position.count;
    sGeo.setAttribute("aP", new THREE.BufferAttribute(new Float32Array(nS * 2), 2));
    sGeo.setAttribute("aH", new THREE.BufferAttribute(new Float32Array(nS), 1));
    sGeo.setAttribute("aL", new THREE.BufferAttribute(new Float32Array(nS), 1));
    sGeo.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(nS).fill(1), 1));
    this.sLand = new THREE.Mesh(sGeo, landMaterial(0, this.uni));
    this.sLand.receiveShadow = this.sLand.castShadow = true;
    this.plateGroup.add(this.sLand);
    this.root.add(this.plateGroup);

    // z-disc
    const Rd = BENCH.wide.Rd;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(Rd + 0.07, Rd + 0.07, 0.2, 96), enamel);
    disc.position.y = 0.24 - 0.1 - 0.001;
    disc.castShadow = disc.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(Rd + 0.17, Rd + 0.2, 0.07, 96), this.brass);
    ring.position.y = 0.035;
    ring.castShadow = ring.receiveShadow = true;
    this.discGroup.add(disc, ring);
    this.zLand = new THREE.Mesh(this.discGeo(), landMaterial(1, this.uni));
    this.zLand.receiveShadow = this.zLand.castShadow = true;
    this.discGroup.add(this.zLand);
    this.root.add(this.discGroup);

    // rolling sheet
    const shGeo = new THREE.PlaneGeometry(1, 1, SHS, SHW);
    const nSh = shGeo.attributes.position.count;
    const aP = new Float32Array(nSh * 2);
    for (let j = 0; j <= SHW; j++)
      for (let i = 0; i <= SHS; i++) {
        const k = j * (SHS + 1) + i;
        aP[k * 2] = SIG_MIN + ((SIG_MAX - SIG_MIN) * i) / SHS;
        aP[k * 2 + 1] = W_MAX - (2 * W_MAX * j) / SHW;
      }
    shGeo.setAttribute("aP", new THREE.BufferAttribute(aP, 2));
    shGeo.setAttribute("aH", new THREE.BufferAttribute(new Float32Array(nSh), 1));
    shGeo.setAttribute("aL", new THREE.BufferAttribute(new Float32Array(nSh), 1));
    shGeo.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(nSh).fill(1), 1));
    this.sheet = new THREE.Mesh(shGeo, landMaterial(2, this.uni));
    this.sheet.renderOrder = 5;
    this.sheet.frustumCulled = false;
    this.root.add(this.sheet);

    // amber lines
    const gm = glowMats();
    const mk = () => {
      const core = new THREE.Mesh(new THREE.BufferGeometry(), gm.core);
      const halo = new THREE.Mesh(new THREE.BufferGeometry(), gm.halo);
      core.frustumCulled = halo.frustumCulled = false;
      halo.renderOrder = 6;
      this.root.add(core, halo);
      return { core, halo };
    };
    this.axisS = mk();
    this.axisZ = mk();
    this.axisSheet = mk();

    // knobs (s-plane), twins (z-plane), sheet beads, Tustin rings, alias copies
    const kg = knobGeo(0.085), tg = knobGeo(0.062);
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffd27a").multiplyScalar(1.4), transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 2; i++) {
      const k = new THREE.Mesh(kg, this.brass);
      k.castShadow = true;
      this.knobs.push(k);
      const t = new THREE.Mesh(tg, this.brass);
      t.castShadow = true;
      this.twins.push(t);
      const g = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.012, 8, 48).rotateX(Math.PI / 2), glowMat.clone());
      this.knobGlow.push(g);
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 14), this.brass);
      this.sheetBeads.push(b);
      const tr = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 10, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: VIOLET, roughness: 0.6, emissive: VIOLET, emissiveIntensity: 0.35 }));
      this.tustinRings.push(tr);
      this.root.add(k, t, g, b, tr);
    }
    this.aliasRings = new THREE.InstancedMesh(new THREE.TorusGeometry(0.075, 0.012, 8, 36).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#fff3d6", roughness: 0.5, emissive: "#ffcf7a", emissiveIntensity: 0.25, transparent: true, opacity: 0.85 }), 24);
    this.aliasRings.count = 0;
    this.root.add(this.aliasRings);

    // ── the glass track ──
    const tr = this.track;
    const glass = new THREE.MeshPhysicalMaterial({ color: "#dfe8ef", roughness: 0.3, metalness: 0, transparent: true, opacity: 0.8, clearcoat: 1, clearcoatRoughness: 0.12 });
    this.trackMats = { glass, brassDark };
    this.root.add(tr);
    this.traceMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: MAGENTA, roughness: 0.7, emissive: MAGENTA, emissiveIntensity: 0.3 }));
    this.fakeMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: "#4f8a1a", roughness: 0.7, emissive: "#4f8a1a", emissiveIntensity: 0.3 }));
    tr.add(this.traceMesh, this.fakeMesh);
    const MAXB = 420;
    this.beads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ color: LIME, roughness: 0.55, emissive: LIME, emissiveIntensity: 0.22 }), MAXB);
    this.beadOut = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: "#14180e", side: THREE.BackSide }), MAXB);
    this.ghosts = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.09, 6, 28), new THREE.MeshStandardMaterial({ color: "#1d5f5b", roughness: 0.6, transparent: true, opacity: 0.8 }), MAXB);
    this.stems = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#4a505a", transparent: true, opacity: 0.75 }));
    for (const o of [this.beads, this.beadOut, this.ghosts]) {
      o.count = 0;
      o.frustumCulled = false;
    }
    tr.add(this.beads, this.beadOut, this.ghosts, this.stems);
    this.playhead = new THREE.Group();
    const ph = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 8).translate(0, 0.5, 0), brassDark);
    const phDot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 14, 10), new THREE.MeshStandardMaterial({ color: "#fff", roughness: 0.4, emissive: MAGENTA, emissiveIntensity: 0.6 }));
    phDot.name = "dot";
    this.playhead.add(ph, phDot);
    tr.add(this.playhead);

    // ── the spring ──
    const sp = this.spring;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.07, 48), this.brass);
    base.position.y = 0.035;
    base.castShadow = base.receiveShadow = true;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.25, 10), brassDark);
    rod.position.y = 0.65;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 20), brassDark);
    top.position.y = 1.28;
    const helix: THREE.Vector3[] = [];
    const turns = 9, N = 260;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * turns * Math.PI * 2;
      helix.push(new THREE.Vector3(Math.cos(a) * 0.085, i / N, Math.sin(a) * 0.085));
    }
    this.coilMat = new THREE.MeshStandardMaterial({ color: "#c9a25a", metalness: 1, roughness: 0.3, emissive: "#ff2a10", emissiveIntensity: 0 });
    this.coil = new THREE.Mesh(tube(helix, 0.011, 6), this.coilMat);
    this.coil.position.y = 0.07;
    this.coil.castShadow = true;
    this.mass = new THREE.Group();
    const m1 = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.17, 40), this.brass);
    const m2 = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 8, 40).rotateX(Math.PI / 2), brassDark);
    m2.position.y = 0.05;
    const m3 = m2.clone();
    m3.position.y = -0.05;
    m1.castShadow = true;
    this.mass.add(m1, m2, m3);
    sp.add(base, rod, top, this.coil, this.mass);
    this.root.add(sp);

    // ── the dial ──
    const d = this.dial;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.42, 14), brassDark);
    post.position.y = 0.21;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.05, 32), this.brass);
    foot.position.y = 0.025;
    const head = new THREE.Group();
    head.position.y = 0.66;
    const bezel = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.07, 48).rotateX(Math.PI / 2), this.brass);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.235, 48), new THREE.MeshStandardMaterial({ map: dialFaceTex(), roughness: 0.6 }));
    face.position.z = 0.037;
    this.needle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.2, 0.008).translate(0, 0.09, 0), new THREE.MeshStandardMaterial({ color: "#c4281f", roughness: 0.4, emissive: "#7a0d06", emissiveIntensity: 0.4 }));
    this.needle.position.z = 0.045;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.02, 16).rotateX(Math.PI / 2), brassDark);
    hub.position.z = 0.05;
    head.add(bezel, face, this.needle, hub);
    for (const o of [post, foot, bezel]) o.castShadow = true;
    d.add(post, foot, head);
    this.root.add(d);

    this.applyBench();
    this.resetCamera();
  }

  private benchMats!: { walnut: THREE.Material; trim: THREE.Material };
  private trackMats!: { glass: THREE.Material; brassDark: THREE.Material };
  private trackStatic = new THREE.Group();

  private discGeo(): THREE.BufferGeometry {
    const Ru = BENCH.wide.geo.Ru;
    const pos: number[] = [], aP: number[] = [], idx: number[] = [];
    for (let i = 0; i <= ZR; i++) {
      const r = (i / ZR) * Z_MAX;
      for (let j = 0; j <= ZA; j++) {
        const a = (j / ZA) * Math.PI * 2;
        pos.push(Ru * r * Math.cos(a), 0, -Ru * r * Math.sin(a));
        aP.push(r * Math.cos(a), r * Math.sin(a));
      }
    }
    for (let i = 0; i < ZR; i++)
      for (let j = 0; j < ZA; j++) {
        const a = i * (ZA + 1) + j, b = a + ZA + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aP", new THREE.Float32BufferAttribute(aP, 2));
    const n = pos.length / 3;
    g.setAttribute("aH", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aL", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    g.setIndex(idx);
    return g;
  }

  /** Place everything for the current layout (wide or portrait). */
  private applyBench(): void {
    const B = this.bench, g = B.geo;
    const key = this.layout.phone ? "phone" : "wide";
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.plateGroup.position.set(g.plateX, 0, g.plateZ);
    this.discGroup.position.set(g.discX, 0, g.discZ);
    // bench slab
    this.benchGroup.clear();
    const w = B.slab.x1 - B.slab.x0, dpt = B.slab.z1 - B.slab.z0;
    const cxm = (B.slab.x0 + B.slab.x1) / 2, czm = (B.slab.z0 + B.slab.z1) / 2;
    const slab = new THREE.Mesh(new RoundedBoxGeometry(w, 0.36, dpt, 3, 0.05), this.benchMats.walnut);
    slab.position.set(cxm, -0.18, czm);
    slab.receiveShadow = true;
    this.benchGroup.add(slab);
    for (const z of [B.slab.z0 + 0.16, B.slab.z1 - 0.16]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, 0.012, 0.035), this.benchMats.trim);
      t.position.set(cxm, 0.006, z);
      t.receiveShadow = true;
      this.benchGroup.add(t);
    }
    for (const x of [B.slab.x0 + 0.16, B.slab.x1 - 0.16]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, dpt - 0.3), this.benchMats.trim);
      t.position.set(x, 0.006, czm);
      this.benchGroup.add(t);
    }
    // track frame
    const T = B.track;
    this.track.position.set(T.x0, T.y, T.z);
    this.trackStatic.removeFromParent();
    const st = (this.trackStatic = new THREE.Group());
    const L = T.len, A = T.amp;
    const yc = 0.14 + A * LIMIT;
    this.trackYc = yc;
    const panel = new THREE.Mesh(new RoundedBoxGeometry(L + 0.24, 2 * A * LIMIT + 0.2, 0.025, 2, 0.01), this.trackMats.glass);
    panel.position.set(L / 2, yc, -0.045);
    panel.renderOrder = 1;
    const rail = new THREE.Mesh(new RoundedBoxGeometry(L + 0.5, 0.05, 0.2, 2, 0.015), this.brass);
    rail.position.set(L / 2, -0.035, -0.04);
    rail.castShadow = rail.receiveShadow = true;
    st.add(panel, rail);
    for (const x of [-0.12, L + 0.12]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2 * A * LIMIT + 0.32, 12), this.brass);
      post.position.set(x, yc, -0.045);
      post.castShadow = true;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 10), this.brass);
      cap.position.set(x, yc + A * LIMIT + 0.17, -0.045);
      st.add(post, cap);
    }
    // zero line and one tick per second
    const zl = new THREE.Mesh(new THREE.BoxGeometry(L, 0.006, 0.004), new THREE.MeshBasicMaterial({ color: "#5d6470" }));
    zl.position.set(L / 2, yc, -0.028);
    st.add(zl);
    for (let s = 0; s <= TRACK_SECONDS; s++) {
      const tk = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.05, 0.004), new THREE.MeshBasicMaterial({ color: "#5d6470" }));
      tk.position.set((s / TRACK_SECONDS) * L, yc, -0.028);
      st.add(tk);
    }
    this.track.add(st);
    this.track.rotation.x = -T.tilt;
    this.spring.position.set(B.spring.x, 0, B.spring.z);
    this.spring.scale.setScalar(1.3);
    this.dial.position.set(B.dial.x, 0, B.dial.z);
    this.dial.rotation.y = B.dial.rotY;
    this.ver = -1;
    this.sheetKey = "";
    this.beadKey = "";
  }
  private trackYc = 0.6;

  resize(w: number, h: number, layout: Layout): void {
    this.W = w;
    this.H = h;
    const was = this.layout.phone;
    this.layout = layout;
    this.bench = layout.phone ? BENCH.phone : BENCH.wide;
    this.applyBench();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.bloom.resolution.set(Math.max(64, Math.round((w * pr) / 2)), Math.max(64, Math.round((h * pr) / 2)));
    this.camera.aspect = w / h;
    const cxp = layout.x + layout.w / 2, cyp = layout.y + layout.h / 2;
    this.camera.setViewOffset(w, h, w / 2 - cxp, h / 2 - cyp, w, h);
    this.camera.updateProjectionMatrix();
    const prev = this.fitDist;
    this.fitDist = this.fit(this.bench.az, this.bench.el);
    this.controls.minDistance = this.fitDist * 0.5;
    this.controls.maxDistance = this.fitDist * 1.5;
    if (was !== layout.phone) this.resetCamera();
    else {
      const cur = this.camera.position.distanceTo(this.controls.target);
      this.setCam(undefined, undefined, (cur / prev) * this.fitDist);
    }
  }

  private center(): THREE.Vector3 {
    const f = this.bench.frame;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of f) {
      lo.min(new THREE.Vector3(...p));
      hi.max(new THREE.Vector3(...p));
    }
    return lo.add(hi).multiplyScalar(0.5);
  }

  /** Smallest camera distance that keeps every frame point inside the layout rectangle. */
  private fit(az: number, el: number): number {
    const c = this.center();
    const t = Math.tan(((FOV / 2) * Math.PI) / 180);
    const ax = (this.layout.w / this.W) * 0.97, ay = (this.layout.h / this.H) * 0.97;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const ok = (d: number) => {
      const cam = c.clone().addScaledVector(dir, d);
      const m = new THREE.Matrix4().lookAt(cam, c, new THREE.Vector3(0, 1, 0));
      const inv = m.clone().invert();
      for (const p of this.bench.frame) {
        const v = new THREE.Vector3(...p).sub(cam).applyMatrix4(inv.clone().setPosition(0, 0, 0));
        if (v.z > -0.1) return false;
        const nx = v.x / -v.z / (t * this.camera.aspect), ny = v.y / -v.z / t;
        if (Math.abs(nx) > ax || Math.abs(ny) > ay) return false;
      }
      return true;
    };
    let lo = 2, hi = 60;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  private sph = new THREE.Spherical();
  private setCam(az?: number, el?: number, dist?: number): void {
    const off = this.camera.position.clone().sub(this.controls.target);
    this.sph.setFromVector3(off);
    if (az !== undefined) this.sph.theta = az;
    if (el !== undefined) this.sph.phi = Math.PI / 2 - el;
    if (dist !== undefined && Number.isFinite(dist)) this.sph.radius = dist;
    off.setFromSpherical(this.sph);
    this.camera.position.copy(this.controls.target).add(off);
    this.camera.lookAt(this.controls.target);
  }

  resetCamera(): void {
    this.controls.target.copy(this.center());
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(0, 0, 1));
    this.setCam(this.bench.az, this.bench.el, this.fitDist);
    this.controls.minAzimuthAngle = this.bench.az - 0.9;
    this.controls.maxAzimuthAngle = this.bench.az + 0.9;
    this.idle = 0;
    this.drift = 0;
    this.controls.update();
  }
  private drift = 0;

  poke(): void {
    this.idle = -4;
  }

  // ───────────────────────── per-frame ─────────────────────────

  render(dt: number, m: Model): void {
    this.time += dt;
    const fade = m.wowActive ? Math.min(1, m.wowT / WOW.fade[1]) : 1;
    this.renderer.toneMappingExposure = EXPOSURE * (0.04 + 0.96 * fade * fade * (3 - 2 * fade));

    this.idle += dt;
    if (!this.reduced && this.idle > 0 && dt > 0) {
      const want = Math.sin(this.time * 0.12) * 0.07 * Math.min(1, this.idle / 3);
      const d = want - this.drift;
      this.drift = want;
      this.setCam(this.sph.theta + d);
    }
    this.controls.update();

    this.uni.uT.value = m.T;
    this.uni.uStrips.value = m.strips ? 1 : 0;

    if (m.version !== this.ver) {
      this.ver = m.version;
      this.updateLandscapes(m);
      this.updateTrack(m);
    }
    this.updatePoles(m);
    this.updateSheet(m);
    this.updateBeads(m);
    this.updateSpring(m, dt);

    this.composer.render(dt);
  }

  private updateLandscapes(m: Model): void {
    const g = this.bench.geo;
    // s-plate
    {
      const geo = this.sLand.geometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const aP = geo.attributes.aP as THREE.BufferAttribute, aH = geo.attributes.aH as THREE.BufferAttribute, aL = geo.attributes.aL as THREE.BufferAttribute;
      const q: C = { re: 0, im: 0 };
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const sg = g.sigMin + ((x + g.P / 2) / g.P) * (g.sigMax - g.sigMin);
        const om = -z * ((2 * g.wMax) / g.P);
        q.re = sg;
        q.im = om;
        const L = logHs(m.sys, q);
        const h = unitH(L);
        pos.setY(i, 0.24 + h * H_MAX);
        aP.setXY(i, sg, om);
        aH.setX(i, h);
        aL.setX(i, Math.max(L_FLOOR, Math.min(L_CAP, L)));
      }
      pos.needsUpdate = aP.needsUpdate = aH.needsUpdate = aL.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    }
    // z-disc
    {
      const geo = this.zLand.geometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const aP = geo.attributes.aP as THREE.BufferAttribute, aH = geo.attributes.aH as THREE.BufferAttribute, aL = geo.attributes.aL as THREE.BufferAttribute;
      const z: C = { re: 0, im: 0 };
      for (let i = 0; i < pos.count; i++) {
        z.re = aP.getX(i);
        z.im = aP.getY(i);
        const L = logHz(m.sys, m.T, z);
        const h = unitH(L);
        pos.setY(i, 0.24 + h * H_MAX);
        aH.setX(i, h);
        aL.setX(i, Math.max(L_FLOOR, Math.min(L_CAP, L)));
      }
      pos.needsUpdate = aH.needsUpdate = aL.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    }
    // amber axis draped over the s-landscape: its height is |H(iω)|
    {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 300; i++) {
        const om = -g.wMax + (2 * g.wMax * i) / 300;
        const [x, z] = plateXZ(g, 0, om);
        pts.push(new THREE.Vector3(x, 0.24 + sHeight(m, 0, om) + 0.006, z));
      }
      this.setGlow(this.axisS, pts, 0.011, false);
    }
    // the unit circle draped over the z-landscape: its height is |H_d(e^{iθ})|
    {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        const zz = cx(Math.cos(a), Math.sin(a));
        const [x, z] = discXZ(g, zz);
        pts.push(new THREE.Vector3(x, 0.24 + zHeight(m, zz) + 0.006, z));
      }
      this.setGlow(this.axisZ, pts, 0.011, true);
    }
  }

  private setGlow(o: { core: THREE.Mesh; halo: THREE.Mesh }, pts: THREE.Vector3[], r: number, closed: boolean): void {
    o.core.geometry.dispose();
    o.halo.geometry.dispose();
    o.core.geometry = tube(pts, r, 6, closed);
    o.halo.geometry = tube(pts, r * 3.2, 8, closed);
  }

  private updatePoles(m: Model): void {
    const g = this.bench.geo;
    const ks = m.knobS();
    const zs = [m.d.z1, m.d.z2];
    const real = m.poles.kind === "real";
    for (let i = 0; i < 2; i++) {
      const s = ks[i];
      const [x, z] = plateXZ(g, s.re, s.im);
      const y = 0.24 + sHeight(m, s.re, s.im);
      this.knobs[i].position.set(x, y - 0.012, z);
      const glow = this.knobGlow[i];
      glow.position.set(x, y + 0.01, z);
      const gm = glow.material as THREE.MeshBasicMaterial;
      gm.opacity = m.dragging ? 0.9 : 0.35 + 0.25 * Math.sin(this.time * 3 + i);
      // twin on the disc: for real poles both twins are distinct points on the positive real axis
      const zp = real ? mapExact(ks[i], m.T) : zs[i];
      const [tx, tz] = discXZ(g, zp);
      const inDisc = Math.hypot(zp.re, zp.im) <= Z_MAX;
      this.twins[i].visible = inDisc;
      this.twins[i].position.set(tx, 0.24 + zHeight(m, zp) - 0.01, tz);
      // Tustin's placement of the same pole
      const tzp = i === 0 ? m.d.tz1 : m.d.tz2;
      const [ux, uz] = discXZ(g, tzp);
      const tr = this.tustinRings[i];
      tr.visible = m.tustin && Math.hypot(tzp.re, tzp.im) <= Z_MAX;
      tr.position.set(ux, 0.24 + zHeight(m, tzp) + 0.02, uz);
    }
    // alias copies of the poles on the plate (one per strip)
    let n = 0;
    if (m.strips && !real) {
      const P = (2 * Math.PI) / m.T;
      const mtx = new THREE.Matrix4();
      for (const s of ks) {
        for (let k = -6; k <= 6; k++) {
          if (k === 0) continue;
          const om = s.im + k * P;
          if (Math.abs(om) > g.wMax || n >= 24) continue;
          const [x, z] = plateXZ(g, s.re, om);
          mtx.makeTranslation(x, 0.24 + sHeight(m, s.re, om) + 0.015, z);
          this.aliasRings.setMatrixAt(n++, mtx);
        }
      }
    }
    this.aliasRings.count = n;
    this.aliasRings.instanceMatrix.needsUpdate = true;

    const b = m.bend;
    for (let i = 0; i < 2; i++) {
      const sb = this.sheetBeads[i];
      sb.visible = b > 0.003 && b < 0.995;
      const p = morph(g, ks[i].re, ks[i].im, m.T, b);
      sb.position.set(p[0], p[1] + 0.04, p[2]);
    }
    this.anchorPts.knob = this.knobs[0].position.toArray() as V3;
    this.anchorPts.twin = this.twins[0].visible ? (this.twins[0].position.toArray() as V3) : null;
  }

  private updateSheet(m: Model): void {
    const b = m.bend;
    const show = b > 0.003;
    this.sheet.visible = show;
    this.axisSheet.core.visible = this.axisSheet.halo.visible = show;
    if (!show) return;
    const key = `${b.toFixed(5)}|${m.T}|${this.layoutKey}`;
    if (key === this.sheetKey) return;
    this.sheetKey = key;
    const g = this.bench.geo;
    const geo = this.sheet.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const aP = geo.attributes.aP as THREE.BufferAttribute;
    const aA = geo.attributes.aA as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const sg = aP.getX(i), om = aP.getY(i);
      const p = morph(g, sg, om, m.T, b);
      pos.setXYZ(i, p[0], p[1], p[2]);
      const r = Math.exp(b * sg * m.T);
      aA.setX(i, Math.min(1, 0.25 + 3 * b) * (1 - b * b * smooth01((r - 1.45) / 0.35)));
    }
    pos.needsUpdate = aA.needsUpdate = true;
    geo.computeVertexNormals();
    // the amber axis on the sheet curls into the unit circle
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 320; i++) {
      const om = -g.wMax + (2 * g.wMax * i) / 320;
      const p = morph(g, 0, om, m.T, b);
      pts.push(new THREE.Vector3(p[0], p[1] + 0.004, p[2]));
    }
    this.setGlow(this.axisSheet, pts, 0.01, false);
  }

  private updateTrack(m: Model): void {
    const T = this.bench.track;
    const L = T.len, A = T.amp, yc = this.trackYc;
    const d = m.d;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= TRACE_N; i++) pts.push(new THREE.Vector3((i / TRACE_N) * L, yc + d.trace[i] * A, 0));
    this.traceMesh.geometry.dispose();
    this.traceMesh.geometry = tube(pts, 0.013, 6);
    this.fakeMesh.visible = !!d.fake;
    if (d.fake) {
      const fp: THREE.Vector3[] = [];
      for (let i = 0; i <= TRACE_N; i++) fp.push(new THREE.Vector3((i / TRACE_N) * L, yc + d.fake[i] * A, -0.012));
      this.fakeMesh.geometry.dispose();
      this.fakeMesh.geometry = tube(fp, 0.008, 5);
    }
  }

  private updateBeads(m: Model): void {
    const T = this.bench.track;
    const L = T.len, A = T.amp, yc = this.trackYc;
    const d = m.d;
    const key = `${m.version}|${m.reveal}|${this.layoutKey}`;
    if (key === this.beadKey) return;
    this.beadKey = key;
    const shownT = m.reveal * TRACK_SECONDS;
    // trace reveal
    const idxCount = this.traceMesh.geometry.index?.count ?? 0;
    const segs = TRACE_N;
    const nSeg = Math.round(m.reveal * segs);
    this.traceMesh.geometry.setDrawRange(0, m.reveal >= 1 ? idxCount : Math.floor((idxCount / segs) * nSeg));
    const n = Math.min(d.beadT.length, 420);
    const spacing = (m.T / TRACK_SECONDS) * L;
    const r = Math.min(0.032, spacing * 0.42);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3();
    const stem: number[] = [];
    let c = 0;
    for (let i = 0; i < n; i++) {
      const t = d.beadT[i];
      const k = Math.max(0, Math.min(1, (shownT - t) / 0.5 + 0.02));
      if (k <= 0) continue;
      const x = (t / TRACK_SECONDS) * L;
      const drop = (1 - k * k) * 0.35;
      const y = yc + d.beads[i] * A + drop;
      mtx.compose(new THREE.Vector3(x, y, 0.004), q, one.setScalar(r));
      this.beads.setMatrixAt(c, mtx);
      mtx.compose(new THREE.Vector3(x, y, 0.004), q, one.setScalar(r * 1.32));
      this.beadOut.setMatrixAt(c, mtx);
      mtx.compose(new THREE.Vector3(x, yc + d.ghost[i] * A, 0.004), q, one.setScalar(r * 1.75));
      this.ghosts.setMatrixAt(c, mtx);
      stem.push(x, yc, -0.01, x, y, -0.01);
      c++;
    }
    this.beads.count = this.beadOut.count = this.ghosts.count = c;
    this.beads.instanceMatrix.needsUpdate = this.beadOut.instanceMatrix.needsUpdate = this.ghosts.instanceMatrix.needsUpdate = true;
    this.stems.geometry.dispose();
    this.stems.geometry = new THREE.BufferGeometry();
    this.stems.geometry.setAttribute("position", new THREE.Float32BufferAttribute(stem, 3));
    this.fakeMesh.visible = !!d.fake && m.reveal >= 1;
    // anchors on the track
    const bi = Math.min(c - 1, Math.max(0, Math.round(1.6 / m.T)));
    const toW = (x: number, y: number) => this.track.localToWorld(new THREE.Vector3(x, y, 0)).toArray() as V3;
    this.anchorPts.beads = c > 0 ? toW((d.beadT[bi] / TRACK_SECONDS) * L, yc + d.beads[bi] * A + 0.04) : null;
    // the real motion: first crest of the trace
    let best = 0;
    for (let i = 0; i <= TRACE_N * 0.4; i++) if (Math.abs(d.trace[i]) > Math.abs(d.trace[best])) best = i;
    this.anchorPts.trace = toW((best / TRACE_N) * L, yc + d.trace[best] * A);
  }

  private updateSpring(m: Model, dt: number): void {
    const T = this.bench.track;
    const t = m.playT;
    const on = t <= TRACK_SECONDS;
    const v = on ? m.at(t) : { y: m.d.trace[TRACE_N], raw: 0 };
    const disp = v.y * 0.24;
    const rest = 0.72;
    this.mass.position.y = rest + disp;
    const len = rest + disp - 0.085 - 0.07;
    this.coil.scale.y = Math.max(0.05, len);
    const blown = !m.d.stable && Math.abs(v.raw) > 1.05;
    const glow = blown ? Math.min(1.6, (Math.abs(v.raw) - 1.05) * 1.2 + 0.5) : 0;
    this.coilMat.emissiveIntensity += (glow - this.coilMat.emissiveIntensity) * Math.min(1, dt * 8 || 1);
    // playhead on the track
    const L = T.len;
    this.playhead.visible = on;
    this.playhead.position.set((Math.min(t, TRACK_SECONDS) / TRACK_SECONDS) * L, 0.0, 0.012);
    const stick = this.playhead.children[0];
    stick.scale.y = this.trackYc + T.amp * LIMIT + 0.05;
    const dot = this.playhead.getObjectByName("dot")!;
    dot.position.y = this.trackYc + v.y * T.amp;
    // dial needle: size of the twin
    const target = (0.75 + Math.min(1.6, m.d.zMax)) * Math.PI;
    this.needleA += (target - this.needleA) * Math.min(1, dt * 10 || 1);
    // the face is drawn clockwise in canvas space (y down); the needle points along local +y
    this.needle.rotation.z = -(this.needleA + Math.PI / 2);
    this.anchorPts.spring = this.mass.localToWorld(new THREE.Vector3(0.15, 0.05, 0)).toArray() as V3;
  }

  // ───────────────────────── picking + labels ─────────────────────────

  project(p: V3): Anchor {
    const v = new THREE.Vector3(...p).project(this.camera);
    const on = v.z < 1 && v.z > -1;
    return { x: ((v.x + 1) / 2) * this.W, y: ((1 - v.y) / 2) * this.H, on };
  }

  onPlane(x: number, y: number, h: number): [number, number] | null {
    const ndc = new THREE.Vector2((x / this.W) * 2 - 1, -(y / this.H) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -h);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.z];
  }

  anchors(): Anchors {
    const g = this.bench.geo;
    const pts: Record<string, V3 | null> = {
      plate: [...pl(plateXZ(g, -3.2, g.wMax * 0.98), 0.25)],
      disc: [g.discX - this.bench.Rd * 0.55, 0.25, g.discZ - this.bench.Rd * 0.85],
      axis: [...pl(plateXZ(g, 0, g.wMax * 0.9), 0.26)],
      circle: [...pl(discXZ(g, cexp(cx(0, -0.75))), 0.26)],
      ...this.anchorPts,
    };
    const out: Anchors = {};
    for (const [k, p] of Object.entries(pts)) out[k] = p ? this.project(p) : undefined;
    return out;
  }

  dispose(): void {
    this.controls.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

function pl([x, z]: [number, number], y: number): V3 {
  return [x, y, z];
}
function smooth01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
