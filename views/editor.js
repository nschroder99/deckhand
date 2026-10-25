// Add / edit notes: one rich-text box per field, Anki's cloze shortcut, image paste, HTML view, tags.
import * as C from '../lib/col.js';
import { addFile, blobFor } from '../lib/media.js';
import { esc, toast, sanitize, $, $$ } from '../lib/ui.js';

const LS = 'deckhand.addPrefs';
const prefs = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const savePrefs = p => { try { localStorage.setItem(LS, JSON.stringify({ ...prefs(), ...p })); } catch {} };

// Field HTML <-> editor DOM. Images show via blob: URLs while editing, and go back to bare filenames on save.
async function fillEditor(ed, html) {
  ed.innerHTML = sanitize(html);
  for (const img of ed.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:|blob:)/i.test(src)) continue;
    img.dataset.name = src;
    const blob = await blobFor(decodeURIComponent(src)).catch(() => null);
    if (blob) img.src = URL.createObjectURL(blob);
  }
}
function readEditor(ed) {
  const clone = ed.cloneNode(true);
  for (const img of clone.querySelectorAll('img[data-name]')) { img.setAttribute('src', img.dataset.name); img.removeAttribute('data-name'); }
  let html = clone.innerHTML.replace(/<div><br><\/div>$/, '').replace(/^<br>$/, '');
  return html;
}

