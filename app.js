// Deckhand: an Anki-compatible flashcard PWA. Router, deck list, deck overview, import, settings, sync wiring.
import * as C from './lib/col.js';
import * as store from './lib/store.js';
import * as sync from './lib/sync.js';
import { prefetchAll } from './lib/media.js';
import { exportDeck } from './lib/export.js';
import { esc, toast, icon, download, fmtBytes, $ } from './lib/ui.js';
import { mountReview } from './views/review.js';
import { mountEditor } from './views/editor.js';
import { mountBrowse } from './views/browse.js';
import { mountStats } from './views/stats.js';
import { mountOptions, mountNotetypes } from './views/options.js';

const app = $('#app');
let cleanup = null;
const COLLAPSE = 'deckhand.collapsed';

// ---- Router ----
async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  const tab = { add: 'add', browse: 'browse', edit: 'browse', stats: 'stats', settings: 'settings', notetypes: 'settings' }[parts[0]] || 'decks';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  scrollTo(0, 0);
  switch (parts[0]) {
    case 'deck': return deckOverview(+parts[1]);
    case 'study': cleanup = mountReview(app, +parts[1]); return;
    case 'add': return mountEditor(app, {});
    case 'edit': return mountEditor(app, { nid: +parts[1], back: params.get('back') || '' });
    case 'browse': return mountBrowse(app, params);
    case 'stats': return mountStats(app, params);
    case 'options': return mountOptions(app, +parts[1]);
    case 'notetypes': return mountNotetypes(app, parts[1] ? +parts[1] : null);
    case 'settings': return settings();
    case 'import': return importPage();
    default: return decks();
  }
}

// ---- Sync pill ----
function syncPill() {
  const s = sync.status();
  if (!sync.configured()) return '';
  const cls = s.status === 'syncing' ? 'busy' : s.status === 'idle' ? 'ok' : s.status === 'error' || s.status === 'offline' ? 'err' : '';
  const label = { syncing: 'Syncing', idle: 'Synced', error: 'Sync paused', offline: 'Offline', 'signed-out': 'Sign in to sync', off: '' }[s.status] || '';
  return `<a class="pill ${cls}" href="#/settings" id="syncpill" title="${esc(s.error || '')}"><i></i>${label}</a>`;
}

// ---- Deck list ----
function collapsed() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE) || '[]')); } catch { return new Set(); } }
function setCollapsed(set) { try { localStorage.setItem(COLLAPSE, JSON.stringify([...set])); } catch {} }

function decks() {
  const tree = C.deckTree();
  const closed = collapsed();
  const now = Date.now();
  const rows = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      const c = C.counts(n.deck.id, now);
      const leaf = n.deck.name.split('::').pop();
      const isClosed = closed.has(n.deck.id);
      const num = (v, cls) => `<span class="c ${v ? cls : 'z'}">${v}</span>`;
      rows.push(`<li><div class="deckrow" style="padding-left:${4 + n.depth * 18}px">
        ${n.kids.length ? `<button class="tw" data-toggle="${n.deck.id}" aria-label="${isClosed ? 'Expand' : 'Collapse'} ${esc(leaf)}" aria-expanded="${!isClosed}">${isClosed ? icon.chevron : icon.chevronDown}</button>` : '<span></span>'}
        <a class="name" href="#/deck/${n.deck.id}">${esc(leaf)}</a>${num(c.n, 'n')}${num(c.l, 'l')}${num(c.r, 'r')}</div></li>`);
      if (n.kids.length && !isClosed) walk(n.kids);
    }
  };
  walk(tree);
  const empty = C.col.cards.size === 0;
  app.innerHTML = `
    <header class="top"><div><p class="eyebrow">Deckhand</p><h1>Decks</h1></div><div class="row">${syncPill()}</div></header>
    ${empty ? `<div class="panel pad stack"><h2>Start with a deck</h2><p class="muted">Import an Anki deck (.apkg or .colpkg) from AnkiWeb, a friend, or your own Anki export. Or add cards yourself.</p>
      <div class="row"><a class="btn primary" href="#/import">Import a deck</a><a class="btn" href="#/add">Add cards</a></div></div>` : `
    <div class="panel"><div class="deckhead"><span style="text-align:left">Deck</span><span>New</span><span>Learn</span><span>Due</span></div><ul class="decks">${rows.join('')}</ul></div>`}
    <div class="row" style="margin-top:14px"><a class="btn" href="#/import">Import</a><button class="btn" id="newDeck">Create deck</button></div>`;
  app.querySelectorAll('[data-toggle]').forEach(b => (b.onclick = () => {
    const set = collapsed(); const id = +b.dataset.toggle;
    set.has(id) ? set.delete(id) : set.add(id);
    setCollapsed(set); decks();
  }));
  $('#newDeck', app).onclick = async () => {
    const name = prompt('New deck name (use :: for a subdeck, e.g. Spanish::Verbs):');
    if (!name?.trim()) return;
    await C.addDeck(name);
    decks();
  };
}

