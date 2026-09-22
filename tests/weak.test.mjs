import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.mjs';
import { loadLexicon } from '../src/analyze/relevance.mjs';
import { parseStealthPage, parseLiteLlmKeys, parseHfOrg, parseGithubOrg, modelAddFromTitle, parseInferencePulls, parseSitemap, parseChangelogMd, parseStatusComponents, diffEntries, catalogAll, loadCatalogs, parseSirene, parseAshbyJobs, parseGreenhouseDepartments, parseEdgar, parsePolymarketEvents, parseDiscourseCategories, parseDiscordWidget } from '../src/collect/catalog.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const lex = loadLexicon(ROOT);
const NOW = '2026-09-22T12:00:00.000Z';
const t = h => new Date(Date.parse(NOW) - h * 3600e3).toISOString();
const mk = () => openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-weak-')));

test('parseurs de catalogues : stealth, LiteLLM (openrouter/ ignoré), HF, GitHub (forks exclus), Statuspage', () => {
  const st = parseStealthPage('<a href="/stealth/ox-alpha">Ox</a><a href="/stealth/union-alpha">U</a><a href="/stealth/ox-alpha">dup</a><a href="/docs/quickstart">x</a>');
  assert.deepEqual(st.map(e => e.key), ['stealth/ox-alpha', 'stealth/union-alpha']);
  const ll = parseLiteLlmKeys({ sample_spec: {}, 'openrouter/openai/gpt-6': {}, 'anthropic.claude-mythos-preview': { litellm_provider: 'bedrock' }, 'stealth/union-alpha': {} });
  assert.deepEqual(ll.map(e => e.key).sort(), ['anthropic.claude-mythos-preview', 'stealth/union-alpha']); assert.equal(ll[0].extra.provider, 'bedrock');
  const hf = parseHfOrg([{ id: 'google/gemma-4', createdAt: '2026-09-10T00:00:00.000Z', likes: 3, pipeline_tag: 'text-generation' }], 'google');
  assert.equal(hf[0].url, 'https://huggingface.co/google/gemma-4'); assert.equal(hf[0].event_at, '2026-09-10T00:00:00.000Z');
  const gh = parseGithubOrg([{ full_name: 'openai/new-thing', html_url: 'https://github.com/openai/new-thing', created_at: '2026-09-20T00:00:00Z', fork: false }, { full_name: 'openai/forked', fork: true, created_at: '2026-09-21T00:00:00Z' }], 'openai');
  assert.equal(gh.length, 1); assert.equal(gh[0].key, 'openai/new-thing');
  const sc = parseStatusComponents({ page: { url: 'https://status.anthropic.com' }, components: [{ id: 'c1', name: 'Claude Cowork', created_at: '2026-04-01T10:00:00.000Z', status: 'operational' }] });
  assert.equal(sc[0].key, 'c1'); assert.equal(sc[0].title, 'Claude Cowork'); assert.equal(sc[0].url, 'https://status.anthropic.com');
});

