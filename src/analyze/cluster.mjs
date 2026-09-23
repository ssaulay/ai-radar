// Regroupement incremental en sujets : liens partages d'abord (meme URL canonique), puis leader clustering sur embeddings.
import { cosine, toBlob, fromBlob, normalize } from '../core/embed.mjs';
import { isAiRelevant, extractEntities } from './relevance.mjs';

// Calibre le 22/09/2026 sur 700 voisins reels (text-embedding-3-small) : doublons >= 0,80 ; meme histoire formulee autrement 0,60 a 0,80.
export const JOIN = 0.62, JOIN_CATALOG = 0.74, CENTROID_SLACK = 0.06, DUP = 0.90, MERGE = 0.85, ACTIVE_HOURS = 72;
// Papiers, depots, modeles, marches : titres courts et vocabulaire homogene, ils se ressemblent tous a 0,6 ; seuil plus haut.
const CATALOG_KINDS = new Set(['PAPER', 'REPO', 'MODEL', 'DATASET', 'SPACE', 'MODEL_LISTED', 'RELEASE', 'MARKET', 'TREND']);
export const joinThreshold = it => CATALOG_KINDS.has(it.kind) ? JOIN_CATALOG : JOIN;

export function ensureClusterSchema(store) {
  store.db.exec(`
CREATE TABLE IF NOT EXISTS embeddings(item_id INTEGER PRIMARY KEY, model TEXT, vec BLOB);
CREATE TABLE IF NOT EXISTS clusters(cluster_id INTEGER PRIMARY KEY AUTOINCREMENT, centroid BLOB, seed BLOB, dim INTEGER, n INTEGER DEFAULT 0, first_seen_at TEXT, last_seen_at TEXT, label TEXT, entities_json TEXT, merged_into INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS cluster_items(cluster_id INTEGER, item_id INTEGER PRIMARY KEY, joined_at TEXT, sim REAL);
CREATE INDEX IF NOT EXISTS idx_ci_cluster ON cluster_items(cluster_id);
CREATE TABLE IF NOT EXISTS cluster_briefs(cluster_id INTEGER PRIMARY KEY, lang_fr TEXT, lang_en TEXT, model TEXT, generated_at TEXT, items_hash TEXT);
CREATE TABLE IF NOT EXISTS cluster_scores(cluster_id INTEGER, computed_at TEXT, score REAL, components_json TEXT, status TEXT, n_families INTEGER, press_count INTEGER, PRIMARY KEY(cluster_id, computed_at));
CREATE TABLE IF NOT EXISTS term_hourly(term TEXT, hour TEXT, n INTEGER, PRIMARY KEY(term, hour));
`);
  for (const col of ['relevant INTEGER', 'evt_at TEXT']) { try { store.db.exec(`ALTER TABLE items ADD COLUMN ${col}`); } catch {} }
  try { store.db.exec('ALTER TABLE clusters ADD COLUMN seed BLOB'); } catch {}
}

// Heure de l'evenement : publication pour les contenus, premiere observation pour les tendances (E, H) et les items sans date.
export const eventTime = it => (['E', 'H'].includes(it.family) || !it.published_at || Date.parse(it.published_at) < Date.parse(it.first_seen_at) - 30 * 864e5) ? it.first_seen_at : it.published_at;
export const clusterText = it => `${it.title ?? ''}${it.text && !(it.text ?? '').startsWith((it.title ?? '').slice(0, 40)) ? ' ' + it.text.slice(0, 200) : ''}`.trim();

