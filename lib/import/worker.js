// Import worker: parses the package and merges it into IndexedDB without blocking the page.
import { readPackage } from './apkg.js';
import * as store from '../store.js';
import { dayIndex, addDays, nextMemory, DEFAULT_CONF } from '../srs.js';

const DAY = 86400000;
const post = (type, data) => self.postMessage({ type, ...data });

self.onmessage = async e => {
  try {
    const summary = await importPackage(e.data.file);
    post('done', { summary });
  } catch (err) {
    console.error(err);
    post('error', { message: err.message || String(err) });
  }
};

async function importPackage(file) {
  const progress = text => post('progress', { text });
  const pkg = await readPackage(await file.arrayBuffer(), progress);
  const now = Date.now();
  progress('Merging…');

  const [localDecks, localConfs] = await Promise.all([store.all('decks'), store.all('deckConfigs')]);
  const confIds = new Set(localConfs.map(c => c.id));
  const newConfs = [];
  if (!confIds.has(1)) { newConfs.push({ ...DEFAULT_CONF, mtime: now }); confIds.add(1); }
  for (const c of pkg.deckConfigs) {
    if (confIds.has(c.id)) continue; // keep settings the user already has
    newConfs.push({ ...DEFAULT_CONF, ...c, learnSteps: c.learnSteps.length ? c.learnSteps : [], mtime: now });
    confIds.add(c.id);
  }
  const confById = new Map([...localConfs, ...newConfs].map(c => [c.id, c]));

  // Notetypes: same id means the same note type; the incoming copy wins (templates may have been updated).
  const types = pkg.notetypes.map(nt => ({ ...nt, mtime: now }));

  // Decks: matched by full name. Only decks that end up holding cards (and their parents) are created.
  const usedDids = new Set(pkg.cards.map(c => c.odid || c.did));
  const pkgDeckById = new Map(pkg.decks.map(d => [d.id, d]));
  const wanted = new Set();
  for (const did of usedDids) {
    const d = pkgDeckById.get(did);
    const parts = (d ? d.name : 'Default').split('::');
    for (let i = 1; i <= parts.length; i++) wanted.add(parts.slice(0, i).join('::'));
  }
  const deckByName = new Map(localDecks.map(d => [d.name, d]));
  const usedIds = new Set(localDecks.map(d => d.id));
  const newDecks = [];
  let nextDeckId = Math.max(now, ...usedIds) + 1;
  for (const name of [...wanted].sort()) {
    if (deckByName.has(name)) continue;
    const src = pkg.decks.find(d => d.name === name && !d.filtered);
    const id = src && !usedIds.has(src.id) ? src.id : nextDeckId++;
    const conf = src && confIds.has(src.conf) ? src.conf : 1;
    const deck = { id, name, conf, desc: src?.desc || '', collapsed: false, mtime: now };
    usedIds.add(id); deckByName.set(name, deck); newDecks.push(deck);
  }
  const mapDid = did => deckByName.get(pkgDeckById.get(did)?.name || 'Default')?.id ?? deckByName.get('Default')?.id;

  // Notes: matched by guid. Existing notes get newer field contents but keep their cards and progress.
  const noteIdMap = new Map();
  const newNotes = [], updatedNotes = [];
  let nextNoteId = now;
  for (const n of pkg.notes) {
    const existing = (await store.byIndex('notes', 'guid', n.guid))[0];
    if (existing) {
      noteIdMap.set(n.id, null);
      if (n.mod * 1000 > (existing.srcMod || 0) && existing.mid === n.mid) {
        updatedNotes.push({ ...existing, fields: n.fields, tags: n.tags, srcMod: n.mod * 1000, mtime: now });
      }
      continue;
    }
    let id = n.id;
    if (await store.get('notes', id)) id = ++nextNoteId;
    noteIdMap.set(n.id, id);
    newNotes.push({ id, guid: n.guid, mid: n.mid, fields: n.fields, tags: n.tags, srcMod: n.mod * 1000, mtime: now });
  }

  // Cards and review history (for new notes only).
  const logsByCard = new Map();
  for (const r of pkg.revlog) (logsByCard.get(r.cid) || logsByCard.set(r.cid, []).get(r.cid)).push(r);
  const ankiToday = Math.floor((now / 1000 - pkg.crt) / 86400);
  const newCards = [], newLogs = [];
  let nextCardId = now;
  let maxPos = 0;
  for (const c of await store.all('cards')) if (c.type === 0) maxPos = Math.max(maxPos, c.pos || 0);

  for (const c of pkg.cards) {
    const nid = noteIdMap.get(c.nid);
    if (!nid) continue;
    let id = c.id;
    if (await store.get('cards', id)) id = ++nextCardId;
    const did = mapDid(c.odid || c.did);
    const conf = confById.get(newDecks.concat(localDecks).find(d => d.id === did)?.conf) || DEFAULT_CONF;
    const due = c.odid ? c.odue : c.due;
    const card = {
      id, nid, did, ord: c.ord, type: c.type, due: 0, pos: 0, ivl: Math.max(0, c.ivl), s: 0, d: 0, step: 0,
      reps: c.reps, lapses: c.lapses, last: 0, flags: c.flags & 7, susp: c.queue === -1, buried: 0, mtime: now,
    };
    if (c.type === 0) card.pos = maxPos + due;
    else if (c.type === 2) card.due = addDays(due - ankiToday, now);
    else if (c.queue === 1) card.due = due * 1000;
    else card.due = addDays(due - ankiToday, now);
    if (c.type === 1 || c.type === 3) {
      const steps = c.type === 3 ? conf.relearnSteps : conf.learnSteps;
      card.step = Math.max(0, Math.min(steps.length - 1, steps.length - (c.left % 1000)));
    }

    // Memory state: Anki's own FSRS values if present, else replay history, else estimate from interval/ease.
    const logs = (logsByCard.get(c.id) || []).filter(r => r.ease >= 1 && r.ease <= 4 && r.type <= 3);
    let data = {};
    try { data = c.data ? JSON.parse(c.data) : {}; } catch {}
    if (logs.length) card.last = logs[logs.length - 1].id;
    if (data.s && data.d) { card.s = data.s; card.d = data.d; }
    else if (c.type !== 0 && logs.length) {
      let mem = null, prev = null;
      for (const r of logs) {
        const elapsed = prev ? Math.max(0, dayIndex(r.id) - dayIndex(prev)) : 0;
        mem = nextMemory(conf, mem, elapsed, r.ease);
        prev = r.id;
      }
      card.s = mem.stability; card.d = mem.difficulty;
    } else if (c.type !== 0) {
      card.s = Math.max(0.1, c.ivl);
      card.d = Math.min(10, Math.max(1, 5 + (2500 - (c.factor || 2500)) / 240));
    }
    if (!card.last && c.type === 2) card.last = card.due - card.ivl * DAY;
    if (card.last > now) card.last = now - DAY;
    if (c.type === 0) card.last = 0;
    newCards.push(card);

    for (const r of logsByCard.get(c.id) || []) {
      newLogs.push({ id: r.id, cid: id, ease: r.ease, ivl: r.ivl, lastIvl: r.lastIvl, type: r.type, time: r.time, mtime: now });
    }
  }

  // Anki new-card positions can be huge (AnkiHub uses timestamps); renumber 1..n after existing cards, keeping siblings together.
  const fresh = newCards.filter(c => c.type === 0).sort((a, b) => a.pos - b.pos);
  let rank = maxPos, prev = null;
  for (const c of fresh) { if (c.pos !== prev) { rank++; prev = c.pos; } c.pos = rank; }

  // Media: rows keyed by filename, bytes keyed by content hash (shared between decks).
  const haveBlobs = new Set(await store.blobKeys());
  const mediaRows = [], blobs = [];
  for (const m of pkg.media) {
    const existing = await store.get('media', m.name);
    if (existing?.sha1 === m.sha1) continue;
    mediaRows.push({ name: m.name, sha1: m.sha1, size: m.size, uploaded: false, mtime: now });
    if (!haveBlobs.has(m.sha1)) { blobs.push([m.sha1, m.blob]); haveBlobs.add(m.sha1); }
  }

  progress('Saving…');
  const batches = [
    ['deckConfigs', newConfs], ['notetypes', types], ['decks', newDecks], ['notes', [...newNotes, ...updatedNotes]],
    ['cards', newCards], ['revlog', newLogs], ['media', mediaRows],
  ];
  for (const [name, list] of batches) {
    for (let i = 0; i < list.length; i += 2000) {
      const chunk = list.slice(i, i + 2000);
      await store.bulkPut(name, chunk);
      await store.queueAll(name, chunk.map(r => (name === 'media' ? r.name : r.id)), now);
    }
  }
  for (let i = 0; i < blobs.length; i += 50) {
    await store.putBlobs(blobs.slice(i, i + 50));
    progress(`Saving media ${Math.min(i + 50, blobs.length)}/${blobs.length}…`);
  }

  return {
    decks: newDecks.length, notes: newNotes.length, updated: updatedNotes.length, cards: newCards.length,
    revlog: newLogs.length, media: mediaRows.length, skipped: pkg.notes.length - newNotes.length - updatedNotes.length,
    topDeck: [...wanted].sort()[0],
  };
}