test('PR d’inférence : « add Qwen3 » citant un nom inconnu du lexique est détectée ; typo, bot et PR sans ajout ignorés', () => {
  assert.deepEqual(modelAddFromTitle('[Model] Add Qwen3 support').candidates, ['Qwen3']);
  assert.equal(modelAddFromTitle('[New Model] GLM-4.5 support').candidate, 'GLM-4.5');
  assert.equal(modelAddFromTitle('model : support Gemma4 DSpark draft backbone').candidate, 'Gemma4 DSpark');
  assert.equal(modelAddFromTitle('Fix typo in README'), null);
  assert.equal(modelAddFromTitle('[Model] Preserve MiMo cache policy and hybrid attention windows'), null, 'pas un ajout');
  assert.equal(modelAddFromTitle('[Agents] Add model-optimization skill with performance goal matrix'), null, 'aucun nom propre candidat');
  const pulls = [
    { number: 1, title: '[Model] Add Qwen3 support', html_url: 'https://github.com/vllm-project/vllm/pull/1', created_at: t(3), user: { login: 'dev' }, labels: [] },
    { number: 2, title: 'Fix typo in README', html_url: 'u2', created_at: t(2), user: { login: 'dev' } },
    { number: 3, title: '[Model] Add Zorblax support', html_url: 'u3', created_at: t(1), user: { login: 'serge[bot]' } },
  ];
  const noQwen = { entities: lex.entities.filter(e => e.name !== 'Qwen'), stop: lex.stop };
  const unknown = parseInferencePulls(pulls, 'vllm-project/vllm', noQwen);
  assert.equal(unknown.length, 1); assert.equal(unknown[0].key, 'vllm-project/vllm#1'); assert.equal(unknown[0].entity, 'Qwen3'); assert.deepEqual(unknown[0].extra.known, []);
  const known = parseInferencePulls(pulls, 'vllm-project/vllm', lex);
  assert.equal(known[0].entity, 'Qwen3', 'l’entité reste le nom candidat du titre'); assert.deepEqual(known[0].extra.known, ['Qwen']);
});

test('sitemap et changelogs : entrées lisibles, clés stables d’une lecture à l’autre, liens et intro ignorés', () => {
  const sm = parseSitemap('<urlset><url><loc>https://openai.com/index/introducing-gpt-6/</loc><lastmod>2026-09-22T16:46:31.553Z</lastmod><xhtml:link rel="alternate" href="x"/></url><url><loc>https://openai.com/</loc></url></urlset>');
  assert.equal(sm.length, 2); assert.equal(sm[0].key, 'https://openai.com/index/introducing-gpt-6/'); assert.equal(sm[0].title, 'introducing gpt 6'); assert.equal(sm[0].extra.lastmod, '2026-09-22T16:46:31.553Z');
  const openai = '# Changelog\n\n> intro text that must be ignored because no date heading\n\n## September, 2026\n\n### Sep 15\n\nFeature\n\nAdded API key creation governance controls at the organization level. See [docs](https://x/1).\n\n### Sep 10\n\nFeature\n\nYou can now set expiration dates when creating project API keys.\n';
  const a = parseChangelogMd(openai);
  assert.equal(a.length, 2, JSON.stringify(a.map(x => x.title)));
  assert.ok(a[0].title.startsWith('September, 2026 › Sep 15 : Added API key creation governance controls'));
  const b = parseChangelogMd(openai.replace('https://x/1', 'https://x/2'));
  assert.deepEqual(a.map(x => x.key), b.map(x => x.key), 'un lien modifié ne change pas la clé');
  const gemini = 'This page documents updates.\n\n## September 18, 2026\n\n- **Gemini 2.5 models access update**: limiting access to the 2.5 models\n  to users who have actively used them.\n- **Antigravity Agent 09-2026** : Released `antigravity-preview-09-2026`.\n\n## September 17, 2026\n\n- **Lyria 3.5 GA**: Released the next generation of music models.\n';
  const g = parseChangelogMd(gemini);
  assert.equal(g.length, 3); assert.ok(g[0].title.includes('Gemini 2.5 models access update: limiting access to the 2.5 models to users'), g[0].title);
  const claude = '---\ntitle: notes\n---\n\nIntro.\n\n<Tip>\n  ignored tip\n</Tip>\n\n### September 22, 2026\n\n* We\'ve launched **Claude Opus 5.5** (`claude-opus-5-5`), a model for long-running agentic coding.\n';
  const c = parseChangelogMd(claude);
  assert.equal(c.length, 1); assert.ok(c[0].title.includes('Claude Opus 5.5'));
});