// ---- Deck overview ----
function deckOverview(did) {
  const deck = C.col.decks.get(did);
  if (!deck) { location.hash = '#/'; return; }
  const c = C.counts(did);
  const total = [...C.col.cards.values()].filter(x => C.subtreeIds(did).has(x.did)).length;
  const parts = deck.name.split('::');
  app.innerHTML = `
    <header class="top"><div><a class="link back" href="#/">‹ Decks</a>${parts.length > 1 ? `<p class="eyebrow">${esc(parts.slice(0, -1).join(' › '))}</p>` : ''}<h1>${esc(parts.at(-1))}</h1></div></header>
    <div class="panel pad">
      <div class="bigcounts"><div><b class="c n">${c.n}</b><span>New</span></div><div><b class="c l">${c.l}</b><span>Learning</span></div><div><b class="c r">${c.r}</b><span>To review</span></div></div>
      ${c.n + c.l + c.r ? `<a class="btn primary big block" href="#/study/${did}">Study now</a>` : `<p class="muted" style="text-align:center;margin:0">${total ? 'Nothing due right now. ' : 'This deck is empty. '}${c.laterLearn ? 'Some learning cards are due later today.' : ''}</p>`}
      ${deck.desc ? `<div class="desc" style="margin-top:16px">${esc(deck.desc.replace(/<[^>]*>/g, ' '))}</div>` : ''}
    </div>
    <p class="muted small num" style="margin:10px 2px">${total.toLocaleString()} cards</p>
    <div class="row" style="margin-top:12px">
      <a class="btn" href="#/options/${did}">Options</a>
      <a class="btn" href="#/browse?q=${encodeURIComponent(`"deck:${deck.name}"`)}">Browse</a>
      <a class="btn" href="#/stats?deck=${did}">Stats</a>
      <button class="btn" id="export">Export</button>
      <button class="btn" id="rename">Rename</button>
      <button class="btn danger" id="delete">Delete</button>
    </div>
    <p class="muted small" id="exportStatus"></p>`;
  $('#rename', app).onclick = async () => {
    const name = prompt('Rename deck (full name, :: for subdecks):', deck.name);
    if (!name?.trim() || name === deck.name) return;
    if ([...C.col.decks.values()].some(d => d.name === name.trim())) return toast('A deck with that name exists.');
    await C.renameDeck(did, name.trim());
    deckOverview(did);
  };
  $('#delete', app).onclick = async () => {
    if (!confirm(`Delete "${deck.name}" and all ${total} of its cards? This syncs to your other devices.`)) return;
    await C.deleteDeck(did);
    toast('Deck deleted');
    location.hash = '#/';
  };
  $('#export', app).onclick = async () => {
    const withSched = confirm('Include your scheduling (review history and due dates)?\n\nOK = include, Cancel = export as new cards.');
    const status = $('#exportStatus', app);
    try {
      const blob = await exportDeck(did, { scheduling: withSched, progress: t => (status.textContent = t) });
      download(blob, `${parts.at(-1).replace(/[\\/:*?"<>|]/g, '_')}.apkg`);
      status.textContent = `Exported ${fmtBytes(blob.size)}.`;
    } catch (err) { console.error(err); status.textContent = 'Export failed: ' + err.message; }
  };
}

// ---- Import ----
let importing = null;
function importFile(file) {
  if (importing) return toast('An import is already running.');
  importing = new Promise((resolve) => {
    const worker = new Worker(new URL('./lib/import/worker.js', import.meta.url), { type: 'module' });
    const status = text => { const s = document.getElementById('importStatus'); if (s) s.textContent = text; };
    status(`Reading ${file.name}…`);
    worker.onmessage = async e => {
      const m = e.data;
      if (m.type === 'progress') status(m.text);
      else {
        worker.terminate();
        importing = null;
        if (m.type === 'error') { status('Import failed: ' + m.message); toast('Import failed'); return resolve(); }
        await C.reload();
        const s = m.summary;
        const msg = `Imported ${s.notes.toLocaleString()} notes (${s.cards.toLocaleString()} cards), ${s.media} media files` + (s.updated ? `, updated ${s.updated} existing notes` : '') + (s.skipped ? `, ${s.skipped} already present` : '') + '.';
        status(msg);
        toast('Import finished');
        sync.schedule(500);
        resolve();
      }
    };
    worker.onerror = e => { status('Import failed: ' + (e.message || 'worker error')); importing = null; worker.terminate(); resolve(); };
    worker.postMessage({ file });
  });
  return importing;
}

