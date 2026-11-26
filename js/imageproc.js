// Image processing: loading, rotation, page detection, perspective warp,
// binarisation and detection of ruled lines, tables and checkboxes.

export async function fileToCanvas(file, maxSide = 4200) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file could not be read as an image.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = src.width, h = src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(Math.round(w * k), Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export function rotateCanvas(src, clockwise = true) {
  const c = makeCanvas(src.height, src.width);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((clockwise ? 1 : -1) * Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function toGray(imgData) {
  const d = imgData.data, n = d.length / 4, g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// Find the sheet of paper in a photo: the largest bright connected region.
export function detectPageCorners(canvas) {
  const W = canvas.width, H = canvas.height;
  const full = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const s = Math.min(1, 360 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
  const small = makeCanvas(w, h);
  const ctx = small.getContext('2d');
  ctx.filter = 'blur(2px)';
  ctx.drawImage(canvas, 0, 0, w, h);
  const gray = toGray(ctx.getImageData(0, 0, w, h));
  const t = otsu(gray);
  const label = new Int32Array(w * h).fill(-1);
  let best = null;
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || gray[start] <= t) continue;
    let sp = 0, area = 0;
    stack[sp++] = start;
    label[start] = start;
    let tl = Infinity, br = -Infinity, tr = -Infinity, bl = Infinity;
    const pts = { tl: 0, br: 0, tr: 0, bl: 0 };
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p / w) | 0;
      const a = x + y, b = x - y;
      if (a < tl) { tl = a; pts.tl = p; }
      if (a > br) { br = a; pts.br = p; }
      if (b > tr) { tr = b; pts.tr = p; }
      if (b < bl) { bl = b; pts.bl = p; }
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && label[q] === -1 && gray[q] > t) { label[q] = start; stack[sp++] = q; }
      }
    }
    if (!best || area > best.area) best = { area, pts };
  }
  if (!best) return full;
  const ratio = best.area / (w * h);
  if (ratio < 0.12 || ratio > 0.9) return full;
  const P = (p) => ({ x: Math.min(W, Math.max(0, (p % w) / s)), y: Math.min(H, Math.max(0, ((p / w) | 0) / s)) });
  const corners = [P(best.pts.tl), P(best.pts.tr), P(best.pts.br), P(best.pts.bl)];
  // sanity: quad must be reasonably large
  const area = Math.abs(polyArea(corners));
  if (area < W * H * 0.1) return full;
  return corners;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return a / 2;
}

function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let max = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[max][i])) max = r;
    [A[i], A[max]] = [A[max], A[i]];
    [b[i], b[max]] = [b[max], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

// Homography that maps destination (u,v) to source (x,y).
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i], { x, y } = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve(A, b);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Crop + straighten the quadrilateral `corners` (tl,tr,br,bl) into a flat page.
export function warpPerspective(src, corners, minW = 2000, maxW = 2480) {
  const [tl, tr, br, bl] = corners;
  let outW = Math.max(dist(tl, tr), dist(bl, br));
  let outH = Math.max(dist(tl, bl), dist(tr, br));
  const k = outW < minW ? minW / outW : outW > maxW ? maxW / outW : 1;
  outW = Math.round(outW * k); outH = Math.round(outH * k);
  const Hm = homography(
    [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }],
    corners,
  );
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(outW, outH);
  const octx = out.getContext('2d');
  const od = octx.createImageData(outW, outH);
  const o = od.data;
  const [a, b, c, d, e, f, g, h] = Hm;
  // When shrinking, average several samples per output pixel so thin pen
  // strokes don't break up; when enlarging, one bilinear sample is enough.
  const ss = k < 0.9 ? 3 : 1;
  const offs = [];
  for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) offs.push([(i + 0.5) / ss - 0.5, (j + 0.5) / ss - 0.5]);
  const acc = [0, 0, 0];
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      acc[0] = acc[1] = acc[2] = 0;
      for (const [du, dv] of offs) {
        const uu = u + 0.5 + du, vv = v + 0.5 + dv;
        const den = g * uu + h * vv + 1;
        let x = (a * uu + b * vv + c) / den - 0.5, y = (d * uu + e * vv + f) / den - 0.5;
        x = Math.min(sw - 1.001, Math.max(0, x));
        y = Math.min(sh - 1.001, Math.max(0, y));
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
          const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
          acc[ch] += top + (bot - top) * fy;
        }
      }
      const oi = (v * outW + u) * 4, n = offs.length;
      o[oi] = acc[0] / n; o[oi + 1] = acc[1] / n; o[oi + 2] = acc[2] / n;
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// Adaptive (local mean) threshold. Returns 1 for ink, 0 for paper.
export function binarize(gray, w, h) {
  const r = Math.max(8, Math.round(Math.max(w, h) / 70));
  const W1 = w + 1;
  const integ = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
    }
  }
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const g = gray[y * w + x];
      bin[y * w + x] = g < mean * 0.84 && mean - g > 12 ? 1 : 0;
    }
  }
  return bin;
}

