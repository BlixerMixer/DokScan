// Document storage.
//
// Every document is kept in this browser's IndexedDB so the app is fast and
// works offline. When a person is signed in, documents are also stored in
// their Supabase account (table "documents" + private storage bucket "scans")
// and synced, so the same person sees them on every device.
//
// Records carry `owner`: the signed-in user's id, or null for documents made
// without an account (local-only mode, or from before accounts existed).

const DB_NAME = 'dokscan', VERSION = 1;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbp;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    result = fn(...stores.map((s) => t.objectStore(s)));
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function getLocal(store, id) {
  const d = await db();
  return reqP(d.transaction(store).objectStore(store).get(id));
}
async function allLocal(store) {
  const d = await db();
  return reqP(d.transaction(store).objectStore(store).getAll());
}

function metaOf(doc) {
  return {
    id: doc.id, owner: doc.owner ?? null, name: doc.name, created: doc.created, updated: doc.updated,
    thumb: doc.thumb || '', dirty: !!doc.dirty, remoteUpdated: doc.remoteUpdated || 0,
  };
}

async function putLocal(doc) {
  await tx(['docs', 'meta'], 'readwrite', (d, m) => { d.put(doc); m.put(metaOf(doc)); });
}

// ------------------------------------------------------------------ account
let owner = null;     // id of the signed-in user, or null
let cloud = null;     // { sb, uid } while signed in
const mine = (rec) => (rec.owner ?? null) === owner;

export function setAccount(sb, uid) {
  owner = uid || null;
  cloud = sb && uid ? { sb, uid } : null;
  lastError = null;
  notify();
}

// ------------------------------------------------------------------ sync status
let lastError = null, inflight = 0;
const pushTimers = new Map();
const listeners = new Set();
export function onSyncStatus(cb) { listeners.add(cb); cb(syncStatus()); }
export function syncStatus() {
  if (!cloud) return 'local';
  if (inflight || pushTimers.size) return 'syncing';
  if (lastError) return navigator.onLine === false ? 'offline' : 'error';
  return 'synced';
}
function notify() { const s = syncStatus(); listeners.forEach((cb) => cb(s, lastError)); }

// ------------------------------------------------------------------ public API
export async function saveDoc(doc, thumb) {
  doc.updated = Date.now();
  doc.owner = owner;
  if (thumb !== undefined) doc.thumb = thumb;
  if (cloud) doc.dirty = true;
  await putLocal(doc);
  if (cloud) queuePush(doc.id);
}

export async function loadDoc(id) {
  let doc = await getLocal('docs', id);
  if (doc && !mine(doc)) return null;
  const meta = await getLocal('meta', id);
  if (meta && !mine(meta)) return null;
  const stale = cloud && meta && (!doc || (!doc.dirty && (meta.remoteUpdated || 0) > (doc.updated || 0)));
  if (stale) {
    try {
      doc = await download(id);
    } catch (e) {
      console.warn(e);
      if (!doc) throw new Error('This document is saved in your account. Connect to the internet to open it on this device.');
    }
  }
  return doc || null;
}

export async function listDocs() {
  const all = await allLocal('meta');
  return all.filter(mine).sort((a, b) => b.updated - a.updated);
}

export async function deleteDoc(id) {
  await tx(['docs', 'meta'], 'readwrite', (d, m) => { d.delete(id); m.delete(id); });
  clearTimeout(pushTimers.get(id));
  pushTimers.delete(id);
  if (!cloud) return;
  try {
    await remoteDelete(id);
  } catch (e) {
    console.warn(e);
    const key = 'pendingDeletes:' + cloud.uid;
    prefs.set(key, [...new Set([...prefs.get(key, []), id])]);
  }
}

// Documents on this device that don't belong to any account.
export async function guestDocCount() {
  return (await allLocal('meta')).filter((m) => (m.owner ?? null) === null).length;
}

export async function adoptGuestDocs() {
  if (!cloud) return 0;
  const docs = (await allLocal('docs')).filter((d) => (d.owner ?? null) === null);
  for (const doc of docs) {
    doc.owner = cloud.uid;
    doc.dirty = true;
    doc.imageSynced = false;
    doc.remoteUpdated = 0;
    await putLocal(doc);
    queuePush(doc.id, 0);
  }
  return docs.length;
}

export async function unsyncedCount() {
  return (await allLocal('meta')).filter((m) => mine(m) && m.dirty).length;
}

// Remove the signed-in person's documents from this device (on log out).
export async function purgeLocal(uid) {
  const ids = (await allLocal('meta')).filter((m) => m.owner === uid).map((m) => m.id);
  await tx(['docs', 'meta'], 'readwrite', (d, m) => { for (const id of ids) { d.delete(id); m.delete(id); } });
}

// ------------------------------------------------------------------ cloud
const BUCKET = 'scans';
const imagePath = (uid, id) => `${uid}/${id}.jpg`;
let chain = Promise.resolve();

function queuePush(id, delay = 1500) {
  clearTimeout(pushTimers.get(id));
  pushTimers.set(id, setTimeout(() => {
    pushTimers.delete(id);
    runQueued(() => pushDoc(id));
  }, delay));
  notify();
}

