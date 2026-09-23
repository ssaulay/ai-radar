import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.mjs';
import { upsertItems } from '../src/collect/collect.mjs';
import { loadLexicon, isAiRelevant, extractEntities, extractTerms } from '../src/analyze/relevance.mjs';
import { makeEmbedder, cosine, hashEmbed } from '../src/core/embed.mjs';
import * as embedMod from '../src/core/embed.mjs';
import { clusterNewItems, ensureClusterSchema } from '../src/analyze/cluster.mjs';
import { scoreAll, rebuildTermHourly, termBurst } from '../src/analyze/score.mjs';
import { renderAll } from '../src/render/render.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const lex = loadLexicon(ROOT);
const NOW = '2026-09-22T12:00:00.000Z';
const mk = (root) => { const s = openStore(root); ensureClusterSchema(s); return s; };

test('pertinence IA : sources spécialisées toujours, sinon mots-clés ; entités et termes', () => {
  assert.equal(isAiRelevant({ source_id: 'arxiv_ai', title: 'Anything' }), true);
  assert.equal(isAiRelevant({ source_id: 'hn_top', title: 'Rust 2.0 released', text: '' }), false);
  assert.equal(isAiRelevant({ source_id: 'hn_top', title: 'Anthropic releases Claude 5', text: '' }), true);
  assert.deepEqual(extractEntities('OpenAI et Mistral AI annoncent un partenariat GPT-5', lex).sort(), ['GPT-5', 'Mistral AI', 'OpenAI']);
  const terms = extractTerms('Anthropic releases Claude 5 with computer use', lex);
  assert.ok(terms.includes('@Anthropic') && terms.includes('@Claude'));
  assert.ok(terms.includes('computer use') || terms.some(t => t.includes('computer')));
});

test('vecteurs int8 : aller-retour avec erreur de cosinus < 0,005, anciens float32 lisibles et convertis à la purge', () => {
  const { toBlob, fromBlob, normalize, isFloat32Blob } = embedMod;
  let worst = 0;
  for (let k = 0; k < 50; k++) { const v = normalize(Float32Array.from({ length: 512 }, () => Math.random() * 2 - 1)); const w = normalize(Float32Array.from({ length: 512 }, (_, i) => v[i] + (Math.random() - 0.5) * 0.2)); const b = toBlob(v); assert.equal(b.byteLength, 516); const err = Math.abs(cosine(v, w) - cosine(fromBlob(b), fromBlob(toBlob(w)))); if (err > worst) worst = err; }
  assert.ok(worst < 0.005, 'erreur max ' + worst);
  const v = normalize(Float32Array.from({ length: 512 }, () => Math.random() - 0.5)); const old = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  assert.ok(isFloat32Blob(old)); assert.ok(cosine(fromBlob(old), v) > 0.9999);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = mk(dir);
  s.run('INSERT INTO embeddings(item_id,model,vec) VALUES (1,?,?)', 'x', old); s.run('INSERT INTO clusters(cluster_id,centroid,seed,n,first_seen_at,last_seen_at) VALUES (1,?,?,1,?,?)', old, old, NOW, NOW);
  const r = embedMod.compactVectors(s); assert.equal(r, 2);
  assert.equal(s.get('SELECT length(vec) l FROM embeddings').l, 516); assert.ok(cosine(fromBlob(s.get('SELECT vec FROM embeddings').vec), v) > 0.999);
  assert.equal(embedMod.compactVectors(s), 0, 'idempotent'); s.close();
});

test('embedding de repli : similaire pour titres proches, éloigné sinon', () => {
  const a = hashEmbed('Anthropic releases Claude 5 model'), b = hashEmbed('Anthropic Claude 5 model released today'), c = hashEmbed('Rust compiler gets faster borrow checker');
  assert.ok(cosine(a, b) > cosine(a, c));
});