// Group runs of ink along one axis into straight line segments.
// get(o, i): ink at outer index o (row for horizontal), inner index i.
function scanLines(get, outer, inner, minRun) {
  const active = [], done = [];
  for (let o = 0; o < outer; o++) {
    const runs = [];
    let start = -1, last = -10, cnt = 0;
    for (let i = 0; i < inner; i++) {
      if (!get(o, i)) continue;
      if (start >= 0 && i - last > 3) {
        if (last - start + 1 >= minRun) runs.push([start, last, cnt]);
        start = -1;
      }
      if (start < 0) { start = i; cnt = 0; }
      last = i; cnt++;
    }
    if (start >= 0 && last - start + 1 >= minRun) runs.push([start, last, cnt]);

    for (const [a, b, n] of runs) {
      let g = null;
      for (const cand of active) {
        const [pa, pb] = cand.lastO === o ? [cand.pa, cand.pb] : [cand.la, cand.lb];
        if (pa < 0) continue;
        if (a <= pb + 1 && b >= pa - 1) { g = cand; break; }
      }
      if (!g) {
        active.push({ a, b, la: a, lb: b, pa: -1, pb: -1, lastO: o, firstO: o, sum: o * n, cnt: n });
        continue;
      }
      if (g.lastO < o) { g.pa = g.la; g.pb = g.lb; g.la = a; g.lb = b; g.lastO = o; }
      else { g.la = Math.min(g.la, a); g.lb = Math.max(g.lb, b); }
      g.a = Math.min(g.a, a); g.b = Math.max(g.b, b);
      g.sum += o * n; g.cnt += n;
    }
    for (let k = active.length - 1; k >= 0; k--) {
      if (active[k].lastO < o - 2) done.push(active.splice(k, 1)[0]);
    }
  }
  done.push(...active);
  return done.map((g) => ({
    a: g.a, b: g.b, pos: g.sum / g.cnt,
    t: Math.max(1, g.cnt / (g.b - g.a + 1)),
    len: g.b - g.a + 1,
  }));
}

function coverage(intervals, a, b) {
  if (b <= a) return 1;
  const iv = intervals.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s).sort((p, q) => p[0] - q[0]);
  let covered = 0, cur = -Infinity, curS = 0;
  for (const [s, e] of iv) {
    if (s > cur) { if (cur > -Infinity) covered += cur - curS; curS = s; cur = e; }
    else cur = Math.max(cur, e);
  }
  if (cur > -Infinity) covered += cur - curS;
  return covered / (b - a);
}

function clusterValues(vals, tol) {
  const s = [...vals].sort((a, b) => a - b), out = [];
  let group = [];
  for (const v of s) {
    if (group.length && v - group[group.length - 1] > tol) { out.push(group.reduce((p, q) => p + q, 0) / group.length); group = []; }
    group.push(v);
  }
  if (group.length) out.push(group.reduce((p, q) => p + q, 0) / group.length);
  return out;
}

function buildCells(Hs, Vs, tol) {
  const ys = clusterValues(Hs.map((l) => l.y), tol);
  const xs = clusterValues(Vs.map((l) => l.x), tol);
  const hasH = (y, xa, xb) => coverage(Hs.filter((l) => Math.abs(l.y - y) <= tol).map((l) => [l.x1, l.x2]), xa + tol, xb - tol) >= 0.75;
  const hasV = (x, ya, yb) => coverage(Vs.filter((l) => Math.abs(l.x - x) <= tol).map((l) => [l.y1, l.y2]), ya + tol, yb - tol) >= 0.75;
  const occ = ys.map(() => xs.map(() => false));
  const cells = [];
  for (let i = 0; i < ys.length - 1; i++) {
    let j = 0;
    while (j < xs.length - 1) {
      if (occ[i][j] || !hasV(xs[j], ys[i], ys[i + 1])) { j++; continue; }
      let k = j + 1;
      while (k < xs.length && !hasV(xs[k], ys[i], ys[i + 1])) k++;
      if (k >= xs.length) break;
      if (!hasH(ys[i], xs[j], xs[k])) { j = k; continue; }
      let m = i + 1;
      while (m < ys.length && !hasH(ys[m], xs[j], xs[k])) m++;
      if (m >= ys.length) { j = k; continue; }
      for (let r = i; r < m; r++) for (let c = j; c < k; c++) occ[r][c] = true;
      cells.push({ x: xs[j], y: ys[i], w: xs[k] - xs[j], h: ys[m] - ys[i] });
      j = k;
    }
  }
  return cells;
}

