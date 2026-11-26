// Turns a page image into an editable document: ruled lines, table cells,
// fill-in fields, checkboxes and positioned text.
import { toGray, binarize, analyzeStructure, ocrCanvasFrom } from './imageproc.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
let worker = null, workerLang = null, progressCb = null;

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  if (!window.Tesseract) throw new Error('The OCR engine failed to load. Check your internet connection and reload the page.');
  const opts = {
    workerPath: VENDOR + 'tesseract/worker.min.js',
    corePath: VENDOR + 'tesseract/core',
    logger: (m) => progressCb && progressCb(m),
  };
  if (lang === 'eng') opts.langPath = VENDOR + 'tessdata';
  worker = await window.Tesseract.createWorker(lang, 1, opts);
  await worker.setParameters({ preserve_interword_spaces: '1' });
  workerLang = lang;
  return worker;
}

let uid = 0;
export const newId = () => Date.now().toString(36) + (uid++).toString(36) + Math.random().toString(36).slice(2, 6);

const median = (arr, fallback) => {
  if (!arr.length) return fallback;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const inside = (px, py, r, pad = 0) => px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
const DOTS = /^[._…·\-–—:]{4,}$/;
const DOTS_TAIL = /^(.*?[^._…·])([._…·]{4,})$/;

export async function scanCanvas(canvas, lang, onStep) {
  const W = canvas.width, H = canvas.height;
  onStep?.('lines', 0);
  await tick();
  const gray = toGray(canvas.getContext('2d').getImageData(0, 0, W, H));
  const bin = binarize(gray, W, H);
  await tick();
  const st = analyzeStructure(bin, W, H);
  const ocrCanvas = ocrCanvasFrom(bin, W, H, st.lines);

  onStep?.('ocr', 0);
  progressCb = (m) => {
    if (m.status === 'recognizing text') onStep?.('ocr', m.progress);
    else if (/loading|initializ/.test(m.status)) onStep?.('ocr-load', m.progress);
  };
  const wk = await getWorker(lang);
  const { data } = await wk.recognize(ocrCanvas);
  progressCb = null;
  onStep?.('build', 0);
  await tick();
  return buildElements(W, H, st, data, bin);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function buildElements(W, H, st, data, bin) {
  const els = [];
  const tol = st.tol;

  // ---- OCR lines → words with line context
  const ocrLines = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) ocrLines.push(line);
  if (!ocrLines.length && data.lines) ocrLines.push(...data.lines);

  const lineHeights = [];
  const words = [];
  ocrLines.forEach((line, li) => {
    const lb = line.bbox;
    const rowH = line.rowAttributes?.row_height;
    const lh = lb.y1 - lb.y0;
    let font = rowH ? rowH * 0.92 : lh * 0.8;
    font = Math.min(font, lh * 1.15);
    const good = (line.words || []).filter((wd) => {
      const t = (wd.text || '').trim();
      if (!t) return false;
      if (DOTS.test(t)) return true;
      if (wd.confidence < 35) return false;
      if (wd.confidence < 60 && !/[\p{L}\p{N}]/u.test(t)) return false;
      return true;
    });
    if (good.length && line.confidence > 40) lineHeights.push(font);
    for (const wd of good) {
      const b = wd.bbox;
      words.push({ text: wd.text.trim(), x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, line: li, ly0: lb.y0, ly1: lb.y1, font, used: false });
    }
  });
  const baseFont = Math.max(10, median(lineHeights, W * 0.016));
  const fieldH = Math.round(baseFont * 1.45);
  const cx = (wd) => (wd.x0 + wd.x1) / 2, cy = (wd) => (wd.y0 + wd.y1) / 2;

  // ---- ruled lines
  for (const l of st.lines) {
    const t = Math.max(1.5, Math.min(l.t, 8));
    if (l.kind === 'h') els.push({ id: newId(), type: 'line', x: l.x1, y: l.y - t / 2, w: l.x2 - l.x1 + 1, h: t });
    else els.push({ id: newId(), type: 'line', x: l.x - t / 2, y: l.y1, w: t, h: l.y2 - l.y1 + 1 });
  }

  // ---- checkboxes
  for (const c of st.checks) {
    const r = { x: c.x + c.t, y: c.y + c.t, w: c.w - 2 * c.t, h: c.h - 2 * c.t };
    for (const wd of words) if (!wd.used && inside(cx(wd), cy(wd), c, 2)) wd.used = true;
    els.push({ id: newId(), type: 'check', ...r, checked: !!c.checked });
  }

  // ---- table cells
  const cellRects = [];
  for (const c of st.cells) {
    const inset = 3;
    const cell = { x: c.x + inset, y: c.y + inset, w: c.w - inset * 2, h: c.h - inset * 2 };
    cellRects.push(c);
    const inCell = words.filter((wd) => !wd.used && inside(cx(wd), cy(wd), c));
    const cellFont = Math.max(9, Math.min(baseFont, cell.h * 0.62));
    if (!inCell.length) {
      els.push({ id: newId(), type: 'cell', ...cell, value: '', fontSize: cellFont });
      continue;
    }
    inCell.forEach((wd) => (wd.used = true));
    // label text stays as static text, remaining free space becomes fillable
    const segs = segmentWords(inCell, Infinity);
    for (const s of segs) els.push(textEl(s));
    const lb = bbox(inCell);
    const spaceBelow = cell.y + cell.h - lb.y1;
    const spaceRight = cell.x + cell.w - lb.x1;
    if (spaceBelow >= baseFont * 1.6) {
      const y = lb.y1 + 2;
      els.push({ id: newId(), type: 'cell', x: cell.x, y, w: cell.w, h: cell.y + cell.h - y, value: '', fontSize: Math.min(cellFont, baseFont) });
    } else if (/[:：]$/.test(segs[segs.length - 1].map((x) => x.text).join(' ')) && spaceRight >= Math.max(cell.w * 0.3, W * 0.05)) {
      const x = lb.x1 + baseFont * 0.4;
      els.push({ id: newId(), type: 'cell', x, y: cell.y, w: cell.x + cell.w - x, h: cell.h, value: '', fontSize: cellFont });
    }
  }

  // ---- fill-in lines ("Name: ________")
  for (const l of st.fillLines) {
    const mid = (l.x1 + l.x2) / 2;
    if (cellRects.some((c) => inside(mid, l.y, c, -2))) continue;
    const f = { x: l.x1, y: l.y - fieldH - l.t / 2, w: l.x2 - l.x1, h: fieldH };
    const on = words.filter((wd) => !wd.used && cx(wd) > f.x && cx(wd) < f.x + f.w && wd.y1 <= l.y + tol && wd.y1 >= l.y - fieldH * 1.2);
    on.forEach((wd) => (wd.used = true));
    const value = on.sort((a, b) => a.x0 - b.x0).map((wd) => wd.text).join(' ');
    els.push({ id: newId(), type: 'field', ...f, value, fontSize: baseFont });
  }

  // ---- dotted leaders ("Name: ..........")
  for (const wd of words) {
    if (wd.used) continue;
    let fx0;
    const fx1 = wd.x1;
    if (DOTS.test(wd.text)) { fx0 = wd.x0; wd.used = true; }
    else {
      const m = wd.text.match(DOTS_TAIL);
      if (!m) continue;
      fx0 = wd.x0 + (wd.x1 - wd.x0) * (m[1].length / wd.text.length);
      wd.text = m[1];
      wd.x1 = fx0 - 2;
    }
    els.push({ id: newId(), type: 'field', x: fx0, y: wd.ly1 - fieldH, w: Math.max(fx1 - fx0, 40), h: fieldH, value: '', fontSize: baseFont });
  }

  // ---- remaining text → positioned text segments
  const free = words.filter((wd) => !wd.used);
  const segs = segmentWords(free, baseFont);
  const textEls = segs.map(textEl);
  els.push(...textEls);

  // ---- "Label:" followed by empty space → add a field
  const blockers = els.filter((e) => e.type !== 'line' || e.h > e.w);
  for (const t of textEls) {
    if (!/[:：]$/.test(t.text)) continue;
    const y0 = t.y, y1 = t.y + t.h;
    const start = t.x + t.w + baseFont * 0.5;
    let end = W * 0.95;
    for (const b of blockers) {
      if (b === t) continue;
      if (b.y < y1 && b.y + b.h > y0 && b.x + b.w > start - 1 && b.x < end) end = Math.min(end, b.x - baseFont * 0.5);
      if (b.type === 'field' && b.y + b.h >= y0 - 2 && b.y <= y1 && b.x < start + baseFont * 2 && b.x + b.w > start) end = -1;
    }
    if (end - start >= W * 0.12) {
      els.push({ id: newId(), type: 'field', x: start, y: t.y + t.h / 2 - fieldH / 2, w: end - start, h: fieldH, value: '', fontSize: baseFont, underline: true });
    }
  }

  return { elements: sortReadingOrder(els), baseFont };
}

function bbox(ws) {
  return {
    x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)),
    x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)),
  };
}

