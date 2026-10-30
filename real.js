/* Fitroom realistic rendering.
   1) Realistic 3D room: replaces the flat-shaded 3D view with physically based materials,
      soft daylight shadows and ambient occlusion. Camera and dragging still come from G3 in index.html.
   2) "In my photo": the user's own room photo, the floor lined up with 4 dots, and the same
      true-size furniture rendered into it with matching perspective and shadows.
   Furniture is modeled from each product's real width and depth (and typical height for its category).
   Shapes are lifelike stand-ins, not scans of the exact product. Credits: see CREDITS.md. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { solveFloor, projectFloor } from './photosolve.js';

const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
const DPR = () => Math.min(window.devicePixelRatio || 1, MOBILE ? 1.5 : 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ---------------- random + noise ---------------- */
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function noise2(seed) {
  const N = 256, r = rng(seed), P = new Float32Array(N * N); for (let i = 0; i < N * N; i++) P[i] = r();
  const m = (a, p) => ((a % p) + p) % p;
  return (x, y, px = N, py = N) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const g = (i, j) => P[(m(j, py) % N) * N + (m(i, px) % N)];
    return g(xi, yi) * (1 - u) * (1 - v) + g(xi + 1, yi) * u * (1 - v) + g(xi, yi + 1) * (1 - u) * v + g(xi + 1, yi + 1) * u * v;
  };
}
function fbm(n, x, y, oct, px = 256, py = 256) { let s = 0, a = .5, t = 0; for (let i = 0; i < oct; i++) { s += a * n(x, y, px, py); t += a; x *= 2; y *= 2; px *= 2; py *= 2; a *= .5; } return s / t; }

/* ---------------- color helpers ---------------- */
const col = h => new THREE.Color(h);
function mixHex(a, b, t) { return '#' + col(a).lerp(col(b), t).getHexString(); }
function shadeHex(h, amt) { return amt >= 0 ? mixHex(h, '#ffffff', amt) : mixHex(h, '#000000', -amt); }
const s2l = v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);

/* ---------------- procedural textures ---------------- */
const TEX = {};
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function finishTex(c, srgb = true, rep = [1, 1]) {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t;
}
/* grayscale multiplier textures; userData.avg = mean linear value so tints keep their true color */
function grayTex(key, S, fn, srgb = true) {
  if (TEX[key]) return TEX[key];
  const c = canvasOf(S, S), x = c.getContext('2d'), im = x.createImageData(S, S), D = im.data; let sum = 0;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const v = clamp(fn(i, j), 0, 1), k = (j * S + i) * 4, b = Math.round(v * 255); D[k] = D[k + 1] = D[k + 2] = b; D[k + 3] = 255; sum += srgb ? s2l(v) : v; }
  x.putImageData(im, 0, 0); const t = finishTex(c, srgb); t.userData.avg = sum / (S * S); return (TEX[key] = t);
}
function woodTex() {
  const n = noise2(11), n2 = noise2(12), S = MOBILE ? 256 : 512;
  return grayTex('wood', S, (i, j) => {
    const s = fbm(n, i / S * 6, j / S * 40, 4, 6, 40);
    const ring = Math.sin((j / S * 22 + s * 3.4) * Math.PI * 2);
    const pore = n2(i / S * 120, j / S * 400, 120, 400);
    return .80 + .13 * (s - .5) * 2 * .7 + .05 * (ring * .5 + .5) - .06 * Math.pow(pore, 6) + .02;
  });
}
function weaveTex() {
  const n = noise2(21), S = 256;
  return grayTex('weave', S, (i, j) => {
    const warp = ((i >> 2) + (j >> 2)) & 1, a = warp ? (i % 4 + .5) / 4 : (j % 4 + .5) / 4;
    const prof = Math.sin(a * Math.PI), slub = fbm(n, i / S * 8, j / S * 64, 3, 8, 64);
    return .80 + .12 * prof + .08 * (slub - .5) * 2;
  });
}
function grainTex() { const n = noise2(31), S = 256; return grayTex('grain', S, (i, j) => .85 + .15 * fbm(n, i / S * 32, j / S * 32, 3, 32, 32)); }
function pileTex() { const n = noise2(41), r = rng(7), S = 256; return grayTex('pile', S, (i, j) => .78 + .14 * fbm(n, i / S * 64, j / S * 64, 2, 64, 64) + .08 * r()); }
function blobTex() {
  if (TEX.blob) return TEX.blob; const S = 128, c = canvasOf(S, S), x = c.getContext('2d'), im = x.createImageData(S, S), D = im.data;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = Math.abs(i / (S - 1) * 2 - 1), v = Math.abs(j / (S - 1) * 2 - 1), q = Math.pow(Math.pow(u, 4) + Math.pow(v, 4), .25);
    const a = clamp(1 - (q - .62) / .38, 0, 1), k = (j * S + i) * 4; D[k] = D[k + 1] = D[k + 2] = Math.round(255 * a * a); D[k + 3] = 255;
  }
  x.putImageData(im, 0, 0); const t = finishTex(c, false); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return (TEX.blob = t);
}
/* oak planks or concrete, drawn in the floor's real color; tiles seamlessly */
function floorTex(hex, concrete) {
  const key = 'floor' + hex + (concrete ? 'c' : ''); if (TEX[key]) return TEX[key];
  const S = MOBILE ? 1024 : 2048, c = canvasOf(S, S), x = c.getContext('2d'), im = x.createImageData(S, S), D = im.data;
  const b = col(hex), br = b.r, bg = b.g, bb = b.b; /* sRGB components (Color stores linear; convert back) */
  const lr = Math.pow(br, 1 / 2.2), lg = Math.pow(bg, 1 / 2.2), lb = Math.pow(bb, 1 / 2.2);
  const rr = rng(hashStr(key)), n = noise2(51), n2 = noise2(52);
  if (concrete) {
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const v = .92 + .12 * (fbm(n, i / S * 6, j / S * 6, 5, 6, 6) - .5) * 2 + .05 * (n2(i / S * 180, j / S * 180, 180, 180) - .5) - (i < 2 || j < 2 ? .12 : 0);
      const k = (j * S + i) * 4; D[k] = clamp(lr * v, 0, 1) * 255; D[k + 1] = clamp(lg * v, 0, 1) * 255; D[k + 2] = clamp(lb * v, 0, 1) * 255; D[k + 3] = 255;
    }
  } else {
    const P = 8, pw = S / P, cols = [];
    for (let i = 0; i < P; i++) { const k = [1, 2, 2, 3][Math.floor(rr() * 4)]; cols.push({ seg: S / k, off: Math.floor(rr() * S), tints: Array.from({ length: k }, () => [rr() * 2 - 1, rr() * 2 - 1]) }); }
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const ci = Math.floor(i / pw), lx = i - ci * pw, C = cols[ci], yy = (j + C.off) % S, bi = Math.floor(yy / C.seg), ly = yy - bi * C.seg, T = C.tints[bi];
      const s = fbm(n, ly / 260 + bi * 3.1, lx / 9 + ci * 7.7, 4);
      const ring = Math.sin((lx / pw * 3 + s * 4 + ci) * Math.PI * 2);
      let v = .95 + .045 * T[0] + .07 * (s - .5) * 2 + .02 * ring - .05 * Math.pow(n2(ly / 2.5, lx / 1.2), 8);
      if (lx < 1.4 || ly < 1.6) v *= .58; else if (lx < 3 || lx > pw - 2 || ly < 3) v *= .94;
      const hue = .02 * T[1], k = (j * S + i) * 4;
      D[k] = clamp(lr * v * (1 + hue), 0, 1) * 255; D[k + 1] = clamp(lg * v, 0, 1) * 255; D[k + 2] = clamp(lb * v * (1 - hue), 0, 1) * 255; D[k + 3] = 255;
    }
  }
  x.putImageData(im, 0, 0); const t = finishTex(c, true); t.userData.span = concrete ? [96, 96] : [44, 176]; return (TEX[key] = t);
}
/* rug pattern per style, in the rug's real palette */
function rugTex(style, pal, base, w, d, seed) {
  const key = ['rug', style, base, Math.round(w), Math.round(d), seed].join(); if (TEX[key]) return TEX[key];
  const W = 1024, H = clamp(Math.round(W * d / w), 256, 2048), c = canvasOf(W, H), x = c.getContext('2d'), r = rng(seed);
  const acc = pal.accent, dark = pal.dark, soft = pal.soft, cream = mixHex(base, '#f4efe6', .55);
  x.fillStyle = base; x.fillRect(0, 0, W, H);
  const band = (inset, wdt, color) => { x.strokeStyle = color; x.lineWidth = wdt; x.strokeRect(inset, inset, W - 2 * inset, H - 2 * inset); };
  if (style === 'plain') { }
  else if (style === 'japandi') { band(W * .06, W * .012, shadeHex(base, -.10)); band(W * .085, W * .004, shadeHex(base, -.06)); }
  else if (style === 'coastal') {
    const n = 7 + Math.floor(r() * 4), sw = H / n;
    for (let i = 0; i < n; i++) if (i % 2) { x.fillStyle = i % 4 === 1 ? acc : mixHex(acc, cream, .5); x.fillRect(0, i * sw + sw * .2, W, sw * .6); }
  } else if (style === 'midcentury') {
    const cs = W / 9; x.lineWidth = cs * .09;
    for (let j = -1; j * cs < H + cs; j++) for (let i = -1; i < 10; i++) {
      const cx = i * cs + (j % 2 ? cs / 2 : 0), cy = j * cs * .9;
      x.strokeStyle = (i + j) % 3 === 0 ? acc : (i + j) % 3 === 1 ? dark : cream; x.beginPath(); x.arc(cx, cy, cs * .38, 0, Math.PI); x.stroke();
    }
    band(W * .03, W * .03, dark);
  } else if (style === 'boho') {
    const rows = Math.max(4, Math.round(H / 150)), rh = H / rows, colsR = [acc, dark, cream, soft, shadeHex(acc, -.2)];
    for (let k = 0; k < rows; k++) {
      const y0 = k * rh, cc = colsR[k % colsR.length], n = 6 + (k % 3) * 2, tw = W / n;
      x.fillStyle = cc;
      for (let i = 0; i < n; i++) {
        x.beginPath(); x.moveTo(i * tw, y0 + rh * .5); x.lineTo(i * tw + tw / 2, y0 + rh * .15); x.lineTo(i * tw + tw, y0 + rh * .5); x.lineTo(i * tw + tw / 2, y0 + rh * .85); x.closePath(); x.fill();
      }
      x.fillStyle = colsR[(k + 2) % colsR.length]; x.fillRect(0, y0 + rh * .48, W, rh * .04);
    }
    band(W * .02, W * .035, dark);
  } else if (style === 'industrial') {
    const red = mixHex(base, '#5d4a3e', .35), navy = mixHex(dark, base, .25);
    x.fillStyle = red; x.fillRect(0, 0, W, H); band(W * .05, W * .06, navy); band(W * .11, W * .015, cream);
    x.fillStyle = navy; x.beginPath(); x.ellipse(W / 2, H / 2, W * .2, H * .2, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = cream; x.lineWidth = W * .01; x.beginPath(); x.ellipse(W / 2, H / 2, W * .14, H * .14, 0, 0, Math.PI * 2); x.stroke();
    for (let i = 0; i < 4; i++) { x.fillStyle = navy; x.beginPath(); x.ellipse(i % 2 ? W * .8 : W * .2, i < 2 ? H * .22 : H * .78, W * .06, H * .06, 0, 0, Math.PI * 2); x.fill(); }
  }
  const im = x.getImageData(0, 0, W, H), D = im.data, n = noise2(seed + 3), worn = style === 'industrial';
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = (j * W + i) * 4; let v = .9 + .1 * n(i / 3, j / 3);
    if (worn) { const wv = fbm(n, i / W * 5, j / H * 5, 4); if (wv > .6) { const m = (wv - .6) * 1.3; D[k] += (225 - D[k]) * m; D[k + 1] += (210 - D[k + 1]) * m; D[k + 2] += (190 - D[k + 2]) * m; } }
    D[k] *= v; D[k + 1] *= v; D[k + 2] *= v;
  }
  x.putImageData(im, 0, 0); return (TEX[key] = finishTex(c, true));
}
function skyTex() {
  if (TEX.sky) return TEX.sky; const c = canvasOf(16, 256), x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#9fc3e0'); g.addColorStop(.6, '#dbe9f2'); g.addColorStop(.75, '#c9d6c2'); g.addColorStop(1, '#a7b59b');
  x.fillStyle = g; x.fillRect(0, 0, 16, 256); const t = finishTex(c, true); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return (TEX.sky = t);
}

