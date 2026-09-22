// Collecteur : parcourt config/sources.json, appelle le parseur du type, normalise, insere ou met a jour, journalise par source.
// Chaque source est isolee : une panne ne stoppe pas le run. Les items existants gardent first_seen_at ; score et commentaires sont
// re-snapshotes pour mesurer la velocite.
import fs from 'node:fs';
import path from 'node:path';
import * as P from './parsers.mjs';

const TRACKING = /^(utm_\w+|fbclid|gclid|ref|ref_src|source|mc_cid|mc_eid|igshid|si|feature)$/i;
export function canonicalUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    x.hash = ''; x.hostname = x.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    let s = x.toString().replace(/\/+$/, ''); if (x.protocol === 'http:') s = s.replace(/^http:/, 'https:');
    return s;
  } catch { return u; }
}
export const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

function fill(url, ctx) { return url.replace('{{DATE_MINUS_30}}', new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)).replace('{{SERIES}}', ctx.series ?? ''); }

async function fetchItems(src, http, secrets) {
  const opt = { hostDelay: src.host_delay_ms ?? undefined };
  const many = async (urls, fn, extra = {}) => { const out = []; const errs = []; for (const u of urls) { const r = await http(u, { ...opt, ...extra }); if (r.error) { errs.push(`${r.error} ${u}`); continue; } try { out.push(...fn(r, u)); } catch (e) { errs.push(`PARSE ${e.message} ${u}`); } } return { items: out, error: errs.length === urls.length ? errs.join(' | ') : null, warnings: errs }; };
  switch (src.type) {
    case 'rss': { const r = await http(fill(src.url, {}), opt); if (r.error) return { error: r.error }; return { items: P.parseFeed(r.body, src.url).map(i => ({ ...i, kind: src.kind ?? i.kind, lang: src.lang ?? i.lang ?? null })) }; }
    case 'rss_multi': return many(src.urls, (r, u) => { const repo = u.split('/').slice(3, 5).join('/'); return P.parseFeed(r.body, u).map(i => ({ ...i, kind: src.kind ?? i.kind, author: i.author ?? repo, title: src.kind === 'RELEASE' && !i.title.includes(repo.split('/')[1]) ? `${repo} ${i.title}` : i.title })); });
    case 'hn_list': {
      const l = await http(src.url, opt); if (l.error) return { error: l.error };
      const ids = JSON.parse(l.body).slice(0, src.limit ?? 60);
      const items = []; const batch = 20;
      for (let i = 0; i < ids.length; i += batch) { const part = await Promise.all(ids.slice(i, i + batch).map(id => http(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { hostDelay: 0 }).then(r => r.error ? null : JSON.parse(r.body)))); items.push(...part); }
      return { items: P.parseHnItems(items, { withRank: src.id === 'hn_top' }) };
    }
    case 'hn_algolia': { const since = Math.floor(Date.now() / 1000) - 3 * 3600; const r = await http(`${src.url}&numericFilters=created_at_i%3E${since}`, opt); if (r.error) return { error: r.error }; return { items: P.parseHnAlgolia(JSON.parse(r.body)) }; }
    case 'lobsters': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseLobsters(JSON.parse(r.body)) }; }
    case 'hf_hub': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseHfHub(JSON.parse(r.body), src.kind) }; }
    case 'hf_papers': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseHfPapers(JSON.parse(r.body)) }; }
    case 'openrouter': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseOpenRouter(JSON.parse(r.body)) }; }
    case 'github_search': { const h = secrets.GITHUB_TOKEN ? { Authorization: `Bearer ${secrets.GITHUB_TOKEN}` } : {}; const r = await http(fill(src.url, {}), { ...opt, headers: { ...h, Accept: 'application/vnd.github+json' } }); if (r.error) return { error: r.error }; return { items: P.parseGithubSearch(JSON.parse(r.body)) }; }
    case 'mastodon_tag': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseMastodonStatuses(JSON.parse(r.body), new URL(src.url).hostname) }; }
    case 'mastodon_links': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseMastodonLinks(JSON.parse(r.body)) }; }
    case 'bsky_trends': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseBskyTrends(JSON.parse(r.body)) }; }
    case 'bsky_authors': return many(src.actors.map(a => `${src.url}?actor=${encodeURIComponent(a)}&limit=${src.limit ?? 15}&filter=posts_no_replies`), r => P.parseBskyPosts(JSON.parse(r.body)));
    case 'bsky_search': {
      if (!secrets.BSKY_JWT) return { error: 'SKIPPED_NO_BSKY_ACCOUNT' };
      const since = new Date(Date.now() - 6 * 3600e3).toISOString();
      return many(src.queries.map(q => `${src.url}?q=${encodeURIComponent(q)}&sort=latest&since=${encodeURIComponent(since)}&limit=${src.limit ?? 25}`), r => P.parseBskyPosts(JSON.parse(r.body)), { headers: { Authorization: `Bearer ${secrets.BSKY_JWT}` } });
    }
    case 'manifold': { const r = await http(src.url, opt); if (r.error) return { error: r.error }; return { items: P.parseManifold(JSON.parse(r.body)) }; }
    case 'kalshi': return many(src.series.map(s => fill(src.url, { series: s })), r => P.parseKalshi(JSON.parse(r.body)));
    default: return { error: `UNKNOWN_TYPE ${src.type}` };
  }
}

