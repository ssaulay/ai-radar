import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.mjs';
import { upsertItems } from '../src/collect/collect.mjs';
import { loadLexicon, isAiRelevant, extractEntities, extractTerms } from '../src/analyze/relevance.mjs';
import { makeEmbedder, cosine, hashEmbed } from '../src/core/embed.mjs';
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
