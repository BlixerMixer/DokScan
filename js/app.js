import { fileToCanvas, rotateCanvas, detectPageCorners, warpPerspective, makeCanvas } from './imageproc.js';
import { scanCanvas, newId, sortReadingOrder } from './scan.js';
import {
  saveDoc, loadDoc, listDocs, deleteDoc, prefs, setAccount, syncAll, onSyncStatus, syncStatus,
  flushPushes, guestDocCount, adoptGuestDocs, unsyncedCount, purgeLocal,
} from './storage.js';
import { cloudEnabled, sb, siteUrl, friendlyError } from './cloud.js';
import { renderDoc, fitRatio, naturalWidth } from './render.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const LANGS = [
  ['eng', 'English'], ['swe+eng', 'Swedish'], ['nor+eng', 'Norwegian'], ['dan+eng', 'Danish'],
  ['fin+eng', 'Finnish'], ['pol+eng', 'Polish'], ['deu+eng', 'German'], ['fra+eng', 'French'],
  ['spa+eng', 'Spanish'], ['ita+eng', 'Italian'], ['nld+eng', 'Dutch'], ['por+eng', 'Portuguese'],
  ['ukr+eng', 'Ukrainian'], ['ara+eng', 'Arabic'],
];

// ------------------------------------------------------------------ helpers
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

const busy = {
  show(text, sub = '') { $('#busy').hidden = false; this.set(text, null, sub); },
  set(text, frac, sub) {
    if (text) $('#busyText').textContent = text;
    if (sub !== undefined) $('#busySub').textContent = sub;
    $('#busyBar').style.width = frac == null ? '0%' : `${Math.round(frac * 100)}%`;
  },
  hide() { $('#busy').hidden = true; },
};

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// In-page confirmation (native confirm() is blocked in some embedded viewers).
function ask(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'busy ask';
    wrap.innerHTML = `<div class="busy-card" role="alertdialog" aria-modal="true">
      <p class="ask-msg"></p>
      <div class="ask-row"><button class="btn" data-r="0">Cancel</button>
      <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-r="1"></button></div></div>`;
    wrap.querySelector('.ask-msg').textContent = message;
    wrap.querySelector('[data-r="1"]').textContent = okLabel;
    const done = (v) => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-r="1"]').focus();
  });
}

function setHash(h) {
  try { history.replaceState(null, '', h || location.pathname + location.search); } catch { /* sandboxed viewer */ }
}

const safeName = (s) => (s || 'document').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function showView(name) {
  for (const v of ['auth', 'home', 'crop', 'editor']) $(`#view-${v}`).hidden = v !== name;
  updateStatus();
}

function canvasFromDataURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Stored image could not be loaded'));
    img.src = url;
  });
}

// ------------------------------------------------------------------ language
function initLang() {
  const cur = prefs.get('lang', 'eng');
  for (const sel of [$('#langSelect'), $('#langSelect2')]) {
    sel.innerHTML = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
    sel.value = cur;
    sel.addEventListener('change', () => {
      prefs.set('lang', sel.value);
      $('#langSelect').value = $('#langSelect2').value = sel.value;
    });
  }
}

// ------------------------------------------------------------------ home / library
async function renderLibrary(sync = true) {
  if (sync && account.user) syncAll().then((changed) => { if (changed && !$('#view-home').hidden) renderLibrary(false); });
  const list = $('#docList');
  let docs = [];
  try { docs = await listDocs(); } catch (e) { console.error(e); }
  if (!docs.length) {
    list.innerHTML = '<div class="empty">No documents yet. Scan one to get started.</div>';
    return;
  }
  list.innerHTML = '';
  for (const d of docs) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = `
      <button class="thumb" title="Open">${d.thumb ? `<img alt="" src="${d.thumb}">` : ''}</button>
      <div class="info"><div class="name"></div><div class="date">Edited ${fmtDate(d.updated)}</div></div>
      <div class="row">
        <button class="btn" data-a="open">Open</button>
        <button class="btn" data-a="copy" title="Make an empty copy to fill in again">Blank copy</button>
        <button class="btn danger" data-a="del" title="Delete">✕</button>
      </div>`;
    card.querySelector('.name').textContent = d.name;
    card.querySelector('.name').title = d.name;
    card.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a || (e.target.closest('.thumb') ? 'open' : null);
      if (a === 'open') openDoc(d.id);
      else if (a === 'copy') blankCopy(d.id);
      else if (a === 'del' && await ask(`Delete “${d.name}”? This cannot be undone.`, 'Delete', true)) {
        await deleteDoc(d.id);
        if (prefs.get(lastDocKey()) === d.id) prefs.set(lastDocKey(), null);
        renderLibrary();
      }
    });
    list.appendChild(card);
  }
}

async function blankCopy(id) {
  const src = await loadDoc(id);
  if (!src) return;
  const doc = freshCopy(src);
  doc.name = src.name + ' (blank)';
  doc.created = Date.now();
  for (const el of doc.elements) {
    if (el.type === 'field' || el.type === 'cell') el.value = '';
    if (el.type === 'check') el.checked = false;
  }
  await saveDoc(doc, thumbFor(doc));
  openDoc(doc.id);
}

function goHome() {
  flushSave();
  editor.doc = null;
  prefs.set(lastDocKey(), null);
  showView('home');
  renderLibrary();
  setHash('');
}

