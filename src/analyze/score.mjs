// Score explicable v1 : composantes observables, poids manuels affiches. Statut presse separe.
// Burst de termes : z-score horaire contre une ligne de base de 7 jours par heure de la semaine, plancher Poisson.
import fs from 'node:fs';
import path from 'node:path';
import { extractTerms } from './relevance.mjs';

let MAJOR = null;
export function loadMajorOfficial(root) { if (!MAJOR) { const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'sources.json'), 'utf8')); MAJOR = new Set(cfg.sources.filter(x => x.official_major).map(x => x.id)); } return MAJOR; }

export const WEIGHTS = { families: 25, burst: 20, hn: 15, github: 10, hf: 10, official: 10, social: 10 };
const hourKey = iso => iso.slice(0, 13); // YYYY-MM-DDTHH

export function rebuildTermHourly(store, lex, { days = 7, now = store.now() } = {}) {
  const since = new Date(Date.parse(now) - days * 864e5).toISOString();
  const rows = store.all("SELECT title, evt_at FROM items WHERE relevant=1 AND family <> 'G' AND evt_at >= ?", since);
  const counts = new Map();
  for (const r of rows) { const h = hourKey(r.evt_at); for (const t of extractTerms(r.title, lex)) { const k = `${t}\u0001${h}`; counts.set(k, (counts.get(k) ?? 0) + 1); } }
  store.tx(() => { store.run('DELETE FROM term_hourly'); const ins = store.db.prepare('INSERT INTO term_hourly(term,hour,n) VALUES (?,?,?)'); for (const [k, n] of counts) { const [term, hour] = k.split('\u0001'); ins.run(term, hour, n); } });
  return counts.size;
}

// z-score du terme sur les 6 dernieres heures contre la meme tranche de 6 h des jours precedents (saisonnalite jour/nuit)
export function termBurst(store, term, { now = store.now(), windowH = 6, days = 7 } = {}) {
  const rows = store.all('SELECT hour, n FROM term_hourly WHERE term=?', term);
  if (!rows.length) return { z: 0, current: 0, mean: 0 };
  const byHour = new Map(rows.map(r => [r.hour, r.n]));
  const sumWindow = (endMs) => { let s = 0; for (let h = 0; h < windowH; h++) s += byHour.get(hourKey(new Date(endMs - h * 3600e3).toISOString())) ?? 0; return s; };
  const nowMs = Date.parse(now); const current = sumWindow(nowMs);
  const base = []; for (let d = 1; d <= days; d++) base.push(sumWindow(nowMs - d * 864e5));
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length);
  const z = (current - mean) / Math.max(sd, Math.sqrt(mean), 1);
  return { z, current, mean };
}

const clamp01 = x => Math.max(0, Math.min(1, x));

