#!/usr/bin/env node
// Entree unique du radar : collect | catalog | cluster | score | render | analyze | run | status | purge | evaluate | recluster | mark | outcome
import path from 'node:path';
import fs from 'node:fs';
import { loadEnv } from './src/core/env.mjs';
import { openStore, purge } from './src/core/store.mjs';
import { makeHttp } from './src/core/http.mjs';
import { collectAll } from './src/collect/collect.mjs';
import { loadLexicon } from './src/analyze/relevance.mjs';
import { makeEmbedder } from './src/core/embed.mjs';
import { clusterNewItems } from './src/analyze/cluster.mjs';
import { scoreAll } from './src/analyze/score.mjs';
import { renderAll } from './src/render/render.mjs';
import { makeLlm } from './src/core/llm.mjs';
import { writeBriefs, loadProfile } from './src/analyze/brief.mjs';
import { markPublished, recordOutcome, publicationReport } from './src/analyze/publish.mjs';
import { recordDetections, evaluateDue, dailyMetrics } from './src/analyze/evaluate.mjs';
import { checkPress } from './src/analyze/presscheck.mjs';
import { catalogAll } from './src/collect/catalog.mjs';

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
  } else if (cmd === 'catalog') {
    // lot 5a : catalogues a fuite -> evenements dates dans weak_signals (detecteur D7), sans affichage (mode fantome)
    const r = await catalogAll(store, http, { root: ROOT, lex: loadLexicon(ROOT), secrets, only: args.only ? args.only.split(',') : null, force: args.force === 'true' });
    console.log(JSON.stringify({ ...r.stats, requests: counters.requests, http_errors: counters.errors, seconds: Math.round((Date.now() - t0) / 1000), errors: r.summary.filter(s => s.status === 'ERROR').map(e => `${e.catalog}: ${e.error}`) }, null, 2));
    for (const e of r.events.slice(0, 40)) console.log(`  + [${e.catalog}] ${e.event_at.slice(0, 16)} ${e.reason.slice(0, 160)}`);
  } else if (cmd === 'status') {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    console.log(JSON.stringify({
      items_total: store.get('SELECT COUNT(*) n FROM items').n,
      items_24h_by_family: store.all('SELECT family, COUNT(*) n FROM items WHERE first_seen_at >= ? GROUP BY family ORDER BY family', since),
      items_24h_by_source: store.all('SELECT source_id, COUNT(*) n, MIN(published_at) oldest, MAX(published_at) newest FROM items WHERE first_seen_at >= ? GROUP BY source_id ORDER BY n DESC', since),
      last_run_per_source: store.all('SELECT source_id, MAX(run_ts) last_run, (SELECT status FROM source_runs s2 WHERE s2.source_id=s1.source_id ORDER BY run_ts DESC LIMIT 1) last_status, (SELECT error FROM source_runs s2 WHERE s2.source_id=s1.source_id ORDER BY run_ts DESC LIMIT 1) last_error, (SELECT latency_median_min FROM source_runs s2 WHERE s2.source_id=s1.source_id AND status=\'OK\' ORDER BY run_ts DESC LIMIT 1) latency_min FROM source_runs s1 GROUP BY source_id ORDER BY source_id'),
      runs: store.all('SELECT run_id, started_at, ended_at, stats_json FROM runs ORDER BY started_at DESC LIMIT 5'),
      weak_signals_24h: (() => { try { return store.all('SELECT catalog_id, COUNT(*) n FROM weak_signals WHERE detected_at >= ? GROUP BY catalog_id ORDER BY n DESC', since); } catch { return []; } })(),
    }, null, 2));
  } else if (cmd === 'purge') {
    console.log(JSON.stringify(purge(store, { itemDays: Number(args.days ?? 14) })));
  } else if (cmd === 'mark') {
    console.log(JSON.stringify(markPublished(store, { clusterId: Number(args.cluster), url: args.url, platform: args.platform ?? 'linkedin', lang: args.lang ?? 'fr', note: args.note ?? null }), null, 2));
  } else if (cmd === 'outcome') {
    console.log(JSON.stringify(recordOutcome(store, { url: args.url, impressions: args.impressions ? Number(args.impressions) : null, reactions: args.reactions ? Number(args.reactions) : null, comments: args.comments ? Number(args.comments) : null, reposts: args.reposts ? Number(args.reposts) : null }), null, 2));
  } else if (cmd === 'evaluate') {
    const r = await evaluateDue(store, http, { maxQueries: Number(args.max ?? 40) }); console.log(JSON.stringify({ ...r, metrics: dailyMetrics(store) }, null, 2));
  } else if (cmd === 'recluster') {
    store.db.exec('DELETE FROM cluster_items; DELETE FROM clusters; DELETE FROM cluster_scores; DELETE FROM cluster_briefs;'); console.log('clusters effacés (embeddings conservés) ; relancer analyze');
  } else if (['cluster', 'score', 'render', 'analyze', 'run'].includes(cmd)) {
    const lex = loadLexicon(ROOT); const now = store.now();
    const embedder = makeEmbedder({ counters, forceHash: args['hash-embeddings'] === 'true' });
    const stats = {};
    if (cmd === 'run') {
      const r = await collectAll(store, http, { root: ROOT, secrets, force: args.force === 'true' }); stats.collect = { ok: r.summary.filter(s => s.status === 'OK').length, error: r.summary.filter(s => s.status === 'ERROR').length, new: r.summary.reduce((a, s) => a + (s.new ?? 0), 0) };
      // catalogues a fuite (lot 5a) : isole, une panne ne stoppe pas le run
      try { const c = await catalogAll(store, http, { root: ROOT, lex, secrets, force: args.force === 'true' }); stats.catalog = c.stats; } catch (e) { stats.catalog = { error: e.message.slice(0, 200) }; }
    }
    if (['cluster', 'analyze', 'run'].includes(cmd)) stats.cluster = await clusterNewItems(store, embedder, lex, { now });
    let results = null;
    if (['score', 'render', 'analyze', 'run'].includes(cmd)) { results = scoreAll(store, lex, { now, root: ROOT }); stats.topics = results.length; stats.press = await checkPress(store, http, results, lex, { now, embedder }); }
    let briefs = new Map();
    if (['render', 'analyze', 'run'].includes(cmd) && results) {
      const providers = process.env.OPENAI_API_KEY ? [{ name: 'openai', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY, model: process.env.BRIEF_MODEL ?? 'gpt-5.4-nano', textChars: 20000, minGapMs: 0, inUsd: 0.20, outUsd: 1.25, free: false, reasoning: 'minimal' }] : [];
      const llm = makeLlm(store, providers, { maxCalls: Number(process.env.BRIEF_MAX_CALLS ?? 40), counters });
      const b = await writeBriefs(store, llm, results, { top: Number(process.env.BRIEF_TOP ?? 30), maxUsdPerRun: Number(process.env.BRIEF_MAX_USD ?? 0.05), now, profile: loadProfile(ROOT) });
      briefs = b.briefs; stats.briefs = { generated: b.generated ?? 0, reused: b.reused ?? 0, skipped: b.skipped ?? null, llm_usd: Number((counters.llmUsd ?? 0).toFixed(4)) };
    }
    let metrics = [];
    if (results) { recordDetections(store, results, lex, { now }); if (['analyze', 'run'].includes(cmd)) stats.evaluate = await evaluateDue(store, http, { now }); metrics = dailyMetrics(store, { now }); }
    if (['render', 'analyze', 'run'].includes(cmd)) { stats.render = renderAll(store, results, { root: ROOT, now, briefs, metrics, publications: publicationReport(store), stats: { ...stats, embed_usd: Number(counters.embedUsd?.toFixed(4) ?? 0), embed_tokens: counters.embedTokens ?? 0, requests: counters.requests } }); }
    if (cmd === 'run') purge(store);
    stats.embed_usd = Number((counters.embedUsd ?? 0).toFixed(4)); stats.embed_tokens = counters.embedTokens ?? 0; stats.seconds = Math.round((Date.now() - t0) / 1000);
    console.log(JSON.stringify(stats, null, 2));
    if (results) console.log(results.slice(0, 12).map((r, i) => `${String(i + 1).padStart(2)}. [${String(Math.round(r.score)).padStart(3)}] ${r.status.padEnd(12)} ${r.components.families.list.join('')}${' '.repeat(Math.max(0, 5 - r.components.families.list.length))} ${r.n_items}it  ${r.label.slice(0, 90)}`).join('\n'));
  } else {
    console.log('Usage: node radar.mjs collect [--only id1,id2] [--force] | catalog [--only id1,id2] [--force] | cluster | score | render | analyze | run | status | purge [--days 14] | evaluate | recluster\n       node radar.mjs mark --cluster <id> --url <lien du post> [--platform linkedin|x] [--lang fr|en] [--note ...]\n       node radar.mjs outcome --url <lien du post> [--impressions N] [--reactions N] [--comments N] [--reposts N]');
  }
} finally { store.close(); }
