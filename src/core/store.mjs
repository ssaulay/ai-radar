// Base SQLite du radar (node:sqlite, zero dependance). Items = observations brutes ; tout le reste en derive.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compactVectors } from './embed.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items(
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL, family TEXT NOT NULL, kind TEXT NOT NULL,
  external_id TEXT NOT NULL, url TEXT, url_canon TEXT, domain TEXT,
  title TEXT, text TEXT, author TEXT, lang TEXT,
  published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  score_raw REAL, comments INTEGER, raw_json TEXT,
  UNIQUE(source_id, external_id));
CREATE INDEX IF NOT EXISTS idx_items_pub ON items(published_at);
CREATE INDEX IF NOT EXISTS idx_items_seen ON items(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_items_canon ON items(url_canon);
CREATE TABLE IF NOT EXISTS score_snapshots(source_id TEXT, external_id TEXT, ts TEXT, score REAL, comments INTEGER, rank INTEGER, PRIMARY KEY(source_id, external_id, ts));
CREATE TABLE IF NOT EXISTS source_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, run_ts TEXT, source_id TEXT, status TEXT, items_seen INTEGER, items_new INTEGER, items_updated INTEGER, ms INTEGER, error TEXT, latency_median_min REAL);
CREATE TABLE IF NOT EXISTS cursors(source_id TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, step TEXT, stats_json TEXT);
CREATE TABLE IF NOT EXISTS llm_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, purpose TEXT, provider TEXT, model TEXT, document_url TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, ms INTEGER, ok INTEGER, error TEXT, created_at TEXT);
`;

export function openStore(root, file = 'radar.sqlite') {
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'state', file));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
  db.exec(SCHEMA);
  const now = () => new Date().toISOString();
  return {
    db, now,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    close: () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} db.close(); },
  };
}

// Purge des items anciens (14 jours par defaut) et de leurs snapshots ; les clusters et scores vivent plus longtemps (tables des lots suivants).
export function purge(store, { itemDays = 14 } = {}) {
  const cutoff = new Date(Date.now() - itemDays * 864e5).toISOString();
  const a = store.run('DELETE FROM score_snapshots WHERE ts < ?', cutoff).changes;
  // Familles E et H (modeles, depots, marches) : l'evenement est d'etre en tendance maintenant, on garde tant que l'item est revu ;
  // pour les autres, la date de publication fait foi (les flux renvoient souvent un fond de catalogue ancien sans valeur de signal).
  const b = store.run("DELETE FROM items WHERE (family NOT IN ('E','H') AND COALESCE(published_at, first_seen_at) < ?) OR (family IN ('E','H') AND last_seen_at < ?)", cutoff, cutoff).changes;
  const c = store.run('DELETE FROM source_runs WHERE run_ts < ?', new Date(Date.now() - 30 * 864e5).toISOString()).changes;
  // embeddings : seulement utiles pendant la fenetre active de regroupement (72 h) ; au-dela on les supprime pour garder l'etat leger
  let d = 0; try { d = store.run("DELETE FROM embeddings WHERE item_id IN (SELECT item_id FROM items WHERE COALESCE(evt_at, first_seen_at) < ?) OR item_id NOT IN (SELECT item_id FROM items)", new Date(Date.now() - 4 * 864e5).toISOString()).changes; } catch {}
  // vecteurs des sujets inactifs depuis plus de 4 jours : inutiles au regroupement (fenetre 72 h) ; embeddings presse au-dela de 4 jours ;
  // scores intermediaires au-dela de 6 h (dernier score par sujet conserve). Objectif : etat sous la limite GitHub de 100 Mo.
  let e = 0, f = 0, g = 0;
  try { e = store.run('UPDATE clusters SET centroid=NULL, seed=NULL WHERE (centroid IS NOT NULL OR seed IS NOT NULL) AND last_seen_at < ?', new Date(Date.now() - 4 * 864e5).toISOString()).changes; } catch {}
  try { store.run('UPDATE clusters SET seed=NULL WHERE seed IS NOT NULL'); } catch {} // seed n'est jamais lu
  let h = 0; try { h = compactVectors(store); } catch {}
  try { f = store.run('DELETE FROM press_embeddings WHERE created_at < ?', new Date(Date.now() - 4 * 864e5).toISOString()).changes; } catch {}
  try { g = store.run('DELETE FROM cluster_scores WHERE computed_at < ? AND computed_at < (SELECT MAX(computed_at) FROM cluster_scores c2 WHERE c2.cluster_id = cluster_scores.cluster_id)', new Date(Date.now() - 6 * 3600e3).toISOString()).changes; } catch {}
  try { store.db.exec('VACUUM'); } catch {}
  return { snapshots: a, items: b, source_runs: c, embeddings: d, cluster_vectors_cleared: e, press_embeddings: f, cluster_scores: g, vectors_compacted: h };
}