// ------------------------------------------------------------------ input of images
async function handleImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image file (JPG, PNG, …).'); return; }
  busy.show('Loading image…');
  try {
    crop.canvas = await fileToCanvas(file);
    crop.name = file.name.replace(/\.[^.]+$/, '') || 'Scanned document';
    crop.corners = detectPageCorners(crop.canvas);
    showView('crop');
    requestAnimationFrame(drawCrop);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could not open that image.');
  } finally {
    busy.hide();
  }
}

// ------------------------------------------------------------------ crop view
const crop = { canvas: null, corners: null, name: '', scale: 1, drag: -1 };

function drawCrop() {
  if (!crop.canvas) return;
  const stage = $('#cropStage'), cv = $('#cropCanvas');
  const maxW = stage.clientWidth, maxH = Math.max(300, stage.clientHeight);
  const s = Math.min(maxW / crop.canvas.width, maxH / crop.canvas.height, 1);
  cv.width = Math.round(crop.canvas.width * s);
  cv.height = Math.round(crop.canvas.height * s);
  cv.getContext('2d').drawImage(crop.canvas, 0, 0, cv.width, cv.height);
  crop.scale = s;
  const svg = $('#cropSvg');
  const r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  svg.style.left = `${r.left - sr.left}px`;
  svg.style.top = `${r.top - sr.top}px`;
  svg.setAttribute('width', cv.width);
  svg.setAttribute('height', cv.height);
  const pts = crop.corners.map((p) => [p.x * s, p.y * s]);
  const rad = matchMedia('(pointer: coarse)').matches ? 16 : 10;
  svg.innerHTML = `<polygon points="${pts.map((p) => p.join(',')).join(' ')}"/>` +
    pts.map((p, i) => `<circle data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="${rad}" class="${crop.drag === i ? 'drag' : ''}"/>`).join('');
}

function initCrop() {
  const svg = $('#cropSvg');
  svg.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('circle');
    if (!c) return;
    crop.drag = +c.dataset.i;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (crop.drag < 0) return;
    const r = svg.getBoundingClientRect();
    const x = Math.min(crop.canvas.width, Math.max(0, (e.clientX - r.left) / crop.scale));
    const y = Math.min(crop.canvas.height, Math.max(0, (e.clientY - r.top) / crop.scale));
    crop.corners[crop.drag] = { x, y };
    drawCrop();
  });
  const end = () => { if (crop.drag >= 0) { crop.drag = -1; drawCrop(); } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (!$('#view-crop').hidden) drawCrop(); });

  $('#cropBack').onclick = () => { crop.canvas = null; showView('home'); };
  const rot = (cw) => {
    crop.canvas = rotateCanvas(crop.canvas, cw);
    crop.corners = detectPageCorners(crop.canvas);
    drawCrop();
  };
  $('#rotL').onclick = () => rot(false);
  $('#rotR').onclick = () => rot(true);
  $('#cropAuto').onclick = () => {
    crop.corners = detectPageCorners(crop.canvas);
    drawCrop();
    const W = crop.canvas.width, H = crop.canvas.height, c = crop.corners;
    if (c[0].x === 0 && c[0].y === 0 && c[2].x === W && c[2].y === H) toast('No clear page edge found – using the whole image. Drag the corners to adjust.');
  };
  $('#cropFull').onclick = () => {
    const W = crop.canvas.width, H = crop.canvas.height;
    crop.corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    drawCrop();
  };
  $('#cropGo').onclick = runScan;
}

const STEP_TEXT = {
  lines: 'Finding lines, tables and boxes…',
  'ocr-load': 'Loading text recognition…',
  ocr: 'Reading the text…',
  build: 'Rebuilding the layout…',
};

function onScanStep(step, frac) {
  const sub = step === 'ocr-load' ? 'The first scan downloads the language data – this can take a moment.' : '';
  busy.set(STEP_TEXT[step], frac, sub);
}

async function runScan() {
  busy.show('Straightening the page…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const page = warpPerspective(crop.canvas, crop.corners);
    const lang = prefs.get('lang', 'eng');
    const result = await scanCanvas(page, lang, onScanStep);
    const doc = {
      id: newId(),
      name: crop.name,
      created: Date.now(),
      updated: Date.now(),
      width: page.width,
      height: page.height,
      image: page.toDataURL('image/jpeg', 0.82),
      lang,
      elements: result.elements,
    };
    for (const el of doc.elements) if (el.type === 'text') el.sx = fitRatio(el);
    await saveDoc(doc, thumbFor(doc));
    crop.canvas = null;
    busy.hide();
    await openDoc(doc.id);
    reportScan(doc);
  } catch (e) {
    console.error(e);
    busy.hide();
    toast('Scanning failed: ' + (e.message || e), 6000);
  }
}

function reportScan(doc) {
  const n = (t) => doc.elements.filter((e) => e.type === t).length;
  const parts = [];
  if (n('cell')) parts.push(`${n('cell')} table cells`);
  if (n('field')) parts.push(`${n('field')} fill-in lines`);
  if (n('check')) parts.push(`${n('check')} checkboxes`);
  toast(parts.length ? `Found ${parts.join(', ')}. Click a field to type.` : 'No fields found – use “Edit layout” to add some.', 5000);
}