/* ---------------- materials (cached) ---------------- */
const MAT = {};
function M(key, make) { return MAT[key] || (MAT[key] = make()); }
function tinted(hex, tex) { const c = col(hex); if (tex && tex.userData.avg) c.multiplyScalar(clamp(.82 / tex.userData.avg, 1, 2.2)); return c; }
const matFabric = hex => M('fab' + hex, () => {
  const t = weaveTex(); const m = new THREE.MeshPhysicalMaterial({
    color: tinted(hex, t), map: t, roughness: .92, metalness: 0, bumpMap: t, bumpScale: .9,
    sheen: 1, sheenRoughness: .55, sheenColor: col(mixHex(hex, '#ffffff', .35))
  }); m.map.repeat.set(4, 4); return m;
});
const matLeather = hex => M('lea' + hex, () => { const t = grainTex(); return new THREE.MeshPhysicalMaterial({ color: tinted(hex, t), map: t, bumpMap: t, bumpScale: .6, roughness: .48, clearcoat: .25, clearcoatRoughness: .5 }); });
const matWood = hex => M('wood' + hex, () => { const t = woodTex(); return new THREE.MeshPhysicalMaterial({ color: tinted(hex, t), map: t, bumpMap: t, bumpScale: .25, roughness: .5, clearcoat: .18, clearcoatRoughness: .35 }); });
const matPaint = hex => M('paint' + hex, () => new THREE.MeshPhysicalMaterial({ color: col(hex), roughness: .42, clearcoat: .2, clearcoatRoughness: .4 }));
const matMatte = hex => M('matte' + hex, () => new THREE.MeshStandardMaterial({ color: col(hex), roughness: .9 }));
const matMetal = hex => M('metal' + hex, () => new THREE.MeshStandardMaterial({ color: col(hex), roughness: .32, metalness: 1 }));
const matCeramic = hex => M('cer' + hex, () => new THREE.MeshPhysicalMaterial({ color: col(hex), roughness: .35, clearcoat: .6, clearcoatRoughness: .2 }));
const matLinen = hex => M('lin' + hex, () => { const t = weaveTex(); const m = new THREE.MeshPhysicalMaterial({ color: tinted(hex, t), map: t, roughness: .95, bumpMap: t, bumpScale: .6, sheen: .6, sheenRoughness: .7, sheenColor: col('#ffffff') }); return m; });
const matGlass = hex => M('glass' + hex, () => new THREE.MeshPhysicalMaterial({ color: col(hex), roughness: .06, metalness: 0, transparent: true, opacity: .35, clearcoat: 1, depthWrite: false }));
const matScreen = () => M('screen', () => new THREE.MeshPhysicalMaterial({ color: col('#07090c'), roughness: .12, clearcoat: 1, clearcoatRoughness: .05 }));
const matShade = hex => M('shade' + hex, () => new THREE.MeshStandardMaterial({ color: col(hex), roughness: .95, side: THREE.DoubleSide, emissive: col('#ffd9a3'), emissiveIntensity: .55 }));
const matLeaf = hex => M('leaf' + hex, () => new THREE.MeshStandardMaterial({ color: col(hex), roughness: .6, side: THREE.DoubleSide }));
/* top-down product photo -> rug texture (white margins trimmed) */
const matRugPhoto = src => M('rugph' + src, () => {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, bumpMap: pileTex(), bumpScale: 1.2 });
  const im = new Image(); im.onload = () => {
    const c = canvasOf(im.naturalWidth, im.naturalHeight), x = c.getContext('2d'); x.drawImage(im, 0, 0); const D = x.getImageData(0, 0, c.width, c.height).data;
    const bg = i => D[i] > 238 && D[i + 1] > 238 && D[i + 2] > 238; let t = 0, b = c.height - 1, l = 0, r = c.width - 1;
    const rowBg = y => { let n = 0; for (let i = 0; i < c.width; i += 4) n += bg((y * c.width + i) * 4) ? 1 : 0; return n > c.width / 4 * .9; };
    const colBg = xx => { let n = 0; for (let j = 0; j < c.height; j += 4) n += bg((j * c.width + xx) * 4) ? 1 : 0; return n > c.height / 4 * .9; };
    while (t < b && rowBg(t)) t++; while (b > t && rowBg(b)) b--; while (l < r && colBg(l)) l++; while (r > l && colBg(r)) r--;
    const o = canvasOf(r - l + 1, b - t + 1); o.getContext('2d').drawImage(c, l, t, o.width, o.height, 0, 0, o.width, o.height);
    m.map = finishTex(o, true); m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping; m.needsUpdate = true; listeners.forEach(f => f());
  }; im.src = src; return m;
});
const matRug = (style, pal, base, w, d, seed) => M(['rug', style, base, Math.round(w), Math.round(d), seed].join(), () => {
  const p = pileTex(); const m = new THREE.MeshStandardMaterial({ map: rugTex(style, pal, base, w, d, seed), roughness: 1, bumpMap: p, bumpScale: 1.2 });
  return m;
});

/* ---------------- geometry ---------------- */
const GEO = {};
function rbox(w, h, d, r, seg = 3) {
  const key = ['rb', w.toFixed(2), h.toFixed(2), d.toFixed(2), r.toFixed(2), seg].join();
  return GEO[key] || (GEO[key] = new RoundedBoxGeometry(w, h, d, seg, Math.max(.01, Math.min(r, w / 2 - .01, h / 2 - .01, d / 2 - .01))));
}
/* soft cushion: rounded box whose faces along `axis` bulge outward */
function cushion(w, h, d, r, amt, axis = 'y', both = false) {
  const key = ['cu', w.toFixed(2), h.toFixed(2), d.toFixed(2), r.toFixed(2), amt.toFixed(2), axis, both].join(); if (GEO[key]) return GEO[key];
  const g = new RoundedBoxGeometry(w, h, d, 5, Math.max(.01, Math.min(r, w / 2 - .01, h / 2 - .01, d / 2 - .01)));
  const P = g.attributes.position, N = g.attributes.normal, ax = { x: 0, y: 1, z: 2 }[axis], o = [0, 1, 2].filter(i => i !== ax), half = [w / 2, h / 2, d / 2];
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); n.fromBufferAttribute(N, i);
    const s = v.getComponent(ax) >= 0 ? 1 : -1; if (s < 0 && !both) continue;
    const ns = n.getComponent(ax) * s; if (ns <= .05) continue;
    const a = v.getComponent(o[0]) / half[o[0]], b = v.getComponent(o[1]) / half[o[1]];
    const fa = Math.max(0, 1 - a * a), fb = Math.max(0, 1 - b * b), bump = amt * fa * fb * ns;
    v.setComponent(ax, v.getComponent(ax) + s * bump);
    const ga = amt * (-2 * a / half[o[0]]) * fb * ns, gb = amt * (-2 * b / half[o[1]]) * fa * ns;
    n.setComponent(o[0], n.getComponent(o[0]) - s * ga * .9); n.setComponent(o[1], n.getComponent(o[1]) - s * gb * .9); n.normalize();
    P.setXYZ(i, v.x, v.y, v.z); N.setXYZ(i, n.x, n.y, n.z);
  }
  P.needsUpdate = N.needsUpdate = true; g.computeBoundingBox(); g.computeBoundingSphere(); return (GEO[key] = g);
}
function lathe(key, pts, seg = 40) { return GEO[key] || (GEO[key] = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg)); }
function cyl(rt, rb, h, seg = 24) { const k = ['cy', rt.toFixed(2), rb.toFixed(2), h.toFixed(2), seg].join(); return GEO[k] || (GEO[k] = new THREE.CylinderGeometry(rt, rb, h, seg)); }

/* ---------------- loaded models ---------------- */
const GLB = {};
const loader = new GLTFLoader();
const listeners = new Set();
function loadModel(name, url, prep) {
  if (GLB[name]) return; GLB[name] = { status: 'loading' };
  loader.load(url, g => {
    const root = g.scene; prep(root);
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const bb = new THREE.Box3().setFromObject(root), size = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
    const wrap = new THREE.Group(); root.position.set(-ctr.x, -bb.min.y, -ctr.z); wrap.add(root);
    GLB[name] = { status: 'ok', scene: wrap, size }; listeners.forEach(f => f());
  }, undefined, e => { GLB[name] = { status: 'fail' }; console.warn('Fitroom model', name, e); });
}
function prepPlant(root) {
  const drop = []; root.traverse(o => { const nm = (o.name || '').toLowerCase(), mn = o.material && (o.material.name || '').toLowerCase();
    if (nm.includes('firefly') || nm.includes('path') || mn === 'wings') drop.push(o); });
  drop.forEach(o => o.parent && o.parent.remove(o));
}
function prepChair(root) { root.traverse(o => { if (o.isMesh && /label/i.test(o.name)) o.visible = false; }); }

/* ---------------- furniture ---------------- */
const LEGKIND = { japandi: 'block', midcentury: 'taper', coastal: 'turned', industrial: 'metal', boho: 'taper' };
const HW = { japandi: null, midcentury: '#B08A4A', coastal: '#C9C4BA', industrial: '#2A2B2D', boho: '#A9824A' };
function legMat(style, pal) { return style === 'industrial' ? matMetal('#2b2c2e') : matWood(pal.wood); }

function kit(group) {
  const add = (geo, mat, x, y, z, o = {}) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
    if (o.rx) m.rotation.x = o.rx; if (o.ry) m.rotation.y = o.ry; if (o.rz) m.rotation.z = o.rz;
    m.castShadow = o.cast !== false; m.receiveShadow = true; group.add(m); return m;
  };
  const box = (w, h, d, r, mat, x, y, z, o) => add(rbox(w, h, d, r, o && o.seg), mat, x, y + h / 2, z, o);
  return { add, box };
}
function legs(K, w, d, h, ins, kind, mat) {
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    const x = a * (w / 2 - ins), z = b * (d / 2 - ins);
    if (kind === 'taper') K.add(cyl(.85, .5, h, 16), mat, x + a * .25, h / 2, z + b * .25, { rz: -a * .05, rx: b * .05 });
    else if (kind === 'turned') K.add(lathe('turned' + h.toFixed(1), [[0, 0], [.55, 0], [.6, h * .15], [.75, h * .2], [.5, h * .35], [.6, h * .7], [.8, h * .85], [.8, h], [0, h]], 16), mat, x, 0, z);
    else if (kind === 'metal') K.box(.9, h, .9, .1, mat, x, 0, z);
    else K.box(1.7, h, 1.7, .25, mat, x, 0, z);
  }
}
function books(K, x0, y, z, maxW, maxH, depth, r, colors) {
  let x = x0; const end = x0 + maxW;
  while (x < end - 1.2) {
    if (r() < .14) { x += 2 + r() * 4; continue; }
    const bw = .8 + r() * 1.4, bh = Math.min(maxH, maxH * (.62 + r() * .38)), bd = depth * (.72 + r() * .2);
    if (x + bw > end) break;
    const c = colors[Math.floor(r() * colors.length)];
    K.box(bw, bh, bd, .08, matPaint(c), x + bw / 2, y, z, { cast: false, seg: 1 }); x += bw + .05;
  }
}
const BOOKC = ['#7A2E2B', '#2F4858', '#C9A227', '#5B7553', '#E8E1D3', '#33302D', '#8A5A3B', '#9DB4C0', '#B35A36', '#D8CFC0'];
function vase(K, x, y, z, s, hex) { K.add(lathe('vase', [[0, 0], [2, 0], [2.4, .6], [2.7, 2.6], [2.3, 5], [1.2, 6.6], [1, 7.6], [1.3, 8.2], [1.15, 8.2], [.9, 7.6], [0, 7.6]], 40), matCeramic(hex), x, y, z).scale.setScalar(s); }
function bowl(K, x, y, z, s, hex) { K.add(lathe('bowl', [[0, 0], [1.6, 0], [3.2, .9], [4, 2.4], [3.85, 2.4], [3.05, 1.05], [0, .3]], 40), matCeramic(hex), x, y, z).scale.setScalar(s); }

