#!/usr/bin/env node
// Entree unique du radar : collect | status | purge (les etapes cluster, score, brief, render, evaluate arrivent aux lots suivants)
import path from 'node:path';
import fs from 'node:fs';
import { loadEnv } from './src/core/env.mjs';
import { openStore, purge } from './src/core/store.mjs';
import { makeHttp } from './src/core/http.mjs';
import { collectAll } from './src/collect/collect.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
loadEnv(ROOT);
const [cmd, ...rest] = process.argv.slice(2);
const args = {}; for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true'; args[k] = v; }
const store = openStore(ROOT);
const counters = {}; const http = makeHttp({ counters });
const secrets = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, BSKY_JWT: process.env.BSKY_JWT };
const t0 = Date.now();

try {
  if (cmd === 'collect') {
    const runId = `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    store.run('INSERT INTO runs(run_id,started_at,step) VALUES (?,?,?)', runId, store.now(), 'collect');
    const r = await collectAll(store, http, { root: ROOT, secrets, only: args.only ? args.only.split(',') : null, force: args.force === 'true' });
    const ok = r.summary.filter(s => s.status === 'OK'), err = r.summary.filter(s => s.status === 'ERROR');
    const stats = { sources_ok: ok.length, sources_error: err.length, sources_not_due: r.summary.filter(s => s.status === 'NOT_DUE').length, sources_skipped: r.summary.filter(s => s.status === 'SKIPPED').length, items_new: ok.reduce((a, s) => a + s.new, 0), items_updated: ok.reduce((a, s) => a + s.updated, 0), requests: counters.requests, http_errors: counters.errors, seconds: Math.round((Date.now() - t0) / 1000), errors: err.map(e => `${e.source}: ${e.error}`) };
    store.run('UPDATE runs SET ended_at=?, stats_json=? WHERE run_id=?', store.now(), JSON.stringify(stats), runId);
    console.log(JSON.stringify(stats, null, 2));
  } else if (cmd === 'status') {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    console.log(JSON.stringify({
      items_total: store.get('SELECT COUNT(*) n FROM items').n,
      items_24h_by_family: store.all('SELECT family, COUNT(*) n FROM items WHERE first_seen_at >= ? GROUP BY family ORDER BY family', since),
      items_24h_by_source: store.all('SELECT source_id, COUNT(*) n, MIN(published_at) oldest, MAX(published_at) newest FROM items WHERE first_seen_at >= ? GROUP BY source_id ORDER BY n DESC', since),
      last_run_per_source: store.all('SELECT source_id, MAX(run_ts) last_run, (SELECT status FROM source_runs s2 WHERE s2.source_id=s1.source_id ORDER BY run_ts DESC LIMIT 1) last_status, (SELECT error FROM source_runs s2 WHERE s2.source_id=s1.source_id ORDER BY run_ts DESC LIMIT 1) last_error, (SELECT latency_median_min FROM source_runs s2 WHERE s2.source_id=s1.source_id AND status=\'OK\' ORDER BY run_ts DESC LIMIT 1) latency_min FROM source_runs s1 GROUP BY source_id ORDER BY source_id'),
      runs: store.all('SELECT run_id, started_at, ended_at, stats_json FROM runs ORDER BY started_at DESC LIMIT 5'),
    }, null, 2));
  } else if (cmd === 'purge') {
    console.log(JSON.stringify(purge(store, { itemDays: Number(args.days ?? 14) })));
  } else {
    console.log('Usage: node radar.mjs collect [--only id1,id2] [--force] | status | purge [--days 14]');
  }
} finally { store.close(); }
