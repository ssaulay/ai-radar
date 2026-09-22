import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeed, parseHnItems, parseHfHub, parseHfPapers, parseOpenRouter } from '../src/collect/parsers.mjs';
import { canonicalUrl, upsertItems } from '../src/collect/collect.mjs';
import { openStore, purge } from '../src/core/store.mjs';

test('RSS avec source Google News, Atom, RDF Slashdot', () => {
  const rss = '<rss><channel><item><title>OpenAI lance X - Le Monde</title><link>https://news.google.com/rss/articles/abc?oc=5</link><guid>g1</guid><pubDate>Mon, 22 Sep 2026 08:00:00 GMT</pubDate><source url="https://lemonde.fr">Le Monde</source></item></channel></rss>';
  const r = parseFeed(rss, 'https://news.google.com/rss/search?q=x');
  assert.equal(r.length, 1); assert.equal(r[0].author, 'Le Monde'); assert.equal(r[0].published_at, '2026-09-22T08:00:00.000Z'); assert.equal(r[0].external_id, 'g1');
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title>Release v1.2</title><link rel="alternate" href="/ollama/ollama/releases/tag/v1.2"/><updated>2026-09-22T00:00:00Z</updated><content type="html">&lt;p&gt;notes&lt;/p&gt;</content></entry></feed>';
  const a = parseFeed(atom, 'https://github.com/ollama/ollama/releases.atom');
  assert.equal(a[0].url, 'https://github.com/ollama/ollama/releases/tag/v1.2'); assert.equal(a[0].text, 'notes');
  const rdf = '<rdf:RDF><item rdf:about="https://slashdot.org/story/1"><title>T</title><dc:date>2026-09-22T01:00:00+00:00</dc:date></item></rdf:RDF>';
  assert.equal(parseFeed(rdf, 'https://rss.slashdot.org/x')[0].url, 'https://slashdot.org/story/1');
});

test('HN : stories seulement, rang, kind Show HN', () => {
  const items = parseHnItems([{ id: 1, type: 'story', title: 'Show HN: Foo', by: 'a', time: 1758500000, score: 12, descendants: 3 }, { id: 2, type: 'comment' }, null, { id: 3, type: 'story', title: 'Bar', time: 1758500000, dead: true }], { withRank: true });
  assert.equal(items.length, 1); assert.equal(items[0].kind, 'SHOW_HN'); assert.equal(items[0].rank, 1); assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=1');
});

test('HF hub, HF papers, OpenRouter', () => {
  const m = parseHfHub([{ id: 'org/model', trendingScore: 42, likes: 10, downloads: 5, lastModified: '2026-09-21T10:00:00.000Z', tags: ['a'] }], 'MODEL');
  assert.equal(m[0].url, 'https://huggingface.co/org/model'); assert.equal(m[0].score_raw, 42);
  const p = parseHfPapers([{ paper: { id: '2609.01234', title: 'P', upvotes: 7, authors: [{ name: 'A' }], githubRepo: 'x/y' }, publishedAt: '2026-09-21T00:00:00Z' }]);
  assert.equal(p[0].url, 'https://huggingface.co/papers/2609.01234'); assert.equal(p[0].score_raw, 7); assert.equal(p[0].raw.githubRepo, 'x/y');
  const o = parseOpenRouter({ data: [{ id: 'openai/gpt-6', name: 'GPT-6', created: 1758500000 }] });
  assert.equal(o[0].kind, 'MODEL_LISTED'); assert.equal(o[0].published_at, new Date(1758500000000).toISOString());
});

test('URL canonique : tracking retiré, www et slash final normalisés, http vers https', () => {
  assert.equal(canonicalUrl('http://www.Example.com/a/?utm_source=x&id=1&fbclid=z#frag'), 'https://example.com/a/?id=1');
  assert.equal(canonicalUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalUrl(null), null);
});

test('upsert : pas de doublon au second passage, score re-snapshoté, first_seen conservé, purge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = openStore(dir);
  const src = { id: 'hn_top', family: 'A' };
  const it = { external_id: '1', url: 'https://x.io/a?utm_source=t', title: 'Hello', published_at: '2026-09-22T07:00:00.000Z', score_raw: 5, comments: 1, kind: 'STORY', rank: 3 };
  const a = upsertItems(s, src, [it], '2026-09-22T08:00:00.000Z');
  assert.deepEqual([a.created, a.updated, a.latencyMedianMin], [1, 0, 60]);
  const b = upsertItems(s, src, [{ ...it, score_raw: 50, comments: 9 }], '2026-09-22T08:30:00.000Z');
  assert.deepEqual([b.created, b.updated], [0, 1]);
  const row = s.get('SELECT * FROM items'); assert.equal(row.score_raw, 50); assert.equal(row.first_seen_at, '2026-09-22T08:00:00.000Z'); assert.equal(row.url_canon, 'https://x.io/a');
  assert.equal(s.get('SELECT COUNT(*) n FROM score_snapshots').n, 2);
  assert.equal(s.get('SELECT COUNT(*) n FROM items').n, 1);
  upsertItems(s, src, [{ external_id: 'old', title: 'Old', published_at: '2026-08-01T00:00:00.000Z' }], '2026-08-01T00:00:00.000Z');
  const p = purge(s, { itemDays: 14 }); assert.equal(p.items, 1);
  s.close();
});

test('upsert : un item publié il y a plus de 14 jours n\'est pas inséré (hors familles E et H)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-')); const s = openStore(dir);
  const old = { external_id: 'o', url: 'https://x.io/o', title: 'Old post', published_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(upsertItems(s, { id: 'blog', family: 'F' }, [old], '2026-09-22T08:00:00.000Z').created, 0);
  assert.equal(upsertItems(s, { id: 'hf', family: 'E' }, [old], '2026-09-22T08:00:00.000Z').created, 1);
  s.close();
});