function sofaLike(K, c, single) {
  const { w, d, pal, base, style } = c, H = single ? HGT.armchair : HGT.sofa;
  const lea = c.leather, fab = lea ? matLeather(base) : matFabric(base), fabD = lea ? matLeather(shadeHex(base, -.12)) : matFabric(shadeHex(base, -.07));
  const lh = { japandi: 3.5, midcentury: 6.5, coastal: 4.5, industrial: 5.5, boho: 5 }[style];
  legs(K, w, d, lh, 3, LEGKIND[style], legMat(style, pal));
  const aw = single ? clamp(w * .15, 3.5, 6) : clamp(w * .075, 3.5, 6.5), armTop = lh + (single ? 20 : 19.5), ih = w - 2 * aw, baseH = 7.5;
  K.box(w - .3, baseH, d - .3, 1.3, fabD, 0, lh, 0);
  for (const s of [-1, 1]) K.add(cushion(aw, armTop - lh, d, 1.9, .45, 'y'), fab, s * (w / 2 - aw / 2), lh + (armTop - lh) / 2, 0);
  const backD = 6.5; K.box(ih + .3, H - lh - 1.5, backD, 1.8, fabD, 0, lh, -d / 2 + backD / 2);
  const n = single ? 1 : Math.max(2, Math.round(ih / 30)), cw = ih / n, seatY = lh + baseH, seatH = 5.5, seatD = d - backD - .8;
  const bh = H + 1.5 - (seatY + seatH);
  for (let i = 0; i < n; i++) {
    const x = -ih / 2 + cw * (i + .5);
    K.add(cushion(cw - .5, seatH, seatD, 1.7, 1.25, 'y'), fab, x, seatY + seatH / 2, -d / 2 + backD + seatD / 2 + .3);
    K.add(cushion(cw - .7, bh, 6, 1.7, 1.1, 'z'), fab, x, seatY + seatH + bh / 2 - .4, -d / 2 + backD + 2.6, { rx: -.13 });
  }
  if (!single) {
    const pc = [pal.accent, pal.soft], spots = n >= 3 ? [-1, 1] : [-1];
    spots.forEach((s, i) => K.add(cushion(16, 4.5, 16, 2.2, 1.9, 'y', true), matFabric(pc[i % 2]), s * (ih / 2 - 9.5), seatY + seatH + 8.5, -d / 2 + backD + 6.3, { rx: Math.PI / 2 - .32, rz: s * .12 }));
  }
}
function armchairGLB(K, c, group) {
  const G = GLB.chair; if (!G || G.status !== 'ok') return false;
  const m = G.scene.clone(true), sz = G.size, sx = c.w / (sz.x * 39.37), sz2 = c.d / (sz.z * 39.37), sy = (sx + sz2) / 2;
  m.scale.set(sx * 39.37, sy * 39.37, sz2 * 39.37);
  const hex = c.base;
  m.traverse(o => {
    if (!o.isMesh) return;
    if (/fabric/i.test(o.material.name || o.name)) {
      o.material = MAT['chairfab' + hex] || (MAT['chairfab' + hex] = (() => { const t = o.material.clone(); t.map = null; t.sheenColorMap = null; t.color = col(hex); t.sheen = .6; t.sheenColor = col(mixHex(hex, '#ffffff', .12)); return t; })());
    }
    if (/wood/i.test(o.material.name || o.name) && c.style === 'industrial') o.material = matMetal('#2b2c2e');
  });
  group.add(m); return true;
}
function diningChair(K, c) {
  const { w, d, pal, base, style } = c, wood = legMat(style, pal), seat = 18;
  legs(K, w, d, seat - 2.2, 1.5, LEGKIND[style], wood);
  K.box(w, 2.2, d, .4, style === 'industrial' ? matMetal('#2b2c2e') : matWood(pal.wood), 0, seat - 2.2, 0);
  const seatM = c.leather ? matLeather(base) : base === pal.wood ? matWood(base) : matFabric(base);
  K.add(cushion(w - 1, 2.3, d - 1.2, .9, base === pal.wood ? .15 : .55, 'y'), seatM, 0, seat + 1.15, .4);
  for (const s of [-1, 1]) K.box(1.2, 14.5, 1.2, .2, wood, s * (w / 2 - 1.5), seat, -d / 2 + 1.4, { rx: -.07 });
  K.add(cushion(w - 1.4, 6.5, 1.8, .8, .35, 'z'), style === 'japandi' || base === pal.wood ? matWood(pal.wood) : seatM, 0, seat + 10.5, -d / 2 + .9, { rx: -.08 });
}
function bed(K, c) {
  const { w, d, pal, base, style } = c, wood = matWood(c.isWood ? base : pal.wood), up = matFabric(base), frame = c.isWood ? wood : up;
  legs(K, w - 4, d - 4, 4, 2, LEGKIND[style], legMat(style, pal));
  K.box(w, 9, d, 1, frame, 0, 4, 0);
  const hb = 44 - 4; K.box(w, hb, 3.4, 1.2, frame, 0, 4, -d / 2 + 1.7);
  if (!c.isWood) { const n = Math.max(4, Math.round(w / 9)), cw = (w - 2) / n; for (let i = 0; i < n; i++) K.add(cushion(cw - .3, hb - 14, 1.6, .7, .5, 'z'), up, -w / 2 + 1 + cw * (i + .5), 4 + 14 + (hb - 14) / 2 - 1, -d / 2 + 3.6); }
  const white = matLinen('#F4F1EA'); K.box(w - 1.6, 9, d - 4.5, 2.5, white, 0, 13, 1.6);
  const duv = mixHex(pal.soft, '#ffffff', .35), dv = d * .66, z0 = d / 2 - dv / 2 + .4;
  K.add(cushion(w + .4, 2.6, dv, 1.2, 1.1, 'y'), matLinen(duv), 0, 22 + 1.3, z0);
  for (const s of [-1, 1]) K.box(1, 10, dv, .5, matLinen(duv), s * (w / 2 + .1), 13.5, z0);
  K.box(w + .4, 10, 1, .5, matLinen(duv), 0, 13.5, d / 2 + .4);
  K.add(cushion(w + 1, 1.6, 15, .8, .4, 'y'), matFabric(pal.accent), 0, 25, d / 2 - 9);
  const two = w >= 54, pw = two ? w * .4 : w * .64;
  for (const x of two ? [-w * .23, w * .23] : [0]) K.add(cushion(pw, 6, 14, 2.4, 1.6, 'y', true), white, x, 25.5, -d / 2 + 11.5, { rx: -.5 });
  K.add(cushion(16, 4.5, 16, 2, 1.7, 'y', true), matFabric(pal.accent), 0, 29, -d / 2 + 16, { rx: Math.PI / 2 - .35 });
}
function table(K, c, cat, r) {
  const { w, d, pal, base, style, p } = c, h = HGT[cat], tp = cat === 'dtable' ? 1.6 : 1.4, top = c.isWood ? matWood(base) : matPaint(base), lm = c.isWood || style !== 'industrial' ? (c.isWood ? matWood(base) : legMat(style, pal)) : legMat(style, pal);
  const round = p.tag === 'round';
  if (round) {
    const g = lathe('rtop' + tp, [[0, 0], [.5 - .02, 0], [.5, tp * .3], [.5, tp * .7], [.5 - .02, tp], [0, tp]], 64);
    K.add(g, top, 0, h - tp, 0).scale.set(w, 1, d);
    if (cat === 'dtable') { K.add(cyl(2, 3, h - tp - 1, 32), lm, 0, (h - tp) / 2, 0); K.add(cyl(Math.min(w, d) * .22, Math.min(w, d) * .24, 1.2, 48), lm, 0, .6, 0); }
    else legs(K, w * .62, d * .62, h - tp, 0, LEGKIND[style], lm);
  } else {
    K.box(w, tp, d, .35, top, 0, h - tp, 0, { seg: 2 });
    legs(K, w, d, h - tp, Math.min(3, Math.min(w, d) * .12), LEGKIND[style], lm);
    if (cat !== 'dtable') K.box(w - 4, .9, d - 4, .2, c.isWood ? matWood(shadeHex(base, -.06)) : matPaint(shadeHex(base, -.04)), 0, Math.min(5, h * .3), 0);
    if (cat === 'dtable') { K.box(w - 6, 3, 1.2, .2, top, 0, h - tp - 3, -d / 2 + 3); K.box(w - 6, 3, 1.2, .2, top, 0, h - tp - 3, d / 2 - 3); }
  }
  if (cat === 'coffee') {
    for (let i = 0; i < 2; i++) K.box(9 - i, 1.1, 7 - i * .5, .1, matPaint([pal.dark, pal.soft][i]), w * .16, h + i * 1.1, d * .08, { ry: .15 - i * .25, seg: 1 });
    vase(K, -w * .2, h, -d * .05, .9, pal.accent); bowl(K, w * .17, h + 2.2, d * .08, .55, mixHex(pal.soft, '#ffffff', .4));
  }
  if (cat === 'side') vase(K, 0, h, 0, .8, pal.accent);
  if (cat === 'dtable') { bowl(K, 0, h, 0, 1.4, mixHex(pal.soft, '#ffffff', .3)); vase(K, Math.min(w, d) * .22, h, 0, 1, pal.accent); }
}
function cabinet(K, c, h, rows, cols, feet) {
  const { w, d, pal, base, style } = c, isWood = c.isWood, body = isWood ? matWood(base) : matPaint(base);
  const front = isWood ? matWood(shadeHex(base, .05)) : matPaint(shadeHex(base, .05)), hw = HW[style];
  if (feet > 0) legs(K, w, d, feet, 2, LEGKIND[style], legMat(style, pal));
  K.box(w, h - feet, d, .4, body, 0, feet, 0);
  const fh = (h - feet - 1.6) / rows, fw = (w - 1.6) / cols;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const x = -w / 2 + .8 + fw * (j + .5), y = feet + .8 + fh * i;
    K.box(fw - .35, fh - .35, .7, .25, front, x, y + .175, d / 2, { seg: 2 });
    if (hw) K.box(Math.min(5, fw * .3), .5, .7, .2, matMetal(hw), x, y + fh / 2 - .25, d / 2 + .7, { cast: false, seg: 1 });
    else K.box(Math.min(6, fw * .4), .35, .3, .1, matMatte('#1d1b19'), x, y + fh - .9, d / 2 + .36, { cast: false, seg: 1 });
  }
}
function shelf(K, c, r) {
  const { w, d, pal, base } = c, h = HGT.shelf, n = Math.max(3, Math.round(h / 15)), wood = c.isWood ? matWood(base) : matPaint(base);
  for (const s of [-1, 1]) K.box(1, h, d, .2, wood, s * (w / 2 - .5), 0, 0, { seg: 1 });
  K.box(w - 2, h - 1, .5, .1, c.isWood ? matWood(shadeHex(base, -.12)) : matPaint(shadeHex(base, -.05)), 0, 0, -d / 2 + .25, { seg: 1 });
  const colors = [...BOOKC, pal.accent, pal.dark];
  for (let i = 0; i <= n; i++) {
    const y = i * (h - 1) / n; K.box(w - 2, 1, d, .1, wood, 0, y, 0, { seg: 1 }); if (i === n) break;
    const room = (h - 1) / n - 1.5;
    if (r() < .25) { vase(K, (r() - .5) * (w - 12), y + 1, 0, .85, r() < .5 ? pal.accent : pal.soft); books(K, -w / 2 + 1.5, y + 1, 0, (w - 3) * .45, Math.min(room, 10), d - 1, r, colors); }
    else books(K, -w / 2 + 1.5, y + 1, 0, w - 3, Math.min(room, 10.5), d - 1, r, colors);
  }
}
function lamp(K, c, group, withLight) {
  const { w, d, pal, style } = c, m = Math.min(w, d), metal = style === 'industrial' ? matMetal('#2b2c2e') : style === 'japandi' || style === 'coastal' ? matMetal('#c9c4ba') : matMetal('#B08A4A');
  const shadeHexC = style === 'industrial' ? '#2b2c2e' : '#F3EBDC', H = HGT.lamp;
  if (style === 'midcentury' || style === 'boho') {
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; const L = K.add(cyl(.45, .55, H - 12, 12), matWood(pal.wood), Math.cos(a) * m * .2, (H - 12) / 2, Math.sin(a) * m * .2); L.rotation.set(Math.sin(a) * .12, 0, -Math.cos(a) * .12); }
  } else { K.add(cyl(m * .28, m * .3, .9, 40), metal, 0, .45, 0); K.add(cyl(.4, .4, H - 13, 12), metal, 0, (H - 13) / 2 + .9, 0); }
  const sh = style === 'industrial'
    ? K.add(lathe('domeshade', [[1, 12], [2.6, 11], [6, 6.5], [8.5, 0], [8.4, 0], [5.9, 6.4], [2.5, 10.9], [.9, 11.9]], 48), matMetal('#2b2c2e'), 0, H - 12, 0)
    : K.add(cyl(m * .36, m * .44, 12, 48).clone().translate(0, 0, 0), matShade(shadeHexC), 0, H - 6, 0, { cast: true });
  if (style !== 'industrial') { sh.geometry = new THREE.CylinderGeometry(Math.min(7.5, m * .38), Math.min(9.5, m * .48), 12, 48, 1, true); }
  K.add(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshBasicMaterial({ color: '#fff3d6' }), 0, H - 7, 0, { cast: false });
  if (withLight) { const L = new THREE.PointLight('#ffd7a1', 1300, 220, 1.6); L.position.set(0, H - 7, 0); group.add(L); }
}
function plant(K, c, group) {
  const { w, d } = c, G = GLB.plant, H = HGT.plant;
  if (G && G.status === 'ok') {
    const m = G.scene.clone(true), sz = G.size, s = H / (sz.y * 39.37) * 39.37;
    m.scale.setScalar(s); group.add(m); return;
  }
  const m = Math.min(w, d);
  K.add(lathe('pot', [[0, 0], [m * .26, 0], [m * .3, 11], [m * .32, 12.5], [m * .29, 12.5], [0, 12]], 32), matCeramic('#B8694A'), 0, 0, 0);
  const r = rng(hashStr(c.p.id));
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, t = .2 + r() * .8, h = 14 + t * (H - 16), rad = (1 - t * .4) * m * .38;
    const leaf = K.add(new THREE.SphereGeometry(1, 10, 8), matLeaf(['#4f7a46', '#5d8a50', '#3f6a3b', '#6b9658'][i % 4]), Math.cos(a) * rad, h, Math.sin(a) * rad);
    leaf.scale.set(5.5, .4, 2.6); leaf.rotation.set(r() - .5, -a, (r() - .5) * .9);
  }
}
function barcart(K, c) {
  const { w, d, pal, style } = c, metal = matMetal(style === 'industrial' ? '#2b2c2e' : '#B08A4A'), tray = matWood(pal.wood);
  for (const a of [-1, 1]) for (const b of [-1, 1]) K.add(cyl(.45, .45, 32, 12), metal, a * (w / 2 - 1), 16 + 1.5, b * (d / 2 - 1));
  for (const a of [-1, 1]) for (const b of [-1, 1]) K.add(new THREE.SphereGeometry(1.5, 16, 12), matMatte('#1d1b19'), a * (w / 2 - 1), 1.5, b * (d / 2 - 1));
  K.box(w, .8, d, .2, tray, 0, 9, 0, { seg: 1 }); K.box(w, .8, d, .2, tray, 0, 31, 0, { seg: 1 });
  const btl = [['#2f5a3c', 11], ['#6e2a24', 12.5], ['#c8d6da', 10]];
  btl.forEach(([hx, h], i) => K.add(lathe('bottle' + h, [[0, 0], [1.4, 0], [1.5, h * .62], [.55, h * .78], [.5, h], [0, h]], 24), matGlass(hx), -w * .28 + i * 3.6, 31.8, -d * .12).material.opacity = .8);
  bowl(K, w * .22, 31.8, d * .05, .55, mixHex(pal.soft, '#ffffff', .3));
}
function bench(K, c) {
  const { w, d, pal, base, style } = c;
  legs(K, w, d, 13, 2, LEGKIND[style], legMat(style, pal));
  K.box(w, 2, d, .4, matWood(pal.wood), 0, 13, 0);
  K.add(cushion(w - .6, 3, d - .6, 1, .7, 'y'), matFabric(base), 0, 16.5, 0);
}

