// The reviewer: question → show answer → Again/Hard/Good/Easy, with Anki's keyboard shortcuts.
import * as C from '../lib/col.js';
import { schedule, humanInterval, dayIndex } from '../lib/srs.js';
import { renderCard, mediaRefs, typeCompare } from '../lib/render.js';
import { dataUrls } from '../lib/media.js';
import { icon, toast, $ } from '../lib/ui.js';

const LABELS = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const coarse = () => matchMedia('(pointer: coarse)').matches;

export function mountReview(el, did) {
  document.body.classList.add('reviewing');
  el.innerHTML = `
    <div class="reviewer">
      <div class="rv-top">
        <a class="iconbtn" href="#/deck/${did}" aria-label="Back to deck">${icon.back}</a>
        <div class="counts" id="counts"></div>
        <button class="iconbtn" id="undo" aria-label="Undo" title="Undo (z)">${icon.undo}</button>
        <button class="iconbtn" id="more" aria-label="More actions">${icon.more}</button>
      </div>
      <div class="rv-frame"><iframe id="frame" src="card.html" sandbox="allow-scripts" title="Card" referrerpolicy="no-referrer"></iframe></div>
      <div class="rv-bottom" id="bottom"></div>
      <div class="menu panel" id="menu" hidden></div>
    </div>`;
  const frame = $('#frame', el);
  const bottom = $('#bottom', el);
  const menu = $('#menu', el);
  let ready = false, loading = false, card = null, rendered = null, side = 'q', shownAt = 0, options = null, busy = false, laterTimer = null;
  let typedResolve = null;

  const post = msg => frame.contentWindow.postMessage(msg, '*');

  function updateCounts() {
    const c = C.counts(did);
    const kind = !card ? '' : card.type === 0 ? 'n' : card.type === 2 ? 'r' : 'l';
    $('#counts', el).innerHTML = `<span class="c n ${kind === 'n' ? 'cur' : ''}">${c.n}</span><span class="c l ${kind === 'l' ? 'cur' : ''}">${c.l}</span><span class="c r ${kind === 'r' ? 'cur' : ''}">${c.r}</span>`;
    $('#undo', el).disabled = !C.canUndo();
  }

  async function next() {
    clearTimeout(laterTimer);
    card = C.nextCard(did);
    side = 'q';
    updateCounts();
    if (!card) return finished();
    // Ignore answer keys until this card's question is on screen.
    loading = true;
    const note = C.col.notes.get(card.nid);
    const nt = note && C.notetypeOf(note);
    if (!nt) { card = null; return finished(); }
    rendered = renderCard({ note, notetype: nt, card, deckName: C.deckName(card.did) });
    const media = await dataUrls(mediaRefs(rendered.q + rendered.a + rendered.css));
    post({ type: 'show', html: rendered.q, css: rendered.css, ord: rendered.ord, media, night: dark(), mobile: coarse(), autoplay: true });
    loading = false;
    bottom.innerHTML = `<button class="btn primary big block showans" id="show">Show answer</button>`;
    $('#show', bottom).onclick = showAnswer;
    shownAt = Date.now();
  }

  function finished() {
    const later = C.gather(did).learn[0];
    frame.parentElement.hidden = true;
    bottom.innerHTML = '';
    const congrats = document.createElement('div');
    congrats.className = 'congrats';
    congrats.innerHTML = `<h2>Congratulations!</h2><p class="muted">You have finished this deck for now.${later ? ` More learning cards are due ${new Date(later.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/deck/${did}">Back to deck</a><a class="btn" href="#/">Decks</a></div>`;
    frame.parentElement.after(congrats);
    if (later) laterTimer = setTimeout(() => { congrats.remove(); frame.parentElement.hidden = false; next(); }, Math.max(1000, later.due - Date.now()));
  }

  async function showAnswer() {
    if (side !== 'q' || !card || loading) return;
    side = 'a';
    let html = rendered.a;
    if (rendered.typeExpected != null && html.includes('[[typeans]]')) {
      const typed = await new Promise(res => { typedResolve = res; post({ type: 'typed' }); setTimeout(() => res(''), 300); });
      typedResolve = null;
      html = html.replace('[[typeans]]', typeCompare(typed, rendered.typeExpected));
    }
    post({ type: 'show', html, css: rendered.css, ord: rendered.ord, media: {}, night: dark(), mobile: coarse(), scrollToAnswer: true, autoplay: true });
    options = schedule(card, C.confFor(card.did));
    const now = Date.now();
    bottom.innerHTML = `<div class="answers">${[1, 2, 3, 4].map(e => `<button class="e${e}" data-ease="${e}"><span>${LABELS[e]}</span><small>${humanInterval(options[e].card.due, now)}</small></button>`).join('')}</div>`;
    bottom.querySelectorAll('[data-ease]').forEach(b => (b.onclick = () => rate(+b.dataset.ease)));
  }

  async function rate(ease) {
    if (side !== 'a' || busy || loading || !card) return;
    busy = true;
    try { await C.answer(card, ease, Date.now() - shownAt); } finally { busy = false; }
    next();
  }

  async function undo() {
    const c = await C.undo();
    if (!c) return;
    toast('Undid last answer');
    next();
  }

  // ---- Card actions ----
  async function setCards(list, patch, msg) { await C.updateCards(list.map(c => ({ ...c, ...patch }))); toast(msg); next(); }
  const actions = {
    edit: () => { location.hash = `#/edit/${card.nid}?back=${encodeURIComponent(location.hash)}`; },
    buryCard: () => setCards([card], { buried: dayIndex() }, 'Card buried until tomorrow'),
    buryNote: () => setCards(C.cardsOf(card.nid), { buried: dayIndex() }, 'Note buried until tomorrow'),
    suspendCard: () => setCards([card], { susp: true }, 'Card suspended'),
    suspendNote: () => setCards(C.cardsOf(card.nid), { susp: true }, 'Note suspended'),
    mark: async () => {
      const note = C.col.notes.get(card.nid);
      const has = note.tags.includes('marked');
      await C.saveNote({ ...note, tags: has ? note.tags.filter(t => t !== 'marked') : [...note.tags, 'marked'] });
      toast(has ? 'Unmarked' : 'Marked');
    },
    deleteNote: async () => { if (!confirm('Delete this note and all its cards?')) return; await C.deleteNotes([card.nid]); toast('Note deleted'); next(); },
    replay: () => post({ type: 'replay' }),
    options: () => { location.hash = `#/options/${did}`; },
  };
  async function flag(n) {
    const f = card.flags === n ? 0 : n;
    await C.updateCards([{ ...card, flags: f }]);
    card = C.col.cards.get(card.id);
    toast(f ? `Flag ${f}` : 'Flag removed');
  }

  function openMenu() {
    if (!card) return;
    menu.hidden = !menu.hidden;
    if (menu.hidden) return;
    const item = (k, label, key) => `<button data-act="${k}"><span>${label}</span><kbd>${key || ''}</kbd></button>`;
    menu.innerHTML = `
      ${item('edit', 'Edit note', 'E')}
      <div class="flags">${[1, 2, 3, 4, 5, 6, 7].map(n => `<button data-flag="${n}" aria-label="Flag ${n}" title="Flag ${n} (Ctrl+${n})"><span class="flagdot f${n}" style="${card.flags === n ? 'outline:2px solid var(--ink);outline-offset:2px' : ''}"></span></button>`).join('')}</div>
      ${item('mark', 'Mark note', '*')}${item('buryCard', 'Bury card', '-')}${item('buryNote', 'Bury note', '=')}
      ${item('suspendCard', 'Suspend card', '@')}${item('suspendNote', 'Suspend note', '!')}${item('replay', 'Replay audio', 'R')}
      ${item('options', 'Deck options', 'O')}${item('deleteNote', 'Delete note', 'Ctrl+Del')}`;
    menu.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => { menu.hidden = true; actions[b.dataset.act](); }));
    menu.querySelectorAll('[data-flag]').forEach(b => (b.onclick = () => { menu.hidden = true; flag(+b.dataset.flag); }));
  }
  $('#more', el).onclick = openMenu;
  $('#undo', el).onclick = undo;

  function onKey(k) {
    if (!menu.hidden && k.key === 'Escape') { menu.hidden = true; return; }
    if (k.ctrl && /^[0-7]$/.test(k.key)) { if (card) flag(+k.key); return; }
    if (k.ctrl && (k.key === 'Delete' || k.key === 'Backspace')) { if (card) actions.deleteNote(); return; }
    if (k.ctrl && k.key === 'z') return undo();
    if (k.ctrl || k.alt) return;
    if (k.key === ' ' || k.key === 'Enter') { side === 'q' ? showAnswer() : !k.fromInput && rate(3); return; }
    if (side === 'a' && /^[1-4]$/.test(k.key)) return rate(+k.key);
    if (!card) return;
    if (k.key === 'z') return undo();
    const map = { e: 'edit', '-': 'buryCard', '=': 'buryNote', '@': 'suspendCard', '!': 'suspendNote', r: 'replay', '*': 'mark', o: 'options' };
    if (map[k.key]) actions[map[k.key]]();
  }

  const onMessage = e => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type === 'ready') { ready = true; next(); }
    else if (m.type === 'key') onKey(m);
    else if (m.type === 'tap') { if (!menu.hidden) menu.hidden = true; else if (side === 'q') showAnswer(); }
    else if (m.type === 'typed' && typedResolve) typedResolve(m.value);
    else if (m.type === 'open' && /^https?:\/\//i.test(m.href)) window.open(m.href, '_blank', 'noopener,noreferrer');
  };
  const onKeydown = e => {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
    onKey({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
  };
  addEventListener('message', onMessage);
  addEventListener('keydown', onKeydown);
  const unsub = C.onChange(() => { if (ready) updateCounts(); });

  return () => {
    clearTimeout(laterTimer);
    removeEventListener('message', onMessage);
    removeEventListener('keydown', onKeydown);
    unsub();
    document.body.classList.remove('reviewing');
  };
}
