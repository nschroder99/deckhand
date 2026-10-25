// Export a deck (and its subdecks) as a legacy .apkg (schema 11), which every desktop/mobile Anki can import.
// FSRS memory state goes in cards.data so Anki with FSRS on picks it up.
import { zipSync, strToU8 } from './vendor/fflate.mjs';
import { sqlite } from './sqlite.js';
import { col, subtreeIds, confFor } from './col.js';
import { mediaRefs, stripHtml } from './render.js';
import { dayIndex, dayStart } from './srs.js';
import { blobFor } from './media.js';
import * as store from './store.js';

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn); CREATE INDEX ix_cards_usn on cards (usn); CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid); CREATE INDEX ix_cards_sched on cards (did, queue, due); CREATE INDEX ix_revlog_cid on revlog (cid); CREATE INDEX ix_notes_csum on notes (csum);`;

async function csum(text) {
  const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(stripHtml(text).trim()));
  const b = new Uint8Array(h);
  return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
}

export async function exportDeck(did, { scheduling = true, media = true, progress = () => {} } = {}) {
  const S = await sqlite();
  const db = new S.Database();
  db.exec(SCHEMA);
  const now = Date.now();
  const secs = Math.floor(now / 1000);
  const DAYS_BACK = 3650; // collection "created" ten years ago keeps every due day positive
  const crt = Math.floor(dayStart(now) / 1000) - DAYS_BACK * 86400;
  const today = dayIndex(now);

  const ids = subtreeIds(did);
  const cards = [...col.cards.values()].filter(c => ids.has(c.did));
  const nids = new Set(cards.map(c => c.nid));
  const notes = [...nids].map(id => col.notes.get(id)).filter(Boolean);
  const mids = new Set(notes.map(n => n.mid));
  const decks = [...ids].map(id => col.decks.get(id));

  const models = {};
  for (const mid of mids) {
    const nt = col.types.get(mid);
    models[mid] = {
      id: mid, name: nt.name, type: nt.kind === 'cloze' ? 1 : 0, mod: secs, usn: -1, sortf: nt.sortf || 0, did: null, tags: [], vers: [],
      css: nt.css || '', latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
      latexPost: '\\end{document}', latexsvg: false,
      flds: nt.fields.map((f, ord) => ({ name: f.name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
      tmpls: nt.templates.map((t, ord) => ({ name: t.name, ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0 })),
      req: nt.templates.map((_, ord) => [ord, 'any', [0]]),
    };
  }
  const dconf = {};
  const deckJson = {};
  for (const d of decks) {
    const c = confFor(d.id);
    const cid = col.confs.has(d.conf) ? d.conf : 1;
    dconf[cid] ||= {
      id: cid, name: c.name || 'Default', mod: secs, usn: -1, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
      new: { bury: c.buryNew, delays: c.learnSteps, initialFactor: 2500, ints: [1, 4, 0], order: c.newOrder === 'random' ? 0 : 1, perDay: c.newPerDay },
      rev: { bury: c.buryRev, ease4: 1.3, ivlFct: 1, maxIvl: c.maxIvl, perDay: c.revPerDay, hardFactor: 1.2 },
      lapse: { delays: c.relearnSteps, leechAction: 1, leechFails: 8, minInt: 1, mult: 0 }, desiredRetention: c.retention,
    };
    deckJson[d.id] = { id: d.id, name: d.name, mod: secs, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
      collapsed: false, browserCollapsed: false, desc: d.desc || '', dyn: 0, conf: cid, extendNew: 0, extendRev: 0 };
  }
  dconf[1] ||= { ...Object.values(dconf)[0], id: 1, name: 'Default' };
  db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [crt, now, now, JSON.stringify({ nextPos: cards.length + 1, schedVer: 2, curDeck: did, activeDecks: [did] }),
    JSON.stringify(models), JSON.stringify(deckJson), JSON.stringify(dconf), '{}']);

  progress('Writing notes…');
  const files = new Set();
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const n of notes) {
    const nt = col.types.get(n.mid);
    const sf = stripHtml(n.fields[nt.sortf || 0] || '');
    ins.run([n.id, n.guid, n.mid, Math.floor((n.mtime || now) / 1000), -1, n.tags.length ? ` ${n.tags.join(' ')} ` : '', n.fields.join('\x1f'), sf, await csum(n.fields[0] || ''), 0, '']);
    if (media) for (const f of n.fields) mediaRefs(f).forEach(x => files.add(x));
  }
  ins.free();
  if (media) for (const mid of mids) { const nt = col.types.get(mid); for (const t of nt.templates) [...mediaRefs(t.qfmt), ...mediaRefs(t.afmt)].forEach(x => files.add(x)); mediaRefs(nt.css).forEach(x => files.add(x)); }

  const insc = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const c of cards) {
    const conf = confFor(c.did);
    let type = c.type, queue = c.type, due = c.pos || 0, ivl = c.ivl, left = 0;
    if (!scheduling || c.type === 0) { type = 0; queue = 0; due = c.pos || 0; ivl = 0; }
    else if (c.type === 2) due = dayIndex(c.due) - (today - DAYS_BACK);
    else {
      queue = 1; due = Math.floor(c.due / 1000);
      const steps = c.type === 3 ? conf.relearnSteps : conf.learnSteps;
      const remaining = Math.max(1, steps.length - (c.step || 0));
      left = remaining * 1000 + remaining;
    }
    if (c.susp) queue = -1;
    const data = scheduling && c.s ? JSON.stringify({ s: +c.s.toFixed(4), d: +c.d.toFixed(4), dr: conf.retention }) : '';
    insc.run([c.id, c.nid, c.did, c.ord, Math.floor((c.mtime || now) / 1000), -1, type, queue, due, scheduling ? ivl : 0, 2500,
      scheduling ? c.reps : 0, scheduling ? c.lapses : 0, left, 0, 0, c.flags || 0, data]);
  }
  insc.free();
  if (scheduling) {
    const cids = new Set(cards.map(c => c.id));
    const logs = (await store.all('revlog')).filter(r => cids.has(r.cid));
    const insr = db.prepare('INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)');
    for (const r of logs) insr.run([r.id, r.cid, -1, r.ease, r.ivl, r.lastIvl, 2500, r.time || 0, r.type]);
    insr.free();
  }
  db.exec('COMMIT');
  const colBytes = db.export();
  db.close();

  const zip = { 'collection.anki2': [colBytes, { level: 6 }] };
  const mediaMap = {};
  let i = 0;
  for (const name of files) {
    const blob = await blobFor(name).catch(() => null);
    if (!blob) continue;
    zip[String(i)] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
    mediaMap[i] = name;
    i++;
    if (i % 25 === 0) progress(`Packing media ${i}/${files.size}…`);
  }
  zip.media = strToU8(JSON.stringify(mediaMap));
  progress('Zipping…');
  return new Blob([zipSync(zip)], { type: 'application/octet-stream' });
}