/* Real finish and color from the product's name (e.g. "Ceni sofa, Hemlock green", "LACK side table, white") */
const FABRIC_WORDS = [['hot pink', '#D2457E'], ['light brown-pink', '#C9A49A'], ['pale pink', '#E9C9C8'], ['dusty pink', '#D8A7A8'], ['pastel pink', '#EBC3C6'], ['pink', '#E3AEB6'], ['rose', '#D9A0A6'],
  ['mint green', '#A8D5C2'], ['spearmint aqua', '#7FC8C0'], ['yarrow gold', '#C9962E'], ['bright yellow', '#E5B92E'], ['orange spice', '#C8642E'], ['valor rust', '#A4532F'], ['hale rust', '#A4532F'], ['amber', '#B9772F'],
  ['hale fir green', '#2F4A3B'], ['forest green', '#2E4A36'], ['dark green', '#2F4B3A'], ['light green', '#A9B98F'], ['vissle green', '#5A7A55'], ['sage', '#9DAA8C'], ['hale ink', '#2A3346'],
  ['dark blue', '#2C3A5A'], ['sky blue', '#8FB1CF'], ['blue', '#4C6A92'], ['cream white', '#EEE8DC'], ['rawhide tan', '#A5683A'], ['dark brown', '#3D2B22'], ['multicolor', '#C77B5A'], ['brown', '#6B4A33'],
  ['hemlock green', '#4F6B4E'], ['thistle green', '#7E8C6A'], ['norfolk green', '#5E6F57'], ['ratine navy', '#2E3B55'], ['navy', '#2E3B55'],
  ['ivory bouclé', '#ECE6DA'], ['bouclé', '#ECE6DA'], ['quartz white', '#E9E7E1'], ['off-white', '#ECE7DD'], ['ivory', '#ECE6DA'], ['cream', '#E6DDCB'],
  ['beige/gray', '#C4BCAF'], ['beige', '#D6C8B2'], ['gray/white', '#CACAC6'], ['dark gray', '#4B4D50'], ['anthracite', '#3B3D40'], ['charcoal', '#3B3C3E'], ['gray', '#8E8F8E'],
  ['charme tan', '#9C6236'], ['welsh taupe', '#9C8C7C'], ['taupe', '#9C8C7C'], ['light brown', '#A88463'], ['tan', '#A8703F'], ['red', '#8E3A33'], ['green', '#5F7A5A'], ['white', '#EFEDE8'], ['black', '#232325']];
const WOOD_WORDS = [['light walnut', '#9A6F4B'], ['weathered cherry', '#7A4A35'], ['cherry', '#7A3E2A'], ['rubberwood', '#C49A6C'], ['reclaimed', '#9C8466'], ['smoked oak', '#7D5E43'], ['white oak', '#C9A97F'], ['natural oak', '#C59D6A'], ['walnut', '#6A4630'], ['oak', '#C49C69'], ['birch', '#D9BE92'], ['ash', '#D4BA90'],
  ['weathered pine', '#A39684'], ['white stain', '#E2DACB'], ['pine', '#CFA66F'], ['acacia', '#8B5B39'], ['mango', '#9A6C45'], ['beech', '#D2AE7D'], ['bamboo', '#C6A367'],
  ['elm', '#A88866'], ['rattan', '#C29A62'], ['natural wood', '#BF9567'], ['natural', '#C6A57A'], ['wood', '#A57D55']];
const PAINT_WORDS = [['terra cotta', '#B5653F'], ['white marble', '#E8E5E0'], ['travertine', '#D9CBB4'], ['chrome', '#C8CCD0'], ['glam gray', '#9EA2A6'], ['mirror', '#D8DCDF'], ['stone', '#D6CFC4'], ['black-brown', '#2D2622'], ['black-blue', '#262C38'], ['gray-brown', '#6E6359'], ['dark brown', '#3D2B22'], ['brown', '#6B4A33'], ['anthracite', '#3B3D40'],
  ['concrete', '#9E9C97'], ['marble', '#D9D5CD'], ['weathered gray', '#9A958C'], ['white', '#EEECE7'], ['black', '#222224']];
const find = (n, L) => { for (const [w, h] of L) if (n.includes(w)) return h; return null; };
const UPH = new Set(['sofa', 'armchair', 'bench', 'dchair']);
function realLook(p) {
  const n = (p.name.split(',').slice(1).join(',') || p.name).toLowerCase(), full = p.name.toLowerCase(), pal = { ...STYLES[p.look || p.style].pal };
  const wood = find(n, WOOD_WORDS), paint = find(n, PAINT_WORDS), fab = find(n, FABRIC_WORDS);
  const leather = /leather/.test(full) || (/charme/.test(full));
  let base = colorFor(p), isWood = base === pal.wood;
  if (UPH.has(p.cat) || (p.cat === 'bed' && /upholster|beige|fabric/.test(full))) { if (fab) base = fab; if (wood) pal.wood = wood; isWood = false; }
  else if (p.cat === 'rug') { base = fab || find(n, [['natural', '#CDBB9C']]) || base; }
  else if (wood) { base = wood; pal.wood = wood; isWood = true; }
  else if (paint) { base = paint; isWood = false; }
  if (p.cat === 'dchair' && /ash|natural|wood/.test(n) && !fab) { base = wood || pal.wood; }
  return { base, pal, isWood, leather, plainRug: /high pile|off-white|tan|wool hand/.test(full), name: n };
}