// Hollow square connected components = checkboxes.
function findCheckboxes(bin, w, h) {
  const minS = Math.max(14, w * 0.011), maxS = w * 0.05;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes = [];
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || seen[start]) continue;
    let sp = 0, n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = start; seen[start] = 1;
    while (sp) {
      const p = stack[--sp];
      n++;
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && bin[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && bin[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && bin[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && bin[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < minS || bh < minS || bw > maxS || bh > maxS) continue;
    const ar = bw / bh;
    if (ar < 0.75 || ar > 1.33) continue;
    const band = Math.max(2, Math.round(Math.min(bw, bh) * 0.16));
    const side = (xa, xb, ya, yb, horiz) => {
      let hit = 0, tot = 0;
      if (horiz) {
        for (let x = xa; x <= xb; x++) { tot++; for (let y = ya; y <= yb; y++) if (bin[y * w + x]) { hit++; break; } }
      } else {
        for (let y = ya; y <= yb; y++) { tot++; for (let x = xa; x <= xb; x++) if (bin[y * w + x]) { hit++; break; } }
      }
      return hit / tot;
    };
    const ok = side(x0, x1, y0, y0 + band, true) > 0.88 && side(x0, x1, y1 - band, y1, true) > 0.88 &&
      side(x0, x0 + band, y0, y1, false) > 0.88 && side(x1 - band, x1, y0, y1, false) > 0.88;
    if (!ok) continue;
    // square corners: round letters like "o" have no ink there
    const corner = (cx, cy) => {
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x]) return true;
      }
      return false;
    };
    const k = Math.max(1, Math.round(band / 2));
    if (!corner(x0 + k, y0 + k) || !corner(x1 - k, y0 + k) || !corner(x0 + k, y1 - k) || !corner(x1 - k, y1 - k)) continue;
    // stroke thickness ≈ ink pixels of frame / perimeter
    let ink = 0, tot = 0;
    const inset = band + Math.max(2, Math.round(bw * 0.08));
    for (let y = y0 + inset; y <= y1 - inset; y++) for (let x = x0 + inset; x <= x1 - inset; x++) { ink += bin[y * w + x]; tot++; }
    const fill = tot ? ink / tot : 0;
    if (fill > 0.6) continue; // solid block, not a box
    const t = Math.max(1.5, Math.min(band, (n - ink) / (2 * (bw + bh))));
    boxes.push({ x: x0, y: y0, w: bw, h: bh, t, checked: fill > 0.06 });
  }
  return boxes;
}