function runQueued(fn) {
  inflight++;
  notify();
  chain = chain.then(fn).then(() => { lastError = null; }, (e) => { lastError = e; console.warn('Sync failed', e); })
    .finally(() => { inflight--; notify(); });
  return chain;
}

// Push any waiting changes right away (before printing, leaving, logging out).
export function flushPushes() {
  for (const [id, t] of pushTimers) {
    clearTimeout(t);
    pushTimers.delete(id);
    runQueued(() => pushDoc(id));
  }
  return chain;
}

async function pushDoc(id) {
  if (!cloud) return;
  const { sb, uid } = cloud;
  const doc = await getLocal('docs', id);
  if (!doc || !doc.dirty || doc.owner !== uid) return;
  const stamp = doc.updated;
  if (doc.image && !doc.imageSynced) {
    const blob = await (await fetch(doc.image)).blob();
    const { error } = await sb.storage.from(BUCKET).upload(imagePath(uid, id), blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) throw error;
  }
  const { error } = await sb.from('documents').upsert({
    id, user_id: uid, name: doc.name || 'Untitled', created: doc.created || stamp, updated: stamp,
    thumb: doc.thumb || '', has_image: !!doc.image,
    data: { width: doc.width, height: doc.height, lang: doc.lang || null, elements: doc.elements },
  });
  if (error) throw error;
  const cur = await getLocal('docs', id);
  if (!cur || cur.owner !== uid) return;
  cur.imageSynced = !!cur.image;
  cur.remoteUpdated = stamp;
  if (cur.updated === stamp) cur.dirty = false;
  await putLocal(cur);
}

async function remoteDelete(id) {
  const { sb, uid } = cloud;
  const { error } = await sb.from('documents').delete().eq('id', id);
  if (error) throw error;
  await sb.storage.from(BUCKET).remove([imagePath(uid, id)]);
}

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function download(id) {
  const { sb, uid } = cloud;
  const { data: row, error } = await sb.from('documents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row) throw new Error('This document no longer exists in your account.');
  let image = null;
  if (row.has_image) {
    const { data: blob, error: e2 } = await sb.storage.from(BUCKET).download(imagePath(uid, id));
    if (e2) console.warn('Scan image missing', e2); else image = await blobToDataURL(blob);
  }
  const d = row.data || {};
  const doc = {
    id, owner: uid, name: row.name, created: row.created, updated: row.updated, thumb: row.thumb || '',
    width: d.width, height: d.height, lang: d.lang, elements: d.elements || [], image,
    dirty: false, imageSynced: true, remoteUpdated: row.updated,
  };
  await putLocal(doc);
  return doc;
}

// Bring this device's list up to date with the account and push local changes.
// Returns true when the list of documents changed.
let syncing = null;
export function syncAll() {
  if (!cloud) return Promise.resolve(false);
  if (!syncing) syncing = runSync().finally(() => { syncing = null; });
  return syncing;
}

async function runSync() {
  const { sb, uid } = cloud;
  let changed = false;
  inflight++;
  notify();
  try {
    const key = 'pendingDeletes:' + uid;
    for (const id of prefs.get(key, [])) {
      await remoteDelete(id);
      prefs.set(key, prefs.get(key, []).filter((x) => x !== id));
    }
    const { data, error } = await sb.from('documents').select('id,name,created,updated,thumb');
    if (error) throw error;
    const remote = new Map(data.map((r) => [r.id, r]));
    const locals = (await allLocal('meta')).filter((m) => m.owner === uid);
    const localIds = new Set(locals.map((m) => m.id));
    for (const m of locals) {
      const r = remote.get(m.id);
      if (m.dirty) { queuePush(m.id, 0); continue; }
      if (!r) {
        // it was in the account before and is gone now: deleted on another device
        if (m.remoteUpdated) {
          await tx(['docs', 'meta'], 'readwrite', (d, mm) => { d.delete(m.id); mm.delete(m.id); });
          changed = true;
        }
        continue;
      }
      if (r.updated > (m.remoteUpdated || 0)) {
        await tx(['meta'], 'readwrite', (mm) => mm.put({ ...m, name: r.name, thumb: r.thumb || m.thumb, updated: Math.max(m.updated, r.updated), remoteUpdated: r.updated }));
        changed = true;
      }
    }
    for (const r of remote.values()) {
      if (localIds.has(r.id)) continue;
      await tx(['meta'], 'readwrite', (mm) => mm.put({ id: r.id, owner: uid, name: r.name, created: r.created, updated: r.updated, thumb: r.thumb || '', dirty: false, remoteUpdated: r.updated }));
      changed = true;
    }
    lastError = null;
  } catch (e) {
    lastError = e;
    console.warn('Sync failed', e);
  } finally {
    inflight--;
    notify();
  }
  return changed;
}

window.addEventListener('online', () => { if (cloud) syncAll(); });
setInterval(() => { if (cloud && lastError && navigator.onLine !== false) syncAll(); }, 30000);

export const prefs = {
  get(k, def) { try { const v = localStorage.getItem('dokscan.' + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('dokscan.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
