// Media lookup for the card frame: filename -> data: URL (the sandboxed frame can't read this origin's blob: URLs).
// Bytes come from IndexedDB, or are fetched once from the sync bucket if another device imported the deck.
import * as store from './store.js';
import { downloadMedia } from './sync.js';

const cache = new Map();
const MAX = 120;

const toDataUrl = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export async function blobFor(name) {
  const row = await store.get('media', name);
  if (!row) return null;
  return (await store.getBlob(row.sha1)) || (await downloadMedia(row.sha1));
}

export async function dataUrls(names) {
  const out = {};
  await Promise.all(names.map(async n => {
    if (cache.has(n)) { out[n] = cache.get(n); return; }
    const blob = await blobFor(n).catch(() => null);
    if (!blob) return;
    const url = await toDataUrl(blob);
    cache.set(n, url);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    out[n] = url;
  }));
  return out;
}

async function sha1hex(buf) {
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Adds a pasted/picked file to the collection; returns its filename for use in a field.
export async function addFile(file) {
  const buf = await file.arrayBuffer();
  const sha1 = await sha1hex(buf);
  const ext = (file.name && file.name.includes('.') ? file.name.split('.').pop() : (file.type.split('/')[1] || 'bin')).toLowerCase().replace('jpeg', 'jpg');
  const name = `paste-${sha1}.${ext}`;
  if (!(await store.get('media', name))) {
    await store.putBlobs([[sha1, new Blob([buf], { type: file.type })]]);
    await store.put('media', { name, sha1, size: buf.byteLength, uploaded: false });
  }
  return name;
}

export async function prefetchAll(progress = () => {}) {
  const rows = await store.all('media');
  const have = new Set(await store.blobKeys());
  const missing = rows.filter(r => !have.has(r.sha1));
  let i = 0;
  for (const r of missing) { await downloadMedia(r.sha1); progress(++i, missing.length); }
  return missing.length;
}
