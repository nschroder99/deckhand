// Deck options (presets shared between decks, like Anki) and the note type / card template editor.
import * as C from '../lib/col.js';
import { DEFAULT_CONF } from '../lib/srs.js';
import { esc, toast, $ } from '../lib/ui.js';

// Steps as Anki writes them: "1m 10m 1h 1d" <-> minutes.
const fmtSteps = s => s.map(m => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : m < 1 ? `${Math.round(m * 60)}s` : `${+m.toFixed(2)}m`)).join(' ');
function parseSteps(text) {
  const out = [];
  for (const t of text.trim().split(/[\s,]+/).filter(Boolean)) {
    const m = t.match(/^(\d+(?:\.\d+)?)([smhd]?)$/i);
    if (!m) throw new Error(`"${t}" isn't a step. Use values like 1m 10m 1h 1d.`);
    out.push(+m[1] * ({ s: 1 / 60, m: 1, h: 60, d: 1440 }[(m[2] || 'm').toLowerCase()]));
  }
  return out;
}

export function mountOptions(el, did) {
  const deck = C.col.decks.get(did);
  if (!deck) { el.innerHTML = '<p class="muted" style="padding:40px 0">Deck not found.</p>'; return; }
  let conf = C.confFor(did);
  const users = id => [...C.col.decks.values()].filter(d => (C.col.confs.has(d.conf) ? d.conf : 1) === id).length;

  function draw() {
    const confs = [...C.col.confs.values()].sort((a, b) => a.name.localeCompare(b.name));
    el.innerHTML = `
      <header class="top"><div><a class="link back" href="#/deck/${did}">‹ ${esc(deck.name.split('::').pop())}</a><p class="eyebrow">Options</p><h1>${esc(deck.name.split('::').pop())}</h1></div></header>
      <div class="panel pad">
        <label class="f" for="preset">Preset</label>
        <div class="row"><select class="t" id="preset" style="flex:1">${confs.map(c => `<option value="${c.id}" ${c.id === conf.id ? 'selected' : ''}>${esc(c.name)} (used by ${users(c.id)})</option>`).join('')}</select>
          <button class="btn sm" id="clone">New preset</button></div>
        <label class="f" for="name">Preset name</label><input class="t" id="name" value="${esc(conf.name)}">
        <h3>Daily limits</h3>
        <div class="grid2">
          <div><label class="f" for="np">New cards/day</label><input class="t" id="np" type="number" min="0" inputmode="numeric" value="${conf.newPerDay}"></div>
          <div><label class="f" for="rp">Maximum reviews/day</label><input class="t" id="rp" type="number" min="0" inputmode="numeric" value="${conf.revPerDay}"></div>
        </div>
        <h3>Steps</h3>
        <div class="grid2">
          <div><label class="f" for="ls">Learning steps</label><input class="t" id="ls" value="${esc(fmtSteps(conf.learnSteps))}" autocapitalize="off"></div>
          <div><label class="f" for="rs">Relearning steps</label><input class="t" id="rs" value="${esc(fmtSteps(conf.relearnSteps))}" autocapitalize="off"></div>
        </div>
        <h3>FSRS</h3>
        <div class="grid2">
          <div><label class="f" for="ret">Desired retention</label><input class="t" id="ret" type="number" min="0.7" max="0.99" step="0.01" value="${conf.retention}"></div>
          <div><label class="f" for="mi">Maximum interval (days)</label><input class="t" id="mi" type="number" min="1" inputmode="numeric" value="${conf.maxIvl}"></div>
        </div>
        <p class="muted small">Higher retention means more reviews. 0.85–0.92 suits most people.</p>
        <h3>New cards</h3>
        <label class="f" for="order">Order</label>
        <select class="t" id="order"><option value="due" ${conf.newOrder !== 'random' ? 'selected' : ''}>In the order added</option><option value="random" ${conf.newOrder === 'random' ? 'selected' : ''}>Random</option></select>
        <h3>Burying</h3>
        <label class="check"><input type="checkbox" id="bn" ${conf.buryNew ? 'checked' : ''}> Bury new siblings until tomorrow</label>
        <label class="check"><input type="checkbox" id="br" ${conf.buryRev ? 'checked' : ''}> Bury review siblings until tomorrow</label>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="save">Save</button><a class="btn" href="#/deck/${did}">Cancel</a>
          <span class="spacer"></span>${conf.id !== 1 ? '<button class="btn danger" id="delp">Delete preset</button>' : ''}</div>
      </div>
      <h3>Description</h3>
      <div class="panel pad"><textarea class="t" id="desc" style="font-family:var(--sans)">${esc(deck.desc || '')}</textarea>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="saveDesc">Save description</button></div></div>`;

    $('#preset', el).onchange = e => { conf = { ...DEFAULT_CONF, ...C.col.confs.get(+e.target.value) }; draw(); };
    $('#clone', el).onclick = async () => {
      const name = prompt('Name for the new preset:', deck.name.split('::').pop());
      if (!name) return;
      conf = { ...conf, id: C.newId(), name };
      await C.saveConf(conf);
      draw();
    };
    $('#save', el).onclick = async () => {
      try {
        const next = {
          ...conf, name: $('#name', el).value.trim() || conf.name,
          newPerDay: Math.max(0, +$('#np', el).value | 0), revPerDay: Math.max(0, +$('#rp', el).value | 0),
          learnSteps: parseSteps($('#ls', el).value), relearnSteps: parseSteps($('#rs', el).value),
          retention: Math.min(0.99, Math.max(0.7, +$('#ret', el).value || 0.9)), maxIvl: Math.max(1, +$('#mi', el).value | 0),
          newOrder: $('#order', el).value, buryNew: $('#bn', el).checked, buryRev: $('#br', el).checked,
        };
        await C.saveConf(next);
        if (deck.conf !== next.id) await C.saveDeck({ ...deck, conf: next.id });
        toast('Options saved');
        location.hash = `#/deck/${did}`;
      } catch (err) { toast(err.message); }
    };
    $('#saveDesc', el).onclick = async () => { await C.saveDeck({ ...C.col.decks.get(did), desc: $('#desc', el).value }); toast('Saved'); };
    const delp = $('#delp', el);
    if (delp) delp.onclick = async () => {
      if (!confirm(`Delete preset "${conf.name}"? Decks using it go back to Default.`)) return;
      const { remove } = await import('../lib/store.js');
      for (const d of C.col.decks.values()) if (d.conf === conf.id) await C.saveDeck({ ...d, conf: 1 });
      await remove([['deckConfigs', conf.id]]);
      C.col.confs.delete(conf.id);
      conf = C.confFor(did);
      draw();
    };
  }
  draw();
}

