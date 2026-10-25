// Sync with Supabase. Local-first: IndexedDB is the source of truth on each device; this pushes the outbox,
// pulls rows other devices wrote since our cursor, and moves media bytes through a private Storage bucket.
import { createClient } from './vendor/supabase.mjs';
import * as store from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const LS = 'deckhand.supabase';
let client = null;
const state = { status: 'off', error: '', last: 0, pending: 0, user: null };
const listeners = new Set();
export const onStatus = fn => (listeners.add(fn), fn(state), () => listeners.delete(fn));
const set = patch => { Object.assign(state, patch); listeners.forEach(fn => fn(state)); };
export const status = () => state;

export function settings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch {}
  return { url: saved.url || SUPABASE_URL, key: saved.key || SUPABASE_ANON_KEY };
}
export function saveSettings(url, key) {
  try { localStorage.setItem(LS, JSON.stringify({ url: url.trim(), key: key.trim() })); } catch {}
  client = null;
  return init();
}
export const configured = () => { const s = settings(); return !!(s.url && s.key); };

export async function init() {
  if (!configured()) { set({ status: 'off', user: null }); return null; }
  if (client) return client;
  const { url, key } = settings();
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'deckhand.auth' } });
  const { data } = await client.auth.getSession();
  set({ user: data.session?.user || null, status: data.session ? 'idle' : 'signed-out' });
  client.auth.onAuthStateChange((_e, session) => {
    const user = session?.user || null;
    if ((user?.id || null) !== (state.user?.id || null)) { set({ user, status: user ? 'idle' : 'signed-out' }); if (user) schedule(0); }
  });
  return client;
}

// Email sign-in: sends a 6-digit code (and a link). The code works inside an installed iPhone app, where links open Safari instead.
export async function sendCode(email) {
  const c = await init();
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
  if (error) throw error;
}
export async function verifyCode(email, token) {
  const c = await init();
  const { error } = await c.auth.verifyOtp({ email, token: token.trim(), type: 'email' });
  if (error) throw error;
}
export async function signOut() {
  if (!client) return;
  await client.auth.signOut();
  set({ user: null, status: 'signed-out' });
}

// ---- Sync loop ----
let timer = null, running = null, onPulled = () => {};
export function onRemoteChanges(fn) { onPulled = fn; }
export function schedule(delay = 4000) {
  if (!configured()) return;
  clearTimeout(timer);
  timer = setTimeout(() => sync().catch(() => {}), delay);
}

export function sync() {
  running ||= run().finally(() => { running = null; });
  return running;
}

async function run() {
  const c = await init();
  if (!c || !state.user) return;
  if (!navigator.onLine) { set({ status: 'offline' }); return; }
  set({ status: 'syncing', error: '' });
  try {
    await push(c);
    const pulled = await pull(c);
    await uploadMedia(c);
    set({ status: 'idle', last: Date.now(), pending: (await store.outbox(10000)).length });
    if (pulled) await onPulled();
  } catch (err) {
    const msg = err?.message || String(err);
    // A paused free-tier project answers with network errors or 5xx; the app keeps working offline either way.
    set({ status: 'error', error: /fetch|network|503|502|paused/i.test(msg) ? 'Sync server unreachable (paused or offline). Your reviews are saved on this device.' : msg });
    throw err;
  }
}

const keyOf = (s, id) => (s === 'media' ? String(id) : Number(id));

async function push(c) {
  const uid = state.user.id;
  for (;;) {
    const items = await store.outbox(400);
    if (!items.length) return;
    set({ pending: items.length });
    const rows = [];
    for (const it of items) {
      const data = it.deleted ? null : await store.get(it.store, it.id);
      if (!it.deleted && !data) { rows.push({ user_id: uid, store: it.store, id: String(it.id), data: null, mtime: it.mtime, deleted: true }); continue; }
      rows.push({ user_id: uid, store: it.store, id: String(it.id), data, mtime: data ? data.mtime : it.mtime, deleted: !!it.deleted });
    }
    const { error } = await c.from('objects').upsert(rows, { onConflict: 'user_id,store,id' });
    if (error) throw error;
    await store.clearOutbox(items);
  }
}

async function pull(c) {
  let cursor = (await store.meta('pullSeq')) || 0;
  let any = false;
  // Re-read a small overlap: sequence values can commit slightly out of order. Applying a row twice is harmless.
  let from = Math.max(0, cursor - 200);
  for (;;) {
    const { data, error } = await c.from('objects').select('store,id,data,mtime,deleted,seq').gt('seq', from).order('seq').limit(1000);
    if (error) throw error;
    if (!data.length) break;
    const rows = data.map(r => {
      const d = r.data;
      if (r.store === 'media' && d) d.uploaded = true;
      return { store: r.store, id: keyOf(r.store, r.id), data: d, mtime: Number(r.mtime), deleted: r.deleted };
    });
    if (await store.applyRemote(rows)) any = true;
    from = data[data.length - 1].seq;
    cursor = Math.max(cursor, from);
    await store.meta('pullSeq', cursor);
    if (data.length < 1000) break;
  }
  return any;
}

async function uploadMedia(c) {
  const uid = state.user.id;
  const rows = (await store.all('media')).filter(m => !m.uploaded);
  let done = 0;
  for (const m of rows) {
    const blob = await store.getBlob(m.sha1);
    if (!blob) continue;
    set({ status: 'syncing', detail: `Uploading media ${++done}/${rows.length}` });
    const { error } = await c.storage.from('media').upload(`${uid}/${m.sha1}`, blob, { upsert: false, contentType: blob.type || 'application/octet-stream' });
    if (error && !/exists|Duplicate|409/i.test(error.message + (error.statusCode || ''))) throw error;
    await store.bulkPut('media', [{ ...m, uploaded: true }]);
  }
  set({ detail: '' });
}

// Fetch one media file another device uploaded. Cached in IndexedDB after the first download.
export async function downloadMedia(sha1) {
  const c = await init();
  if (!c || !state.user) return null;
  const { data, error } = await c.storage.from('media').download(`${state.user.id}/${sha1}`);
  if (error || !data) return null;
  await store.putBlobs([[sha1, data]]);
  return data;
}

export async function storageUsed() {
  const c = await init();
  if (!c || !state.user) return null;
  let total = 0, offset = 0;
  for (;;) {
    const { data, error } = await c.storage.from('media').list(state.user.id, { limit: 1000, offset });
    if (error) return null;
    for (const f of data) total += f.metadata?.size || 0;
    if (data.length < 1000) break;
    offset += 1000;
  }
  return total;
}