function newBlankDoc() {
  const doc = {
    id: newId(), name: 'Blank page', created: Date.now(), updated: Date.now(),
    width: 1240, height: 1754, image: null, elements: [],
  };
  saveDoc(doc, thumbFor(doc)).then(() => openDoc(doc.id, 'layout'));
}

// ------------------------------------------------------------------ editor
const editor = {
  doc: null, mode: 'fill', zoom: 1, sel: null, undo: [], redo: [], nodes: new Map(), editingText: null,
};

async function openDoc(id, mode = 'fill') {
  let doc;
  try {
    busy.show('Opening…');
    doc = await loadDoc(id);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    busy.hide();
  }
  if (!doc) { if (doc === null) toast('That document could not be found.'); goHome(); return; }
  editor.doc = doc;
  editor.sel = null;
  editor.undo = []; editor.redo = [];
  editor.zoom = 1;
  prefs.set(lastDocKey(), id);
  $('#docName').value = doc.name;
  $('#origToggle').checked = false;
  $('#origOpacity').hidden = true;
  $('#rescanBtn').hidden = !doc.image;
  $('#origToggle').parentElement.hidden = !doc.image;
  showView('editor');
  setMode(mode);
  renderPage();
  setSaved(true);
  setHash('#doc=' + id);
}

const pos = (v) => `calc(var(--s) * ${+v.toFixed(2)}px)`;

function placeNode(node, el) {
  node.style.left = pos(el.x);
  node.style.top = pos(el.y);
  node.style.width = pos(el.w);
  node.style.height = pos(el.h);
  if (el.fontSize) node.style.fontSize = pos(el.fontSize);
}

const CHECK_SVG = '<svg viewBox="0 0 10 10" width="100%" height="100%" aria-hidden="true"><path d="M1.8 5.2 4.2 7.8 8.4 2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function makeNode(el) {
  let n;
  switch (el.type) {
    case 'line':
      n = document.createElement('div');
      break;
    case 'text': {
      n = document.createElement('div');
      const sp = document.createElement('span');
      sp.textContent = el.text;
      sp.style.transform = `scaleX(${fitRatio(el)})`;
      n.appendChild(sp);
      n.style.lineHeight = pos(el.h);
      n.classList.toggle('bold', !!el.bold);
      break;
    }
    case 'field':
      n = document.createElement('input');
      n.type = 'text';
      n.value = el.value || '';
      n.autocomplete = 'off';
      n.setAttribute('aria-label', 'Field');
      if (el.underline) n.classList.add('underline');
      break;
    case 'cell':
      n = document.createElement('textarea');
      n.value = el.value || '';
      n.setAttribute('aria-label', 'Table cell');
      n.spellcheck = false;
      break;
    case 'check':
      n = document.createElement('div');
      n.tabIndex = 0;
      n.setAttribute('role', 'checkbox');
      n.setAttribute('aria-checked', String(!!el.checked));
      n.innerHTML = el.checked ? CHECK_SVG : '';
      break;
  }
  n.classList.add('el', 'el-' + el.type);
  n.dataset.id = el.id;
  placeNode(n, el);
  if (editor.mode === 'layout' && (el.type === 'field' || el.type === 'cell')) n.readOnly = true;
  return n;
}

function renderPage() {
  const { doc } = editor;
  const page = $('#page');
  page.innerHTML = '';
  editor.nodes.clear();
  page.style.width = pos(doc.width);
  page.style.height = pos(doc.height);
  if (doc.image) {
    const img = document.createElement('img');
    img.className = 'orig';
    img.src = doc.image;
    img.alt = '';
    img.hidden = !$('#origToggle').checked;
    img.style.opacity = $('#origOpacity').value / 100;
    page.appendChild(img);
  }
  const frag = document.createDocumentFragment();
  for (const el of doc.elements) {
    const n = makeNode(el);
    editor.nodes.set(el.id, n);
    frag.appendChild(n);
  }
  page.appendChild(frag);
  applyZoom();
  drawSelection();
}

function applyZoom() {
  const { doc } = editor;
  if (!doc) return;
  const wrap = $('#pageWrap');
  const avail = Math.max(200, wrap.clientWidth - 24);
  const fit = avail / doc.width;
  $('#page').style.setProperty('--s', (fit * editor.zoom).toFixed(5));
}

const elById = (id) => editor.doc.elements.find((e) => e.id === id);

// ---------- saving
let saveTimer = null, dirty = false;
let localSaving = false;
function setSaved(ok) { localSaving = !ok; updateStatus(); }
function updateStatus() {
  const el = $('#saveStatus');
  el.classList.remove('warn');
  if (!$('#view-auth').hidden) { el.textContent = ''; return; }
  const inEditor = !$('#view-editor').hidden;
  const st = syncStatus();
  if (inEditor && localSaving) { el.textContent = 'Saving…'; return; }
  if (st === 'local') { el.textContent = inEditor ? 'All changes saved' : ''; return; }
  if (st === 'syncing') el.textContent = 'Syncing…';
  else if (st === 'synced') el.textContent = inEditor ? 'Saved to your account' : 'Up to date';
  else { el.textContent = st === 'offline' ? 'Offline – saved on this device' : 'Sync problem – saved on this device'; el.classList.add('warn'); }
}
function scheduleSave() {
  dirty = true;
  setSaved(false);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !editor.doc) return;
  dirty = false;
  const doc = editor.doc;
  try {
    await saveDoc(doc, thumbFor(doc));
    if (editor.doc === doc && !dirty) setSaved(true);
  } catch (e) {
    console.error(e);
    $('#saveStatus').textContent = 'Could not save – storage may be full';
  }
}
function thumbFor(doc) {
  try { return renderDoc(doc, 240).toDataURL('image/jpeg', 0.75); } catch { return ''; }
}