export function scoreCluster(store, c, lex, { now = store.now(), major = new Set() } = {}) {
  const items = store.all('SELECT i.*, ci.sim FROM cluster_items ci JOIN items i ON i.item_id=ci.item_id WHERE ci.cluster_id=? ORDER BY i.evt_at', c.cluster_id);
  const nowMs = Date.parse(now); const h6 = new Date(nowMs - 6 * 3600e3).toISOString(), h24 = new Date(nowMs - 24 * 3600e3).toISOString();
  const nonPress = items.filter(i => i.family !== 'G'); const press = items.filter(i => i.family === 'G');
  const fam6h = new Set(nonPress.filter(i => i.evt_at >= h6 || i.last_seen_at >= h6).map(i => i.family));
  const famAll = new Set(nonPress.map(i => i.family));
  // burst : meilleur z parmi les termes des titres (hors presse)
  const termCount = new Map(); for (const it of nonPress) for (const t of extractTerms(it.title, lex)) termCount.set(t, (termCount.get(t) ?? 0) + 1);
  let burst = { term: null, z: 0, current: 0, mean: 0 };
  for (const [t, n] of [...termCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) { const b = termBurst(store, t, { now }); if (b.current >= 5 && b.current >= 2 * b.mean && b.z > burst.z) burst = { term: t, ...b }; }
  // HN : points par heure sur les items HN (age >= 30 min)
  let hnVel = 0, hnBest = null;
  for (const it of items.filter(i => i.source_id.startsWith('hn_'))) { const ageH = Math.max(0.5, (nowMs - Date.parse(it.evt_at)) / 3600e3); const v = (it.score_raw ?? 0) / Math.min(ageH, 24); if (v > hnVel) { hnVel = v; hnBest = it; } }
  // GitHub : delta d'etoiles sur 24 h via snapshots
  let ghDelta = 0, ghBest = null;
  for (const it of items.filter(i => i.kind === 'REPO')) { const snaps = store.all('SELECT ts, score FROM score_snapshots WHERE source_id=? AND external_id=? ORDER BY ts', it.source_id, it.external_id); const old = snaps.find(s => s.ts >= h24) ?? snaps[0]; const last = snaps[snaps.length - 1]; const d = old && last ? (last.score ?? 0) - (old.score ?? 0) : 0; const val = snaps.length > 1 ? d : (Date.parse(it.first_seen_at) >= Date.parse(h24) ? (it.score_raw ?? 0) : 0); if (val > ghDelta) { ghDelta = val; ghBest = it; } }
  // HF papers upvotes ; trending models
  const hfUp = Math.max(0, ...items.filter(i => i.kind === 'PAPER' && i.source_id === 'hf_papers').map(i => i.score_raw ?? 0));
  const hfTrend = items.some(i => ['MODEL', 'DATASET', 'SPACE'].includes(i.kind) && i.source_id.startsWith('hf_'));
  // annonce officielle : uniquement les laboratoires majeurs (official_major dans sources.json) et publiee depuis moins de 24 h
  const official = items.some(i => i.family === 'F' && major.has(i.source_id) && i.evt_at >= h24);
  const social6h = items.filter(i => i.family === 'C' && i.evt_at >= h6).length;
  const components = {
    families: { value: fam6h.size, all: famAll.size, list: [...fam6h].sort(), points: WEIGHTS.families * clamp01((fam6h.size - 1) / 2) },
    burst: { term: burst.term, z: Number(burst.z.toFixed(2)), current: burst.current, mean: Number(burst.mean.toFixed(1)), points: WEIGHTS.burst * clamp01(burst.z / 6) },
    hn: { points_per_hour: Number(hnVel.toFixed(1)), item: hnBest?.title ?? null, points: WEIGHTS.hn * clamp01(hnVel / 10) },
    github: { stars_24h: ghDelta, repo: ghBest?.title?.split(':')[0] ?? null, points: WEIGHTS.github * clamp01(ghDelta / 500) },
    hf: { paper_upvotes: hfUp, trending: hfTrend, points: WEIGHTS.hf * clamp01(Math.max(hfUp / 20, hfTrend ? 0.5 : 0)) },
    official: { value: official, points: official ? WEIGHTS.official : 0 },
    social: { posts_6h: social6h, points: WEIGHTS.social * clamp01(social6h / 20) },
  };
  let score = Object.values(components).reduce((a, c) => a + c.points, 0);
  // preuve minimale : un item isole sans velocite ni annonce majeure ne peut pas depasser 15
  const hasSignal = official || hnVel >= 3 || ghDelta >= 100 || hfUp >= 10 || fam6h.size >= 2 || burst.z >= 3;
  if (items.length < 2 && !hasSignal) score = Math.min(score, 15);
  // fraicheur : pleine valeur dans les 6 h suivant la derniere activite, puis decroissance lineaire jusqu'a 0,4 a 48 h
  const lastMs = Math.max(...items.map(i => Date.parse(i.evt_at))); const ageH = (nowMs - lastMs) / 3600e3;
  const freshness = ageH <= 6 ? 1 : Math.max(0.4, 1 - 0.6 * (ageH - 6) / 42);
  score *= freshness;
  const firstNonPress = nonPress[0]?.evt_at ?? items[0]?.evt_at; const pressBefore = press.filter(p => p.evt_at < firstNonPress).length;
  const firstPress = press[0]?.evt_at ?? null;
  const status = press.length === 0 ? 'ANTICIPATION' : pressBefore > 0 && nonPress.length === 0 ? 'PRESS_ONLY' : 'CONFIRMED';
  // velocite : items sur 3 h vs 3 h precedentes
  const h3 = new Date(nowMs - 3 * 3600e3).toISOString(), h6b = h6;
  const recent = items.filter(i => i.evt_at >= h3).length, prev = items.filter(i => i.evt_at >= h6b && i.evt_at < h3).length;
  const hourly = Array.from({ length: 24 }, (_, k) => { const start = nowMs - (24 - k) * 3600e3, end = start + 3600e3; return items.filter(i => { const t = Date.parse(i.evt_at); return t >= start && t < end; }).length; });
  return { cluster_id: c.cluster_id, score: Number(score.toFixed(1)), freshness: Number(freshness.toFixed(2)), components, status, n_items: items.length, n_families: famAll.size, press_count: press.length, press_before: pressBefore, first_press_at: firstPress, first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at, velocity: { recent3h: recent, prev3h: prev }, hourly, items };
}

export function scoreAll(store, lex, { now = store.now(), activeHours = 72, log = console.log, root = null } = {}) {
  const major = root ? loadMajorOfficial(root) : new Set();
  const terms = rebuildTermHourly(store, lex, { now });
  const cutoff = new Date(Date.parse(now) - activeHours * 3600e3).toISOString();
  const clusters = store.all('SELECT * FROM clusters WHERE merged_into IS NULL AND n > 0 AND last_seen_at >= ?', cutoff);
  const results = [];
  store.tx(() => {
    for (const c of clusters) {
      const r = scoreCluster(store, c, lex, { now, major });
      store.run('INSERT OR REPLACE INTO cluster_scores(cluster_id,computed_at,score,components_json,status,n_families,press_count) VALUES (?,?,?,?,?,?,?)', c.cluster_id, now, r.score, JSON.stringify(r.components), r.status, r.n_families, r.press_count);
      results.push({ ...r, label: c.label, entities: JSON.parse(c.entities_json ?? '[]') });
    }
    // hygiene : au-dela de 6 h on ne garde que le dernier score de chaque sujet (le journal de publication lit le dernier), et rien au-dela de 7 jours ;
    // sans cela la table croit de 5 000 lignes par passage et l'etat depasse la limite GitHub de 100 Mo
    store.run('DELETE FROM cluster_scores WHERE computed_at < ? AND computed_at < (SELECT MAX(computed_at) FROM cluster_scores c2 WHERE c2.cluster_id = cluster_scores.cluster_id)', new Date(Date.parse(now) - 6 * 3600e3).toISOString());
    store.run('DELETE FROM cluster_scores WHERE computed_at < ?', new Date(Date.parse(now) - 7 * 864e5).toISOString());
  });
  results.sort((a, b) => b.score - a.score);
  log(`  score : ${clusters.length} sujets actifs, ${terms} termes-heures, top = ${results[0]?.score ?? 0} « ${results[0]?.label ?? ''} »`);
  return results;
}
