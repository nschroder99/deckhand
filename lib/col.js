// The collection in memory: loaded once from IndexedDB, edited through these functions (which also persist + queue sync).
import * as store from './store.js';
import { schedule, dayStart, dayIndex, DEFAULT_CONF, blankCard } from './srs.js';
import { cardOrdinals } from './render.js';

export const col = { decks: new Map(), confs: new Map(), types: new Map(), notes: new Map(), cards: new Map(), today: [] };
const listeners = new Set();
export const onChange = fn => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => listeners.forEach(fn => fn());

export async function load() {
  const [decks, confs, types, notes, cards] = await Promise.all(['decks', 'deckConfigs', 'notetypes', 'notes', 'cards'].map(s => store.all(s)));
  col.decks = new Map(decks.map(d => [d.id, d]));
  col.confs = new Map(confs.map(c => [c.id, c]));
  col.types = new Map(types.map(t => [t.id, t]));
  col.notes = new Map(notes.map(n => [n.id, n]));
  col.cards = new Map(cards.map(c => [c.id, c]));
  await loadToday();
  await ensureDefaults();
  changed();
}

async function loadToday() {
  const db = await store.open();
  const range = IDBKeyRange.lowerBound(dayStart());
  col.today = await new Promise((res, rej) => {
    const r = db.transaction('revlog').objectStore('revlog').getAll(range);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  col.todayIndex = dayIndex();
}

// Default deck, Default preset, and Anki's stock note types (added once per collection, so deleting one sticks).
async function ensureDefaults() {
  const entries = [];
  if (!col.confs.has(1)) { const conf = { ...DEFAULT_CONF }; entries.push(['deckConfigs', conf]); col.confs.set(1, conf); }
  if (!col.decks.has(1)) { const deck = { id: 1, name: 'Default', conf: 1, desc: '', collapsed: false }; entries.push(['decks', deck]); col.decks.set(1, deck); }
  if (!(await store.meta('stockTypes'))) {
    const names = new Set([...col.types.values()].map(t => t.name));
    for (const nt of stockNotetypes()) if (!names.has(nt.name)) { entries.push(['notetypes', nt]); col.types.set(nt.id, nt); }
    await store.meta('stockTypes', true);
  }
  // mtime 1: any real edit (on this or another device) always wins over these defaults when syncing.
  if (entries.length) await store.save(entries, { now: 1 });
}

// Fixed ids so every device creates the same rows (sync merges them instead of duplicating).
function stockNotetypes() {
  const css = '.card {\n  font-family: arial;\n  font-size: 20px;\n  text-align: center;\n  color: black;\n  background-color: white;\n}\n';
  const back = '{{FrontSide}}\n\n<hr id=answer>\n\n';
  return [
    { id: 1000 + 1, name: 'Basic', kind: 'normal', css, sortf: 0, fields: [{ name: 'Front' }, { name: 'Back' }], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: back + '{{Back}}' }] },
    { id: 1000 + 2, name: 'Basic (and reversed card)', kind: 'normal', css, sortf: 0, fields: [{ name: 'Front' }, { name: 'Back' }],
      templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: back + '{{Back}}' }, { name: 'Card 2', qfmt: '{{Back}}', afmt: back + '{{Front}}' }] },
    { id: 1000 + 3, name: 'Basic (type in the answer)', kind: 'normal', css, sortf: 0, fields: [{ name: 'Front' }, { name: 'Back' }],
      templates: [{ name: 'Card 1', qfmt: '{{Front}}\n\n{{type:Back}}', afmt: '{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}' }] },
    { id: 1000 + 4, name: 'Cloze', kind: 'cloze', css: css + '.cloze {\n  font-weight: bold;\n  color: blue;\n}\n.nightMode .cloze {\n  color: lightblue;\n}\n', sortf: 0,
      fields: [{ name: 'Text' }, { name: 'Back Extra' }], templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }] },
  ];
}

// ---- Decks ----
export const confFor = did => ({ ...DEFAULT_CONF, ...(col.confs.get(col.decks.get(did)?.conf) || col.confs.get(1)) });
export const deckName = did => col.decks.get(did)?.name || 'Default';
export function children(did) {
  const name = col.decks.get(did)?.name;
  if (!name) return [];
  return [...col.decks.values()].filter(d => d.name.startsWith(name + '::'));
}
export const subtreeIds = did => new Set([did, ...children(did).map(d => d.id)]);

