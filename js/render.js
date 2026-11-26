// Draws a document onto a canvas. Used for PDF/PNG export, printing and thumbnails,
// so all outputs look identical.
export const DOC_FONT = 'Arial, Helvetica, "Liberation Sans", sans-serif';
const measureCtx = document.createElement('canvas').getContext('2d');

export function naturalWidth(text, fontSize, bold) {
  measureCtx.font = `${bold ? 'bold ' : ''}100px ${DOC_FONT}`;
  return measureCtx.measureText(text || '').width * fontSize / 100;
}

// Horizontal squeeze/stretch so recognised text occupies the same width as on paper.
export function fitRatio(el) {
  if (el.sx) return el.sx;
  const nat = naturalWidth(el.text, el.fontSize, el.bold);
  if (!nat) return 1;
  return Math.min(1.6, Math.max(0.6, el.w / nat));
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test).width > maxW && w.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

export function renderDoc(doc, targetWidth) {
  const s = targetWidth / doc.width;
  const c = document.createElement('canvas');
  c.width = Math.round(doc.width * s);
  c.height = Math.round(doc.height * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(s, s);
  const ink = '#111', fill = '#0b2a8a';

  for (const el of doc.elements) {
    ctx.save();
    switch (el.type) {
      case 'line':
        ctx.fillStyle = ink;
        ctx.fillRect(el.x, el.y, el.w, el.h);
        break;
      case 'text': {
        ctx.fillStyle = ink;
        ctx.font = `${el.bold ? 'bold ' : ''}${el.fontSize}px ${DOC_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.translate(el.x, el.y + el.h / 2);
        ctx.scale(fitRatio(el), 1);
        ctx.fillText(el.text, 0, 0);
        break;
      }
      case 'field': {
        if (!el.value) break;
        ctx.beginPath(); ctx.rect(el.x, el.y - el.h, el.w, el.h * 2); ctx.clip();
        ctx.fillStyle = fill;
        ctx.font = `${el.fontSize}px ${DOC_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(el.value, el.x + el.fontSize * 0.15, el.y + el.h / 2);
        break;
      }
      case 'cell': {
        if (!el.value) break;
        ctx.beginPath(); ctx.rect(el.x, el.y, el.w, el.h); ctx.clip();
        ctx.fillStyle = fill;
        ctx.font = `${el.fontSize}px ${DOC_FONT}`;
        ctx.textBaseline = 'middle';
        const pad = el.fontSize * 0.15, lh = el.fontSize * 1.2;
        const lines = wrapLines(ctx, el.value, el.w - pad * 2);
        lines.forEach((ln, i) => ctx.fillText(ln, el.x + pad, el.y + pad + lh * i + lh / 2));
        break;
      }
      case 'check': {
        if (!el.checked) break;
        const m = Math.min(el.w, el.h);
        ctx.strokeStyle = fill;
        ctx.lineWidth = Math.max(1.5, m * 0.14);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const x = el.x + (el.w - m) / 2, y = el.y + (el.h - m) / 2;
        ctx.beginPath();
        ctx.moveTo(x + m * 0.18, y + m * 0.52);
        ctx.lineTo(x + m * 0.42, y + m * 0.78);
        ctx.lineTo(x + m * 0.84, y + m * 0.22);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }
  return c;
}