// ---------- undo
function snapshot() {
  editor.undo.push(JSON.stringify(editor.doc.elements));
  if (editor.undo.length > 80) editor.undo.shift();
  editor.redo = [];
  updateUndoButtons();
}
function undoRedo(redo) {
  const from = redo ? editor.redo : editor.undo, to = redo ? editor.undo : editor.redo;
  if (!from.length) return;
  to.push(JSON.stringify(editor.doc.elements));
  editor.doc.elements = JSON.parse(from.pop());
  if (editor.sel && !elById(editor.sel)) editor.sel = null;
  renderPage();
  updateSelUI();
  updateUndoButtons();
  scheduleSave();
}
function updateUndoButtons() {
  $('#undoBtn').disabled = !editor.undo.length;
  $('#redoBtn').disabled = !editor.redo.length;
}

// ---------- modes
function setMode(mode) {
  commitTextEdit();
  editor.mode = mode;
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#layoutBar').hidden = mode !== 'layout';
  $('#page').classList.toggle('layout', mode === 'layout');
  for (const [id, n] of editor.nodes) {
    if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') n.readOnly = mode === 'layout';
  }
  if (mode !== 'layout') editor.sel = null;
  drawSelection();
  updateSelUI();
  updateUndoButtons();
  if (mode === 'layout') document.activeElement?.blur?.();
}

// ---------- selection & layout editing
function drawSelection() {
  $('#page').querySelector('.sel-box')?.remove();
  if (editor.mode !== 'layout' || !editor.sel) return;
  const el = elById(editor.sel);
  if (!el) return;
  const box = document.createElement('div');
  box.className = 'sel-box';
  const pad = 2;
  box.style.left = `calc(var(--s) * ${el.x}px - ${pad}px)`;
  box.style.top = `calc(var(--s) * ${el.y}px - ${pad}px)`;
  box.style.width = `calc(var(--s) * ${el.w}px + ${pad * 2}px)`;
  box.style.height = `calc(var(--s) * ${el.h}px + ${pad * 2}px)`;
  const h = document.createElement('div');
  h.className = 'handle';
  h.title = 'Drag to resize';
  box.appendChild(h);
  $('#page').appendChild(box);
}

const TYPE_NAMES = { text: 'Text', field: 'Line field', cell: 'Box field', check: 'Checkbox', line: 'Line' };
function updateSelUI() {
  const el = editor.sel && elById(editor.sel);
  $('#selLabel').textContent = el ? `Selected: ${TYPE_NAMES[el.type]}${el.type === 'text' ? ' (double-click to edit)' : ''}` : 'Click an element to select it';
  const hasFont = el && 'fontSize' in el;
  $('#fontDown').disabled = $('#fontUp').disabled = !hasFont;
  $('#boldBtn').disabled = !(el && el.type === 'text');
  $('#dupBtn').disabled = $('#delBtn').disabled = !el;
}

function select(id) {
  editor.sel = id;
  drawSelection();
  updateSelUI();
}

function refreshNode(el) {
  const old = editor.nodes.get(el.id);
  const n = makeNode(el);
  editor.nodes.set(el.id, n);
  old.replaceWith(n);
  drawSelection();
}

function initLayoutEditing() {
  const page = $('#page');
  let drag = null;

  page.addEventListener('pointerdown', (e) => {
    if (editor.mode !== 'layout') return;
    if (editor.editingText && e.target.closest('[contenteditable="true"]')) return;
    commitTextEdit();
    const s = parseFloat(page.style.getPropertyValue('--s'));
    if (e.target.classList.contains('handle')) {
      const el = elById(editor.sel);
      snapshot();
      drag = { kind: 'resize', el, sx: e.clientX, sy: e.clientY, w: el.w, h: el.h, s, moved: false };
    } else {
      const node = e.target.closest('.el');
      if (!node) { select(null); return; }
      const el = elById(node.dataset.id);
      select(el.id);
      drag = { kind: 'move', el, sx: e.clientX, sy: e.clientY, x: el.x, y: el.y, s, moved: false };
    }
    page.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  page.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / drag.s, dy = (e.clientY - drag.sy) / drag.s;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
    if (!drag.moved && drag.kind === 'move') snapshot();
    drag.moved = true;
    const el = drag.el;
    if (drag.kind === 'move') {
      el.x = Math.round(drag.x + dx); el.y = Math.round(drag.y + dy);
    } else {
      el.w = Math.max(4, Math.round(drag.w + dx));
      el.h = Math.max(el.type === 'line' ? 1 : 8, Math.round(drag.h + dy));
      if (el.type === 'text') { el.sx = el.w / Math.max(1, naturalWidth(el.text, el.fontSize, el.bold)); }
    }
    const n = editor.nodes.get(el.id);
    placeNode(n, el);
    if (el.type === 'text') { n.style.lineHeight = pos(el.h); n.firstChild.style.transform = `scaleX(${fitRatio(el)})`; }
    drawSelection();
  });
  const end = () => {
    if (!drag) return;
    if (drag.kind === 'resize' && !drag.moved) editor.undo.pop();
    if (drag.moved) scheduleSave();
    drag = null;
    updateUndoButtons();
  };
  page.addEventListener('pointerup', end);
  page.addEventListener('pointercancel', end);

  page.addEventListener('dblclick', (e) => {
    if (editor.mode !== 'layout') return;
    // pointer capture retargets the event to the page, so look under the cursor
    const node = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList?.contains('el-text'));
    if (!node) return;
    startTextEdit(node);
  });

  // layout toolbar
  $$('[data-add]').forEach((b) => b.addEventListener('click', () => addElement(b.dataset.add)));
  $('#delBtn').onclick = deleteSelected;
  $('#dupBtn').onclick = duplicateSelected;
  $('#fontUp').onclick = () => changeFont(1.1);
  $('#fontDown').onclick = () => changeFont(1 / 1.1);
  $('#boldBtn').onclick = () => {
    const el = elById(editor.sel);
    if (!el || el.type !== 'text') return;
    snapshot();
    el.bold = !el.bold;
    el.w = naturalWidth(el.text, el.fontSize, el.bold) * fitRatio(el);
    refreshNode(el);
    scheduleSave();
  };
}