export async function clusterNewItems(store, embedder, lex, { log = console.log, now = store.now() } = {}) {
  ensureClusterSchema(store);
  // 1. marquer pertinence et evt_at des items non encore traites
  const fresh = store.all('SELECT * FROM items WHERE relevant IS NULL');
  store.tx(() => { for (const it of fresh) store.run('UPDATE items SET relevant=?, evt_at=? WHERE item_id=?', isAiRelevant(it) ? 1 : 0, eventTime(it), it.item_id); });
  // 2. items pertinents sans cluster, dans la fenetre active
  const cutoff = new Date(Date.parse(now) - ACTIVE_HOURS * 3600e3).toISOString();
  const todo = store.all('SELECT i.* FROM items i LEFT JOIN cluster_items c ON c.item_id=i.item_id WHERE i.relevant=1 AND c.item_id IS NULL AND i.evt_at >= ? ORDER BY i.evt_at', cutoff);
  if (!todo.length) return { relevantMarked: fresh.length, clustered: 0, created: 0, joined: 0 };
  // 3. embeddings manquants
  const need = todo.filter(it => !store.get('SELECT 1 FROM embeddings WHERE item_id=?', it.item_id));
  for (let i = 0; i < need.length; i += 200) {
    const batch = need.slice(i, i + 200); const vecs = await embedder.embed(batch.map(clusterText));
    store.tx(() => { batch.forEach((it, k) => store.run('INSERT OR REPLACE INTO embeddings(item_id,model,vec) VALUES (?,?,?)', it.item_id, embedder.name, toBlob(vecs[k]))); });
  }
  // 4. clusters actifs en memoire
  const active = store.all('SELECT cluster_id, centroid, n, first_seen_at, last_seen_at FROM clusters WHERE merged_into IS NULL AND last_seen_at >= ? AND centroid IS NOT NULL', cutoff).map(c => ({ ...c, vec: fromBlob(c.centroid), members: [], sum: null }));
  const byIdTmp = new Map(active.map(c => [c.cluster_id, c]));
  for (const r of store.all('SELECT ci.cluster_id, e.vec FROM cluster_items ci JOIN embeddings e ON e.item_id=ci.item_id WHERE ci.cluster_id IN (SELECT cluster_id FROM clusters WHERE merged_into IS NULL AND last_seen_at >= ?)', cutoff)) byIdTmp.get(r.cluster_id)?.members.push(fromBlob(r.vec));
  for (const c of active) { const v = fromBlob(c.centroid); c.sum = Float32Array.from(v, x => x * c.n); }
  let created = 0, joined = 0;
  const urlToCluster = new Map(store.all('SELECT i.url_canon u, c.cluster_id k FROM cluster_items c JOIN items i ON i.item_id=c.item_id WHERE i.url_canon IS NOT NULL AND i.evt_at >= ?', cutoff).map(r => [r.u, r.k]));
  const byId = new Map(active.map(c => [c.cluster_id, c]));
  const attach = (c, it, vec, sim) => {
    store.run('INSERT OR REPLACE INTO cluster_items(cluster_id,item_id,joined_at,sim) VALUES (?,?,?,?)', c.cluster_id, it.item_id, now, sim);
    for (let i = 0; i < c.sum.length; i++) c.sum[i] += vec[i]; c.n++; c.vec = normalize(c.sum); c.members.push(vec);
    c.first_seen_at = c.first_seen_at < it.evt_at ? c.first_seen_at : it.evt_at; c.last_seen_at = c.last_seen_at > it.evt_at ? c.last_seen_at : it.evt_at;
    store.run('UPDATE clusters SET centroid=?, n=?, first_seen_at=?, last_seen_at=? WHERE cluster_id=?', toBlob(c.vec), c.n, c.first_seen_at, c.last_seen_at, c.cluster_id);
    if (it.url_canon) urlToCluster.set(it.url_canon, c.cluster_id);
  };
  store.tx(() => {
    for (const it of todo) {
      const vec = fromBlob(store.get('SELECT vec FROM embeddings WHERE item_id=?', it.item_id).vec);
      // lien partage : meme URL canonique deja rangee (sauf pages d'accueil de plateformes)
      const linked = it.url_canon && !/^https:\/\/(news\.ycombinator\.com|huggingface\.co|github\.com|bsky\.app|x\.com)\/?$/.test(it.url_canon) ? byId.get(urlToCluster.get(it.url_canon)) : null;
      if (linked) { attach(linked, it, vec, 1); joined++; continue; }
      // double condition : au moins un membre reel au-dessus du seuil (meme histoire) ET centroide proche (pas de derive par chainage)
      const thr = joinThreshold(it); let best = null, bestSim = -1;
      for (const c of active) { const s = cosine(vec, c.vec); if (s <= bestSim || s < thr - CENTROID_SLACK) continue; let m = 0; for (const mv of c.members) { const x = cosine(vec, mv); if (x > m) m = x; if (m >= thr) break; } if (m >= thr) { bestSim = s; best = c; } }
      if (best) { attach(best, it, vec, bestSim); joined++; }
      else {
        const r = store.run('INSERT INTO clusters(centroid,seed,dim,n,first_seen_at,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?)', toBlob(vec), null, vec.length, 1, it.evt_at, it.evt_at, now);
        const c = { cluster_id: Number(r.lastInsertRowid), vec, members: [vec], sum: Float32Array.from(vec), n: 1, first_seen_at: it.evt_at, last_seen_at: it.evt_at };
        active.push(c); byId.set(c.cluster_id, c); store.run('INSERT OR REPLACE INTO cluster_items(cluster_id,item_id,joined_at,sim) VALUES (?,?,?,?)', c.cluster_id, it.item_id, now, 1);
        if (it.url_canon) urlToCluster.set(it.url_canon, c.cluster_id); created++;
      }
    }
  });
  // 5. fusion des centroides trop proches
  let merged = 0;
  store.tx(() => {
    const live = active.filter(c => c.n > 0).sort((a, b) => b.n - a.n);
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      if (live[j].n === 0) continue;
      if (cosine(live[i].vec, live[j].vec) >= MERGE) {
        store.run('UPDATE cluster_items SET cluster_id=? WHERE cluster_id=?', live[i].cluster_id, live[j].cluster_id);
        store.run('UPDATE clusters SET merged_into=?, n=0 WHERE cluster_id=?', live[i].cluster_id, live[j].cluster_id);
        for (let k = 0; k < live[i].sum.length; k++) live[i].sum[k] += live[j].sum[k]; live[i].n += live[j].n; live[i].vec = normalize(live[i].sum); live[i].members.push(...live[j].members);
        live[i].first_seen_at = live[i].first_seen_at < live[j].first_seen_at ? live[i].first_seen_at : live[j].first_seen_at; live[i].last_seen_at = live[i].last_seen_at > live[j].last_seen_at ? live[i].last_seen_at : live[j].last_seen_at;
        store.run('UPDATE clusters SET centroid=?, n=?, first_seen_at=?, last_seen_at=? WHERE cluster_id=?', toBlob(live[i].vec), live[i].n, live[i].first_seen_at, live[i].last_seen_at, live[i].cluster_id);
        live[j].n = 0; merged++;
      }
    }
  });
  // 6. entites et libelle provisoire par cluster touche
  store.tx(() => {
    for (const c of active.filter(c => c.n > 0)) {
      const items = store.all('SELECT i.title, i.score_raw, i.family FROM cluster_items ci JOIN items i ON i.item_id=ci.item_id WHERE ci.cluster_id=?', c.cluster_id);
      const cnt = new Map(); for (const it of items) for (const e of extractEntities(it.title, lex)) cnt.set(e, (cnt.get(e) ?? 0) + 1);
      const ents = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => ({ e, n }));
      const rep = items.filter(i => i.family !== 'G').sort((a, b) => (b.score_raw ?? 0) - (a.score_raw ?? 0))[0] ?? items[0];
      store.run('UPDATE clusters SET entities_json=?, label=COALESCE(label, ?) WHERE cluster_id=?', JSON.stringify(ents), (rep?.title ?? '').slice(0, 140), c.cluster_id);
    }
  });
  log(`  clustering : ${todo.length} items, ${created} nouveaux sujets, ${joined} rattachés, ${merged} fusions, embeddings ${embedder.name}`);
  return { relevantMarked: fresh.length, clustered: todo.length, created, joined, merged };
}