export const MAX_ITEM_AGE_DAYS = 14;
export function upsertItems(store, src, items, runTs) {
  let created = 0, updated = 0; const latencies = [];
  // Fond de catalogue : un flux renvoie souvent des billets vieux de mois ou d'annees ; sans valeur de signal, on ne les insere pas
  // (sauf familles E et H dont l'evenement est d'etre en tendance maintenant).
  const ageCutoff = Date.parse(runTs) - MAX_ITEM_AGE_DAYS * 864e5;
  const tooOld = it => !['E', 'H'].includes(src.family) && it.published_at && Date.parse(it.published_at) < ageCutoff;
  const insert = store.db.prepare('INSERT INTO items(source_id,family,kind,external_id,url,url_canon,domain,title,text,author,lang,published_at,first_seen_at,last_seen_at,score_raw,comments,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const update = store.db.prepare('UPDATE items SET last_seen_at=?, score_raw=COALESCE(?,score_raw), comments=COALESCE(?,comments), title=CASE WHEN ? <> \'\' THEN ? ELSE title END WHERE item_id=?');
  const find = store.db.prepare('SELECT item_id, first_seen_at FROM items WHERE source_id=? AND external_id=?');
  const snap = store.db.prepare('INSERT OR IGNORE INTO score_snapshots(source_id,external_id,ts,score,comments,rank) VALUES (?,?,?,?,?,?)');
  store.tx(() => {
    for (const it of items) {
      if (!it.external_id || !(it.title ?? '').trim()) continue;
      const ex = find.get(src.id, it.external_id);
      if (!ex && tooOld(it)) continue;
      if (ex) { update.run(runTs, it.score_raw ?? null, it.comments ?? null, it.title ?? '', it.title ?? '', ex.item_id); updated++; }
      else {
        insert.run(src.id, src.family, it.kind ?? 'POST', it.external_id, it.url ?? null, canonicalUrl(it.url), domainOf(it.url), (it.title ?? '').slice(0, 500), (it.text ?? '').slice(0, 2000), it.author ?? null, it.lang ?? src.lang ?? null, it.published_at ?? null, runTs, runTs, it.score_raw ?? null, it.comments ?? null, it.raw ? JSON.stringify(it.raw).slice(0, 2000) : null);
        created++;
        if (it.published_at) latencies.push((Date.parse(runTs) - Date.parse(it.published_at)) / 60000);
      }
      if (it.score_raw !== null && it.score_raw !== undefined || it.rank) snap.run(src.id, it.external_id, runTs, it.score_raw ?? null, it.comments ?? null, it.rank ?? null);
    }
  });
  latencies.sort((a, b) => a - b);
  return { created, updated, latencyMedianMin: latencies.length ? Math.round(latencies[Math.floor(latencies.length / 2)]) : null };
}

export function dueNow(store, src, runTs) {
  const last = store.get('SELECT run_ts FROM source_runs WHERE source_id=? AND status=\'OK\' ORDER BY run_ts DESC LIMIT 1', src.id)?.run_ts;
  if (!last) return true;
  return (Date.parse(runTs) - Date.parse(last)) / 60000 >= (src.every_min ?? 30) - 2;
}

// Session Bluesky a partir d'un compte gratuit et d'un mot de passe d'application ; jeton valable pour la duree du run.
export async function bskySession(http, { handle = process.env.BSKY_HANDLE, appPassword = process.env.BSKY_APP_PASSWORD } = {}) {
  if (!handle || !appPassword) return null;
  try {
    const r = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: handle, password: appPassword }), signal: AbortSignal.timeout(15000) });
    const j = await r.json(); return j.accessJwt ?? null;
  } catch { return null; }
}

export async function collectAll(store, http, { root, secrets = {}, only = null, force = false, log = console.log }) {
  if (!secrets.BSKY_JWT) { const jwt = await bskySession(http); if (jwt) secrets.BSKY_JWT = jwt; }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'sources.json'), 'utf8'));
  const runTs = store.now(); const summary = [];
  for (const src of cfg.sources) {
    if (only && !only.includes(src.id)) continue;
    if (!force && !dueNow(store, src, runTs)) { summary.push({ source: src.id, status: 'NOT_DUE' }); continue; }
    const t0 = Date.now(); let res;
    try { res = await fetchItems(src, http, secrets); } catch (e) { res = { error: `EXCEPTION ${e.message}` }; }
    if (res.error) {
      store.run('INSERT INTO source_runs(run_ts,source_id,status,items_seen,items_new,items_updated,ms,error) VALUES (?,?,?,?,?,?,?,?)', runTs, src.id, res.error.startsWith('SKIPPED') ? 'SKIPPED' : 'ERROR', 0, 0, 0, Date.now() - t0, res.error.slice(0, 300));
      summary.push({ source: src.id, status: res.error.startsWith('SKIPPED') ? 'SKIPPED' : 'ERROR', error: res.error.slice(0, 120) }); log(`  ${src.id}: ${res.error.slice(0, 100)}`); continue;
    }
    const u = upsertItems(store, src, res.items, runTs);
    store.run('INSERT INTO source_runs(run_ts,source_id,status,items_seen,items_new,items_updated,ms,error,latency_median_min) VALUES (?,?,?,?,?,?,?,?,?)', runTs, src.id, 'OK', res.items.length, u.created, u.updated, Date.now() - t0, res.warnings?.length ? res.warnings.slice(0, 3).join(' | ').slice(0, 300) : null, u.latencyMedianMin);
    summary.push({ source: src.id, status: 'OK', seen: res.items.length, new: u.created, updated: u.updated, latency_min: u.latencyMedianMin });
    log(`  ${src.id}: ${res.items.length} vus, ${u.created} nouveaux, ${u.updated} mis à jour${u.latencyMedianMin !== null ? `, latence médiane ${u.latencyMedianMin} min` : ''}${res.warnings?.length ? `, ${res.warnings.length} avertissements` : ''}`);
  }
  return { runTs, summary };
}