function startTextEdit(node) {
  const el = elById(node.dataset.id);
  editor.editingText = { node, el, before: el.text };
  const sp = node.firstChild;
  sp.style.transform = 'none';
  node.contentEditable = 'true';
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(sp);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function commitTextEdit() {
  const ed = editor.editingText;
  if (!ed) return;
  editor.editingText = null;
  ed.node.contentEditable = 'false';
  const text = ed.node.textContent.replace(/\n/g, ' ');
  const el = ed.el;
  if (text !== ed.before) {
    snapshot();
    el.text = text;
    el.w = Math.max(4, naturalWidth(text, el.fontSize, el.bold) * fitRatio(el));
    scheduleSave();
  }
  if (!el.text.trim()) {
    editor.doc.elements = editor.doc.elements.filter((x) => x !== el);
    ed.node.remove();
    editor.nodes.delete(el.id);
    editor.sel = null;
    drawSelection();
    updateSelUI();
    return;
  }
  refreshNode(el);
}

function visibleCenter() {
  const wrap = $('#pageWrap'), page = $('#page');
  const s = parseFloat(page.style.getPropertyValue('--s'));
  const pr = page.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const cx = (Math.max(pr.left, wr.left) + Math.min(pr.right, wr.right)) / 2 - pr.left;
  const cy = (Math.max(pr.top, wr.top) + Math.min(pr.bottom, wr.bottom)) / 2 - pr.top;
  return { x: cx / s, y: cy / s };
}

function baseFont() {
  const fs = editor.doc.elements.filter((e) => e.type === 'field' || e.type === 'text').map((e) => e.fontSize).sort((a, b) => a - b);
  return fs.length ? fs[Math.floor(fs.length / 2)] : editor.doc.width * 0.018;
}

function addElement(kind) {
  const doc = editor.doc;
  const c = visibleCenter();
  const f = baseFont();
  const W = doc.width;
  let el;
  switch (kind) {
    case 'text':
      el = { type: 'text', text: 'Text', fontSize: f, h: f * 1.3 };
      el.w = naturalWidth(el.text, f);
      el.sx = 1;
      break;
    case 'field': el = { type: 'field', w: W * 0.3, h: f * 1.45, value: '', fontSize: f, underline: true }; break;
    case 'cell': el = { type: 'cell', w: W * 0.3, h: f * 4, value: '', fontSize: f }; break;
    case 'check': el = { type: 'check', w: f * 1.2, h: f * 1.2, checked: false }; break;
    case 'hline': el = { type: 'line', w: W * 0.3, h: 2 }; break;
    case 'vline': el = { type: 'line', w: 2, h: W * 0.1 }; break;
  }
  snapshot();
  el.id = newId();
  el.x = Math.round(c.x - el.w / 2);
  el.y = Math.round(c.y - el.h / 2);
  doc.elements.push(el);
  // an added checkbox or box field gets a printed outline so it shows on paper
  if (kind === 'check' || kind === 'cell') {
    const t = 2;
    doc.elements.push(
      { id: newId(), type: 'line', x: el.x - t, y: el.y - t, w: el.w + 2 * t, h: t },
      { id: newId(), type: 'line', x: el.x - t, y: el.y + el.h, w: el.w + 2 * t, h: t },
      { id: newId(), type: 'line', x: el.x - t, y: el.y, w: t, h: el.h },
      { id: newId(), type: 'line', x: el.x + el.w, y: el.y, w: t, h: el.h },
    );
  }
  if (kind === 'field') {
    el.underline = false;
    doc.elements.push({ id: newId(), type: 'line', x: el.x, y: el.y + el.h, w: el.w, h: 2 });
  }
  renderPage();
  select(el.id);
  scheduleSave();
}

function deleteSelected() {
  if (!editor.sel) return;
  snapshot();
  editor.doc.elements = editor.doc.elements.filter((e) => e.id !== editor.sel);
  editor.nodes.get(editor.sel)?.remove();
  editor.nodes.delete(editor.sel);
  select(null);
  scheduleSave();
}

function duplicateSelected() {
  const el = elById(editor.sel);
  if (!el) return;
  snapshot();
  const off = Math.max(10, editor.doc.width * 0.01);
  const copy = { ...structuredClone(el), id: newId(), x: el.x + off, y: el.y + off };
  editor.doc.elements.push(copy);
  const n = makeNode(copy);
  editor.nodes.set(copy.id, n);
  $('#page').appendChild(n);
  select(copy.id);
  scheduleSave();
}

function changeFont(k) {
  const el = elById(editor.sel);
  if (!el || !('fontSize' in el)) return;
  snapshot();
  el.fontSize = Math.max(4, Math.round(el.fontSize * k * 10) / 10);
  if (el.type === 'text') {
    el.w *= k;
    el.h = Math.max(el.h, el.fontSize * 1.15);
  }
  refreshNode(el);
  scheduleSave();
}

// ---------- fill-in interactions
function initFill() {
  const page = $('#page');
  page.addEventListener('input', (e) => {
    const n = e.target;
    if (!n.dataset?.id || editor.mode !== 'fill') return;
    const el = elById(n.dataset.id);
    if (el && (el.type === 'field' || el.type === 'cell')) { el.value = n.value; scheduleSave(); }
  });
  const toggle = (n) => {
    const el = elById(n.dataset.id);
    el.checked = !el.checked;
    n.setAttribute('aria-checked', String(el.checked));
    n.innerHTML = el.checked ? CHECK_SVG : '';
    scheduleSave();
  };
  page.addEventListener('click', (e) => {
    if (editor.mode !== 'fill') return;
    const n = e.target.closest('.el-check');
    if (n) toggle(n);
  });
  page.addEventListener('keydown', (e) => {
    if (editor.mode !== 'fill') return;
    const n = e.target.closest?.('.el-check');
    if (n && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(n); }
    // Enter in a single-line field jumps to the next field, like on paper forms
    if (e.target.classList?.contains('el-field') && e.key === 'Enter') {
      e.preventDefault();
      const inputs = $$('#page .el-field, #page .el-cell, #page .el-check');
      const i = inputs.indexOf(e.target);
      inputs[i + 1]?.focus();
    }
  });
}

// ---------- export / print
async function exportAs(kind) {
  const doc = editor.doc;
  await flushSave();
  const name = safeName(doc.name);
  if (kind === 'json') {
    const { id, name: n, created, updated, width, height, lang, image, elements } = doc;
    const plain = { id, name: n, created, updated, width, height, lang, image, elements };
    const blob = new Blob([JSON.stringify({ app: 'dokscan', version: 1, doc: plain }, null, 0)], { type: 'application/json' });
    download(blob, `${name}.dokscan.json`);
    return;
  }
  busy.show(kind === 'pdf' ? 'Creating PDF…' : 'Creating image…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const canvas = renderDoc(doc, Math.max(1700, Math.min(2480, doc.width)));
    if (kind === 'png') {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      download(blob, `${name}.png`);
    } else {
      const { jsPDF } = window.jspdf;
      const landscape = doc.width > doc.height;
      const ratio = doc.height / doc.width;
      const a4 = landscape ? 210 / 297 : 297 / 210;
      let pdf, pw, ph;
      if (Math.abs(ratio - a4) / a4 < 0.08) {
        pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'mm', format: 'a4', compress: true });
        pw = landscape ? 297 : 210; ph = landscape ? 210 : 297;
      } else {
        pw = landscape ? 297 : 210; ph = pw * ratio;
        pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'mm', format: [pw, ph], compress: true });
      }
      pdf.setProperties({ title: doc.name, creator: 'DokScan' });
      pdf.addImage(canvas, 'PNG', 0, 0, pw, ph, undefined, 'FAST');
      download(pdf.output('blob'), `${name}.pdf`);
    }
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + (e.message || e));
  } finally {
    busy.hide();
  }
}

