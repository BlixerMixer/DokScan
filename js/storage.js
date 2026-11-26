// Persistent storage in the browser (IndexedDB). Survives reloads and
// browser restarts on the same device.
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

export async function saveDoc(doc, thumb) {
  doc.updated = Date.now();
  await tx(['docs', 'meta'], 'readwrite', (docs, meta) => {
    docs.put(doc);
    meta.put({ id: doc.id, name: doc.name, created: doc.created, updated: doc.updated, thumb: thumb ?? doc.thumb ?? '' });
  });
}

export async function loadDoc(id) {
  const d = await db();
  return reqP(d.transaction('docs').objectStore('docs').get(id));
}

export async function listDocs() {
  const d = await db();
  const all = await reqP(d.transaction('meta').objectStore('meta').getAll());
  return all.sort((a, b) => b.updated - a.updated);
}

export async function deleteDoc(id) {
  await tx(['docs', 'meta'], 'readwrite', (docs, meta) => { docs.delete(id); meta.delete(id); });
}

export const prefs = {
  get(k, def) { try { const v = localStorage.getItem('dokscan.' + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('dokscan.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