export function mountEditor(el, { nid = null, back = '' } = {}) {
  const editing = nid != null;
  const note = editing ? C.col.notes.get(nid) : null;
  if (editing && !note) { el.innerHTML = '<p class="muted" style="padding:40px 0">That note no longer exists.</p>'; return; }
  const p = prefs();
  const types = [...C.col.types.values()].sort((a, b) => a.name.localeCompare(b.name));
  const decks = [...C.col.decks.values()].sort((a, b) => a.name.localeCompare(b.name));
  let mid = editing ? note.mid : C.col.types.has(p.mid) ? p.mid : (types.find(t => t.name === 'Basic') || types[0])?.id;
  let did = C.col.decks.has(p.did) ? p.did : decks[0]?.id;
  const backHref = back || (editing ? '#/browse' : '#/');

  el.innerHTML = `
    <header class="top"><div>${editing ? `<a class="link back" href="${esc(backHref)}">‹ Back</a>` : ''}<p class="eyebrow">${editing ? 'Edit note' : 'Add'}</p><h1>${editing ? esc(C.notetypeOf(note)?.name || 'Note') : 'New note'}</h1></div></header>
    ${editing ? '' : `<div class="grid2">
      <div><label class="f" for="nt">Type</label><select class="t" id="nt">${types.map(t => `<option value="${t.id}" ${t.id === mid ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div><label class="f" for="dk">Deck</label><select class="t" id="dk">${decks.map(d => `<option value="${d.id}" ${d.id === did ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
    </div>`}
    <div id="fields"></div>
    <label class="f" for="tags">Tags</label><input class="t" id="tags" placeholder="space separated" autocapitalize="off" autocomplete="off" spellcheck="false">
    <div class="row" style="margin-top:18px">
      <button class="btn primary" id="save">${editing ? 'Save' : 'Add'}</button>
      ${editing ? `<a class="btn" href="${esc(backHref)}">Cancel</a><span class="spacer"></span><button class="btn danger" id="del">Delete note</button>` : '<span class="muted small">Ctrl+Enter adds · Ctrl+Shift+C makes a cloze</span>'}
    </div>
    ${editing ? `<p class="muted small" style="margin-top:18px">${C.cardsOf(nid).length} card(s) · created ${new Date(nid).toLocaleDateString()}</p>` : ''}`;

  const fieldsEl = $('#fields', el);
  const tagsEl = $('#tags', el);
  tagsEl.value = editing ? note.tags.join(' ') : p.tags || '';

  function renderFields(values) {
    const nt = C.col.types.get(mid);
    fieldsEl.innerHTML = nt.fields.map((f, i) => `
      <label class="f">${esc(f.name)}</label>
      <div class="field" data-i="${i}">
        <div class="bar">
          <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          ${nt.kind === 'cloze' ? '<button type="button" data-cmd="cloze" title="Cloze (Ctrl+Shift+C)">[…]</button>' : ''}
          <button type="button" data-cmd="image" title="Attach image or audio">＋</button>
          <span class="spacer"></span>
          <button type="button" data-cmd="html" title="HTML editor (Ctrl+Shift+X)">&lt;/&gt;</button>
        </div>
        <div class="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${esc(f.name)}"></div>
        <textarea hidden spellcheck="false" aria-label="${esc(f.name)} HTML"></textarea>
      </div>`).join('');
    $$('.field', fieldsEl).forEach((box, i) => fillEditor($('.ed', box), values[i] || ''));
  }
  renderFields(editing ? note.fields : []);

  const values = () => $$('.field', fieldsEl).map(box => {
    const ta = $('textarea', box);
    return ta.hidden ? readEditor($('.ed', box)) : ta.value;
  });

  function cloze(ed, same) {
    const all = values().join(' ');
    const nums = [...all.matchAll(/\{\{c(\d+)::/g)].map(m => +m[1]);
    const n = nums.length ? Math.max(...nums) + (same ? 0 : 1) : 1;
    ed.focus();
    const sel = getSelection();
    const text = sel.rangeCount ? sel.getRangeAt(0).toString() : '';
    document.execCommand('insertText', false, `{{c${n}::${text}}}`);
    if (!text) { const s = getSelection(); for (let k = 0; k < 2; k++) s.modify?.('move', 'backward', 'character'); }
  }

  async function attach(ed) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,audio/*,video/*';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      const name = await addFile(f);
      ed.focus();
      if (f.type.startsWith('image/')) {
        document.execCommand('insertHTML', false, `<img src="${URL.createObjectURL(f)}" data-name="${esc(name)}">`);
      } else document.execCommand('insertText', false, `[sound:${name}]`);
    };
    input.click();
  }

  fieldsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]');
    if (!b) return;
    const box = b.closest('.field');
    const ed = $('.ed', box), ta = $('textarea', box);
    const cmd = b.dataset.cmd;
    if (cmd === 'html') {
      if (ta.hidden) { ta.value = readEditor(ed); ta.hidden = false; ed.hidden = true; ta.focus(); }
      else { fillEditor(ed, ta.value); ta.hidden = true; ed.hidden = false; ed.focus(); }
    } else if (cmd === 'cloze') cloze(ed, false);
    else if (cmd === 'image') attach(ed);
    else { ed.focus(); document.execCommand(cmd); }
  });
  fieldsEl.addEventListener('keydown', e => {
    const ed = e.target.closest('.ed');
    const ctrl = e.ctrlKey || e.metaKey;
    if (ed && ctrl && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); cloze(ed, e.altKey); }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); e.target.closest('.field').querySelector('[data-cmd=html]').click(); }
  });
  fieldsEl.addEventListener('paste', async e => {
    const ed = e.target.closest('.ed');
    if (!ed) return;
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    e.preventDefault();
    if (file) {
      const name = await addFile(file);
      document.execCommand('insertHTML', false, `<img src="${URL.createObjectURL(file)}" data-name="${esc(name)}">`);
      return;
    }
    const html = e.clipboardData.getData('text/html');
    if (html) document.execCommand('insertHTML', false, sanitize(html).replace(/\s(class|style|id)="[^"]*"/g, ''));
    else document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  if (!editing) {
    $('#nt', el).onchange = e => { const old = values(); mid = +e.target.value; savePrefs({ mid }); renderFields(old); };
    $('#dk', el).onchange = e => { did = +e.target.value; savePrefs({ did }); };
  }

  async function save() {
    const fields = values();
    const tags = tagsEl.value.trim().split(/\s+/).filter(Boolean);
    try {
      if (editing) {
        await C.saveNote({ ...note, fields, tags });
        toast('Saved');
        location.hash = backHref;
      } else {
        await C.addNote({ mid, did, fields, tags });
        savePrefs({ mid, did, tags: tags.join(' ') });
        toast('Added');
        const nt = C.col.types.get(mid);
        renderFields(nt.fields.map(() => ''));
        $('.ed', fieldsEl)?.focus();
      }
    } catch (err) { toast(err.message); }
  }
  $('#save', el).onclick = save;
  el.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
  if (editing) $('#del', el).onclick = async () => {
    if (!confirm('Delete this note and its cards?')) return;
    await C.deleteNotes([nid]);
    toast('Note deleted');
    location.hash = back || '#/browse';
  };
  setTimeout(() => $('.ed', fieldsEl)?.focus(), 50);
}