async function printDoc() {
  const doc = editor.doc;
  commitTextEdit();
  await flushSave();
  busy.show('Preparing to print…');
  try {
    const canvas = renderDoc(doc, Math.max(1700, Math.min(2480, doc.width)));
    const area = $('#printArea');
    area.innerHTML = '';
    const img = new Image();
    img.src = canvas.toDataURL('image/png');
    await img.decode();
    area.appendChild(img);
    let style = $('#pageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'pageStyle'; document.head.appendChild(style); }
    style.textContent = `@page { size: A4 ${doc.width > doc.height ? 'landscape' : 'portrait'}; margin: 6mm; }`;
  } finally {
    busy.hide();
  }
  setTimeout(() => window.print(), 50);
}

async function clearFields() {
  if (!await ask('Empty every field, table cell and checkbox in this document?', 'Clear fields', true)) return;
  snapshot();
  for (const el of editor.doc.elements) {
    if (el.type === 'field' || el.type === 'cell') el.value = '';
    if (el.type === 'check') el.checked = false;
  }
  renderPage();
  scheduleSave();
}

async function rescan() {
  const doc = editor.doc;
  if (!doc.image) return;
  const langName = LANGS.find(([v]) => v === prefs.get('lang', 'eng'))?.[1] || 'English';
  if (!await ask(`Re-scan the original image using ${langName} text recognition? This replaces the current layout and anything typed into it (you can undo).`, 'Re-scan')) return;
  busy.show('Loading image…');
  try {
    const canvas = await canvasFromDataURL(doc.image);
    const result = await scanCanvas(canvas, prefs.get('lang', 'eng'), onScanStep);
    snapshot();
    doc.elements = result.elements;
    for (const el of doc.elements) if (el.type === 'text') el.sx = fitRatio(el);
    renderPage();
    select(null);
    scheduleSave();
    busy.hide();
    reportScan(doc);
  } catch (e) {
    console.error(e);
    busy.hide();
    toast('Re-scan failed: ' + (e.message || e));
  }
}

function initEditor() {
  $('#edBack').onclick = goHome;
  $$('.seg button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('#docName').addEventListener('input', () => {
    editor.doc.name = $('#docName').value.trim() || 'Untitled';
    scheduleSave();
  });
  $('#zoomIn').onclick = () => { editor.zoom = Math.min(4, editor.zoom * 1.2); applyZoom(); };
  $('#zoomOut').onclick = () => { editor.zoom = Math.max(0.3, editor.zoom / 1.2); applyZoom(); };
  $('#zoomFit').onclick = () => { editor.zoom = 1; applyZoom(); };
  $('#undoBtn').onclick = () => undoRedo(false);
  $('#redoBtn').onclick = () => undoRedo(true);
  $('#origToggle').onchange = () => {
    const on = $('#origToggle').checked;
    $('#origOpacity').hidden = !on;
    $('#page').classList.toggle('show-orig', on);
    const img = $('#page .orig');
    if (img) img.hidden = !on;
  };
  $('#origOpacity').oninput = () => {
    const img = $('#page .orig');
    if (img) img.style.opacity = $('#origOpacity').value / 100;
  };
  $('#clearBtn').onclick = clearFields;
  $('#printBtn').onclick = printDoc;
  $('#rescanBtn').onclick = rescan;
  $$('[data-dl]').forEach((b) => b.addEventListener('click', () => {
    $('#dlMenu').open = false;
    exportAs(b.dataset.dl);
  }));
  document.addEventListener('click', (e) => { if (!e.target.closest('#dlMenu')) $('#dlMenu').open = false; });
  window.addEventListener('resize', applyZoom);

  document.addEventListener('keydown', (e) => {
    if ($('#view-editor').hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target.matches?.('input, textarea, [contenteditable="true"]') && !e.target.readOnly;
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); printDoc(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); toast('Saved'); return; }
    if (typing) {
      if (e.key === 'Escape' && editor.editingText) { commitTextEdit(); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undoRedo(true); return; }
    if (editor.mode !== 'layout' || !editor.sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (e.key === 'Escape') { select(null); return; }
    const step = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) {
      e.preventDefault();
      const el = elById(editor.sel);
      if (!e.repeat) snapshot();
      el.x += mv[0]; el.y += mv[1];
      placeNode(editor.nodes.get(el.id), el);
      drawSelection();
      scheduleSave();
    }
  });

  window.addEventListener('beforeprint', commitTextEdit);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('pagehide', flushSave);
}