/* Build one layout item as a Group: origin at the piece's center on the floor, back toward -z */
function makeItem(it, style, opts = {}) {
  const p = it.p, cat = it.grp, r = it.r, th = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 }[it.back] || 0, side = Math.abs(Math.sin(th)) > .5;
  const w = side ? r.h : r.w, d = side ? r.w : r.h, look = realLook(p), pal = look.pal, base = look.base;
  const g = new THREE.Group(), K = kit(g), c = { w, d, p, pal, base, style: p.style, isWood: look.isWood, leather: look.leather, plainRug: look.plainRug }, rr = rng(hashStr(p.id + cat));
  switch (cat) {
    case 'sofa': sofaLike(K, c, false); break;
    case 'armchair': if (!armchairGLB(K, c, g)) sofaLike(K, c, true); break;
    case 'dchair': diningChair(K, c); break;
    case 'bed': bed(K, c); break;
    case 'coffee': case 'side': case 'dtable': table(K, c, cat, rr); break;
    case 'night': cabinet(K, c, 24, 2, 1, 5); vase(K, w * .18, 24, -d * .1, .75, pal.accent); break;
    case 'dresser': cabinet(K, c, 34, 3, w > 40 ? 2 : 1, 4); break;
    case 'sideboard': cabinet(K, c, 32, 1, Math.max(2, Math.round(w / 20)), 6); vase(K, -w * .25, 32, 0, 1, pal.accent); bowl(K, w * .2, 32, 0, .8, pal.soft); break;
    case 'tv': {
      cabinet(K, c, 22, 1, Math.max(2, Math.round(w / 22)), 4);
      const tw = Math.min(w * .82, 65), tvh = tw * .5625, z = -d / 2 + Math.min(d * .4, 6);
      K.box(12, .8, 7, .3, matMetal('#1d1e20'), 0, 22, z); K.box(2.2, 3.5, 1.4, .3, matMetal('#1d1e20'), 0, 22.8, z);
      K.box(tw, tvh, 1.2, .25, matMatte('#141618'), 0, 25.5, z);
      K.box(tw - .8, tvh - .8, .1, .05, matScreen(), 0, 25.9, z + .62, { cast: false, seg: 1 });
      vase(K, w * .36, 22, 0, .8, pal.accent); break;
    }
    case 'rug': { const ph = typeof PHOTOS !== 'undefined' && PHOTOS[p.url], m = ph ? matRugPhoto(ph) : matRug(c.plainRug ? 'plain' : p.style, pal, base, w, d, hashStr(p.id) % 997); K.box(w, .45, d, .2, m, 0, 0, 0, { cast: false, seg: 2 }); break; }
    case 'lamp': lamp(K, c, g, opts.lights !== false); break;
    case 'plant': plant(K, c, g); break;
    case 'shelf': shelf(K, c, rr); break;
    case 'barcart': barcart(K, c); break;
    case 'bench': bench(K, c); break;
    default: K.box(w, HGT[cat] || 20, d, .5, matFabric(base), 0, 0, 0);
  }
  if (opts.blob && cat !== 'rug') {
    const pad = cat === 'plant' || cat === 'lamp' ? 2 : 5, sh = new THREE.Mesh(new THREE.PlaneGeometry(w + pad, d + pad), new THREE.MeshBasicMaterial({ color: 0, alphaMap: blobTex(), transparent: true, opacity: .55, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = .08; sh.renderOrder = -1; g.add(sh);
  }
  if (opts.ghost) g.traverse(o => { if (o.isMesh) { o.material = ghostOf(o.material); o.castShadow = false; } if (o.isLight) o.intensity = 0; });
  g.rotation.y = th; g.position.set(r.x + r.w / 2, 0, r.y + r.h / 2);
  g.userData.key = it.key; g.traverse(o => { o.userData.key = it.key; });
  return g;
}
const GHOST = new Map();
function ghostOf(m) { if (GHOST.has(m)) return GHOST.get(m); const g = m.clone(); g.transparent = true; g.opacity = .32; g.depthWrite = false; GHOST.set(m, g); return g; }
function ringFor(r, hex) {
  const sh = new THREE.Shape(), hole = new THREE.Path(), rr = (P, x, y, w, h, q) => { P.moveTo(x + q, y); P.lineTo(x + w - q, y); P.quadraticCurveTo(x + w, y, x + w, y + q); P.lineTo(x + w, y + h - q); P.quadraticCurveTo(x + w, y + h, x + w - q, y + h); P.lineTo(x + q, y + h); P.quadraticCurveTo(x, y + h, x, y + h - q); P.lineTo(x, y + q); P.quadraticCurveTo(x, y, x + q, y); };
  rr(sh, -r.w / 2 - 4, -r.h / 2 - 4, r.w + 8, r.h + 8, 4); rr(hole, -r.w / 2 - 2, -r.h / 2 - 2, r.w + 4, r.h + 4, 2.5); sh.holes.push(hole);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh, 6), new THREE.MeshBasicMaterial({ color: col(hex), toneMapped: false, transparent: true, opacity: .95, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(r.x + r.w / 2, .9, r.y + r.h / 2); m.renderOrder = 2; return m;
}

/* Keeps a Group of furniture in step with the layout; rebuilds only what changed */
class FurnitureSync {
  constructor(parent, opts) { this.parent = parent; this.opts = opts; this.map = new Map(); this.rings = new THREE.Group(); parent.add(this.rings); }
  update() {
    const Lay = S.layout, on = S.step === 3 && Lay && Lay.type === S.room.type, seen = new Set();
    const bad = on ? conflicts().bad : new Set(), glb = [GLB.chair && GLB.chair.status, GLB.plant && GLB.plant.status].join();
    if (on) for (const [k, it] of Object.entries(Lay.items)) {
      it.key = k; const ghost = S.skip.has(it.grp), side = Math.abs(Math.sin({ N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 }[it.back] || 0)) > .5;
      const sig = [it.p.id, side ? it.r.h : it.r.w, side ? it.r.w : it.r.h, ghost, glb].join('|'); seen.add(k);
      let e = this.map.get(k);
      if (!e || e.sig !== sig) { if (e) this.parent.remove(e.obj); e = { sig, obj: makeItem(it, Lay.style, { ...this.opts, ghost }) }; this.map.set(k, e); this.parent.add(e.obj); }
      const th = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 }[it.back] || 0; e.obj.rotation.y = th; e.obj.position.set(it.r.x + it.r.w / 2, 0, it.r.y + it.r.h / 2);
    }
    for (const [k, e] of this.map) if (!seen.has(k)) { this.parent.remove(e.obj); this.map.delete(k); }
    this.rings.clear();
    if (on && this.opts.rings !== false) for (const [k, it] of Object.entries(Lay.items)) if (S.sel === k || bad.has(k)) this.rings.add(ringFor(it.r, bad.has(k) ? (cssVar('--warn') || '#B8432F') : (cssVar('--accent') || '#2B5E8C')));
  }
  objects() { return [...this.map.values()].map(e => e.obj); }
}

/* ---------------- room shell for the 3D view ---------------- */
const LOOK = () => ROOMLOOK;
function buildRoom(group, Wd, Ld, door, win, style, hid, solid) {
  group.clear();
  const look = (LOOK()[style] || LOOK().japandi), t = 5, Hh = 96, concrete = look.mode === 3;
  const ft = floorTex(look.floor, concrete).clone(); ft.needsUpdate = true; const span = ft.userData.span; ft.repeat.set((Wd + 2 * t) / span[0], (Ld + 2 * t) / span[1]);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(Wd + 2 * t, 2, Ld + 2 * t), [matMatte('#8b8378'), matMatte('#8b8378'), new THREE.MeshPhysicalMaterial({ map: ft, roughness: concrete ? .78 : .42, clearcoat: concrete ? 0 : .35, clearcoatRoughness: .3, bumpMap: ft, bumpScale: .4 }), matMatte('#8b8378'), matMatte('#8b8378'), matMatte('#8b8378')]);
  floor.position.set(Wd / 2, -1, Ld / 2); floor.receiveShadow = true; floor.userData.surf = 'floor'; floor.userData.base = look.floor; group.add(floor);
  const wallM = M('wall' + look.wall, () => new THREE.MeshStandardMaterial({ color: col(look.wall), roughness: .93 })), trim = matPaint('#F3F1EC');
  const caster = M('caster', () => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  const box = (x, y, z, sx, sy, sz, m, shadowOnly) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); b.position.set(x, y + sy / 2, z); b.castShadow = true; b.receiveShadow = !shadowOnly;
    /* surfaces that can show the user's own room photos; everything else (trim, door, window) is a "fixture" hidden then */
    if (m === wallM) { b.userData.surf = 'wall'; b.userData.base = look.wall; } else if (!shadowOnly) b.userData.fix = true;
    if (shadowOnly) b.layers.set(1); group.add(b); return b;
  };
  let winInfo = null;
  for (const wall of ['N', 'S', 'W', 'E']) {
    const hz = wall === 'N' || wall === 'S', len = hz ? Wd : Ld, cut = hid[wall], ops = [];
    if (wall === door && !solid) ops.push([12, 46, 0, 80]);
    if (win === wall && !solid) { const wl = Math.min(60, len * .4), c = win === door ? len * .65 : len / 2; ops.push([c - wl / 2, c + wl / 2, 30, 78]); }
    const cuts = [-t, len + t, ...ops.flatMap(o => [o[0], o[1]])].sort((a, b) => a - b);
    const put = (p, q, y0, y1, m, so) => {
      if (y1 - y0 < .05 || q - p < .05) return; const mid = (p + q) / 2;
      if (hz) box(mid, y0, wall === 'N' ? -t / 2 : Ld + t / 2, q - p, y1 - y0, t, m, so); else box(wall === 'W' ? -t / 2 : Wd + t / 2, y0, mid, t, y1 - y0, q - p, m, so);
    };
    for (const [top, m, so] of cut ? [[5, wallM, false], [Hh, caster, true]] : [[Hh, wallM, false]]) {
      for (let i = 0; i < cuts.length - 1; i++) {
        const p = cuts[i], q = cuts[i + 1], mid = (p + q) / 2, o = ops.find(o => mid > o[0] && mid < o[1]);
        if (!o) put(p, q, 0, top, m, so); else { put(p, q, 0, Math.min(o[2], top), m, so); put(p, q, o[3], top, m, so); }
        if (!so && !(o && o[2] === 0)) { const a = Math.max(p, 0), b = Math.min(q, len); if (b > a) { /* baseboard */
          if (hz) box((a + b) / 2, 0, wall === 'N' ? .35 : Ld - .35, b - a, 4, .7, trim); else box(wall === 'W' ? .35 : Wd - .35, 0, (a + b) / 2, .7, 4, b - a, trim); } }
      }
    }
    const wo = ops.find(o => o[2] === 30);
    if (wo) {
      const c = (wo[0] + wo[1]) / 2, wl = wo[1] - wo[0], out = { N: [0, 0, -1], S: [0, 0, 1], W: [-1, 0, 0], E: [1, 0, 0] }[wall];
      const z = wall === 'N' ? -t / 2 : wall === 'S' ? Ld + t / 2 : 0, x = wall === 'W' ? -t / 2 : wall === 'E' ? Wd + t / 2 : 0;
      const A = (u, y, sx, sy, sz, m) => hz ? box(u, y, z, sx, sy, sz, m) : box(x, y, u, sz, sy, sx, m);
      winInfo = { pos: hz ? [c, 54, z] : [x, 54, c], out };
      if (!cut) {
        A(c, 28.4, wl + 6, 1.6, t + 3, trim); A(c, 78, wl + 2, 1.6, t + .6, trim); A(c, 30, 1.5, 48, t + .4, trim);
        A(c - wl / 2 + .7, 30, 1.4, 48, t + .4, trim); A(c + wl / 2 - .7, 30, 1.4, 48, t + .4, trim);
        const g = A(c, 30, wl, 48, .3, matGlass('#cfe2ec')); g.castShadow = false;
        const sky = new THREE.Mesh(new THREE.PlaneGeometry(wl + 40, 80), new THREE.MeshBasicMaterial({ map: skyTex(), toneMapped: false }));
        const pos = new THREE.Vector3(...winInfo.pos).add(new THREE.Vector3(...out).multiplyScalar(t / 2 + 7)); sky.position.set(pos.x, 50, pos.z);
        sky.lookAt(pos.x - out[0], 50, pos.z - out[2]); sky.userData.fix = true; group.add(sky);
      }
    }
    if (wall === door && !cut && !solid) { /* casing */
      const z = wall === 'N' ? .4 : wall === 'S' ? Ld - .4 : 0, x = wall === 'W' ? .4 : wall === 'E' ? Wd - .4 : 0;
      const A = (u, y, sx, sy, sz) => hz ? box(u, y, z, sx, sy, sz, trim) : box(x, y, u, sz, sy, sx, trim);
      A(11, 0, 2.6, 82, 1.2); A(47, 0, 2.6, 82, 1.2); A(29, 80, 38.6, 2.6, 1.2);
    }
  }
  /* closed door leaf, set inside its opening (12"–46" along the wall), slightly recessed from the room face.
     Skipped when that wall is cut away for the view, so it never stands loose in the room. */
  if (door && !hid[door] && !solid) {
    const hz = door === 'N' || door === 'S', inw = { N: 1, S: -1, W: 1, E: -1 }[door];   // direction into the room
    const face = { N: 0, S: Ld, W: 0, E: Wd }[door], mid = face - inw * 1.6;              // leaf center, inside the wall
    const A = (u, y, along, sy, thick, off, m) => { const n = mid + inw * off; return hz ? box(u, y, n, along, sy, thick, m) : box(n, y, u, thick, sy, along, m); };
    const leaf = matPaint('#F1EEE8'), pnl = matPaint('#E9E5DD');
    A(29, 0, 33.6, 79.6, 1.75, 0, leaf);
    A(29, 44, 25, 30, .35, 1.0, pnl); A(29, 8, 25, 30, .35, 1.0, pnl);                     // two raised panels on the room side
    const knob = new THREE.Mesh(new THREE.SphereGeometry(1.15, 16, 12), matMetal('#B08A4A')), kn = mid + inw * 2.2;
    knob.position.set(hz ? 42.5 : kn, 36, hz ? kn : 42.5); knob.castShadow = true; knob.userData.fix = true; group.add(knob);
  }
  return winInfo;
}