// Split OCR lines into segments wherever there's a big horizontal gap.
function segmentWords(ws, baseFont) {
  const byLine = new Map();
  for (const wd of ws) {
    if (!byLine.has(wd.line)) byLine.set(wd.line, []);
    byLine.get(wd.line).push(wd);
  }
  const segs = [];
  for (const list of byLine.values()) {
    list.sort((a, b) => a.x0 - b.x0);
    let cur = [];
    const gapMax = Math.max(list[0].font, Math.min(baseFont, 200)) * 1.6;
    for (const wd of list) {
      if (cur.length && wd.x0 - cur[cur.length - 1].x1 > gapMax) { segs.push(cur); cur = []; }
      cur.push(wd);
    }
    if (cur.length) segs.push(cur);
  }
  return segs;
}

function textEl(seg) {
  const b = bbox(seg);
  const font = seg[0].font;
  const ly0 = Math.min(...seg.map((w) => w.ly0)), ly1 = Math.max(...seg.map((w) => w.ly1));
  const h = Math.max(ly1 - ly0, font * 1.1);
  return {
    id: newId(), type: 'text',
    x: b.x0, y: (ly0 + ly1) / 2 - h / 2, w: Math.max(b.x1 - b.x0, 4), h,
    text: seg.map((w) => w.text).join(' '),
    fontSize: Math.round(font * 10) / 10,
  };
}

const RANK = { line: 0, check: 1, cell: 1, field: 1, text: 2 };
export function sortReadingOrder(els) {
  return els.sort((a, b) => {
    const band = Math.abs(a.y - b.y) < 12 ? 0 : a.y - b.y;
    return band || a.x - b.x || RANK[a.type] - RANK[b.type];
  });
}
