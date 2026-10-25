// Anki search syntax (the commonly used subset): words, "phrases", -negation, or, ( ), deck:, tag:, is:, flag:,
// note:, card:, field:value, prop:ivl>N (ivl, due, reps, lapses), added:N, rated:N, nid:, cid:. * is a wildcard.
import { col, deckName } from './col.js';
import { stripHtml } from './render.js';
import { dayIndex } from './srs.js';

function tokenize(q) {
  const out = [];
  const re = /\s*(-?)(\(|\)|"((?:[^"\\]|\\.)*)"|([^\s()"]+(?:"(?:[^"\\]|\\.)*")?))/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[2] === '(' || m[2] === ')') { out.push({ paren: m[2], neg: !!m[1] }); continue; }
    let text = m[3] !== undefined ? m[3] : m[4];
    text = text.replace(/^([^:]+:)"(.*)"$/, '$1$2').replace(/\\"/g, '"');
    if (m[3] === undefined && /^or$/i.test(text)) { out.push({ or: true }); continue; }
    if (m[3] === undefined && /^and$/i.test(text)) continue;
    out.push({ term: text, neg: !!m[1] });
  }
  return out;
}

function parse(tokens) {
  let i = 0;
  const expr = () => {
    const ors = [[]];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.paren === ')') { i++; break; }
      i++;
      if (t.or) { ors.push([]); continue; }
      if (t.paren === '(') { const sub = expr(); ors.at(-1).push(t.neg ? { not: sub } : sub); continue; }
      const m = matcher(t.term);
      ors.at(-1).push(t.neg ? { not: m } : m);
    }
    return { or: ors.map(and => ({ and })) };
  };
  return expr();
}

const glob = (pat, flags = 'i') => new RegExp('^' + pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', flags);
const contains = pat => new RegExp(pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');

function matcher(term) {
  const k = term.indexOf(':');
  const key = k > 0 ? term.slice(0, k).toLowerCase() : '';
  const val = k > 0 ? term.slice(k + 1) : term;
  const today = dayIndex();
  switch (key) {
    case 'deck': {
      if (val === 'current' || val === '*') return () => true;
      const re = glob(val);
      return c => { const n = deckName(c.did); return re.test(n) || n.split('::').some((_, i, a) => re.test(a.slice(0, i + 1).join('::'))); };
    }
    case 'tag': {
      if (val === 'none') return (c, n) => !n.tags.length;
      const re = glob(val);
      return (c, n) => n.tags.some(t => re.test(t) || t.toLowerCase().startsWith(val.toLowerCase().replace(/\*$/, '') + '::'));
    }
    case 'is':
      return {
        new: c => c.type === 0, learn: c => c.type === 1 || c.type === 3, review: c => c.type === 2 || c.type === 3,
        due: c => (c.type === 2 && dayIndex(c.due) <= today) || ((c.type === 1 || c.type === 3) && c.due <= Date.now()),
        suspended: c => c.susp, buried: c => c.buried >= today, flagged: c => c.flags > 0,
      }[val.toLowerCase()] || (() => false);
    case 'flag': return c => c.flags === +val;
    case 'note': { const re = glob(val); return (c, n) => re.test(col.types.get(n.mid)?.name || ''); }
    case 'card': {
      if (/^\d+$/.test(val)) return c => c.ord === +val - 1;
      const re = glob(val);
      return (c, n) => { const nt = col.types.get(n.mid); return nt && re.test(nt.kind === 'cloze' ? 'Cloze' : nt.templates[c.ord]?.name || ''); };
    }
    case 'nid': { const ids = new Set(val.split(',').map(Number)); return c => ids.has(c.nid); }
    case 'cid': { const ids = new Set(val.split(',').map(Number)); return c => ids.has(c.id); }
    case 'added': return c => dayIndex(c.id) > today - +val;
    case 'rated': { const since = today - +val.split(':')[0]; return c => c.last && dayIndex(c.last) > since; }
    case 'prop': {
      const m = val.match(/^(ivl|due|reps|lapses|ease)(<=|>=|!=|=|<|>)(-?[\d.]+)$/);
      if (!m) return () => false;
      const [, p, op, n] = m;
      const get = c => (p === 'due' ? (c.type === 2 ? dayIndex(c.due) - today : NaN) : p === 'ease' ? c.d : c[p]);
      const num = +n;
      return c => { const v = get(c); return op === '<' ? v < num : op === '>' ? v > num : op === '<=' ? v <= num : op === '>=' ? v >= num : op === '!=' ? v !== num : v === num; };
    }
    case '': return textMatcher(val);
    default: {
      // field:value
      const re = glob(val);
      return (c, n) => {
        const nt = col.types.get(n.mid);
        const i = nt?.fields.findIndex(f => f.name.toLowerCase() === key);
        return i >= 0 && re.test(stripHtml(n.fields[i] || '').trim());
      };
    }
  }
}
function textMatcher(val) {
  const re = contains(val);
  return (c, n) => n.fields.some(f => re.test(stripHtml(f)));
}

function evalNode(node, c, n) {
  if (typeof node === 'function') return node(c, n);
  if (node.not) return !evalNode(node.not, c, n);
  if (node.or) return node.or.some(x => evalNode(x, c, n));
  return node.and.every(x => evalNode(x, c, n));
}

export function search(q) {
  const tree = q.trim() ? parse(tokenize(q)) : null;
  const out = [];
  for (const c of col.cards.values()) {
    const n = col.notes.get(c.nid);
    if (!n) continue;
    if (!tree || evalNode(tree, c, n)) out.push(c);
  }
  return out;
}
