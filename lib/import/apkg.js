// Reads an .apkg/.colpkg (any Anki version) into plain objects in our own shape.
// Formats: meta version 3 = collection.anki21b + media manifest are zstd, media files zstd, notetypes in
// protobuf tables (schema 18). Older = collection.anki21/.anki2 SQLite with JSON in `col`, media is a JSON map.
import { unzipSync } from '../vendor/fflate.mjs';
import { decompress } from '../vendor/fzstd.mjs';
import { decode, str, num, msg, floats } from './proto.js';
import { sqlite } from '../sqlite.js';

const td = new TextDecoder();
const rows = (db, sql) => {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
};

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', opus: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', css: 'text/css', js: 'text/javascript' };
export const mimeOf = name => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

async function sha1hex(bytes) {
  const h = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

export async function readPackage(buf, progress = () => {}) {
  progress('Unzipping…');
  const zip = unzipSync(new Uint8Array(buf));
  const version = zip.meta ? num(decode(zip.meta), 1, 1) : 1;
  let colBytes;
  if (version >= 3 && zip['collection.anki21b']) colBytes = decompress(zip['collection.anki21b']);
  else colBytes = zip['collection.anki21'] || zip['collection.anki2'];
  if (!colBytes) throw new Error('No Anki collection found in this file.');

  progress('Reading collection…');
  const S = await sqlite();
  let db = new S.Database(colBytes);
  // Anki declares a custom "unicase" collation sql.js doesn't have. Drop it from the schema and reopen.
  if (rows(db, "select 1 from sqlite_master where sql like '%unicase%'").length) {
    db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,' COLLATE unicase','') WHERE sql LIKE '%unicase%'; PRAGMA writable_schema=OFF;");
    const bytes = db.export();
    db.close();
    db = new S.Database(bytes);
  }
  const col = rows(db, 'select crt, models, decks, dconf from col')[0];
  const modern = rows(db, "select name from sqlite_master where type='table' and name='notetypes'").length > 0;

  const out = { crt: col.crt, notetypes: [], decks: [], deckConfigs: [], notes: [], cards: [], revlog: [], media: [] };

  if (modern) {
    const fields = rows(db, 'select ntid, ord, name from fields order by ntid, ord');
    const tmpls = rows(db, 'select ntid, ord, name, config from templates order by ntid, ord');
    for (const nt of rows(db, 'select id, name, config from notetypes')) {
      const c = decode(nt.config);
      out.notetypes.push({
        id: nt.id, name: nt.name, kind: num(c, 1) === 1 ? 'cloze' : 'normal', css: str(c, 3), sortf: num(c, 2),
        fields: fields.filter(f => f.ntid === nt.id).map(f => ({ name: f.name })),
        templates: tmpls.filter(t => t.ntid === nt.id).map(t => { const tc = decode(t.config); return { name: t.name, qfmt: str(tc, 1), afmt: str(tc, 2) }; }),
      });
    }
    for (const d of rows(db, 'select id, name, kind from decks')) {
      const k = decode(d.kind);
      const normal = msg(k, 1);
      out.decks.push({ id: d.id, name: d.name.split('\x1f').join('::'), conf: num(normal, 1, 1), desc: str(normal, 4), filtered: !!k[2] });
    }
    for (const dc of rows(db, 'select id, name, config from deck_config')) {
      const c = decode(dc.config);
      out.deckConfigs.push({
        id: dc.id, name: dc.name, learnSteps: floats(c, 1), relearnSteps: floats(c, 2),
        newPerDay: num(c, 9, 20), revPerDay: num(c, 10, 200), maxIvl: num(c, 16, 36500) || 36500,
        retention: c[37] ? +c[37][0].toFixed(3) : 0.9, buryNew: !!num(c, 27), buryRev: !!num(c, 28), newOrder: 'due',
      });
    }
  } else {
    for (const m of Object.values(JSON.parse(col.models))) {
      out.notetypes.push({
        id: m.id, name: m.name, kind: m.type === 1 ? 'cloze' : 'normal', css: m.css || '', sortf: m.sortf || 0,
        fields: m.flds.sort((a, b) => a.ord - b.ord).map(f => ({ name: f.name })),
        templates: m.tmpls.sort((a, b) => a.ord - b.ord).map(t => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
      });
    }
    for (const d of Object.values(JSON.parse(col.decks))) out.decks.push({ id: d.id, name: d.name, conf: d.conf || 1, desc: d.desc || '', filtered: !!d.dyn });
    for (const c of Object.values(JSON.parse(col.dconf || '{}'))) {
      out.deckConfigs.push({
        id: c.id, name: c.name, learnSteps: c.new?.delays || [1, 10], relearnSteps: c.lapse?.delays || [10],
        newPerDay: c.new?.perDay ?? 20, revPerDay: c.rev?.perDay ?? 200, maxIvl: c.rev?.maxIvl || 36500,
        retention: c.desiredRetention || 0.9, buryNew: !!c.new?.bury, buryRev: !!c.rev?.bury, newOrder: c.new?.order === 0 ? 'random' : 'due',
      });
    }
  }

  progress('Reading notes and cards…');
  for (const n of rows(db, 'select id, guid, mid, mod, tags, flds from notes')) {
    out.notes.push({ id: n.id, guid: n.guid, mid: n.mid, mod: n.mod, tags: n.tags.trim().split(/\s+/).filter(Boolean), fields: n.flds.split('\x1f') });
  }
  out.cards = rows(db, 'select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data from cards');
  out.revlog = rows(db, 'select id, cid, ease, ivl, lastIvl, factor, time, type from revlog order by id');
  db.close();

  // Media
  progress('Reading media…');
  if (zip.media) {
    if (version >= 3) {
      const entries = decode(decompress(zip.media))[1] || [];
      entries.forEach((e, i) => {
        const m = decode(e);
        const zipName = m[255] ? String(m[255][0]) : String(i);
        out.media.push({ name: str(m, 1), size: num(m, 2), sha1: m[3] ? hex(m[3][0]) : null, file: zipName });
      });
    } else {
      let map = {};
      try { map = JSON.parse(td.decode(zip.media)); } catch {}
      for (const [file, name] of Object.entries(map)) out.media.push({ name, file });
    }
  }
  for (const m of out.media) {
    let bytes = zip[m.file];
    if (!bytes) { m.missing = true; continue; }
    if (version >= 3) bytes = decompress(bytes);
    m.sha1 ||= await sha1hex(bytes);
    m.size = bytes.length;
    m.blob = new Blob([bytes], { type: mimeOf(m.name) });
    delete zip[m.file];
  }
  out.media = out.media.filter(m => !m.missing);
  return out;
}