function importPage() {
  app.innerHTML = `
    <header class="top"><div><a class="link back" href="#/">‹ Decks</a><p class="eyebrow">Import</p><h1>Import a deck</h1></div></header>
    <label class="drop" id="drop" for="file">
      <p style="margin:0 0 12px">Drop an <b>.apkg</b> or <b>.colpkg</b> file here, or</p>
      <span class="btn primary">Choose file</span>
      <input type="file" id="file" accept=".apkg,.colpkg,.zip,application/octet-stream" hidden>
    </label>
    <p class="muted small" id="importStatus" aria-live="polite">${importing ? 'Import running…' : ''}</p>
    <div class="panel pad small muted stack" style="margin-top:18px">
      <p style="margin:0">Works with exports from every Anki version, including the newest format. Notes already in your collection (same note ID) keep their progress; newer field contents replace older ones.</p>
      <p style="margin:0">Review history and FSRS memory state come along when the file includes scheduling.</p>
    </div>`;
  const drop = $('#drop', app);
  $('#file', app).onchange = e => e.target.files[0] && importFile(e.target.files[0]);
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) importFile(f); });
}
// Dropping a file anywhere starts an import.
addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0];
  if (!f || !/\.(apkg|colpkg)$/i.test(f.name) || e.target.closest?.('#drop, .field')) return;
  e.preventDefault();
  location.hash = '#/import';
  setTimeout(() => importFile(f), 50);
});
// Opened as the handler for .apkg files (installed desktop app).
if ('launchQueue' in window) launchQueue.setConsumer(async params => {
  const h = params.files?.[0];
  if (!h) return;
  location.hash = '#/import';
  importFile(await h.getFile());
});