test('catalogAll : amorçage sans événement sauf entrées datées de moins de 48 h ; rejeu neutre ; nouvelle clé = événement daté avec raison', async () => {
  const s = mk();
  const state = {
    status: { page: { url: 'https://status.example.com' }, components: [{ id: 'a', name: 'API', created_at: '2026-01-01T00:00:00.000Z' }, { id: 'b', name: 'Cowork', created_at: t(2) }] },
    sitemap: '<urlset><url><loc>https://ex.com/index/one/</loc></url><url><loc>https://ex.com/index/two/</loc></url></urlset>',
    pulls: [{ number: 7, title: '[Model] Add Zorblax-7B support', html_url: 'https://github.com/x/y/pull/7', created_at: t(1), user: { login: 'dev' } }, { number: 8, title: 'model : support Gemma4 DSpark draft backbone', html_url: 'https://github.com/x/y/pull/8', created_at: t(1), user: { login: 'dev' } }],
    commits: [{ sha: 'aaa', commit: { committer: { date: t(5) } } }],
    prices: { 'bedrock/foo-v1': { litellm_provider: 'bedrock' } },
  };
  const http = async (url) => {
    if (url.includes('components.json')) return { body: JSON.stringify(state.status) };
    if (url.includes('sitemap')) return { body: state.sitemap };
    if (url.includes('/pulls')) return { body: JSON.stringify(state.pulls) };
    if (url.includes('/commits?')) return { body: JSON.stringify(state.commits) };
    if (url.includes('raw.githubusercontent.com')) return { body: JSON.stringify(state.prices) };
    return { error: 'PERMANENT_HTTP_404' };
  };
  const catalogs = [
    { id: 't_status', type: 'status_components', url: 'https://status.example.com/api/v2/components.json', every_min: 30 },
    { id: 't_sitemap', type: 'sitemap', url: 'https://ex.com/sitemap.xml', every_min: 30 },
    { id: 't_pulls', type: 'inference_pulls', repo: 'ggml-org/llama.cpp', every_min: 30 },
    { id: 't_litellm', type: 'litellm_prices', repo: 'BerriAI/litellm', path: 'model_prices_and_context_window.json', every_min: 30 },
  ];
  const opts = { catalogs, lex, now: NOW, log: () => {} };
  const r1 = await catalogAll(s, http, opts);
  assert.equal(r1.stats.catalogs_ok, 4); assert.equal(r1.stats.first_pass, 4);
  assert.deepEqual(r1.events.map(e => e.key).sort(), ['b', 'ggml-org/llama.cpp#7', 'ggml-org/llama.cpp#8'], 'amorçage : seules les entrées datées de moins de 48 h sortent');
  const pr8 = s.get("SELECT * FROM weak_signals WHERE key='ggml-org/llama.cpp#8'");
  assert.equal(pr8.known_entity, 0, 'la clé contient llama.cpp (entité du lexique) mais le modèle du titre est inconnu'); assert.equal(pr8.entity, 'Gemma4 DSpark'); assert.ok(/nom inconnu du lexique/.test(pr8.reason), pr8.reason);
  assert.equal(s.get('SELECT COUNT(*) n FROM catalog_snapshots').n, 4);
  const r2 = await catalogAll(s, http, { ...opts, force: true });
  assert.equal(r2.stats.events, 0, 'rejeu du même état : aucun événement');
  assert.equal(r2.summary.find(x => x.catalog === 't_litellm').unchanged, true, 'LiteLLM : même commit, fichier non relu');
  const r3 = await catalogAll(s, http, { ...opts });
  assert.ok(r3.summary.every(x => x.status === 'NOT_DUE'), 'cadence respectée sans --force');
  state.status.components.push({ id: 'c', name: 'Claude Cowork', created_at: '2026-04-01T10:00:00.000Z' });
  state.sitemap = state.sitemap.replace('</urlset>', '<url><loc>https://ex.com/index/introducing-thing/</loc></url></urlset>');
  state.commits = [{ sha: 'bbb', commit: { committer: { date: t(0.5) } } }]; state.prices['anthropic.claude-mythos-preview'] = { litellm_provider: 'bedrock' };
  const later = new Date(Date.parse(NOW) + 3600e3).toISOString();
  const r4 = await catalogAll(s, http, { ...opts, now: later });
  assert.deepEqual(r4.events.map(e => e.key).sort(), ['anthropic.claude-mythos-preview', 'c', 'https://ex.com/index/introducing-thing/']);
  const c = s.get("SELECT * FROM weak_signals WHERE key='c'");
  assert.equal(c.detector, 'D7'); assert.equal(c.event_at, '2026-04-01T10:00:00.000Z'); assert.equal(c.detected_at, later);
  assert.ok(/Nouveau composant sur la page de statut status\.example\.com : Claude Cowork, créé le 2026-04-01/.test(c.reason), c.reason);
  assert.equal(c.known_entity, 1, 'Claude est une entité du lexique');
  const ll = s.get("SELECT * FROM weak_signals WHERE key='anthropic.claude-mythos-preview'");
  assert.ok(/fichier de prix LiteLLM/.test(ll.reason) && /bedrock/.test(ll.reason)); assert.equal(ll.event_at, t(0.5));
  const sm = s.get("SELECT * FROM weak_signals WHERE catalog_id='t_sitemap'");
  assert.ok(/Nouvelle URL dans le sitemap de ex\.com : \/index\/introducing-thing\//.test(sm.reason), sm.reason);
  const r5 = await catalogAll(s, http, { ...opts, now: later, force: true });
  assert.equal(r5.stats.events, 0, 'second rejeu : rien');
  assert.equal(s.get('SELECT COUNT(*) n FROM weak_signals').n, 6);
  assert.equal(s.get("SELECT n FROM catalog_snapshots WHERE catalog_id='t_status'").n, 3);
  s.close();
});

test('catalogAll : une source en erreur n’arrête pas le passage et est journalisée', async () => {
  const s = mk();
  const http = async (url) => url.includes('bad') ? { error: 'TEMPORARY_HTTP_503' } : { body: JSON.stringify({ components: [] }) };
  const r = await catalogAll(s, http, { catalogs: [{ id: 'bad', type: 'status_components', url: 'https://bad/x.json' }, { id: 'good', type: 'status_components', url: 'https://good/x.json' }], lex, now: NOW, log: () => {} });
  assert.equal(r.stats.catalogs_error, 1); assert.equal(r.stats.catalogs_ok, 1);
  assert.equal(s.get("SELECT status FROM source_runs WHERE source_id='bad'").status, 'ERROR');
  s.close();
});

test('loadCatalogs : labs.json engendre un catalogue HF et GitHub par organisation, identifiants uniques', () => {
  const cats = loadCatalogs(ROOT);
  const ids = cats.map(c => c.id); assert.equal(new Set(ids).size, ids.length);
  assert.ok(cats.some(c => c.type === 'hf_org' && c.org === 'openai' && c.url.includes('author=openai')));
  assert.ok(cats.some(c => c.type === 'github_org' && c.org === 'anthropics'));
  assert.ok(cats.filter(c => c.type === 'hf_org').length >= 25 && cats.filter(c => c.type === 'github_org').length >= 20);
});

test('5b parseurs : SIRENE (nom filtré, personnes physiques exclues, aucun dirigeant personne physique), EDGAR, Polymarket (filtre IA), Discourse, Discord', () => {
  const sir = parseSirene({ results: [
    { siren: '941811218', nom_complet: 'ANTHROPIC FRANCE', nature_juridique: '5710', date_creation: '2025-02-19', siege: { libelle_commune: 'PARIS' }, activite_principale: '58.29C', dirigeants: [{ nom: 'X', prenoms: 'Y', type_dirigeant: 'personne physique', date_de_naissance: '1990-01' }, { denomination: 'ANTHROPIC PBC', type_dirigeant: 'personne morale' }] },
    { siren: '853616506', nom_complet: 'CLEMENCE GIRODET (ANTHROPIC)', nature_juridique: '1000', date_creation: '2019-09-01' },
    { siren: '910617331', nom_complet: "OPEN'AIR", nature_juridique: '5710', date_creation: '2021-11-02' },
  ] }, { match: '^ANTHROPIC( |$)', lab: 'anthropic' });
  assert.equal(sir.length, 1); assert.equal(sir[0].key, '941811218'); assert.equal(sir[0].event_at, '2025-02-19T00:00:00.000Z');
  assert.deepEqual(sir[0].extra.dirigeants_personnes_morales, ['ANTHROPIC PBC']); assert.ok(!JSON.stringify(sir[0]).includes('1990'), 'aucune donnée de personne physique');
  const ed = parseEdgar({ hits: { hits: [{ _source: { adsh: '0002074935-25-000001', display_names: ['Thinking Machines Lab Jun 2025 a Series of CGF2021 LLC  (CIK 0002074935)'], file_date: '2025-06-27', ciks: ['0002074935'], biz_states: ['DE'], form: 'D' } }] } }, 'Thinking Machines');
  assert.equal(ed[0].key, '0002074935-25-000001'); assert.equal(ed[0].event_at, '2025-06-27T00:00:00.000Z'); assert.equal(ed[0].url, 'https://www.sec.gov/Archives/edgar/data/2074935/000207493525000001/0002074935-25-000001-index.htm');
  const pm = parsePolymarketEvents([{ id: 1, slug: 'gpt-6-release', title: 'Will OpenAI release GPT-6 before 2027?', createdAt: '2026-09-20T00:00:00Z', markets: [{}, {}] }, { id: 2, slug: 'nba', title: 'NBA champion 2027' }]);
  assert.equal(pm.length, 1); assert.equal(pm[0].url, 'https://polymarket.com/event/gpt-6-release'); assert.equal(pm[0].extra.markets, 2);
  const dc = parseDiscourseCategories({ category_list: { categories: [{ id: 5, name: 'Google Antigravity', slug: 'antigravity', topic_count: 12 }] } }, 'discuss.ai.google.dev');
  assert.equal(dc[0].key, 'cat:5'); assert.equal(dc[0].url, 'https://discuss.ai.google.dev/c/antigravity/5');
  const dw = parseDiscordWidget({ name: 'OpenAI', presence_count: 85170, channels: [{ id: '1', name: 'webmcp-stage' }] }, '974519864045756446');
  assert.equal(dw[0].title, 'webmcp-stage'); assert.equal(dw[0].extra.guild, 'OpenAI');
});

test('5b offres d’emploi : postes historisés, un événement groupé par passage (amorçage : publiés < 48 h seulement), nouvelle équipe = événement, rejeu neutre', async () => {
  const s = mk();
  const state = { ashby: { jobs: [
    { id: 'a1', title: 'Research Engineer', department: 'Research', team: 'Research', publishedAt: t(1), jobUrl: 'https://jobs.ashbyhq.com/openai/a1', isListed: true },
    { id: 'a2', title: 'Accountant', department: 'Finance', team: 'Finance', publishedAt: t(24 * 30), jobUrl: 'u', isListed: true },
    { id: 'a3', title: 'Hidden', department: 'Finance', team: 'Finance', publishedAt: t(1), isListed: false },
  ] }, gh: { departments: [{ name: 'Compute', jobs: [{ id: 9, title: 'Datacenter Lead', first_published: t(2), absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/9', location: { name: 'SF' } }] }] } };
  const http = async url => url.includes('ashbyhq') ? { body: JSON.stringify(state.ashby) } : { body: JSON.stringify(state.gh) };
  const catalogs = [{ id: 'jobs_ashby_openai', type: 'ashby_jobs', lab: 'openai', name: 'OpenAI', board: 'openai', url: 'https://api.ashbyhq.com/posting-api/job-board/openai' }, { id: 'jobs_greenhouse_anthropic', type: 'greenhouse_jobs', lab: 'anthropic', name: 'Anthropic', board: 'anthropic', url: 'https://boards-api.greenhouse.io/v1/boards/anthropic/departments' }];
  const r1 = await catalogAll(s, http, { catalogs, lex, now: NOW, log: () => {} });
  assert.equal(s.get('SELECT COUNT(*) n FROM job_postings').n, 3, 'a1, a2 et le poste Greenhouse historisés ; a3 non listé ignoré');
  assert.equal(r1.events.length, 2, 'un événement groupé par board pour les postes publiés depuis moins de 48 h');
  const g = s.get("SELECT * FROM weak_signals WHERE catalog_id='jobs_ashby_openai'");
  assert.ok(/1 nouvelle\(s\) offre\(s\) chez OpenAI \(Ashby\) : « Research Engineer \(Research\) »/.test(g.reason), g.reason);
  assert.equal(s.get("SELECT COUNT(*) n FROM weak_signals WHERE key LIKE 'team:%'").n, 0, 'équipes amorcées sans événement');
  const r2 = await catalogAll(s, http, { catalogs, lex, now: NOW, force: true, log: () => {} });
  assert.equal(r2.stats.events, 0, 'rejeu neutre');
  state.ashby.jobs.push({ id: 'a4', title: 'Robotics Hardware Lead', department: 'Research', team: 'Robotics', publishedAt: t(0.5), jobUrl: 'u4', isListed: true });
  const later = new Date(Date.parse(NOW) + 3600e3).toISOString();
  const r3 = await catalogAll(s, http, { catalogs, lex, now: later, force: true, log: () => {} });
  assert.deepEqual(r3.events.map(e => e.key).sort(), ['jobs:' + later.slice(0, 16), 'team:Research / Robotics']);
  const team = s.get("SELECT * FROM weak_signals WHERE key='team:Research / Robotics'");
  assert.ok(/Nouvelle équipe dans les offres de OpenAI : Research \/ Robotics \(1 poste\(s\) : Robotics Hardware Lead\)/.test(team.reason), team.reason);
  assert.equal(s.get("SELECT first_seen_at FROM job_postings WHERE job_id='a4'").first_seen_at, later);
  s.close();
});

test('5b : un catalogue runner_only est sauté hors GitHub Actions et journalisé SKIPPED', async () => {
  const s = mk(); const prev = process.env.GITHUB_ACTIONS; delete process.env.GITHUB_ACTIONS;
  try {
    const r = await catalogAll(s, async () => ({ body: '[]' }), { catalogs: [{ id: 'polymarket_ai', type: 'polymarket_events', url: 'https://gamma-api.polymarket.com/events', runner_only: true }], lex, now: NOW, log: () => {} });
    assert.equal(r.summary[0].status, 'SKIPPED'); assert.equal(s.get("SELECT status FROM source_runs WHERE source_id='polymarket_ai'").status, 'SKIPPED');
  } finally { if (prev !== undefined) process.env.GITHUB_ACTIONS = prev; }
  s.close();
});

test('5b loadCatalogs : SIRENE, Ashby, Greenhouse et EDGAR engendrés depuis labs.json', () => {
  const cats = loadCatalogs(ROOT);
  assert.ok(cats.some(c => c.id === 'sirene_anthropic' && /ANTHROPIC/.test(c.match)));
  assert.ok(cats.some(c => c.id === 'jobs_greenhouse_anthropic') && cats.some(c => c.id === 'jobs_ashby_openai'));
  assert.ok(cats.some(c => c.id === 'edgar_thinking_machines' && c.url.includes(encodeURIComponent('"Thinking Machines"'))));
  assert.ok(cats.some(c => c.id === 'polymarket_ai' && c.runner_only));
});