test('clustering : trois formulations d’un même sujet se regroupent, un sujet différent reste séparé, le lien partagé rattache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = mk(dir);
  const emb = makeEmbedder({ forceHash: true });
  const t = h => new Date(Date.parse(NOW) - h * 3600e3).toISOString();
  upsertItems(s, { id: 'hn_algolia_ai', family: 'A' }, [
    { external_id: '1', url: 'https://anthropic.com/news/claude-5', title: 'Anthropic releases Claude 5 model', published_at: t(2), score_raw: 120 },
    { external_id: '2', url: 'https://example.com/x', title: 'Anthropic releases Claude 5 model, what changes', published_at: t(1), score_raw: 40 },
  ], t(0.5));
  upsertItems(s, { id: 'hn_top', family: 'A' }, [{ external_id: '3', url: 'https://example.com/rust', title: 'Rust compiler borrow checker speedup', published_at: t(1), score_raw: 10 }], t(0.5));
  upsertItems(s, { id: 'blog_anthropic_tiers', family: 'F' }, [{ external_id: 'a', url: 'https://www.anthropic.com/news/claude-5/', title: 'Introducing Claude 5', published_at: t(3) }], t(0.5));
  upsertItems(s, { id: 'gnews_en_ai', family: 'G' }, [{ external_id: 'g', url: 'https://news.google.com/rss/articles/zzz', title: 'Anthropic releases Claude 5 model: what we know', published_at: t(0.2) }], t(0.1));
  const r = await clusterNewItems(s, emb, lex, { now: NOW, log: () => {} });
  assert.equal(r.clustered, 4, 'Rust exclu par pertinence');
  const claude = s.get("SELECT c.cluster_id, c.n FROM clusters c JOIN cluster_items ci ON ci.cluster_id=c.cluster_id JOIN items i ON i.item_id=ci.item_id WHERE i.external_id='1'");
  assert.ok(claude.n >= 3, `le sujet Claude regroupe au moins 3 items (lien partagé + similarité), n=${claude.n}`);
  const res = scoreAll(s, lex, { now: NOW, log: () => {}, root: ROOT });
  const top = res[0];
  assert.ok(top.components.families.list.includes('A') && top.components.families.list.includes('F'));
  assert.ok(!top.components.families.list.includes('G'), 'la presse ne compte pas dans les familles');
  assert.equal(top.status, 'CONFIRMED'); assert.equal(top.press_count, 1);
  assert.ok(top.components.official.value === true);
  scoreAll(s, lex, { now: new Date(Date.parse(NOW) + 7 * 3600e3).toISOString(), log: () => {}, root: ROOT });
  assert.equal(s.get('SELECT MAX(c) m FROM (SELECT COUNT(*) c FROM cluster_scores GROUP BY cluster_id)').m, 1, 'au-delà de 6 h, un seul score conservé par sujet');
  const again = await clusterNewItems(s, emb, lex, { now: NOW, log: () => {} });
  assert.equal(again.clustered, 0, 'second passage : rien à regrouper');
  const out = renderAll(s, res, { root: dir, now: NOW });
  const html = fs.readFileSync(path.join(out.dir, 'index.html'), 'utf8');
  assert.ok(html.includes('Anthropic') && html.includes('radar.json'));
  assert.ok(fs.existsSync(path.join(out.dir, 'radar.xml')));
  s.close();
});

test('burst : un terme vu 0 puis 2 fois ne déclenche pas ; 12 fois contre 1 par jour déclenche', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = mk(dir);
  const t = h => new Date(Date.parse(NOW) - h * 3600e3).toISOString();
  const items = [];
  for (let d = 1; d <= 7; d++) items.push({ external_id: `b${d}`, title: 'Gemini update', published_at: t(24 * d + 1) });
  for (let k = 0; k < 12; k++) items.push({ external_id: `n${k}`, title: 'Gemini update', published_at: t(0.5 + k * 0.2) });
  items.push({ external_id: 'q1', title: 'Quiet topic', published_at: t(1) }, { external_id: 'q2', title: 'Quiet topic', published_at: t(2) });
  upsertItems(s, { id: 'hn_algolia_ai', family: 'A' }, items, NOW);
  s.run("UPDATE items SET relevant=1, evt_at=published_at");
  rebuildTermHourly(s, lex, { now: NOW });
  const g = termBurst(s, '@Gemini', { now: NOW }); assert.ok(g.z >= 3 && g.current === 12, JSON.stringify(g));
  const q = termBurst(s, 'quiet topic', { now: NOW }); assert.equal(q.current, 2);
  s.close();
});