// ------------------------------------------------------------------ project import
async function importProject(file) {
  try {
    const data = JSON.parse(await file.text());
    const src = data.doc || data;
    if (!src || !Array.isArray(src.elements) || !src.width || !src.height) throw new Error('Not a DokScan project file');
    const doc = freshCopy(src);
    doc.created = doc.created || Date.now();
    doc.elements = sortReadingOrder(doc.elements.filter((e) => e && e.type && isFinite(e.x) && isFinite(e.y)));
    for (const e of doc.elements) if (!e.id) e.id = newId();
    await saveDoc(doc, thumbFor(doc));
    openDoc(doc.id);
    toast('Project opened');
  } catch (e) {
    console.error(e);
    toast('Could not open that file: ' + e.message);
  }
}

// ------------------------------------------------------------------ boot
function initHome() {
  const pick = (input, fn) => input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; fn(f); });
  pick($('#cameraInput'), handleImageFile);
  pick($('#fileInput'), handleImageFile);
  pick($('#projectInput'), (f) => f && importProject(f));
  $('#blankBtn').onclick = newBlankDoc;
  $('#homeLink').onclick = (e) => { e.preventDefault(); if (!$('#view-crop').hidden) crop.canvas = null; goHome(); };

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) importProject(f); else handleImageFile(f);
  });
  document.addEventListener('paste', (e) => {
    if ($('#view-home').hidden) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) handleImageFile(item.getAsFile());
  });
}

// ------------------------------------------------------------------ accounts
const lastDocKey = () => 'lastDoc:' + (account.user?.id || 'local');
const account = { user: null, authMode: 'signin' };

// A copy of a document that is new to storage (new id, nothing synced yet).
function freshCopy(src) {
  const doc = structuredClone(src);
  for (const k of ['owner', 'dirty', 'imageSynced', 'remoteUpdated', 'thumb']) delete doc[k];
  doc.id = newId();
  doc.created = Date.now();
  return doc;
}

