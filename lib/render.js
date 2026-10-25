// Anki template rendering: {{Field}}, {{#F}}…{{/F}}, {{^F}}…{{/F}}, filters (cloze, hint, text, type, furigana, kana, kanji),
// special fields, cloze numbering and card generation. Output HTML still holds media filenames; the card frame resolves them.

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const stripHtml = s => String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const nonEmpty = s => stripHtml(s || '').trim() !== '' || /<img|\[sound:/i.test(s || '');

// ---- Template parsing ----
// Tokens: text, {{name}}, {{#name}}, {{^name}}, {{/name}}. Nested sections become a tree.
function parse(tpl) {
  const root = [];
  const stack = [{ children: root }];
  const re = /\{\{([#^/]?)\s*([^}]*?)\s*\}\}/g;
  let last = 0, m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) stack.at(-1).children.push({ t: 'text', v: tpl.slice(last, m.index) });
    last = re.lastIndex;
    const [, sigil, name] = m;
    if (sigil === '#' || sigil === '^') {
      const node = { t: sigil === '#' ? 'if' : 'unless', name, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      if (stack.length > 1 && stack.at(-1).name === name) stack.pop();
    } else stack.at(-1).children.push({ t: 'field', v: name });
  }
  if (last < tpl.length) stack.at(-1).children.push({ t: 'text', v: tpl.slice(last) });
  return root;
}

// ---- Cloze ----
// Parses nested clozes ({{c1::outer {{c2::inner}} ::hint}}) into a tree and renders it for one card.
function parseCloze(text) {
  const root = { kids: [] };
  const stack = [root];
  const re = /\{\{c(\d+)::|\}\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) stack.at(-1).kids.push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[0] === '}}') {
      if (stack.length > 1) stack.at(-2).kids.push(stack.pop());
      else stack.at(-1).kids.push('}}');
    } else stack.push({ n: +m[1], kids: [] });
  }
  if (last < text.length) stack.at(-1).kids.push(text.slice(last));
  while (stack.length > 1) { const open = stack.pop(); stack.at(-1).kids.push(`{{c${open.n}::`, ...open.kids); }
  return root.kids;
}
// Split trailing ::hint from a cloze's own top-level text.
function splitHint(kids) {
  const body = [...kids];
  for (let i = body.length - 1; i >= 0; i--) {
    if (typeof body[i] !== 'string') continue;
    const k = body[i].lastIndexOf('::');
    if (k >= 0) { const hint = body[i].slice(k + 2); body[i] = body[i].slice(0, k); return { body, hint }; }
  }
  return { body, hint: null };
}
const plainOf = kids => kids.map(k => (typeof k === 'string' ? k : plainOf(splitHint(k.kids).body))).join('');

function renderCloze(nodes, ord, side, only = false) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') { if (!only) out += n; continue; }
    const { body, hint } = splitHint(n.kids);
    if (n.n === ord) {
      if (side === 'q') out += `<span class="cloze" data-cloze="${esc(plainOf(body))}" data-ordinal="${n.n}">[${hint ? esc(stripHtml(hint)) : '...'}]</span>`;
      else out += `<span class="cloze" data-ordinal="${n.n}">${renderCloze(body, ord, side, false)}</span>`;
    } else if (!only) out += `<span class="cloze-inactive" data-ordinal="${n.n}">${renderCloze(body, ord, side, false)}</span>`;
    else out += renderCloze(body, ord, side, true);
  }
  return out;
}
export function clozeNumbers(text) {
  const nums = new Set();
  for (const m of String(text).matchAll(/\{\{c(\d+)::/g)) nums.add(+m[1]);
  return nums;
}
function clozeHasContent(text, ord) {
  return new RegExp(`\\{\\{c${ord}::`).test(text);
}

// ---- Filters ----
function furigana(s, mode) {
  return s.replace(/ ?([^ >]+?)\[(.+?)\]/g, (_, base, reading) => {
    if (mode === 'kana') return reading;
    if (mode === 'kanji') return base;
    return `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`;
  });
}

let hintId = 0;
function applyFilters(value, filters, ctx, fieldName) {
  let v = value;
  for (const f of filters) {
    if (f === 'text') v = esc(stripHtml(v));
    else if (f === 'cloze') v = ctx.cloze ? renderCloze(parseCloze(v), ctx.ord + 1, ctx.side) : v;
    else if (f === 'cloze-only') v = ctx.cloze ? renderCloze(parseCloze(v), ctx.ord + 1, ctx.side, true) : v;
    else if (f === 'hint') {
      if (!nonEmpty(v)) return '';
      const id = 'hint' + ++hintId;
      v = `<a class="hint" href="#" onclick="this.style.display='none';document.getElementById('${id}').style.display='block';return false;">Show ${esc(fieldName)}</a><div id="${id}" class="hint" style="display:none">${v}</div>`;
    } else if (f === 'furigana' || f === 'kana' || f === 'kanji') v = furigana(v, f);
    else if (f === 'type') {
      // Handled by the reviewer: {{type:Field}} becomes an input on the front, a comparison on the back.
      let expected = stripHtml(v);
      if (filters.includes('cloze') || ctx.typeCloze) {
        const parts = [];
        const walk = ns => ns.forEach(n => { if (typeof n !== 'string') { const { body } = splitHint(n.kids); if (n.n === ctx.ord + 1) parts.push(stripHtml(plainOf(body))); walk(body); } });
        walk(parseCloze(value));
        expected = parts.join(', ');
      }
      ctx.typeExpected = expected;
      return ctx.side === 'q' ? '<input id="typeans" autocomplete="off" autocapitalize="off" spellcheck="false">' : '[[typeans]]';
    } else if (f === 'tts' || f.startsWith('tts ')) v = '';
  }
  return v;
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'field') {
      const parts = n.v.split(':');
      const name = parts.pop().trim();
      let filters = parts.map(p => p.trim()).reverse();
      if (filters.includes('type') && filters.includes('cloze')) { filters = ['type']; ctx.typeCloze = true; }
      if (name === 'FrontSide') { out += ctx.side === 'a' ? ctx.front : ''; continue; }
      let value;
      if (name in ctx.special) value = ctx.special[name];
      else if (name in ctx.fields) value = ctx.fields[name];
      else { out += ctx.side === 'q' && !filters.length ? `{unknown field ${esc(name)}}` : ''; continue; }
      out += applyFilters(value, filters, ctx, name);
    } else {
      const val = ctx.special[n.name] ?? ctx.fields[n.name];
      let truthy = nonEmpty(val);
      if (ctx.cloze && n.name in ctx.fields && truthy) {
        // A cloze field counts as non-empty only if it has this card's cloze, matching Anki.
        truthy = !clozeNumbers(val).size || clozeHasContent(val, ctx.ord + 1) || !ctx.clozeFields.includes(n.name);
      }
      if ((n.t === 'if') === truthy) out += renderNodes(n.children, ctx);
    }
  }
  return out;
}