export function mountNotetypes(el, id) {
  const types = [...C.col.types.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!id) {
    el.innerHTML = `
      <header class="top"><div><a class="link back" href="#/settings">‹ Settings</a><p class="eyebrow">Note types</p><h1>Note types</h1></div></header>
      <ul class="list panel">${types.map(t => {
        const n = [...C.col.notes.values()].filter(x => x.mid === t.id).length;
        return `<li style="grid-template-columns:1fr auto"><a class="main" href="#/notetypes/${t.id}"><span class="sf">${esc(t.name)}</span><span class="meta">${t.kind === 'cloze' ? 'Cloze' : `${t.templates.length} card type(s)`} · ${t.fields.length} fields</span></a><span class="due">${n} notes</span></li>`;
      }).join('')}</ul>`;
    return;
  }
  const nt = C.col.types.get(id);
  if (!nt) { el.innerHTML = '<p class="muted">Not found.</p>'; return; }
  let ti = 0;
  const draft = structuredClone(nt);
  function draw() {
    const t = draft.templates[ti];
    el.innerHTML = `
      <header class="top"><div><a class="link back" href="#/notetypes">‹ Note types</a><p class="eyebrow">${draft.kind === 'cloze' ? 'Cloze' : 'Standard'} note type</p><h1>${esc(draft.name)}</h1></div></header>
      <div class="panel pad">
        <label class="f" for="nm">Name</label><input class="t" id="nm" value="${esc(draft.name)}">
        <label class="f" for="fl">Fields (one per line, in order — renaming here doesn't update templates)</label>
        <textarea class="t" id="fl" style="min-height:90px;font-family:var(--sans)">${esc(draft.fields.map(f => f.name).join('\n'))}</textarea>
        ${draft.templates.length > 1 ? `<label class="f" for="tp">Card type</label><select class="t" id="tp">${draft.templates.map((x, i) => `<option value="${i}" ${i === ti ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        <label class="f" for="qf">Front template</label><textarea class="t" id="qf" spellcheck="false">${esc(t.qfmt)}</textarea>
        <label class="f" for="af">Back template</label><textarea class="t" id="af" spellcheck="false">${esc(t.afmt)}</textarea>
        <label class="f" for="css">Styling (shared by all card types)</label><textarea class="t" id="css" spellcheck="false">${esc(draft.css)}</textarea>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="save">Save</button>
          ${draft.kind !== 'cloze' ? '<button class="btn" id="addT">Add card type</button>' : ''}</div>
        <p class="muted small">Changing fields or card types on a note type with existing notes: removing a field drops that field's content from every note; new card types create cards on the next edit of each note.</p>
      </div>`;
    const keep = () => { draft.templates[ti].qfmt = $('#qf', el).value; draft.templates[ti].afmt = $('#af', el).value; draft.css = $('#css', el).value; draft.name = $('#nm', el).value; };
    const tp = $('#tp', el);
    if (tp) tp.onchange = e => { keep(); ti = +e.target.value; draw(); };
    const addT = $('#addT', el);
    if (addT) addT.onclick = () => { keep(); draft.templates.push({ name: `Card ${draft.templates.length + 1}`, qfmt: draft.templates[0].qfmt, afmt: draft.templates[0].afmt }); ti = draft.templates.length - 1; draw(); };
    $('#save', el).onclick = async () => {
      keep();
      const names = $('#fl', el).value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!names.length) return toast('A note type needs at least one field.');
      const oldNames = nt.fields.map(f => f.name);
      draft.fields = names.map(name => ({ name }));
      await C.saveNotetype(draft);
      // Keep note contents aligned with the field list: matched by name, else by position for renamed fields.
      if (names.join('\x1f') !== oldNames.join('\x1f')) {
        for (const n of [...C.col.notes.values()].filter(x => x.mid === id)) {
          const fields = names.map((name, i) => { const j = oldNames.indexOf(name); return j >= 0 ? n.fields[j] : (oldNames[i] !== undefined && !names.includes(oldNames[i]) ? n.fields[i] : ''); });
          await C.saveNote({ ...n, fields });
        }
      }
      toast('Saved');
    };
  }
  draw();
}