function setAuthMode(mode) {
  account.authMode = mode;
  const msg = $('#authMsg');
  msg.textContent = ''; msg.className = 'auth-msg';
  $$('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.auth === mode));
  $('#authTabs').hidden = mode === 'reset' || mode === 'newpw';
  $('#emailRow').hidden = mode === 'newpw';
  $('#pwRow').hidden = mode === 'reset';
  $('#forgotBtn').hidden = mode !== 'signin';
  const pw = $('#authPassword');
  pw.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  const text = {
    signin: ['Sign in to DokScan', 'Your documents are saved to your account, so you can open them on any device where you sign in.', 'Password', 'Sign in'],
    signup: ['Create your account', 'Use your email and choose a password. Only you can see the documents in your account.', 'Choose a password (at least 6 characters)', 'Create account'],
    reset: ['Reset your password', 'Enter your email and we’ll send you a link to choose a new password.', 'Password', 'Send reset link'],
    newpw: ['Choose a new password', 'Type the new password for your account.', 'New password (at least 6 characters)', 'Save new password'],
  }[mode];
  [$('#authTitle').textContent, $('#authLead').textContent, $('#pwLabel').textContent, $('#authSubmit').textContent] = text;
  if (mode === 'reset') $('#forgotBtn').hidden = true;
}

function authMessage(text, ok = false) {
  const msg = $('#authMsg');
  msg.textContent = text;
  msg.className = 'auth-msg ' + (ok ? 'ok' : 'err');
}

function showSignIn(mode = 'signin') {
  editor.doc = null;
  $('#account').hidden = true;
  setAuthMode(mode);
  showView('auth');
}

function initAuth() {
  $$('#authTabs button').forEach((b) => (b.onclick = () => setAuthMode(b.dataset.auth)));
  $('#forgotBtn').onclick = () => setAuthMode('reset');
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    const mode = account.authMode;
    if (mode !== 'newpw' && !/^\S+@\S+\.\S+$/.test(email)) { authMessage('Enter your email address.'); return; }
    if (mode !== 'reset' && password.length < 6) { authMessage('The password must be at least 6 characters.'); return; }
    const btn = $('#authSubmit');
    btn.disabled = true;
    authMessage('Please wait…', true);
    try {
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange takes it from here
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: siteUrl() } });
        if (error) throw error;
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('already registered');
        }
        if (!data.session) {
          setAuthMode('signin');
          authMessage(`Almost done: we sent a confirmation link to ${email}. Open it, then sign in here.`, true);
        }
      } else if (mode === 'reset') {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: siteUrl() });
        if (error) throw error;
        authMessage(`If ${email} has an account, a reset link is on its way. Open it on this device.`, true);
      } else if (mode === 'newpw') {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        $('#authPassword').value = '';
        toast('Password changed');
        const { data } = await sb.auth.getSession();
        await signedIn(data.session?.user);
      }
    } catch (err) {
      authMessage(friendlyError(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('#logoutBtn').onclick = async () => {
    await flushSave();
    await flushPushes();
    const left = await unsyncedCount();
    if (left && !await ask(`${left} document${left > 1 ? 's have' : ' has'} changes that haven’t reached your account yet (you seem to be offline). Log out anyway and lose those changes?`, 'Log out', true)) return;
    const uid = account.user?.id;
    account.user = null;
    setAccount(null, null);
    if (uid) await purgeLocal(uid);   // don't leave a person's documents on a shared computer
    await sb.auth.signOut().catch(() => {});
    $('#authPassword').value = '';
    showSignIn();
  };
}

let signingIn = null;
async function signedIn(user) {
  if (!user) return;
  if (account.user?.id === user.id && $('#view-auth').hidden) return;
  if (signingIn) return signingIn;
  signingIn = (async () => {
    account.user = user;
    account.authMode = 'signin';
    setAccount(sb, user.id);
    $('#acctEmail').textContent = user.email || '';
    $('#acctEmail').title = user.email || '';
    $('#account').hidden = false;
    $('#authPassword').value = '';

    const guests = await guestDocCount();
    if (guests && await ask(`This device has ${guests} document${guests > 1 ? 's' : ''} saved without an account. Move ${guests > 1 ? 'them' : 'it'} into your account (${user.email})?`, 'Move to my account')) {
      await adoptGuestDocs();
    }

    showView('home');
    await renderLibrary(false);
    const changed = await Promise.race([syncAll(), new Promise((r) => setTimeout(() => r(false), 5000))]);
    if (changed) renderLibrary(false);

    const m = location.hash.match(/doc=([\w-]+)/);
    const last = m?.[1] || prefs.get(lastDocKey());
    if (last && (await listDocs()).some((d) => d.id === last)) openDoc(last);
  })().finally(() => { signingIn = null; });
  return signingIn;
}

async function boot() {
  initLang();
  initHome();
  initCrop();
  initEditor();
  initLayoutEditing();
  initFill();
  onSyncStatus(updateStatus);

  if (!cloudEnabled) {
    const m = location.hash.match(/doc=([\w-]+)/);
    const last = m?.[1] || prefs.get(lastDocKey());
    if (last && await loadDoc(last).catch(() => null)) openDoc(last);
    else { showView('home'); renderLibrary(); }
    return;
  }

  initAuth();
  $('.library .muted.small').innerHTML = 'Documents are saved to your account. Sign in on any phone or computer to see them there too. A copy is kept on this device so you can keep working offline.';
  sb.auth.onAuthStateChange((event, session) => {
    // run outside the auth callback (Supabase advises against awaiting in it)
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') { account.user = session?.user || null; showSignIn('newpw'); return; }
      if (event === 'SIGNED_OUT') { if (account.user) { setAccount(null, null); account.user = null; showSignIn(); } return; }
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user && account.authMode !== 'newpw') {
        if (account.user?.id !== session.user.id) signedIn(session.user);
      }
      if (event === 'INITIAL_SESSION' && !session) showSignIn();
    }, 0);
  });
}

boot();
