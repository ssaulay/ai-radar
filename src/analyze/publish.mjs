// Journal de publication et attribution : ce que Simon a publie sur un sujet, puis ce que ca a donne.
// Saisie manuelle par la CLI ; aucune publication automatique. Sert a apprendre quels sujets marchent pour cette audience.
export function ensurePublishSchema(store) {
  store.db.exec(`
CREATE TABLE IF NOT EXISTS publications(pub_id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id INTEGER, url TEXT UNIQUE, platform TEXT, lang TEXT, published_at TEXT, note TEXT,
  topic_label TEXT, score_at_mark REAL, status_at_mark TEXT, families_at_mark TEXT, first_seen_at TEXT, lead_vs_press_h REAL);
CREATE TABLE IF NOT EXISTS outcomes(pub_id INTEGER, measured_at TEXT, impressions INTEGER, reactions INTEGER, comments INTEGER, reposts INTEGER, PRIMARY KEY(pub_id, measured_at));
`);
}

export function markPublished(store, { clusterId, url, platform = 'linkedin', lang = 'fr', note = null, now = store.now() }) {
  ensurePublishSchema(store);
  const c = store.get('SELECT c.cluster_id, c.label, c.first_seen_at FROM clusters c WHERE c.cluster_id=?', clusterId);
  if (!c) throw new Error(`sujet ${clusterId} introuvable`);
  const last = store.get('SELECT score, status, components_json FROM cluster_scores WHERE cluster_id=? ORDER BY computed_at DESC LIMIT 1', clusterId);
  let pc = null; try { pc = store.get('SELECT first_at FROM press_checks WHERE cluster_id=?', clusterId); } catch {}
  const lead = pc?.first_at ? Number(((Date.parse(pc.first_at) - Date.parse(c.first_seen_at)) / 3600e3).toFixed(1)) : null;
  store.run('INSERT OR REPLACE INTO publications(cluster_id,url,platform,lang,published_at,note,topic_label,score_at_mark,status_at_mark,families_at_mark,first_seen_at,lead_vs_press_h) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    clusterId, url, platform, lang, now, note, c.label, last?.score ?? null, last?.status ?? null, last ? (JSON.parse(last.components_json).families?.list ?? []).join('') : null, c.first_seen_at, lead);
  return store.get('SELECT * FROM publications WHERE url=?', url);
}

export function recordOutcome(store, { url, impressions = null, reactions = null, comments = null, reposts = null, now = store.now() }) {
  ensurePublishSchema(store);
  const p = store.get('SELECT pub_id FROM publications WHERE url=?', url);
  if (!p) throw new Error(`publication inconnue : ${url} (utiliser mark d'abord)`);
  store.run('INSERT OR REPLACE INTO outcomes(pub_id,measured_at,impressions,reactions,comments,reposts) VALUES (?,?,?,?,?,?)', p.pub_id, now, impressions, reactions, comments, reposts);
  return store.all('SELECT * FROM outcomes WHERE pub_id=? ORDER BY measured_at', p.pub_id);
}

// Vue pour la page : publications avec derniere mesure, et statistiques simples des que 5 posts ont une mesure.
export function publicationReport(store) {
  ensurePublishSchema(store);
  const rows = store.all(`SELECT p.*, o.impressions, o.reactions, o.comments, o.reposts, o.measured_at FROM publications p
    LEFT JOIN outcomes o ON o.pub_id=p.pub_id AND o.measured_at=(SELECT MAX(measured_at) FROM outcomes WHERE pub_id=p.pub_id) ORDER BY p.published_at DESC`);
  const measured = rows.filter(r => r.impressions !== null && r.impressions !== undefined);
  let stats = null;
  if (measured.length >= 5) {
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const by = key => { const g = new Map(); for (const r of measured) { const k = r[key] ?? '?'; if (!g.has(k)) g.set(k, []); g.get(k).push(r.impressions); } return [...g.entries()].map(([k, v]) => ({ key: k, n: v.length, median_impressions: med(v) })).sort((a, b) => b.median_impressions - a.median_impressions); };
    stats = { n: measured.length, median_impressions: med(measured.map(r => r.impressions)), by_status: by('status_at_mark'), by_lang: by('lang'), by_platform: by('platform'), early_vs_late: { early: med(measured.filter(r => r.lead_vs_press_h === null || r.lead_vs_press_h > 0).map(r => r.impressions)) ?? null, late: med(measured.filter(r => r.lead_vs_press_h !== null && r.lead_vs_press_h <= 0).map(r => r.impressions)) ?? null } };
  }
  return { publications: rows, stats };
}