const cache = new Map();
const parsed = tpl => { if (!cache.has(tpl)) cache.set(tpl, parse(tpl)); return cache.get(tpl); };

function clozeFieldNames(nt) {
  const names = new Set();
  for (const m of (nt.templates[0]?.qfmt || '').matchAll(/\{\{[^}]*cloze:([^}]+)\}\}/g)) names.add(m[1].trim());
  return [...names];
}

// Renders one card. Returns { q, a, css, typeExpected }.
export function renderCard({ note, notetype: nt, card, deckName = '' }) {
  const cloze = nt.kind === 'cloze';
  const tpl = cloze ? nt.templates[0] : nt.templates[card.ord] || nt.templates[0];
  const fields = Object.fromEntries(nt.fields.map((f, i) => [f.name, note.fields[i] ?? '']));
  const special = {
    Tags: (note.tags || []).join(' '), Type: nt.name, Deck: deckName, Subdeck: deckName.split('::').pop(),
    Card: tpl.name, CardFlag: card.flags ? `flag${card.flags}` : '', CardID: String(card.id),
  };
  const base = { fields, special, cloze, ord: card.ord, clozeFields: cloze ? clozeFieldNames(nt) : [] };
  const qctx = { ...base, side: 'q' };
  const q = renderNodes(parsed(tpl.qfmt), qctx);
  const actx = { ...base, side: 'a', front: q.replace('<input id="typeans" autocomplete="off" autocapitalize="off" spellcheck="false">', '[[typeans]]') };
  const a = renderNodes(parsed(tpl.afmt), actx);
  return { q, a, css: nt.css || '', typeExpected: qctx.typeExpected ?? actx.typeExpected ?? null, ord: card.ord };
}

// Which card ordinals a note should have (for new or edited notes).
export function cardOrdinals(note, nt) {
  if (nt.kind === 'cloze') {
    const nums = new Set();
    const names = clozeFieldNames(nt);
    nt.fields.forEach((f, i) => { if (names.includes(f.name)) for (const n of clozeNumbers(note.fields[i] || '')) nums.add(n - 1); });
    return [...nums].sort((x, y) => x - y);
  }
  const empty = { ...note, fields: note.fields.map(() => '') };
  const ords = [];
  nt.templates.forEach((t, ord) => {
    const card = { ord, flags: 0, id: 0 };
    const withFields = stripHtml(renderCard({ note, notetype: nt, card }).q).trim();
    const without = stripHtml(renderCard({ note: empty, notetype: nt, card }).q).trim();
    if (withFields !== without || /<img/i.test(renderCard({ note, notetype: nt, card }).q)) ords.push(ord);
  });
  return ords;
}

// Compare typed answer like Anki: correct chars, wrong chars, missing chars.
export function typeCompare(typed, expected) {
  typed = typed.trim(); expected = expected.trim();
  if (!typed) return `<code id="typeans">${esc(expected)}</code>`;
  if (typed === expected) return `<code id="typeans"><span class="typeGood">${esc(typed)}</span></code>`;
  // LCS-based diff.
  const n = typed.length, m = expected.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = typed[i] === expected[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, given = '', want = '';
  while (i < n && j < m) {
    if (typed[i] === expected[j]) { given += `<span class="typeGood">${esc(typed[i])}</span>`; want += `<span class="typeGood">${esc(expected[j])}</span>`; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { given += `<span class="typeBad">${esc(typed[i])}</span>`; i++; }
    else { want += `<span class="typeMissed">${esc(expected[j])}</span>`; j++; }
  }
  while (i < n) given += `<span class="typeBad">${esc(typed[i++])}</span>`;
  while (j < m) want += `<span class="typeMissed">${esc(expected[j++])}</span>`;
  return `<code id="typeans">${given}<br><span id="typearrow">&darr;</span><br>${want}</code>`;
}

// Media filenames referenced by rendered HTML or CSS.
export function mediaRefs(html) {
  const names = new Set();
  for (const m of html.matchAll(/<(?:img|audio|video|source)\b[^>]*?\bsrc\s*=\s*["']?([^"' >]+)/gi)) names.add(m[1]);
  for (const m of html.matchAll(/\[sound:([^\]]+)\]/g)) names.add(m[1]);
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) names.add(m[1]);
  return [...names].filter(n => !/^(https?:|data:|blob:|\/\/)/i.test(n)).map(n => { try { return decodeURIComponent(n); } catch { return n; } });
}
