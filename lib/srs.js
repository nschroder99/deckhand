// Scheduling: Anki-style learning/relearning steps, with FSRS for memory state and review intervals
// (this is how Anki itself behaves with FSRS switched on).
// Card types: 0 new, 1 learning, 2 review, 3 relearning. Ratings: 1 Again, 2 Hard, 3 Good, 4 Easy.
import { fsrs, get_fuzz_range } from './vendor/ts-fsrs.mjs';

export const ROLLOVER_HOURS = 4;
const DAY = 86400000;

// Anki's day starts at 4am local time.
export function dayStart(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_HOURS) d.setDate(d.getDate() - 1);
  d.setHours(ROLLOVER_HOURS, 0, 0, 0);
  return d.getTime();
}
// A stable day number (days since 1970 in local time, shifted by the rollover).
export function dayIndex(ms = Date.now()) {
  const d = new Date(dayStart(ms));
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
}
export function dayToMs(day) {
  const d = new Date(day * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ROLLOVER_HOURS).getTime();
}
export const addDays = (days, now = Date.now()) => dayToMs(dayIndex(now) + days);

export const DEFAULT_CONF = {
  id: 1, name: 'Default', newPerDay: 20, revPerDay: 200, learnSteps: [1, 10], relearnSteps: [10],
  retention: 0.9, maxIvl: 36500, newOrder: 'due', buryNew: false, buryRev: false,
};

const engines = new Map();
function engine(conf) {
  const key = conf.retention + ':' + conf.maxIvl;
  if (!engines.has(key)) {
    engines.set(key, fsrs({ request_retention: conf.retention, maximum_interval: conf.maxIvl, enable_fuzz: false, enable_short_term: true }));
  }
  return engines.get(key);
}

// Deterministic fuzz, so the button preview and the actual answer agree.
function fuzz(ivl, elapsed, maxIvl, seed) {
  if (ivl < 2.5) return Math.round(ivl);
  const { min_ivl, max_ivl } = get_fuzz_range(ivl, elapsed, maxIvl);
  let x = Math.sin(seed) * 10000; x -= Math.floor(x);
  return Math.floor(x * (max_ivl - min_ivl + 1) + min_ivl);
}

const memoryOf = c => (c.s ? { stability: c.s, difficulty: c.d } : { stability: 0, difficulty: 0 });

export function elapsedDays(card, now = Date.now()) {
  return card.last ? Math.max(0, dayIndex(now) - dayIndex(card.last)) : 0;
}

// Memory state after one rating. Used by answer() and to rebuild memory from imported review history.
export function nextMemory(conf, mem, elapsed, ease) {
  const n = engine(conf).next_state(mem && mem.stability ? mem : { stability: 0, difficulty: 0 }, elapsed, ease);
  return { stability: n.stability, difficulty: n.difficulty };
}

function reviewIntervals(conf, card, mems, elapsed) {
  const f = engine(conf);
  const seed = card.id + card.reps;
  const raw = e => f.next_interval(mems[e].stability, elapsed);
  let hard = fuzz(raw(2), elapsed, conf.maxIvl, seed + 2);
  let good = fuzz(raw(3), elapsed, conf.maxIvl, seed + 3);
  let easy = fuzz(raw(4), elapsed, conf.maxIvl, seed + 4);
  if (card.type === 2) {
    hard = Math.max(1, Math.min(hard, good));
    good = Math.max(good, hard + 1);
  } else hard = Math.max(1, Math.min(hard, good));
  easy = Math.max(easy, good + 1);
  const cap = v => Math.min(v, conf.maxIvl);
  return { 1: cap(Math.max(1, fuzz(raw(1), elapsed, conf.maxIvl, seed + 1))), 2: cap(hard), 3: cap(good), 4: cap(easy) };
}

// Returns { card, log } for each rating, without saving. log.ivl follows Anki: days if positive, -seconds if a step.
export function schedule(card, conf, now = Date.now()) {
  conf = { ...DEFAULT_CONF, ...conf };
  const elapsed = elapsedDays(card, now);
  const mem = memoryOf(card);
  const mems = {};
  for (const e of [1, 2, 3, 4]) mems[e] = nextMemory(conf, mem, elapsed, e);
  const ivls = reviewIntervals(conf, card, mems, elapsed);
  const out = {};
  for (const ease of [1, 2, 3, 4]) {
    const c = { ...card, s: mems[ease].stability, d: mems[ease].difficulty, reps: card.reps + 1, last: now };
    const graduate = (days) => { c.type = 2; c.step = 0; c.ivl = days; c.due = addDays(days, now); };
    const stepTo = (i, minutes) => { c.step = i; c.due = now + Math.round(minutes * 60000); };
    const inSteps = card.type === 0 || card.type === 1 || card.type === 3;
    const steps = card.type === 3 ? conf.relearnSteps : conf.learnSteps;
    const step = Math.min(card.step || 0, Math.max(0, steps.length - 1));
    if (inSteps) {
      if (card.type === 0) c.type = 1;
      if (!steps.length) graduate(ease === 1 ? 1 : ivls[ease]);
      else if (ease === 1) stepTo(0, steps[0]);
      else if (ease === 2) {
        const d = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2
          : step === 0 ? Math.min(steps[0] * 1.5, steps[0] + 1440) : steps[step];
        stepTo(step, d);
      } else if (ease === 3 && step + 1 < steps.length) stepTo(step + 1, steps[step + 1]);
      else graduate(card.type === 3 ? Math.max(1, Math.min(ivls[3], card.ivl || ivls[3])) : ivls[ease]);
    } else {
      // Review card.
      if (ease === 1) {
        c.lapses = card.lapses + 1;
        c.ivl = ivls[1];
        if (conf.relearnSteps.length) { c.type = 3; stepTo(0, conf.relearnSteps[0]); }
        else graduate(ivls[1]);
      } else graduate(ivls[ease]);
    }
    const logType = card.type === 0 || card.type === 1 ? 0 : card.type === 2 ? 1 : 2;
    out[ease] = {
      card: c,
      log: { cid: card.id, ease, ivl: c.type === 2 ? c.ivl : -Math.round((c.due - now) / 1000), lastIvl: card.ivl || 0, type: logType, fresh: card.type === 0 },
    };
  }
  return out;
}

export function humanInterval(due, now = Date.now()) {
  const m = (due - now) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = Math.max(1, Math.round((dayStart(due) - dayStart(now)) / DAY));
  if (d < 30) return `${d}d`;
  if (d < 365) return `${(d / 30).toFixed(d < 300 ? 1 : 0).replace(/\.0$/, '')}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

// Current recall probability, for stats.
export function retrievability(card, now = Date.now()) {
  if (!card.s || !card.last) return null;
  return Math.pow(1 + (19 / 81) * ((now - card.last) / DAY) / card.s, -0.5);
}

export const blankCard = (id, nid, did, ord, pos) => ({
  id, nid, did, ord, type: 0, due: 0, pos, ivl: 0, s: 0, d: 0, step: 0, reps: 0, lapses: 0, last: 0, flags: 0, susp: false, buried: 0,
});
