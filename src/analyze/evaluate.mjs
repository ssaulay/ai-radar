// Boucle de validation : un sujet detecte a t0 a-t-il ete repris par la presse ensuite ?
// Verite terrain : Google News RSS (EN et FR) interroge a +24 h, +48 h, +72 h avec une requete figee a la detection.
// hit = au moins 3 articles publies apres t0 et aucun avant. Metriques : precision@10, avance mediane, par jour.
import { parseFeed } from '../collect/parsers.mjs';
import { normName } from '../core/text.mjs';

const HORIZONS = [24, 48, 72];

export function ensureEvalSchema(store) {
  store.db.exec(`
CREATE TABLE IF NOT EXISTS evaluations(cluster_id INTEGER, horizon_h INTEGER, evaluated_at TEXT, query TEXT, press_after INTEGER, press_before INTEGER, first_press_at TEXT, hit INTEGER, PRIMARY KEY(cluster_id, horizon_h));
CREATE TABLE IF NOT EXISTS detections(cluster_id INTEGER PRIMARY KEY, first_seen_at TEXT, first_scored_at TEXT, score_first REAL, best_rank INTEGER, best_score REAL, status_first TEXT, label TEXT, query TEXT);
`);
}

// Requete presse figee : deux entites du lexique si possible, sinon les mots significatifs du libelle.
export function buildQuery(label, entities, stop) {
  const ents = (entities ?? []).slice(0, 2).map(e => `"${e.e ?? e}"`);
  const entWords = new Set((entities ?? []).flatMap(e => normName(e.e ?? e).split(' ')));
  const words = normName(label ?? '').split(' ').filter(w => w.length > 3 && !stop.has(w) && !entWords.has(w) && !/^\d+$/.test(w)).slice(0, ents.length ? 2 : 4);
  return [...ents, ...words].join(' ').trim();
}

// Enregistre, pour chaque cluster actif, le premier score, le meilleur rang et la requete presse (une seule fois).
export function recordDetections(store, results, lex, { now }) {
  ensureEvalSchema(store);
  store.tx(() => {
    results.forEach((r, idx) => {
      const rank = idx + 1;
      const ex = store.get('SELECT best_rank, best_score FROM detections WHERE cluster_id=?', r.cluster_id);
      if (!ex) store.run('INSERT INTO detections(cluster_id,first_seen_at,first_scored_at,score_first,best_rank,best_score,status_first,label,query) VALUES (?,?,?,?,?,?,?,?,?)', r.cluster_id, r.first_seen_at, now, r.score, rank, r.score, r.status, r.label, buildQuery(r.label, r.entities, lex.stop));
      else if (rank < ex.best_rank || r.score > ex.best_score) store.run('UPDATE detections SET best_rank=MIN(best_rank,?), best_score=MAX(best_score,?) WHERE cluster_id=?', rank, r.score, r.cluster_id);
    });
  });
}

export async function evaluateDue(store, http, { now = store.now(), log = console.log, maxQueries = 40 } = {}) {
  ensureEvalSchema(store);
  const nowMs = Date.parse(now); let done = 0, hits = 0;
  // sujets ayant atteint le top 20 ou un score >= 30, dont un horizon est echu et non encore evalue
  const cands = store.all('SELECT d.* FROM detections d WHERE (d.best_rank <= 20 OR d.best_score >= 30) AND d.first_seen_at <= ? ORDER BY d.first_seen_at', new Date(nowMs - 24 * 3600e3).toISOString());
  for (const d of cands) {
    if (done >= maxQueries) break;
    const t0 = Date.parse(d.first_seen_at);
    const due = HORIZONS.filter(h => nowMs - t0 >= h * 3600e3 && !store.get('SELECT 1 FROM evaluations WHERE cluster_id=? AND horizon_h=?', d.cluster_id, h));
    if (!due.length || !d.query) continue;
    const q = encodeURIComponent(`${d.query} when:7d`);
    const feeds = [`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, `https://news.google.com/rss/search?q=${q}&hl=fr&gl=FR&ceid=FR:fr`];
    const arts = [];
    for (const u of feeds) { const r = await http(u, { hostDelay: 2000 }); if (!r.error) arts.push(...parseFeed(r.body, u)); }
    // un meme article peut sortir dans les deux locales : dedoublonner par URL ou identifiant
    const seen = new Set(); for (let i = arts.length - 1; i >= 0; i--) { const k = arts[i].url || arts[i].external_id; if (seen.has(k)) arts.splice(i, 1); else seen.add(k); }
    done++;
    const after = arts.filter(a => a.published_at && Date.parse(a.published_at) >= t0), before = arts.filter(a => a.published_at && Date.parse(a.published_at) < t0 && Date.parse(a.published_at) >= t0 - 24 * 3600e3);
    const firstPress = after.map(a => a.published_at).sort()[0] ?? null;
    for (const h of due) {
      const inH = after.filter(a => Date.parse(a.published_at) <= t0 + h * 3600e3);
      const hit = inH.length >= 3 && before.length === 0 ? 1 : 0; if (hit && h === Math.max(...due)) hits++;
      store.run('INSERT OR REPLACE INTO evaluations(cluster_id,horizon_h,evaluated_at,query,press_after,press_before,first_press_at,hit) VALUES (?,?,?,?,?,?,?,?)', d.cluster_id, h, now, d.query, inH.length, before.length, firstPress, hit);
    }
  }
  log(`  évaluation : ${done} sujets interrogés, ${hits} reprises confirmées`);
  return { evaluated: done, hits };
}

// Metriques par jour de detection : precision@10 (part des sujets classes <= 10 repris a 48 h), avance mediane en heures.
export function dailyMetrics(store, { days = 7, now = store.now() } = {}) {
  ensureEvalSchema(store);
  const rows = store.all(`SELECT d.cluster_id, d.label, d.first_seen_at, d.best_rank, d.best_score, d.status_first, e.press_after, e.press_before, e.first_press_at, e.hit
    FROM detections d JOIN evaluations e ON e.cluster_id=d.cluster_id AND e.horizon_h=48 WHERE d.first_seen_at >= ? ORDER BY d.first_seen_at DESC`, new Date(Date.parse(now) - days * 864e5).toISOString());
  const byDay = new Map();
  for (const r of rows) { const day = r.first_seen_at.slice(0, 10); if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(r); }
  const out = [];
  for (const [day, rs] of [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const top10 = rs.filter(r => r.best_rank <= 10); const hits = top10.filter(r => r.hit);
    const leads = hits.map(r => (Date.parse(r.first_press_at) - Date.parse(r.first_seen_at)) / 3600e3).sort((a, b) => a - b);
    out.push({ day, evaluated: rs.length, top10: top10.length, hits: hits.length, precision_at_10: top10.length ? Number((hits.length / top10.length).toFixed(2)) : null, lead_median_h: leads.length ? Number(leads[Math.floor(leads.length / 2)].toFixed(1)) : null, already_in_press_at_detection: rs.filter(r => r.press_before > 0).length, calls: rs.filter(r => r.best_rank <= 10).map(r => ({ label: r.label, rank: r.best_rank, hit: !!r.hit, press_after: r.press_after, press_before: r.press_before, lead_h: r.first_press_at ? Number(((Date.parse(r.first_press_at) - Date.parse(r.first_seen_at)) / 3600e3).toFixed(1)) : null })) });
  }
  return out;
}