import { recordDetections, evaluateDue, dailyMetrics, buildQuery } from '../src/analyze/evaluate.mjs';
test('évaluation : requête presse figée, hit si 3 articles après et 0 avant, précision@10 et avance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = mk(dir);
  assert.equal(buildQuery('Anthropic releases Claude 5 agents', [{ e: 'Anthropic' }, { e: 'Claude' }], lex.stop), '"Anthropic" "Claude" agents');
  const t0 = new Date(Date.parse(NOW) - 50 * 3600e3).toISOString();
  const results = [{ cluster_id: 1, first_seen_at: t0, score: 60, status: 'ANTICIPATION', label: 'Anthropic releases Claude 5', entities: [{ e: 'Anthropic' }], items: [] }, { cluster_id: 2, first_seen_at: t0, score: 40, status: 'ANTICIPATION', label: 'Quiet topic nobody covers', entities: [], items: [] }];
  recordDetections(s, results, lex, { now: t0 });
  const art = (h, id) => `<item><title>Art ${id}</title><link>https://ex.com/${id}</link><guid>${id}</guid><pubDate>${new Date(Date.parse(t0) + h * 3600e3).toUTCString()}</pubDate></item>`;
  const http = async url => ({ body: /Anthropic/.test(decodeURIComponent(url)) ? `<rss><channel>${art(3, 'a')}${art(5, 'b')}${art(20, 'c')}</channel></rss>` : '<rss><channel></channel></rss>' });
  const r = await evaluateDue(s, http, { now: NOW, log: () => {} });
  assert.equal(r.evaluated, 2);
  const e1 = s.get('SELECT * FROM evaluations WHERE cluster_id=1 AND horizon_h=48'); assert.equal(e1.hit, 1); assert.equal(e1.press_after, 3); assert.equal(e1.press_before, 0);
  const e2 = s.get('SELECT * FROM evaluations WHERE cluster_id=2 AND horizon_h=48'); assert.equal(e2.hit, 0);
  const m = dailyMetrics(s, { now: NOW });
  assert.equal(m.length, 1); assert.equal(m[0].precision_at_10, 0.5); assert.equal(m[0].lead_median_h, 3);
  s.close();
});

import { buildPressQuery, checkPress } from '../src/analyze/presscheck.mjs';
test('requête presse : noms propres récurrents des titres avant les thèmes du lexique ; vérification active change le statut', async () => {
  const items = [{ title: 'Jev introduces a new shape of LLM' }, { title: 'TypeSafe AI Jev vs. GPT-6 Astra' }, { title: 'Jev “System One” models: TypeSafe AI’s new LLM category' }];
  const q = buildPressQuery(items, [{ e: 'Open weights' }, { e: 'Codex' }], lex, 'Jev introduces a new shape of LLM');
  assert.ok(/^Jev\b/.test(q) && /TypeSafe/.test(q), q); assert.ok(!/Open weights/.test(q), q);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = mk(dir);
  const r = { cluster_id: 7, label: 'Jev', entities: [], items, press_count: 0, status: 'ANTICIPATION' };
  const art = (d, id) => `<item><title>A${id}</title><link>https://ex.com/${id}</link><guid>${id}</guid><pubDate>${new Date(Date.parse(NOW) - d * 864e5).toUTCString()}</pubDate></item>`;
  const http = async () => ({ body: `<rss><channel>${art(1, 'a')}${art(2, 'b')}${art(4, 'c')}</channel></rss>` });
  const res = await checkPress(s, http, [r], lex, { now: NOW, log: () => {} });
  assert.equal(res.queried, 1); assert.equal(r.status, 'CONFIRMED'); assert.equal(r.press_count, 3); assert.equal(r.press_check.last_24h, 1);
  const res2 = await checkPress(s, http, [r], lex, { now: NOW, log: () => {} }); assert.equal(res2.cached, 1);
  s.close();
});

import { markPublished, recordOutcome, publicationReport } from '../src/analyze/publish.mjs';
test('journal de publication : mark conserve score et statut, outcome ajoute une mesure, stats à partir de 5 posts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = mk(dir);
  for (let i = 1; i <= 5; i++) {
    s.run("INSERT INTO clusters(cluster_id,n,first_seen_at,last_seen_at,label) VALUES (?,?,?,?,?)", i, 2, NOW, NOW, `Sujet ${i}`);
    s.run("INSERT INTO cluster_scores(cluster_id,computed_at,score,components_json,status) VALUES (?,?,?,?,?)", i, NOW, 40 + i, JSON.stringify({ families: { list: ['A', 'F'] } }), i % 2 ? 'ANTICIPATION' : 'CONFIRMED');
    const p = markPublished(s, { clusterId: i, url: `https://linkedin.com/posts/${i}`, lang: i % 2 ? 'fr' : 'en', now: NOW });
    assert.equal(p.score_at_mark, 40 + i); assert.equal(p.families_at_mark, 'AF');
    recordOutcome(s, { url: `https://linkedin.com/posts/${i}`, impressions: 1000 * i, reactions: 10 * i, now: NOW });
  }
  const rep = publicationReport(s);
  assert.equal(rep.publications.length, 5); assert.equal(rep.stats.n, 5); assert.equal(rep.stats.median_impressions, 3000);
  assert.throws(() => recordOutcome(s, { url: 'https://inconnu', impressions: 1 }));
  s.close();
});