/* ---------------- the user's own room photos, painted onto the 3D floor and walls ----------------
   Each lined-up photo is a camera we know (from its 4 floor dots). Every floor/wall point is projected
   into each photo; points a photo sees face-on get more of that photo. Spots no photo saw stay plain. */
const NPH = 3;
function photoRoomMat(list, base) {
  const u = { uBase: { value: col(base) } };
  for (let i = 0; i < NPH; i++) {
    const p = list[i];
    u['uT' + i] = { value: p ? p.tex : null }; u['uM' + i] = { value: p ? p.M : new THREE.Matrix4() };
    u['uC' + i] = { value: p ? p.cam : new THREE.Vector3() }; u['uOn' + i] = { value: p ? 1 : 0 };
  }
  const smp = i => `if (uOn${i} > .5) { vec4 c = uM${i} * vec4(vW, 1.); if (c.w > 0.) { vec2 q = c.xy / c.w * .5 + .5;
      if (q.x > 0. && q.x < 1. && q.y > 0. && q.y < 1.) { float e = smoothstep(0., .035, min(min(q.x, 1. - q.x), min(q.y, 1. - q.y)));
        float f = dot(n, normalize(uC${i} - vW)); if (f > 0.) { float w = e * pow(f, 1.5); acc += texture2D(uT${i}, q).rgb * w; ws += w; } } } }`;
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: `varying vec3 vW; varying vec3 vN;
      void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 uBase; ${[...Array(NPH).keys()].map(i => `uniform sampler2D uT${i}; uniform mat4 uM${i}; uniform vec3 uC${i}; uniform float uOn${i};`).join(' ')}
      varying vec3 vW; varying vec3 vN;
      void main() { vec3 n = normalize(vN), acc = vec3(0.); float ws = 0.;
        ${[...Array(NPH).keys()].map(smp).join('\n')}
        vec3 plain = uBase * (.62 + .38 * max(dot(n, normalize(vec3(.3, 1., .4))), 0.));
        vec3 c = mix(plain, ws > 0. ? acc / ws : plain, clamp(ws * 4., 0., 1.));
        gl_FragColor = vec4(c, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
}

/* ---------------- realistic 3D view ---------------- */
class Real3D {
  constructor(canvas) {
    this.cv = canvas;
    const r = this.r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.toneMapping = THREE.NeutralToneMapping; r.toneMappingExposure = 1.02;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(40, 1, 2, 6000);
    const pm = new THREE.PMREMGenerator(r); this.scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture; this.scene.environmentIntensity = .55;
    this.hemi = new THREE.HemisphereLight('#fbf6ee', '#8c7c68', .32); this.scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight('#fff0db', 3.2); sun.castShadow = true; sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
    sun.shadow.bias = -.0004; sun.shadow.normalBias = .35; sun.shadow.radius = 5; sun.shadow.camera.layers.enable(1); this.scene.add(sun, sun.target);
    this.fill = new THREE.DirectionalLight('#eef3ff', .55); this.scene.add(this.fill, this.fill.target);
    this.room = new THREE.Group(); this.furn = new THREE.Group(); this.scene.add(this.room, this.furn);
    this.fs = new FurnitureSync(this.furn, { lights: true });
    this.roomSig = ''; this.dirty = true; this.size = [0, 0];
    if (!MOBILE) {
      const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
      this.comp = new EffectComposer(r, rt); this.comp.addPass(new RenderPass(this.scene, this.cam));
      const ao = this.ao = new GTAOPass(this.scene, this.cam, 2, 2);
      ao.updateGtaoMaterial({ radius: 14, distanceExponent: 2, thickness: 6, scale: 1.15, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 }); ao.blendIntensity = 1.2;
      this.comp.addPass(ao); this.comp.addPass(new OutputPass());
    }
  }
  sync(hid) {
    const Lay = S.layout, on = S.step === 3 && Lay && Lay.type === S.room.type, style = on ? Lay.style : effStyle();
    const pl = photoRoomOn() ? PV.projections() : [], pk = pl.map(p => p.key).join('|');
    const Wd = roomW(), Ld = roomL(), sig = [Wd, Ld, S.room.door, S.room.window, style, JSON.stringify(hid), cssVar('--bg'), pk].join();
    if (sig !== this.roomSig) {
      this.roomSig = sig; const wi = buildRoom(this.room, Wd, Ld, S.room.door, S.room.window, style, hid, pl.length > 0);
      if (pl.length) {
        /* swap floor and walls to the photo material, hide trim/door/window (the photos show the real ones),
           and lay a shadow catcher on the floor so furniture still sits on it */
        const mats = {};
        this.room.traverse(o => {
          if (o.userData.fix) o.visible = false;
          if (o.userData.surf) { const b = o.userData.base; o.material = mats[b] || (mats[b] = photoRoomMat(pl, b)); }
        });
        const sh = new THREE.Mesh(new THREE.PlaneGeometry(Wd, Ld), new THREE.ShadowMaterial({ opacity: .38 }));
        sh.rotation.x = -Math.PI / 2; sh.position.set(Wd / 2, .06, Ld / 2); sh.receiveShadow = true; this.room.add(sh);
      }
      const ctr = new THREE.Vector3(Wd / 2, 0, Ld / 2), m = Math.max(Wd, Ld), sc = this.sun.shadow.camera;
      if (wi) { const o = new THREE.Vector3(...wi.out); this.sun.position.set(wi.pos[0], 0, wi.pos[2]).addScaledVector(o, 210).add(new THREE.Vector3(0, 190, 0)).addScaledVector(new THREE.Vector3(o.z, 0, -o.x), 70); this.sun.intensity = 4.6; }
      else { this.sun.position.set(Wd * .2, 260, Ld * .9); this.sun.intensity = 2.2; }
      this.sun.target.position.copy(ctr); sc.left = sc.bottom = -m * .95; sc.right = sc.top = m * .95; sc.near = 1; sc.far = 900; sc.updateProjectionMatrix();
      this.fill.position.set(Wd * .8, 220, Ld * .1); this.fill.target.position.copy(ctr);
      this.scene.background = col(cssVar('--bg') || '#E8EBEE');
    }
    this.fs.update();
  }
  render(v) {
    const cv = this.cv, w = Math.max(1, cv.clientWidth), h = Math.max(1, cv.clientHeight), dpr = DPR();
    if (w !== this.size[0] || h !== this.size[1] || dpr !== this.size[2]) {
      this.size = [w, h, dpr]; this.r.setPixelRatio(dpr); this.r.setSize(w, h, false);
      if (this.comp) { this.comp.setPixelRatio(dpr); this.comp.setSize(w, h); }
    }
    if (this.dirty) { this.sync(v.hid); this.dirty = false; }
    const c = this.cam; c.fov = v.fov * 180 / Math.PI; c.aspect = w / h; c.near = 2; c.far = 6000; c.updateProjectionMatrix();
    c.position.set(...v.eye); c.up.set(0, 1, 0); c.lookAt(...v.t);
    if (this.comp) this.comp.render(); else this.r.render(this.scene, c);
  }
  snapshot() { return this.cv.toDataURL('image/png'); }
}

/* ---------------- "In my photo" view ---------------- */
const WALLNAME = { N: 'Top', S: 'Bottom', W: 'Left', E: 'Right' };
const DOTNAME = ['Back-left corner', 'Back-right corner', 'Right wall meets floor', 'Left wall meets floor'];
/* small sketch of a room seen from the doorway, with the 4 dots where they belong */
function guideSVG() {
  const L = (a, b, c, d) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`, D = (x, y, n) => `<g transform="translate(${x},${y})"><circle r="6.5"/><text y="3.2">${n}</text></g>`;
  return `<svg class="pv-sketch" viewBox="0 0 160 92" aria-hidden="true"><rect class="bw" x="48" y="10" width="64" height="44"/>
    <path class="fl" d="M48 54 L112 54 L158 90 L2 90 Z"/>${L(2, 0, 48, 10)}${L(158, 0, 112, 10)}${L(48, 10, 112, 10)}${L(48, 10, 48, 54)}${L(112, 10, 112, 54)}
    <g class="edge">${L(48, 54, 112, 54)}${L(48, 54, 6, 87)}${L(112, 54, 154, 87)}</g>
    <text class="cap" x="80" y="34">far wall</text>${D(48, 54, 1)}${D(112, 54, 2)}${D(139, 75, 3)}${D(21, 75, 4)}</svg>`;
}
class PhotoView {
  constructor() {
    this.el = document.getElementById('pv'); this.stage = document.getElementById('pvStage'); this.cv = document.getElementById('cph');
    this.img = document.getElementById('pvImg'); this.svg = document.getElementById('pvSvg'); this.bar = document.getElementById('pvBar'); this.card = document.getElementById('pvCard');
    const r = this.r = new THREE.WebGLRenderer({ canvas: this.cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setClearColor(0, 0); r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.toneMapping = THREE.NeutralToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(50, 1, 2, 6000); this.cam.matrixAutoUpdate = false;
    const pm = new THREE.PMREMGenerator(r); this.scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture; this.scene.environmentIntensity = .7;
    this.hemi = new THREE.HemisphereLight('#ffffff', '#7d7062', .5);
    const sun = this.sun = new THREE.DirectionalLight('#ffffff', 2.4); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -.0004; sun.shadow.normalBias = .35; sun.shadow.radius = 7;
    this.scene.add(this.hemi, sun, sun.target);
    this.world = new THREE.Group(); this.furn = new THREE.Group(); this.catch = new THREE.Group(); this.world.add(this.furn); this.scene.add(this.world, this.catch);
    this.fs = new FurnitureSync(this.furn, { blob: true, lights: false });
    this.ph = null; this.shots = []; this.guideOff = false; this.guide = document.getElementById('pvGuide');
    this.sol = null; this.drag = null; this.raycaster = new THREE.Raycaster();
    const ep = document.querySelector('#pvEmpty p'); if (ep) ep.insertAdjacentHTML('afterend', guideSVG());
    this.wire();
  }
  /* ---- UI ---- */
  wire() {
    this.el.addEventListener('change', e => {
      if (e.target.id === 'pvFile' && e.target.files[0]) { const fr = new FileReader(); fr.onload = () => this.setPhoto(fr.result); fr.readAsDataURL(e.target.files[0]); e.target.value = ''; }
      if (e.target.id === 'pvAdd' && e.target.files[0]) { const fr = new FileReader(); fr.onload = () => this.setPhoto(fr.result, true); fr.readAsDataURL(e.target.files[0]); e.target.value = ''; }
      if (e.target.id === 'pvWall') { this.ph.wall = e.target.value; this.solve(); this.paint(); }
      if (e.target.id === 'pvLens') { this.ph.lens = e.target.value; this.solve(); this.paint(); }
    });
    this.el.addEventListener('click', e => {
      if (e.target.closest('#pvAlign')) { this.ph.mode = this.ph.mode === 'align' ? 'place' : 'align'; if (this.ph.mode === 'align') { S.sel = null; } else { this.ph.done = true; if (R3) R3.dirty = true; } this.bars(); this.paint(); }
      if (e.target.closest('#pvBird')) this.birdsEye();
      if (e.target.closest('#pvSave')) this.save();
      if (e.target.closest('#pvUseFit')) this.setPhoto(S.fit.photo);
      if (e.target.closest('#pvLook')) this.lookFrom3D();
      if (e.target.closest('#pvGuideX')) { this.guideOff = true; this.paint(); }
      if (e.target.closest('#pvGuideOn')) { this.guideOff = false; this.paint(); }
      const sh = e.target.closest('[data-shot]'); if (sh) { this.ph = this.shots[+sh.dataset.shot]; this.img.src = this.ph.src; this.solve(); this.bars(); this.paint(); }
      if (e.target.closest('#pvDrop') && this.shots.length > 1) { this.shots.splice(this.shots.indexOf(this.ph), 1); this.ph = this.shots[0]; this.img.src = this.ph.src; this.solve(); this.bars(); this.paint(); }
    });
    new ResizeObserver(() => this.ph && this.paint()).observe(this.stage);
    /* dots (align mode) */
    this.svg.addEventListener('pointerdown', e => {
      const h = e.target.closest('[data-h]'); if (!h || !this.ph || this.ph.mode !== 'align') return;
      e.preventDefault(); this.svg.setPointerCapture(e.pointerId); this.dragH = +h.dataset.h;
    });
    this.svg.addEventListener('pointermove', e => {
      if (this.dragH == null) return; const b = this.box(), p = this.ph;
      p.pts[this.dragH] = [clamp((e.clientX - b.left) / b.width, 0, 1), clamp((e.clientY - b.top) / b.height, 0, 1)]; this.solve(); this.paint();
    });
    const endH = () => { this.dragH = null; }; this.svg.addEventListener('pointerup', endH); this.svg.addEventListener('pointercancel', endH);
    /* furniture (place mode) */
    this.cv.addEventListener('pointerdown', e => this.down(e)); this.cv.addEventListener('pointermove', e => this.move(e));
    const up = e => { if (this.drag) { this.drag = null; renderBar(); syncRows(); this.cv.style.cursor = ''; } }; this.cv.addEventListener('pointerup', up); this.cv.addEventListener('pointercancel', up);
  }
  box() { return this.cv.getBoundingClientRect(); }
  /* Each photo is one "angle" of the room. asNew adds another angle (facing the next wall); otherwise it replaces the current one. */
  setPhoto(src, asNew) {
    const im = new Image();
    im.onload = () => {
      const used = this.shots.filter(s => s !== this.ph || asNew).map(s => s.wall), first = OPP[S.room.door] || 'N';
      const order = [first, ...['N', 'E', 'S', 'W'].filter(k => k !== first)];
      const wall = !asNew && this.ph ? this.ph.wall : order.find(k => !used.includes(k)) || first;
      const shot = { src, w: im.naturalWidth, h: im.naturalHeight, im, wall, lens: 'auto', mode: 'align',
        pts: [[.3, .52], [.7, .52], [.92, .9], [.08, .9]] };
      if (asNew || !this.ph) this.shots.push(shot); else this.shots[this.shots.indexOf(this.ph)] = shot;
      this.ph = shot; this.guideOff = false;
      this.img.src = src; this.light(im); this.solve(); this.bars(); this.paint();
      document.dispatchEvent(new Event('fitroom-photo'));
    };
    im.src = src;
  }
  /* put the room into the photo's frame: x along the facing wall, z toward the camera */
  placeWorld() {
    const W = roomW(), L = roomL(), wl = this.ph.wall;
    const rot = { N: 0, E: Math.PI / 2, S: Math.PI, W: -Math.PI / 2 }[wl], pos = { N: [0, 0], E: [0, W], S: [W, L], W: [L, 0] }[wl];
    this.world.rotation.y = rot; this.world.position.set(pos[0], 0, pos[1]); this.world.updateMatrixWorld(true);
  }
  /* open the 3D room from the spot where the photo was taken, so the user can turn and look past whatever blocks the photo */
  lookFrom3D() {
    const s = this.sol; if (!s || !s.ok || typeof G3 === 'undefined' || !G3.ok) return;
    this.ph.done = true; S.photoRoom = true; S.real = true; if (R3) R3.dirty = true;
    this.placeWorld();
    /* keep the standing spot inside the room (or just in the doorway) at eye height, even if the photo's numbers are rough */
    const Wm = this.wallWidth(), Dm = this.wallDepth(), eF = new THREE.Vector3(clamp(s.camX, 6, Wm - 6), clamp(s.camH, 36, 72), clamp(s.camY, 24, Dm + 6));
    const tF = new THREE.Vector3(clamp(s.camX, 0, Wm), 26, eF.z * .4);
    const e = this.world.worldToLocal(eF), t = this.world.worldToLocal(tF);
    S.view = '3d'; applyView(); renderBar(); G3.lookFrom([e.x, e.y, e.z], [t.x, t.y, t.z]);
  }
  /* where shot i's camera stood, in room coordinates (eye, and a point it looks toward) */
  standing(shot) {
    const s = shot.sol, ww = shot.wall, hz = ww === 'N' || ww === 'S', Wm = hz ? roomW() : roomL(), Dm = hz ? roomL() : roomW();
    const eF = new THREE.Vector3(clamp(s.camX, 6, Wm - 6), clamp(s.camH, 36, 72), clamp(s.camY, 24, Dm + 6)), tF = new THREE.Vector3(clamp(s.camX, 0, Wm), 26, eF.z * .4);
    const inv = this.frameOf(ww).invert(); return [eF.applyMatrix4(inv), tF.applyMatrix4(inv)];
  }
  /* room coords -> this photo's floor frame (x along the facing wall, z toward the camera) */
  frameOf(ww) {
    const W = roomW(), L = roomL(), o = new THREE.Object3D();
    o.rotation.y = { N: 0, E: Math.PI / 2, S: Math.PI, W: -Math.PI / 2 }[ww]; const pos = { N: [0, 0], E: [0, W], S: [W, L], W: [L, 0] }[ww];
    o.position.set(pos[0], 0, pos[1]); o.updateMatrix(); return o.matrix.clone();
  }
  /* every lined-up photo as a projector: texture, room -> photo clip matrix, camera position */
  projections() {
    const out = [];
    for (const sh of this.shots) {
      const s = sh.sol; if (!sh.done || !s || !s.ok) continue;
      const key = [sh.src.length, sh.src.slice(-40), sh.wall, sh.lens, JSON.stringify(sh.pts), roomW(), roomL()].join();
      if (sh.pkey !== key) {
        const { r1, r2, up, t } = s, V = new THREE.Matrix4().set(r1[0], up[0], r2[0], t[0], -r1[1], -up[1], -r2[1], -t[1], -r1[2], -up[2], -r2[2], -t[2], 0, 0, 0, 1);
        const P = new THREE.PerspectiveCamera(2 * Math.atan(sh.h / 2 / s.f) * 180 / Math.PI, sh.w / sh.h, 2, 6000).projectionMatrix;
        const VW = V.clone().multiply(this.frameOf(sh.wall));
        if (!sh.tex) { sh.tex = new THREE.Texture(sh.im); sh.tex.colorSpace = THREE.SRGBColorSpace; sh.tex.anisotropy = 4; sh.tex.needsUpdate = true; }
        sh.proj = { key, tex: sh.tex, M: P.clone().multiply(VW), cam: new THREE.Vector3().applyMatrix4(VW.clone().invert()) }; sh.pkey = key;
      }
      out.push(sh.proj); if (out.length === NPH) break;
    }
    return out;
  }
  /* jump to the 3D room with the photos on, seen from above */
  birdsEye() {
    if (this.ph && this.sol && this.sol.ok) this.ph.done = true;
    S.photoRoom = true; S.real = true; S.view = '3d'; applyView(); renderBar(); if (R3) R3.dirty = true; G3.cam('corner');
  }
  light(im) { /* read the photo's brightness and color cast so the furniture is lit to match */
    const n = 48, c = canvasOf(n, n), x = c.getContext('2d'); x.drawImage(im, 0, 0, n, n); let d; try { d = x.getImageData(0, 0, n, n).data; } catch (e) { return; }
    let R = 0, G = 0, B = 0, L = 0, Lt = 0, Rt = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = (j * n + i) * 4, r = s2l(d[k] / 255), g = s2l(d[k + 1] / 255), b = s2l(d[k + 2] / 255), y = .2126 * r + .7152 * g + .0722 * b; R += r; G += g; B += b; L += y; if (j < n * .6) { if (i < n / 2) Lt += y; else Rt += y; } }
    const N = n * n; R /= N; G /= N; B /= N; L /= N; const m = Math.max(R, G, B) || 1;
    const tint = new THREE.Color(R / m, G / m, B / m).lerp(new THREE.Color(1, 1, 1), .6);
    this.ph.lum = L; this.ph.tint = tint; this.ph.side = (Rt - Lt) / Math.max(1e-4, Rt + Lt);
  }
  wallWidth() { const w = this.ph.wall; return w === 'N' || w === 'S' ? roomW() : roomL(); }
  wallDepth() { const w = this.ph.wall; return w === 'N' || w === 'S' ? roomL() : roomW(); }
  solve() {
    const p = this.ph; if (!p) return; this.sol = p.sol = solveFloor(p.pts.map(([x, y]) => [x * p.w, y * p.h]), p.w, p.h, this.wallWidth(), p.lens);
    if (R3) R3.dirty = true;
  }
  bars() {
    const p = this.ph, hasFit = S.fit && S.fit.photo;
    const empty = document.getElementById('pvEmpty'); empty.hidden = !!p;
    document.getElementById('pvUseFit').hidden = !hasFit;
    if (!p) { this.bar.innerHTML = ''; this.svg.innerHTML = ''; this.guide.hidden = true; return; }
    const opt = k => `<option value="${k}"${p.wall === k ? ' selected' : ''}>${WALLNAME[k]} wall${S.room.window === k ? ' (window)' : ''}${S.room.door === k ? ' (door)' : ''}</option>`;
    const tabs = this.shots.map((s, i) => `<button type="button" data-shot="${i}" class="${s === p ? 'on' : ''}">Angle ${i + 1} · ${WALLNAME[s.wall]} wall</button>`).join('');
    this.bar.innerHTML = `<div class="pv-angles"><span class="pv-lbl">Angles</span><div class="seg">${tabs}</div>
        <label class="btn small"><input type="file" accept="image/*" id="pvAdd" hidden>+ Add another angle</label>
        ${this.shots.length > 1 ? '<button type="button" class="btn small" id="pvDrop">Remove this angle</button>' : ''}</div>
      <label class="btn small"><input type="file" accept="image/*" id="pvFile" hidden>Change photo</label>
      <button type="button" class="btn small${p.mode === 'align' ? ' primary' : ''}" id="pvAlign">${p.mode === 'align' ? 'Done, place furniture' : 'Line up the floor'}</button>
      <button type="button" class="btn small" id="pvBird" title="Your photos painted onto the 3D room. Pinch to zoom, drag to turn, two fingers to move.">Bird's-eye view of my room</button>
      <button type="button" class="btn small" id="pvLook" title="Opens the 3D room from where you stood. Drag to turn and look past anything blocking the photo.">Look around from here in 3D</button>
      <label class="pv-sel"><span>Wall you're facing</span><select id="pvWall">${['N', 'E', 'S', 'W'].map(opt).join('')}</select></label>
      <label class="pv-sel"><span>Lens</span><select id="pvLens"><option value="auto"${p.lens === 'auto' ? ' selected' : ''}>Auto</option><option value="wide"${p.lens === 'wide' ? ' selected' : ''}>1x</option><option value="ultra"${p.lens === 'ultra' ? ' selected' : ''}>0.5x</option></select></label>
      <button type="button" class="btn small" id="pvSave">Save image</button>
      <p class="hint pv-status" id="pvStatus"></p>`;
  }
  /* the "where do the 4 dots go" card shown over the photo while lining up the floor */
  guideHTML() {
    return `<button type="button" class="pv-gx" id="pvGuideX" aria-label="Hide the guide">×</button>
      <b>Line up the floor in 4 taps</b>${guideSVG()}
      <ol><li><i>1</i><span><b>Back-left corner.</b> Where the far wall, the left wall and the floor meet.</span></li>
      <li><i>2</i><span><b>Back-right corner.</b> The same spot on the right side of the far wall.</span></li>
      <li><i>3</i><span><b>Right wall.</b> Any spot lower down where the right wall meets the floor.</span></li>
      <li><i>4</i><span><b>Left wall.</b> Any spot lower down where the left wall meets the floor.</span></li></ol>
      <p>Corner hidden by a TV or sofa? Put the dot where the corner would be, following the line where the wall meets the floor. Or add another angle.</p>`;
  }
  show() {
    this.bars(); if (this.ph) this.paint();
  }
  /* ---- drawing ---- */
  fitRect() {
    const p = this.ph, sw = this.stage.clientWidth, sh = this.stage.clientHeight, k = Math.min(sw / p.w, sh / p.h);
    const w = Math.round(p.w * k), h = Math.round(p.h * k); return { w, h, x: Math.round((sw - w) / 2), y: Math.round((sh - h) / 2) };
  }
  paint() {
    const p = this.ph; if (!p || this.el.hidden) return;
    const R = this.fitRect();
    for (const el of [this.cv, this.img, this.svg]) Object.assign(el.style, { left: R.x + 'px', top: R.y + 'px', width: R.w + 'px', height: R.h + 'px' });
    const dpr = DPR(); this.r.setPixelRatio(dpr); this.r.setSize(R.w, R.h, false);
    this.svg.setAttribute('viewBox', `0 0 ${R.w} ${R.h}`);
    this.svg.style.pointerEvents = p.mode === 'align' ? 'auto' : 'none'; this.cv.style.pointerEvents = p.mode === 'align' ? 'none' : 'auto';
    this.overlay(R); this.render3();
    const st = document.getElementById('pvStatus'), s = this.sol;
    if (st) st.textContent = !s ? '' : !s.ok ? s.why : p.mode === 'align'
      ? `Drag each yellow dot to the spot its tag names. The white grid should lie flat on your floor in 1 ft squares. Camera about ${fmt(s.camH)} up (phones are usually held 4–5 ft up).`
      : `Showing your ${WALLNAME[p.wall].toLowerCase()} wall, ${fmt(this.wallWidth())} wide, at true scale. Drag a piece to move it.`;
    this.updCard();
  }
  overlay(R) {
    const p = this.ph, s = this.sol, sx = R.w / p.w, sy = R.h / p.h, P = q => q && [q[0] * sx, q[1] * sy];
    let h = '';
    if (s && s.ok && p.mode === 'align') {
      const Wm = this.wallWidth(), Dm = Math.min(this.wallDepth(), Math.max(24, s.camY - 18)), lines = [];
      for (let x = 0; x <= Wm + .01; x += 12) lines.push([[x, 0], [x, Dm]]);
      for (let y = 0; y <= Dm + .01; y += 12) lines.push([[0, y], [Wm, y]]);
      for (const [a, b] of lines) { const A = P(projectFloor(s, ...a)), B = P(projectFloor(s, ...b)); if (A && B) h += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="pv-grid"/>`; }
      const hgt = [[0, 0], [Wm, 0]].map(([x, y]) => [P(projectFloor(s, x, y, 0)), P(projectFloor(s, x, y, 96))]);
      for (const [A, B] of hgt) if (A && B) h += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" class="pv-wall"/>`;
    }
    if (p.mode === 'align') {
      const Q = p.pts.map(([x, y]) => [x * R.w, y * R.h]);
      h += `<polyline points="${Q[3]} ${Q[0]} ${Q[1]} ${Q[2]}" class="pv-edge"/>`;
      Q.forEach((q, i) => {
        /* a name tag beside every dot, so it is clear which corner each one belongs on */
        const t = DOTNAME[i], tw = t.length * 6.7 + 20, below = q[1] < 40, ty = below ? q[1] + 20 : q[1] - 38;
        const tx = clamp(q[0] - tw / 2, 4, Math.max(4, R.w - tw - 4));
        h += `<g class="pv-tag" transform="translate(${tx},${ty})"><rect width="${tw}" height="20" rx="10"/><text x="${tw / 2}" y="14">${t}</text></g>`;
      });
      Q.forEach((q, i) => { h += `<g data-h="${i}" class="pv-h" transform="translate(${q[0]},${q[1]})"><circle r="16" class="pv-hit"/><circle r="9"/><text y="4">${i + 1}</text></g>`; });
    }
    this.svg.innerHTML = h;
    const g = this.guide, showG = p.mode === 'align' && !this.guideOff;
    g.hidden = p.mode !== 'align'; g.classList.toggle('min', !showG);
    g.innerHTML = showG ? this.guideHTML() : '<button type="button" class="btn small" id="pvGuideOn">Where do the dots go?</button>';
  }
  /* world: x along the facing wall, z toward the camera, y up (inches). Room layout coords map in by wall. */
  render3() {
    const p = this.ph, s = this.sol; this.fs.update();
    if (!s || !s.ok || p.mode === 'align') { this.r.clear(); return; }
    const { r1, r2, up, t } = s, V = new THREE.Matrix4().set(r1[0], up[0], r2[0], t[0], -r1[1], -up[1], -r2[1], -t[1], -r1[2], -up[2], -r2[2], -t[2], 0, 0, 0, 1);
    this.cam.matrix.copy(V).invert(); this.cam.matrix.decompose(this.cam.position, this.cam.quaternion, this.cam.scale); this.cam.updateMatrixWorld(true);
    this.cam.fov = 2 * Math.atan(p.h / 2 / s.f) * 180 / Math.PI; this.cam.aspect = p.w / p.h; this.cam.near = 2; this.cam.far = 6000; this.cam.updateProjectionMatrix();
    const Wm = this.wallWidth(), Dm = this.wallDepth();
    this.placeWorld();
    /* shadow catchers on the floor and walls */
    const sig = [Wm, Dm].join(); if (this.catchSig !== sig) {
      this.catchSig = sig; this.catch.clear();
      const fm = new THREE.ShadowMaterial({ opacity: .42 }), wm = new THREE.ShadowMaterial({ opacity: .22 });
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(Wm, Dm), fm); fl.rotation.x = -Math.PI / 2; fl.position.set(Wm / 2, 0, Dm / 2); fl.receiveShadow = true;
      const bk = new THREE.Mesh(new THREE.PlaneGeometry(Wm, 110), wm); bk.position.set(Wm / 2, 55, -.2); bk.receiveShadow = true;
      const lf = new THREE.Mesh(new THREE.PlaneGeometry(Dm, 110), wm); lf.rotation.y = Math.PI / 2; lf.position.set(-.2, 55, Dm / 2); lf.receiveShadow = true;
      const rt = lf.clone(); rt.rotation.y = -Math.PI / 2; rt.position.x = Wm + .2;
      this.catch.add(fl, bk, lf, rt);
    }
    /* light: from the photo's brighter side, above and slightly in front, tinted to the photo */
    const lum = clamp(p.lum ?? .25, .04, .8), side = clamp(p.side ?? 0, -1, 1);
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrix, 0).setY(0).normalize(), back = new THREE.Vector3().setFromMatrixColumn(this.cam.matrix, 2).setY(0).normalize();
    const ctr = new THREE.Vector3(Wm / 2, 0, Dm * .4);
    this.sun.position.copy(ctr).addScaledVector(right, 160 * (side >= 0 ? 1 : -1) * (.35 + Math.abs(side))).addScaledVector(back, 90).add(new THREE.Vector3(0, 230, 0));
    this.sun.target.position.copy(ctr); const sc = this.sun.shadow.camera, m = Math.max(Wm, Dm); sc.left = sc.bottom = -m; sc.right = sc.top = m; sc.near = 1; sc.far = 1000; sc.updateProjectionMatrix();
    this.sun.color.copy(p.tint || col('#ffffff')); this.hemi.color.copy(p.tint || col('#ffffff'));
    this.r.toneMappingExposure = clamp(.55 + lum * 1.4, .62, 1.08); this.sun.intensity = 1.6 + lum * 2.4; this.scene.environmentIntensity = .55 + lum * .8;
    this.r.render(this.scene, this.cam);
  }
  /* ---- moving furniture on the photo ---- */
  ray(e) { const b = this.box(); this.raycaster.setFromCamera(new THREE.Vector2((e.clientX - b.left) / b.width * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), this.cam); return this.raycaster; }
  floorAt(e) { const rc = this.ray(e), pt = new THREE.Vector3(); if (!rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt)) return null; return this.world.worldToLocal(pt); }
  pick(e) {
    const rc = this.ray(e), hits = rc.intersectObjects(this.fs.objects(), true).filter(h => h.object.isMesh && h.object.userData.key && h.object.material.opacity !== 0);
    const nonRug = hits.find(h => S.layout.items[h.object.userData.key] && S.layout.items[h.object.userData.key].grp !== 'rug'); return (nonRug || hits[0] || {}).object?.userData.key || null;
  }
  down(e) {
    if (!this.sol || !this.sol.ok || !S.layout || S.step !== 3) return; const k = this.pick(e);
    if (!k) { if (S.sel) { S.sel = null; syncRows(); renderBar(); this.paint(); } return; }
    const it = S.layout.items[k], f = this.floorAt(e) || new THREE.Vector3(it.r.x, 0, it.r.y);
    this.cv.setPointerCapture(e.pointerId); S.sel = k; this.drag = { k, ox: f.x - it.r.x, oz: f.z - it.r.y }; syncRows(); renderBar(); this.cv.style.cursor = 'grabbing'; this.paint();
  }
  move(e) {
    if (!this.drag) { if (this.sol && this.sol.ok && S.layout && S.step === 3) this.cv.style.cursor = this.pick(e) ? 'grab' : ''; return; }
    const f = this.floorAt(e); if (!f) return; const it = S.layout.items[this.drag.k];
    it.r.x = clamp(Math.round(f.x - this.drag.ox), 0, S.layout.W - it.r.w); it.r.y = clamp(Math.round(f.z - this.drag.oz), 0, S.layout.L - it.r.h); this.paint();
  }
  updCard() {
    const c = this.card, L = S.layout, it = this.ph && this.ph.mode === 'place' && S.step === 3 && L && S.sel && L.items[S.sel]; if (!it) { c.hidden = true; return; }
    const p = it.p; c.innerHTML = `<b>${esc(p.name)}</b><span>${CATS[it.grp].label}, ${inch(p.w)} W × ${inch(p.d)} D, ${money(p.price)}</span><a href="${p.url}" target="_blank" rel="noopener">View at ${p.retailer}</a>`; c.hidden = false;
  }
  save() {
    const p = this.ph; if (!p) return; const k = Math.min(1, 2400 / Math.max(p.w, p.h)), W = Math.round(p.w * k), H = Math.round(p.h * k);
    const was = this.ph.mode; this.ph.mode = 'place';
    this.r.setPixelRatio(1); this.r.setSize(W, H, false); this.render3();
    const c = canvasOf(W, H), x = c.getContext('2d'); x.drawImage(p.im, 0, 0, W, H); x.drawImage(this.cv, 0, 0, W, H);
    this.ph.mode = was; this.paint(); download(c.toDataURL('image/jpeg', .92), 'fitroom-in-my-room.jpg');
  }
}
function download(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

/* ---------------- public API used by index.html ---------------- */
let R3 = null, PV = null;
const photoRoomOn = () => S.photoRoom !== false && S.real !== false && !!PV && PV.projections().length > 0;
const api = {
  ok: false,
  on3d() { return !!R3 && S.real !== false; },
  dirty3d() { if (R3) R3.dirty = true; },
  render3d(v) { if (R3) R3.render(v); },
  snap3d() { if (!R3) return; G3.redraw(true); download(R3.snapshot(), 'fitroom-3d-room.png'); },
  photoShow() { if (PV) PV.show(); },
  photoSync() { if (PV && PV.ph) PV.paint(); },
  photoSet(src) { if (PV) PV.setPhoto(src); },
  hasPhoto() { return !!(PV && PV.ph); },
  photoCount() { return PV ? PV.projections().length : 0; },
  photoRoomOn: () => photoRoomOn(),
  /* glide the 3D camera to where photo angle i was taken */
  flyTo(i) { const sh = PV && PV.shots.filter(x => x.done && x.sol && x.sol.ok)[i]; if (!sh) return; const [e, t] = PV.standing(sh); G3.lookFrom([e.x, e.y, e.z], [t.x, t.y, t.z], true); },
  shotWalls() { return PV ? PV.shots.filter(x => x.done && x.sol && x.sol.ok).map(x => x.wall) : []; },
  _pv: () => PV, _r3: () => R3
};
try {
  R3 = new Real3D(document.getElementById('c3r'));
  PV = new PhotoView();
  api.ok = true;
} catch (e) { console.warn('Fitroom realistic view unavailable', e); }
window.FR_REAL = api;
listeners.add(() => { if (R3) R3.dirty = true; if (window.G3 || typeof G3 !== 'undefined') G3.redraw(); if (PV && PV.ph) PV.paint(); });
loadModel('plant', 'models/plant.glb', prepPlant);
loadModel('chair', 'models/chair.glb', prepChair);
if (typeof G3 !== 'undefined') G3.redraw();
if (typeof S !== 'undefined' && S.view === 'photo') applyView();
document.dispatchEvent(new Event('fitroom-real-ready'));
