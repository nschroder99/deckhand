// Stats: today, card states, a year of reviews (heatmap), 30-day forecast, retention.
// Each chart is single-series (one hue, no legend); every mark has a hover tooltip via <title>.
import * as C from '../lib/col.js';
import * as store from '../lib/store.js';
import { dayIndex, dayToMs } from '../lib/srs.js';
import { esc, $ } from '../lib/ui.js';

const fmtDay = d => new Date(dayToMs(d)).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

export async function mountStats(el, params) {
  const did = params.get('deck') ? +params.get('deck') : null;
  const decks = [...C.col.decks.values()].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `
    <header class="top"><div><p class="eyebrow">Stats</p><h1>${did ? esc(C.deckName(did)) : 'All decks'}</h1></div>
      <select class="t" id="deck" style="width:auto;max-width:100%"><option value="">All decks</option>${decks.map(d => `<option value="${d.id}" ${d.id === did ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></header>
    <div id="body"><p class="muted">Loading…</p></div>`;
  $('#deck', el).onchange = e => { location.hash = e.target.value ? `#/stats?deck=${e.target.value}` : '#/stats'; };

  const ids = did ? C.subtreeIds(did) : null;
  const cards = [...C.col.cards.values()].filter(c => !ids || ids.has(c.did));
  const cids = new Set(cards.map(c => c.id));
  const logs = (await store.all('revlog')).filter(r => cids.has(r.cid));
  const today = dayIndex();

  // Today
  const todays = logs.filter(r => dayIndex(r.id) === today);
  const minutes = todays.reduce((s, r) => s + (r.time || 0), 0) / 60000;
  const againToday = todays.filter(r => r.ease === 1).length;

  // States
  const st = { new: 0, learn: 0, young: 0, mature: 0, susp: 0 };
  for (const c of cards) {
    if (c.susp) st.susp++;
    else if (c.type === 0) st.new++;
    else if (c.type === 1 || c.type === 3) st.learn++;
    else if (c.ivl >= 21) st.mature++;
    else st.young++;
  }

  // Heatmap: reviews per day over the last 52 weeks.
  const perDay = new Map();
  for (const r of logs) { const d = dayIndex(r.id); perDay.set(d, (perDay.get(d) || 0) + 1); }
  // Columns are weeks (Monday at the top); the last column ends today.
  const weeks = 53, start = today - 52 * 7 - (new Date(dayToMs(today)).getDay() + 6) % 7;
  const max = Math.max(1, ...[...perDay.entries()].filter(([d]) => d >= start).map(([, n]) => n));
  const cell = 11, gap = 2;
  let heat = '';
  for (let d = start; d <= today; d++) {
    const i = d - start, x = Math.floor(i / 7) * (cell + gap), y = (i % 7) * (cell + gap);
    const n = perDay.get(d) || 0;
    const level = n ? 0.25 + 0.75 * Math.min(1, n / max) : 0;
    heat += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${n ? 'var(--accent)' : 'var(--line)'}" ${n ? `fill-opacity="${level.toFixed(2)}"` : ''}><title>${fmtDay(d)}: ${n} review${n === 1 ? '' : 's'}</title></rect>`;
  }
  const heatW = weeks * (cell + gap), heatH = 7 * (cell + gap);
  let streak = 0;
  for (let d = today - (perDay.has(today) ? 0 : 1); perDay.has(d); d--) streak++;
  const daysStudied = [...perDay.keys()].filter(d => d > today - 365).length;

  // Forecast: reviews due in each of the next 30 days (overdue counted on day 0).
  const fc = new Array(30).fill(0);
  for (const c of cards) {
    if (c.susp || c.type !== 2) continue;
    const d = Math.max(0, dayIndex(c.due) - today);
    if (d < 30) fc[d]++;
  }
  const fmax = Math.max(1, ...fc);
  const bw = 14, bg = 2, fh = 120;
  const forecast = fc.map((n, i) => {
    const h = n ? Math.max(4, (n / fmax) * fh) : 0;
    return `<g><rect x="${i * (bw + bg)}" y="0" width="${bw + bg}" height="${fh}" fill="transparent"><title>${i === 0 ? 'Today (incl. overdue)' : i === 1 ? 'Tomorrow' : fmtDay(today + i)}: ${n} due</title></rect>
      ${n ? `<path d="M${i * (bw + bg)},${fh} v${-(h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} z" fill="var(--accent)" pointer-events="none"/>` : ''}</g>`;
  }).join('');

  // True retention: share of review-card answers (not learning steps) that weren't Again, last 30 days.
  const recent = logs.filter(r => r.type === 1 && dayIndex(r.id) > today - 30);
  const retention = recent.length ? Math.round((100 * recent.filter(r => r.ease > 1).length) / recent.length) : null;

  $('#body', el).innerHTML = `
    <h3>Today</h3>
    <div class="statgrid">
      <div class="stat"><b>${todays.length}</b><span>reviews</span></div>
      <div class="stat"><b>${minutes < 1 && todays.length ? '<1' : Math.round(minutes)}</b><span>minutes</span></div>
      <div class="stat"><b>${todays.length ? Math.round((100 * (todays.length - againToday)) / todays.length) + '%' : '–'}</b><span>not Again</span></div>
      <div class="stat"><b>${streak}</b><span>day streak</span></div>
    </div>
    <h3>Cards</h3>
    <div class="statgrid">
      <div class="stat"><b class="c n">${st.new.toLocaleString()}</b><span>new</span></div>
      <div class="stat"><b class="c l">${st.learn.toLocaleString()}</b><span>learning</span></div>
      <div class="stat"><b class="c r">${st.young.toLocaleString()}</b><span>young (&lt;21d)</span></div>
      <div class="stat"><b class="c r">${st.mature.toLocaleString()}</b><span>mature</span></div>
    </div>
    ${st.susp ? `<p class="muted small">${st.susp.toLocaleString()} suspended</p>` : ''}
    <h3>Reviews, past year</h3>
    <div class="panel pad">
      <svg class="chart heat" viewBox="0 0 ${heatW} ${heatH}" role="img" aria-label="Reviews per day over the past year">${heat}</svg>
      <p class="muted small" style="margin:10px 0 0">${daysStudied} of the last 365 days studied · ${logs.length.toLocaleString()} review${logs.length === 1 ? "" : "s"} in total</p>
    </div>
    <h3>Due in the next 30 days</h3>
    <div class="panel pad">
      <svg class="chart" viewBox="0 -4 ${30 * (bw + bg)} ${fh + 22}" role="img" aria-label="Reviews due per day, next 30 days">
        <line x1="0" y1="${fh}" x2="${30 * (bw + bg)}" y2="${fh}" stroke="var(--line)"/>
        ${forecast}
        <text x="0" y="${fh + 16}" font-size="10" fill="var(--muted)">Today</text>
        <text x="${30 * (bw + bg)}" y="${fh + 16}" font-size="10" fill="var(--muted)" text-anchor="end">+29d</text>
        <text x="0" y="8" font-size="10" fill="var(--muted)">${fmax} max</text>
      </svg>
      <p class="muted small" style="margin:10px 0 0">${fc.reduce((a, b) => a + b, 0).toLocaleString()} reviews due · ${fc[1]} tomorrow</p>
    </div>
    <h3>Retention</h3>
    <div class="statgrid">
      <div class="stat"><b>${retention == null ? '–' : retention + '%'}</b><span>true retention, 30d</span></div>
      <div class="stat"><b>${recent.length.toLocaleString()}</b><span>review answers, 30d</span></div>
    </div>`;
}
