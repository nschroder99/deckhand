// Card browser: Anki search syntax, sortable list, bulk actions.
import * as C from '../lib/col.js';
import { search } from '../lib/search.js';
import { stripHtml } from '../lib/render.js';
import { dayIndex } from '../lib/srs.js';
import { esc, toast, $ } from '../lib/ui.js';

const PAGE = 200;

function dueText(c) {
  if (c.susp) return 'suspended';
  if (c.type === 0) return `new #${c.pos}`;
  const days = dayIndex(c.due) - dayIndex();
  if (c.type !== 2) return 'learning';
  return days <= 0 ? 'due' : days === 1 ? 'tomorrow' : new Date(c.due).toLocaleDateString([], { month: 'short', day: 'numeric', year: days > 300 ? '2-digit' : undefined });
}

export function mountBrowse(el, params) {
  let q = params.get('q') ?? '';
  let sort = params.get('sort') || 'created';
  let results = [], shown = PAGE;
  const selected = new Set();

  el.innerHTML = `
    <header class="top"><div><p class="eyebrow">Browse</p><h1>Cards</h1></div><span class="muted small num" id="count"></span></header>
    <div class="searchbar">
      <input class="t" id="q" type="search" placeholder='e.g. deck:Spanish tag:verbs is:due "exact phrase"' autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="search">
      <select class="t" id="sort" style="width:auto"><option value="created">Created</option><option value="due">Due</option><option value="sfld">Sort field</option><option value="deck">Deck</option><option value="ivl">Interval</option><option value="lapses">Lapses</option></select>
    </div>
    <ul class="list panel" id="list"></ul>
    <div class="row" style="justify-content:center;margin-top:12px"><button class="btn" id="moreBtn" hidden>Show more</button></div>
    <div class="bulk panel" id="bulk" hidden>
      <span class="small num" id="selCount"></span>
      <button class="btn sm" data-bulk="all">Select all</button>
      <button class="btn sm" data-bulk="suspend">Suspend</button>
      <button class="btn sm" data-bulk="unsuspend">Unsuspend</button>
      <button class="btn sm" data-bulk="deck">Change deck</button>
      <button class="btn sm" data-bulk="tag">Add tags</button>
      <button class="btn sm" data-bulk="untag">Remove tags</button>
      <button class="btn sm" data-bulk="forget">Reset</button>
      <button class="btn sm danger" data-bulk="delete">Delete</button>
      <button class="btn sm" data-bulk="none">Clear</button>
    </div>`;
  const input = $('#q', el), list = $('#list', el);
  input.value = q;
  $('#sort', el).value = sort;

  const sfld = c => { const n = C.col.notes.get(c.nid); const nt = n && C.notetypeOf(n); return n ? stripHtml(n.fields[nt?.sortf || 0] || '').trim() : ''; };
  const sorters = {
    created: (a, b) => b.nid - a.nid || a.ord - b.ord,
    due: (a, b) => (a.type === 0) - (b.type === 0) || (a.type === 0 ? a.pos - b.pos : a.due - b.due),
    sfld: (a, b) => sfld(a).localeCompare(sfld(b), undefined, { numeric: true, sensitivity: 'base' }),
    deck: (a, b) => C.deckName(a.did).localeCompare(C.deckName(b.did)),
    ivl: (a, b) => b.ivl - a.ivl, lapses: (a, b) => b.lapses - a.lapses,
  };

  function run() {
    try { results = search(q).sort(sorters[sort]); } catch { results = []; }
    shown = PAGE;
    selected.clear();
    draw();
    history.replaceState(null, '', `#/browse?q=${encodeURIComponent(q)}&sort=${sort}`);
  }

  function draw() {
    $('#count', el).textContent = `${results.length.toLocaleString()} card${results.length === 1 ? '' : 's'}`;
    list.innerHTML = results.slice(0, shown).map(c => {
      const n = C.col.notes.get(c.nid);
      const nt = C.notetypeOf(n);
      const tname = nt?.kind === 'cloze' ? `Cloze ${c.ord + 1}` : nt?.templates[c.ord]?.name || '';
      return `<li class="${c.susp ? 'susp' : ''}" data-cid="${c.id}">
        <input type="checkbox" aria-label="Select card" ${selected.has(c.id) ? 'checked' : ''}>
        <a class="main" href="#/edit/${c.nid}?back=${encodeURIComponent(location.hash)}">
          <span class="sf">${c.flags ? `<span class="flagdot f${c.flags}"></span> ` : ''}${esc(sfld(c).slice(0, 160)) || '<span class="muted">(empty)</span>'}</span>
          <span class="meta">${esc(C.deckName(c.did))} · ${esc(tname)}${n.tags.length ? ' · ' + esc(n.tags.slice(0, 4).join(' ')) : ''}</span>
        </a>
        <span class="due">${esc(dueText(c))}</span>
      </li>`;
    }).join('') || '<li style="display:block" class="muted">No cards match.</li>';
    $('#moreBtn', el).hidden = results.length <= shown;
    updateBulk();
  }
  function updateBulk() {
    $('#bulk', el).hidden = !selected.size;
    $('#selCount', el).textContent = `${selected.size} selected`;
  }

  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = input.value; run(); }, 250); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); q = input.value; run(); } });
  $('#sort', el).onchange = e => { sort = e.target.value; run(); };
  $('#moreBtn', el).onclick = () => { shown += PAGE; draw(); };
  list.addEventListener('change', e => {
    const li = e.target.closest('li[data-cid]');
    if (!li) return;
    const id = +li.dataset.cid;
    e.target.checked ? selected.add(id) : selected.delete(id);
    updateBulk();
  });

  $('#bulk', el).addEventListener('click', async e => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (!act) return;
    const cards = [...selected].map(id => C.col.cards.get(id)).filter(Boolean);
    const nids = [...new Set(cards.map(c => c.nid))];
    if (act === 'all') { results.forEach(c => selected.add(c.id)); draw(); return; }
    if (act === 'none') { selected.clear(); draw(); return; }
    if (act === 'suspend' || act === 'unsuspend') await C.updateCards(cards.map(c => ({ ...c, susp: act === 'suspend' })));
    else if (act === 'deck') {
      const name = prompt('Move to deck (name, use :: for subdecks):', C.deckName(cards[0].did));
      if (!name) return;
      const deck = await C.addDeck(name);
      await C.updateCards(cards.map(c => ({ ...c, did: deck.id })));
    } else if (act === 'tag' || act === 'untag') {
      const tags = (prompt(act === 'tag' ? 'Tags to add:' : 'Tags to remove:') || '').trim().split(/\s+/).filter(Boolean);
      if (!tags.length) return;
      for (const nid of nids) {
        const n = C.col.notes.get(nid);
        const next = act === 'tag' ? [...new Set([...n.tags, ...tags])] : n.tags.filter(x => !tags.includes(x));
        await C.saveNote({ ...n, tags: next });
      }
    } else if (act === 'forget') {
      if (!confirm(`Reset ${cards.length} card(s) to new? Their review progress will be cleared.`)) return;
      let pos = Math.max(0, ...[...C.col.cards.values()].filter(c => c.type === 0).map(c => c.pos)) + 1;
      await C.updateCards(cards.map(c => ({ ...c, type: 0, due: 0, pos: pos++, ivl: 0, s: 0, d: 0, step: 0, reps: 0, lapses: 0, last: 0 })));
    } else if (act === 'delete') {
      if (!confirm(`Delete ${nids.length} note(s) and all their cards?`)) return;
      await C.deleteNotes(nids);
    }
    toast('Done');
    run();
  });

  run();
  if (!q) input.focus();
}
