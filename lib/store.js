// IndexedDB: the whole collection lives here, on each device. Supabase is a mirror of the synced stores.
//   decks        id -> { id, name ('A::B'), conf, desc, collapsed, mtime }
//   deckConfigs  id -> { id, name, newPerDay, revPerDay, learnSteps[min], relearnSteps[min], retention, maxIvl, newOrder, buryNew, buryRev, mtime }
//   notetypes    id -> { id, name, kind ('normal'|'cloze'), css, fields[{name}], templates[{name, qfmt, afmt}], sortf, mtime }
//   notes        id -> { id, guid, mid, fields[], tags[], mtime }
//   cards        id -> { id, nid, did, ord, type, queue, due (ms), pos, ivl, s, d, step, reps, lapses, last, flags, mtime }
//   revlog       id (ms) -> { id, cid, ease, ivl, lastIvl, type, time, mtime }
//   media        name -> { name, sha1, size, uploaded, mtime }
//   blobs        sha1 -> Blob            (local cache of media bytes; never synced as rows)
//   outbox       'store:id' -> { store, id, mtime, deleted }   (rows waiting to be pushed)
//   meta         key -> value
// Runs in the page and in the import worker.

const DB = 'deckhand';
export const SYNCED = ['decks', 'deckConfigs', 'notetypes', 'notes', 'cards', 'revlog', 'media'];
const KEYS = { media: 'name' };
let dbp;

export function open() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of SYNCED) db.createObjectStore(s, { keyPath: KEYS[s] || 'id' });
      db.createObjectStore('blobs');
      db.createObjectStore('outbox');
      db.createObjectStore('meta');
      const tx = req.transaction;
      tx.objectStore('cards').createIndex('nid', 'nid');
      tx.objectStore('notes').createIndex('guid', 'guid');
      tx.objectStore('revlog').createIndex('cid', 'cid');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function get(store, key) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key));
}
export async function all(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAll());
}
export async function byIndex(store, index, value) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).index(index).getAll(value));
}
export async function count(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).count());
}

// Local edits: stamp mtime and queue for sync. `rows` may mix stores: [[store, row], ...].
export async function save(entries, { now = Date.now() } = {}) {
  if (!entries.length) return;
  const db = await open();
  const stores = [...new Set(entries.map(e => e[0]))];
  const tx = db.transaction([...stores, 'outbox'], 'readwrite');
  const ob = tx.objectStore('outbox');
  for (const [store, row] of entries) {
    row.mtime = now;
    tx.objectStore(store).put(row);
    if (SYNCED.includes(store)) {
      const id = row[KEYS[store] || 'id'];
      ob.put({ store, id, mtime: now }, store + ':' + id);
    }
  }
  return txDone(tx);
}
export const put = (store, row, opts) => save([[store, row]], opts);

export async function remove(entries, { now = Date.now() } = {}) {
  if (!entries.length) return;
  const db = await open();
  const stores = [...new Set(entries.map(e => e[0]))];
  const tx = db.transaction([...stores, 'outbox'], 'readwrite');
  const ob = tx.objectStore('outbox');
  for (const [store, id] of entries) {
    tx.objectStore(store).delete(id);
    if (SYNCED.includes(store)) ob.put({ store, id, mtime: now, deleted: true }, store + ':' + id);
  }
  return txDone(tx);
}

// Rows from the server: written as-is, no outbox entry. Skips rows the device has a newer copy of.
// Returns how many rows actually changed here.
export async function applyRemote(rows) {
  if (!rows.length) return 0;
  const db = await open();
  const stores = [...new Set(rows.map(r => r.store))];
  const tx = db.transaction([...stores, 'outbox'], 'readwrite');
  let changed = 0;
  const ob = tx.objectStore('outbox');
  for (const r of rows) {
    const os = tx.objectStore(r.store);
    const key = r.store + ':' + r.id;
    const local = await done(os.get(r.id));
    const pending = await done(ob.get(key));
    // Same or newer copy here already (including rows this device pushed itself).
    if ((local && local.mtime >= r.mtime) || (pending && pending.mtime > r.mtime) || (!local && r.deleted)) continue;
    changed++;
    if (r.deleted) os.delete(r.id); else os.put(r.data);
    if (pending) ob.delete(key);
  }
  await txDone(tx);
  return changed;
}

// Bulk write without outbox entries (import uses this, then queues everything once with queueAll).
export async function bulkPut(store, rows) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const r of rows) os.put(r);
  return txDone(tx);
}
export async function queueAll(store, ids, now = Date.now()) {
  const db = await open();
  const tx = db.transaction('outbox', 'readwrite');
  const ob = tx.objectStore('outbox');
  for (const id of ids) ob.put({ store, id, mtime: now }, store + ':' + id);
  return txDone(tx);
}

export async function outbox(limit = 500) {
  const db = await open();
  return done(db.transaction('outbox').objectStore('outbox').getAll(undefined, limit));
}
export async function clearOutbox(items) {
  const db = await open();
  const tx = db.transaction('outbox', 'readwrite');
  const ob = tx.objectStore('outbox');
  // Only clear entries that weren't re-edited while the push was in flight.
  for (const it of items) {
    const key = it.store + ':' + it.id;
    const cur = await done(ob.get(key));
    if (cur && cur.mtime === it.mtime) ob.delete(key);
  }
  return txDone(tx);
}

export async function getBlob(sha1) {
  const db = await open();
  return done(db.transaction('blobs').objectStore('blobs').get(sha1));
}
export async function putBlobs(pairs) {
  const db = await open();
  const tx = db.transaction('blobs', 'readwrite');
  for (const [sha1, blob] of pairs) tx.objectStore('blobs').put(blob, sha1);
  return txDone(tx);
}
export async function blobKeys() {
  const db = await open();
  return done(db.transaction('blobs').objectStore('blobs').getAllKeys());
}

export async function meta(key, value) {
  const db = await open();
  if (value === undefined) return done(db.transaction('meta').objectStore('meta').get(key));
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  return txDone(tx);
}

export async function wipe() {
  const db = await open();
  const names = [...db.objectStoreNames];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  return txDone(tx);
}