export function deckTree() {
  const sorted = [...col.decks.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const roots = [], byName = new Map();
  for (const d of sorted) {
    const node = { deck: d, kids: [], depth: d.name.split('::').length - 1 };
    byName.set(d.name, node);
    const parent = byName.get(d.name.split('::').slice(0, -1).join('::'));
    (parent ? parent.kids : roots).push(node);
  }
  // Hide an empty, childless Default deck once other decks exist, like Anki.
  return roots.filter(n => !(n.deck.id === 1 && !n.kids.length && sorted.length > 1 && ![...col.cards.values()].some(c => c.did === 1)));
}

export async function saveDeck(deck) { col.decks.set(deck.id, deck); await store.put('decks', deck); changed(); }
export async function addDeck(name) {
  name = name.split('::').map(s => s.trim()).filter(Boolean).join('::');
  const existing = [...col.decks.values()].find(d => d.name === name);
  if (existing) return existing;
  const parts = name.split('::');
  let deck;
  for (let i = 1; i <= parts.length; i++) {
    const n = parts.slice(0, i).join('::');
    if ([...col.decks.values()].some(d => d.name === n)) continue;
    deck = { id: newId(), name: n, conf: 1, desc: '', collapsed: false };
    await saveDeck(deck);
  }
  return deck;
}
export async function renameDeck(did, newName) {
  const old = col.decks.get(did).name;
  const entries = [];
  for (const d of [col.decks.get(did), ...children(did)]) {
    d.name = newName + d.name.slice(old.length);
    entries.push(['decks', d]);
  }
  await store.save(entries); changed();
}
export async function deleteDeck(did) {
  const ids = subtreeIds(did);
  const cards = [...col.cards.values()].filter(c => ids.has(c.did));
  const nids = new Set(cards.map(c => c.nid));
  const entries = [...cards.map(c => ['cards', c.id]), ...[...ids].filter(id => id !== 1).map(id => ['decks', id])];
  for (const nid of nids) if ([...col.cards.values()].every(c => c.nid !== nid || ids.has(c.did))) entries.push(['notes', nid]);
  await store.remove(entries);
  for (const [s, id] of entries) (s === 'cards' ? col.cards : s === 'notes' ? col.notes : col.decks).delete(id);
  changed();
}
export async function saveConf(conf) { col.confs.set(conf.id, conf); await store.put('deckConfigs', conf); changed(); }

let lastId = 0;
export function newId() { lastId = Math.max(Date.now(), lastId + 1); return lastId; }

// ---- Counts and queues ----
function todayUsage() {
  if (col.todayIndex !== dayIndex()) { col.today = []; col.todayIndex = dayIndex(); }
  const usage = new Map(); // did -> { n, r }
  for (const r of col.today) {
    const c = col.cards.get(r.cid);
    if (!c) continue;
    const u = usage.get(c.did) || usage.set(c.did, { n: 0, r: 0 }).get(c.did);
    if (r.fresh) u.n++; else if (r.type === 1) u.r++;
  }
  return usage;
}

const LEARN_AHEAD = 20 * 60000;
const available = (c, today) => !c.susp && !(c.buried && c.buried >= today);

// Gather what can be studied in a deck subtree, honoring each deck's own daily limits (Anki v3 style).
export function gather(did, now = Date.now()) {
  const ids = subtreeIds(did);
  const usage = todayUsage();
  const today = dayIndex(now);
  const endOfDay = dayStart(now) + 86400000;
  const learn = [], review = [], fresh = [];
  for (const c of col.cards.values()) {
    if (!ids.has(c.did) || !available(c, today)) continue;
    if (c.type === 1 || c.type === 3) { if (c.due < endOfDay) learn.push(c); }
    else if (c.type === 2) { if (c.due <= now || dayIndex(c.due) <= today) review.push(c); }
    else fresh.push(c);
  }
  learn.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due || a.id - b.id);
  const confNew = confFor(did).newOrder;
  if (confNew === 'random') fresh.sort((a, b) => hash(a.id) - hash(b.id)); else fresh.sort((a, b) => a.pos - b.pos || a.ord - b.ord);

  // Limits: each deck's remaining allowance; a card is taken only if its deck and every ancestor up to `did` have room.
  const remaining = new Map();
  for (const id of ids) {
    const conf = confFor(id), u = usage.get(id) || { n: 0, r: 0 };
    let n = u.n, r = u.r;
    for (const kid of children(id)) { const k = usage.get(kid.id); if (k) { n += k.n; r += k.r; } }
    remaining.set(id, { n: Math.max(0, conf.newPerDay - n), r: Math.max(0, conf.revPerDay - r) });
  }
  const chains = new Map();
  const chain = cdid => chains.get(cdid) || chains.set(cdid, chainOf(cdid)).get(cdid);
  const chainOf = cdid => {
    const out = [];
    const name = deckName(cdid);
    const root = deckName(did);
    for (const id of ids) { const n = deckName(id); if (name === n || name.startsWith(n + '::')) if (n === root || n.startsWith(root + '::')) out.push(id); }
    return out;
  };
  const take = (list, key) => list.filter(c => {
    const ch = chain(c.did);
    if (ch.some(id => remaining.get(id)[key] <= 0)) return false;
    ch.forEach(id => remaining.get(id)[key]--);
    return true;
  });
  const reviews = take(review, 'r');
  const news = take(fresh, 'n');
  return { learn, learnNow: learn.filter(c => c.due <= now + LEARN_AHEAD), review: reviews, fresh: news };
}
const hash = x => { let h = x % 2147483647; h = (h * 16807) % 2147483647; return h; };