// ---- Settings ----
async function settings() {
  const s = sync.status();
  const cfg = sync.settings();
  const [nCards, nNotes, nMedia, pending] = await Promise.all([C.col.cards.size, C.col.notes.size, store.count('media'), store.outbox(100000).then(x => x.length)]);
  let est = null;
  try { est = await navigator.storage?.estimate?.(); } catch {}
  const signedIn = !!s.user;
  app.innerHTML = `
    <header class="top"><div><p class="eyebrow">Settings</p><h1>Settings</h1></div></header>
    <h3>Sync</h3>
    <div class="panel pad stack" id="syncBox">
      ${!sync.configured() ? `<p style="margin:0">Sync isn't set up on this device. Your collection is saved here only.</p>` :
        signedIn ? `<p style="margin:0">Signed in as <b>${esc(s.user.email)}</b>.</p>
          <p class="muted small" style="margin:0">${s.status === 'syncing' ? esc(s.detail || 'Syncing…') : s.last ? `Last synced ${new Date(s.last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Not synced yet.'} ${pending ? `${pending.toLocaleString()} change(s) waiting.` : ''}</p>
          ${s.error ? `<p class="warn">${esc(s.error)}</p>` : ''}
          <div class="row"><button class="btn primary" id="syncNow">Sync now</button><button class="btn" id="prefetch">Download all media</button><button class="btn" id="usage">Check storage use</button><button class="btn" id="signOut">Sign out</button></div>
          <p class="muted small" id="syncMsg" style="margin:0"></p>` :
        `<p style="margin:0">Sign in with your email to sync this collection across devices.</p>
          <div class="row"><input class="t" id="email" type="email" placeholder="you@example.com" autocomplete="email" style="flex:1;min-width:200px"><button class="btn primary" id="sendCode">Email me a code</button></div>
          <div class="row" id="codeRow" hidden><input class="t" id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" style="flex:1;min-width:140px"><button class="btn primary" id="verify">Sign in</button></div>
          <p class="muted small" id="syncMsg" style="margin:0"></p>`}
      <details><summary class="small muted" style="cursor:pointer">Sync server</summary>
        <label class="f" for="sbUrl">Supabase project URL</label><input class="t" id="sbUrl" value="${esc(cfg.url)}" placeholder="https://xxxx.supabase.co" autocapitalize="off" spellcheck="false">
        <label class="f" for="sbKey">Publishable (anon) key</label><input class="t" id="sbKey" value="${esc(cfg.key)}" autocapitalize="off" spellcheck="false">
        <div class="row" style="margin-top:10px"><button class="btn sm" id="saveSb">Save</button></div>
      </details>
    </div>
    <h3>Collection</h3>
    <div class="panel pad stack">
      <p class="muted small num" style="margin:0">${nNotes.toLocaleString()} notes · ${nCards.toLocaleString()} cards · ${nMedia.toLocaleString()} media files${est?.usage ? ` · ${fmtBytes(est.usage)} used on this device` : ''}</p>
      <div class="row"><a class="btn" href="#/import">Import</a><a class="btn" href="#/notetypes">Note types</a><button class="btn" id="persist">Keep data on this device</button></div>
    </div>
    <h3>Shortcuts</h3>
    <div class="panel pad small muted">Space/Enter show answer · 1–4 rate · Z undo · E edit · - bury · @ suspend · * mark · R replay audio · Ctrl+1–7 flag</div>
    <h3>Danger zone</h3>
    <div class="panel pad"><button class="btn danger" id="wipe">Erase this device's copy</button>
      <p class="muted small" style="margin:8px 0 0">Removes everything stored in this browser. Synced data stays on the server and comes back when you sign in again.</p></div>`;

  const msg = t => { const m = $('#syncMsg', app); if (m) m.textContent = t; };
  $('#saveSb', app).onclick = async () => { await sync.saveSettings($('#sbUrl', app).value, $('#sbKey', app).value); toast('Saved'); settings(); };
  $('#persist', app).onclick = async () => {
    const ok = await navigator.storage?.persist?.();
    toast(ok ? 'This browser will keep your data' : 'The browser declined; install the app to keep data safe');
  };
  $('#wipe', app).onclick = async () => {
    if (!confirm('Erase all Deckhand data in this browser?' + (pending ? `\n\n${pending} change(s) haven't synced yet and will be lost.` : ''))) return;
    await sync.signOut().catch(() => {});
    await store.wipe();
    await store.meta('pullSeq', 0);
    await C.reload();
    toast('Erased');
    location.hash = '#/';
  };
  if (!sync.configured()) return;
  if (signedIn) {
    $('#syncNow', app).onclick = async () => { msg('Syncing…'); try { await sync.sync(); msg('Up to date.'); } catch { msg(sync.status().error); } };
    $('#signOut', app).onclick = async () => { await sync.signOut(); settings(); };
    $('#prefetch', app).onclick = async () => { const n = await prefetchAll((i, t) => msg(`Downloading media ${i}/${t}…`)); msg(n ? `Downloaded ${n} files.` : 'All media is already on this device.'); };
    $('#usage', app).onclick = async () => {
      msg('Checking…');
      const used = await sync.storageUsed();
      if (used == null) return msg('Could not read storage use.');
      msg(`Media on the server: ${fmtBytes(used)} of the free plan's 1 GB.` + (used > 800 * 1048576 ? ' Getting close to the limit.' : ''));
    };
  } else {
    let email = '';
    $('#sendCode', app).onclick = async () => {
      email = $('#email', app).value.trim();
      if (!email) return;
      msg('Sending…');
      try { await sync.sendCode(email); $('#codeRow', app).hidden = false; $('#code', app).focus(); msg(`Check ${email} for a 6-digit code (or tap the link in the email on this device).`); }
      catch (err) { msg(err.message); }
    };
    $('#verify', app).onclick = async () => {
      try { await sync.verifyCode(email, $('#code', app).value); toast('Signed in'); settings(); }
      catch (err) { msg(err.message); }
    };
  }
}

// ---- Boot ----
async function boot() {
  await C.load();
  route();
  addEventListener('hashchange', route);
  sync.onRemoteChanges(async () => {
    await C.reload();
    // Don't yank the reviewer out from under the user; other screens redraw.
    if (!location.hash.startsWith('#/study') && !location.hash.startsWith('#/edit') && !location.hash.startsWith('#/add')) route();
  });
  let lastStatus = '';
  sync.onStatus(s => {
    const key = s.status + (s.user?.id || '');
    if (key === lastStatus) return;
    lastStatus = key;
    const pill = document.getElementById('syncpill');
    if (pill) pill.outerHTML = syncPill();
  });
  await sync.init().catch(() => {});
  C.onChange(() => sync.schedule());
  sync.schedule(800);
  addEventListener('online', () => sync.schedule(500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.schedule(500); });
  setInterval(() => { if (document.visibilityState === 'visible') sync.schedule(0); }, 5 * 60000);
  if ('serviceWorker' in navigator && location.hostname !== '127.0.0.1') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot().catch(err => { console.error(err); app.innerHTML = `<p class="warn" style="margin-top:40px">Couldn't start: ${esc(err.message)}</p>`; });