// Detect ruled lines, table cells and checkboxes in a binarised page.
export function analyzeStructure(bin, w, h) {
  const at = (x, y) => bin[y * w + x];
  // ruled lines are thin; thicker "lines" are usually blurred words
  const maxT = Math.max(6, w * 0.0055);
  const marginX = w * 0.006, marginY = h * 0.006;
  const minH = Math.max(40, w * 0.03);
  const minV = Math.max(24, w * 0.015);
  const minVLong = h * 0.05;
  const tol = Math.max(4, Math.round(w * 0.004));

  const checks = findCheckboxes(bin, w, h);
  const inCheck = (x, y) => checks.some((c) => x >= c.x - 2 && x <= c.x + c.w + 2 && y >= c.y - 2 && y <= c.y + c.h + 2);

  // A real ruled line has mostly blank paper running alongside it; the top
  // of a bold "m" or the stem of an "l" does not.
  const sideInk = (get, a, b, o) => {
    let n = 0, tot = 0;
    for (let i = a; i <= b; i += 1) { tot++; n += get(o, i) ? 1 : 0; }
    return tot ? n / tot : 1;
  };
  const clean = (get, outerMax, l) => {
    const off = Math.ceil(l.t / 2) + 3;
    const o1 = Math.round(l.pos - off), o2 = Math.round(l.pos + off);
    const s1 = o1 >= 0 ? sideInk(get, l.a, l.b, o1) : 0;
    const s2 = o2 < outerMax ? sideInk(get, l.a, l.b, o2) : 0;
    return Math.max(s1, s2) < 0.45;
  };
  const getH = (o, i) => at(i, o), getV = (o, i) => at(o, i);
  const H = scanLines(getH, h, w, 12)
    .filter((l) => l.len >= minH && l.t <= maxT && l.pos > marginY && l.pos < h - marginY && clean(getH, h, l))
    .map((l) => ({ kind: 'h', x1: l.a, x2: l.b, y: l.pos, t: l.t, len: l.len }))
    .filter((l) => !inCheck((l.x1 + l.x2) / 2, l.y));
  const V = scanLines(getV, w, h, 12)
    .filter((l) => l.len >= minV && l.t <= maxT && l.pos > marginX && l.pos < w - marginX && clean(getV, w, l))
    .map((l) => ({ kind: 'v', y1: l.a, y2: l.b, x: l.pos, t: l.t, len: l.len }))
    .filter((l) => !inCheck(l.x, (l.y1 + l.y2) / 2));

  // union-find clusters of intersecting horizontals and verticals
  const n = H.length + V.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < H.length; i++) {
    const hl = H[i];
    for (let j = 0; j < V.length; j++) {
      const vl = V[j];
      if (vl.x >= hl.x1 - tol && vl.x <= hl.x2 + tol && hl.y >= vl.y1 - tol && hl.y <= vl.y2 + tol) {
        const a = find(i), b = find(H.length + j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, { H: [], V: [] });
    const c = clusters.get(r);
    if (i < H.length) c.H.push(H[i]); else c.V.push(V[i - H.length]);
  }

  const lines = [], cells = [], fillLines = [];
  const used = new Set();
  for (const cl of clusters.values()) {
    if (cl.H.length < 2 || cl.V.length < 2) continue;
    const found = buildCells(cl.H, cl.V, tol).filter((c) => c.w > 12 && c.h > 12);
    if (!found.length) continue;
    cells.push(...found);
    for (const l of [...cl.H, ...cl.V]) { used.add(l); lines.push(l); }
  }
  // a line to write on is at least ~1.3 cm long; shorter dark marks are noise
  const minFill = w * 0.06;
  for (const l of H) {
    if (used.has(l) || l.len < minFill) continue;
    lines.push(l);
    fillLines.push(l);
  }
  for (const l of V) {
    if (used.has(l) || l.len < minVLong) continue;
    lines.push(l);
  }
  for (const c of checks) {
    const t = c.t;
    lines.push(
      { kind: 'h', x1: c.x, x2: c.x + c.w - 1, y: c.y + t / 2, t, len: c.w },
      { kind: 'h', x1: c.x, x2: c.x + c.w - 1, y: c.y + c.h - t / 2, t, len: c.w },
      { kind: 'v', y1: c.y, y2: c.y + c.h - 1, x: c.x + t / 2, t, len: c.h },
      { kind: 'v', y1: c.y, y2: c.y + c.h - 1, x: c.x + c.w - t / 2, t, len: c.h },
    );
  }
  return { lines, cells, checks, fillLines, tol };
}

// Page prepared for text recognition: shadows and uneven light are evened out
// (each pixel divided by its local background brightness) but the greyscale
// edges of letters are kept, which reads far better than pure black/white.
// Ruled lines are painted out so they aren't mistaken for characters.
export function ocrCanvasFrom(gray, w, h, lines) {
  const r = Math.max(10, Math.round(Math.max(w, h) / 45));
  const W1 = w + 1;
  const integ = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
    }
  }
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      // paper is a little brighter than the local mean (which includes ink)
      const bg = Math.max(24, mean * 1.08);
      let t = gray[y * w + x] / bg;
      t = t >= 0.92 ? 1 : Math.pow(Math.max(0, t / 0.92), 1.6);
      const v = Math.round(t * 255), j = (y * w + x) * 4;
      d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = '#fff';
  for (const l of lines) {
    const pad = 2 + l.t / 2;
    if (l.kind === 'h') ctx.fillRect(l.x1 - 2, l.y - pad, l.x2 - l.x1 + 4, pad * 2);
    else ctx.fillRect(l.x - pad, l.y1 - 2, pad * 2, l.y2 - l.y1 + 4);
  }
  return c;
}