export function counts(did, now = Date.now()) {
  const g = gather(did, now);
  return { n: g.fresh.length, l: g.learn.filter(c => c.due <= now + LEARN_AHEAD).length, r: g.review.length, laterLearn: g.learn.length };
}

// Next card to show: due learning first, then reviews and new cards mixed.
export function nextCard(did, now = Date.now()) {
  const g = gather(did, now);
  const learnDue = g.learn.filter(c => c.due <= now);
  if (learnDue.length) return learnDue[0];
  const total = g.review.length + g.fresh.length;
  if (total) {
    // Spread new cards evenly through reviews.
    if (!g.fresh.length) return g.review[0];
    if (!g.review.length) return g.fresh[0];
    const done = col.today.filter(r => subtreeIds(did).has(col.cards.get(r.cid)?.did)).length;
    const every = Math.max(1, Math.floor((g.review.length + g.fresh.length) / g.fresh.length));
    return done % every === every - 1 ? g.fresh[0] : g.review[0];
  }
  if (g.learnNow.length) return g.learnNow[0];
  return null;
}

// ---- Answering ----
const undoStack = [];
export const canUndo = () => undoStack.length > 0;

export async function answer(card, ease, timeTaken) {
  const now = Date.now();
  const conf = confFor(card.did);
  const res = schedule(card, conf, now)[ease];
  let id = now;
  while (col.today.some(r => r.id === id)) id++;
  const log = { id, ...res.log, time: Math.min(timeTaken, 60000) };
  const updated = { ...res.card };
  const entries = [['cards', updated], ['revlog', log]];
  // Bury siblings for today if the deck asks for it.
  const buried = [];
  if (conf.buryNew || conf.buryRev) {
    for (const s of col.cards.values()) {
      if (s.nid !== card.nid || s.id === card.id || s.susp) continue;
      if ((s.type === 0 && conf.buryNew) || (s.type === 2 && conf.buryRev)) { buried.push({ ...s }); entries.push(['cards', { ...s, buried: dayIndex(now) }]); }
    }
  }
  undoStack.push({ card: { ...card }, logId: id, buried });
  if (undoStack.length > 30) undoStack.shift();
  await store.save(entries, { now });
  for (const [s, row] of entries) if (s === 'cards') col.cards.set(row.id, row);
  col.today.push(log);
  changed();
  return updated;
}

export async function undo() {
  const u = undoStack.pop();
  if (!u) return null;
  await store.save([['cards', u.card], ...u.buried.map(b => ['cards', b])]);
  await store.remove([['revlog', u.logId]]);
  col.cards.set(u.card.id, u.card);
  for (const b of u.buried) col.cards.set(b.id, b);
  col.today = col.today.filter(r => r.id !== u.logId);
  changed();
  return u.card;
}

export async function updateCards(list) {
  await store.save(list.map(c => ['cards', c]));
  for (const c of list) col.cards.set(c.id, c);
  changed();
}

// ---- Notes ----
export const notetypeOf = note => col.types.get(note.mid);
export const cardsOf = nid => [...col.cards.values()].filter(c => c.nid === nid);

function nextPos() {
  let max = 0;
  for (const c of col.cards.values()) if (c.type === 0 && c.pos > max) max = c.pos;
  return max + 1;
}

export async function addNote({ mid, did, fields, tags }) {
  const nt = col.types.get(mid);
  const note = { id: newId(), guid: guid(), mid, fields, tags };
  const ords = cardOrdinals(note, nt);
  if (!ords.length) throw new Error(nt.kind === 'cloze' ? 'Add at least one cloze, like {{c1::text}}.' : 'The first field is empty.');
  const pos = nextPos();
  const cards = ords.map(ord => blankCard(newId(), note.id, did, ord, pos));
  await store.save([['notes', note], ...cards.map(c => ['cards', c])]);
  col.notes.set(note.id, note);
  for (const c of cards) col.cards.set(c.id, c);
  changed();
  return note;
}

export async function saveNote(note) {
  const nt = col.types.get(note.mid);
  const have = cardsOf(note.id);
  const did = have[0]?.did ?? 1;
  const entries = [['notes', note]];
  const pos = nextPos();
  for (const ord of cardOrdinals(note, nt)) {
    if (!have.some(c => c.ord === ord)) { const c = blankCard(newId(), note.id, did, ord, pos); entries.push(['cards', c]); col.cards.set(c.id, c); }
  }
  await store.save(entries);
  col.notes.set(note.id, note);
  changed();
}

export async function deleteNotes(nids) {
  const entries = [];
  for (const nid of nids) {
    entries.push(['notes', nid]);
    for (const c of cardsOf(nid)) { entries.push(['cards', c.id]); col.cards.delete(c.id); }
    col.notes.delete(nid);
  }
  await store.remove(entries);
  changed();
}

export async function saveNotetype(nt) { col.types.set(nt.id, nt); await store.put('notetypes', nt); changed(); }

function guid() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map(x => chars[x % chars.length]).join('');
}

// Reload after an import or a sync pull.
export const reload = load;
