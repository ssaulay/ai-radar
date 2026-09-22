// Catalogues a fuite (lots 5a et 5b) : on lit des etats (listes de modeles, de cles, d'URL, de composants) et l'apparition d'une cle
// entre deux passages est l'evenement, date et explique, range dans weak_signals (detecteur D7). Rejouer le meme etat ne produit
// rien : (detecteur, catalogue, cle) est unique. Aucun LLM. Premier passage : on amorce l'instantane sans evenement, sauf pour les
// entrees qui portent leur propre horodatage et datent de moins de 48 h.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, decodeEntities } from '../core/text.mjs';
import { extractEntities } from '../analyze/relevance.mjs';
import { dueNow } from './collect.mjs';

export const DETECTOR = 'D7';
export const FIRST_PASS_WINDOW_H = 48;
const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export function ensureWeakSchema(store) {
  store.db.exec(`
CREATE TABLE IF NOT EXISTS catalog_snapshots(catalog_id TEXT PRIMARY KEY, taken_at TEXT, n INTEGER, state_json TEXT, meta_json TEXT);
CREATE TABLE IF NOT EXISTS weak_signals(signal_id INTEGER PRIMARY KEY AUTOINCREMENT, detector TEXT NOT NULL, catalog_id TEXT, key TEXT NOT NULL, title TEXT, url TEXT, reason TEXT, entity TEXT, known_entity INTEGER, event_at TEXT, detected_at TEXT NOT NULL, raw_json TEXT, score REAL, shown INTEGER DEFAULT 0, UNIQUE(detector, catalog_id, key));
CREATE INDEX IF NOT EXISTS idx_ws_detected ON weak_signals(detected_at);
CREATE TABLE IF NOT EXISTS job_postings(board TEXT, job_id TEXT, title TEXT, department TEXT, team TEXT, location TEXT, published_at TEXT, url TEXT, first_seen_at TEXT, last_seen_at TEXT, PRIMARY KEY(board, job_id));
`);
}

// ---- Parseurs purs : chaque catalogue devient une liste d'entrees { key, title, url, event_at, entity?, extra? } ----

// OpenRouter : la page /stealth (HTML, robots.txt autorise) liste des modeles anonymes absents de /api/v1/models.
export function parseStealthPage(html) {
  const slugs = new Set();
  for (const m of String(html).matchAll(/href="\/stealth\/([a-z0-9][a-z0-9._-]*)"/gi)) slugs.add(m[1].toLowerCase());
  return [...slugs].map(s => ({ key: `stealth/${s}`, title: `OpenRouter stealth : ${s}`, url: `https://openrouter.ai/stealth/${s}`, event_at: null }));
}

// LiteLLM : cles du fichier de prix (identifiants Bedrock, Azure, Vertex, noms de code). openrouter/ deja couvert par la source E.
export function parseLiteLlmKeys(json) {
  return Object.keys(json ?? {}).filter(k => k !== 'sample_spec' && !k.startsWith('openrouter/')).map(k => ({ key: k, title: `LiteLLM : ${k}`, url: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json', event_at: null, extra: { provider: json[k]?.litellm_provider ?? null, mode: json[k]?.mode ?? null } }));
}

// Hugging Face : depots d'une organisation tries par creation ; un createdAt ancien a la premiere observation = passage en public.
export function parseHfOrg(json, org) {
  return (Array.isArray(json) ? json : []).filter(m => m.id).map(m => ({ key: m.id, title: m.id, url: `https://huggingface.co/${m.id}`, event_at: iso(m.createdAt), extra: { org, likes: m.likes ?? null, pipeline: m.pipeline_tag ?? null, private: m.private ?? false } }));
}

// GitHub : depots d'une organisation tries par creation, forks exclus.
export function parseGithubOrg(json, org) {
  return (Array.isArray(json) ? json : []).filter(r => r.full_name && !r.fork).map(r => ({ key: r.full_name, title: `${r.full_name}${r.description ? ': ' + r.description.slice(0, 120) : ''}`, url: r.html_url, event_at: iso(r.created_at), extra: { org, stars: r.stargazers_count ?? 0, language: r.language ?? null, pushed_at: r.pushed_at ?? null } }));
}

// Pull requests des moteurs d'inference : une PR qui ajoute un modele cite souvent son nom avant toute annonce.
const PR_GENERIC = new Set(['model', 'models', 'support', 'supports', 'supported', 'supporting', 'add', 'adds', 'added', 'adding', 'new', 'feature', 'features', 'bugfix', 'fix', 'fixes', 'core', 'cuda', 'rocm', 'cpu', 'gpu', 'tpu', 'xpu', 'npu', 'hpu', 'perf', 'misc', 'doc', 'docs', 'draft', 'wip', 'the', 'for', 'and', 'to', 'in', 'of', 'with', 'from', 'via', 'initial', 'implementation', 'implement', 'enable', 'enables', 'integration', 'integrate', 'loading', 'load', 'weights', 'weight', 'fp8', 'fp4', 'bf16', 'fp16', 'int4', 'int8', 'nvfp4', 'awq', 'gptq', 'quantization', 'quant', 'moe', 'vlm', 'llm', 'multimodal', 'vision', 'audio', 'speech', 'text', 'image', 'video', 'embedding', 'embeddings', 'reranker', 'rerank', 'tokenizer', 'backend', 'kernel', 'kernels', 'attention', 'cache', 'api', 'server', 'test', 'tests', 'ci', 'refactor', 'update', 'upgrade', 'bump', 'release', 'version', 'hf', 'transformers', 'vllm', 'sglang', 'ggml', 'gguf', 'convert', 'converter', 'conversion', 'config', 'configs', 'architecture', 'arch', 'family', 'series', 'variant', 'variants', 'base', 'instruct', 'chat', 'preview', 'experimental', 'prefill', 'decode', 'graph', 'graphs', 'mamba', 'hybrid', 'linear', 'sparse', 'dense', 'draft', 'backbone', 'lora', 'adapter', 'pipeline', 'parallel', 'tensor', 'expert', 'experts', 'router', 'routing', 'when', 'using', 'use', 'option', 'flag', 'mode', 'plugin', 'skill', 'agent', 'agents', 'windows', 'linux', 'macos', 'mac', 'metal', 'vulkan', 'sycl', 'opencl', 'openvino', 'onnx', 'tensorrt', 'triton', 'flash', 'flashinfer', 'xformers', 'torch', 'pytorch', 'jax', 'mlx', 'rfc', 'poc', 'part', 'step', 'stage', 'phase', 'v0', 'v1', 'v2', 'v3']);
export function modelAddFromTitle(title) {
  const t = String(title ?? '');
  if (!/\bmodels?\b|\barchitecture\b/i.test(t)) return null;
  if (!/\b(add|adds|added|adding|support|supports|supporting|introduce|introduces|introducing|implement|implements|implementing|enable|enables|enabling|initial|new model)\b/i.test(t)) return null;
  const cleaned = t.replace(/\[[^\]]*\]/g, ' ').replace(/[`"'“”():,;|/]/g, ' ');
  const toks = cleaned.split(/\s+/).map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.+-]+$/g, '')).filter(Boolean);
  const cands = [];
  toks.forEach((w, i) => {
    if (w.length < 3 || PR_GENERIC.has(w.toLowerCase())) return;
    if (i === 0 && /^[A-Z][a-z]+$/.test(w)) return; // « Add », « Support », « Preserve » : verbe en debut de titre, pas un modele
    if (/^[A-Z][A-Za-z0-9.+-]*$/.test(w) && /[A-Za-z]/.test(w)) cands.push(w);
  });
  if (!cands.length) return null;
  return { candidate: cands.slice(0, 2).join(' '), candidates: cands };
}
export function parseInferencePulls(json, repo, lex) {
  const out = [];
  for (const p of Array.isArray(json) ? json : []) {
    if (!p.number || !p.title || /\[bot\]$/i.test(p.user?.login ?? '')) continue;
    const m = modelAddFromTitle(p.title); if (!m) continue;
    const known = lex ? extractEntities(p.title, lex) : [];
    out.push({ key: `${repo}#${p.number}`, title: `${repo}#${p.number} ${p.title}`.slice(0, 300), url: p.html_url, event_at: iso(p.created_at), entity: m.candidate, extra: { repo, author: p.user?.login ?? null, candidate: m.candidate, known, labels: (p.labels ?? []).map(l => l.name).slice(0, 5) } });
  }
  return out;
}

// Sitemaps : seule l'apparition d'une URL compte (les lastmod d'openai.com sont regeneres a chaque lecture).
export function parseSitemap(xml) {
  const out = [];
  for (const b of String(xml).match(/<url[\s>][\s\S]*?<\/url>/gi) ?? []) {
    const loc = b.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1]; if (!loc) continue;
    const url = decodeEntities(loc); const segs = url.replace(/\/+$/, '').split('/'); const last = segs[segs.length - 1] || hostOf(url);
    out.push({ key: url, title: decodeURIComponent(last).replace(/[-_]+/g, ' '), url, event_at: null, extra: { lastmod: b.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1] ?? null } });
  }
  return out;
}

// Changelogs Markdown bruts (OpenAI : ## Mois, annee / ### Sep 15 / paragraphes ; Gemini et Claude : ## ou ### date / puces).
// Une entree = un paragraphe ou une puce sous un titre date. Cle = hachage du titre et du texte sans liens : stable d'une lecture a l'autre.
const DATEISH = /\b(20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|janv|fevr|mars|avr|mai|juin|juil|aout|octobre|novembre|decembre)\b/i;
export function parseChangelogMd(md) {
  const lines = String(md).replace(/^---[\s\S]*?\n---\n/, '').split('\n');
  const out = []; let h2 = '', h3 = ''; let buf = []; let inTag = false;
  const flush = () => {
    const text = buf.join(' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim(); buf = [];
    if (text.length < 20 || !(h2 || h3) || !DATEISH.test(`${h2} ${h3}`)) return;
    const heading = [h2, h3].filter(Boolean).join(' › ');
    out.push({ key: sha256(`${heading}|${text.toLowerCase()}`).slice(0, 20), title: `${heading} : ${text.slice(0, 160)}`, url: null, event_at: null, extra: { heading, text: text.slice(0, 500) } });
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*<\/?[A-Za-z]/.test(line)) { flush(); inTag = !/^\s*<\//.test(line) && !/\/>\s*$/.test(line); continue; }
    if (inTag) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); if (h[1].length <= 2) { h2 = h[2].trim(); h3 = ''; } else h3 = h[2].trim(); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { flush(); buf.push(line.replace(/^\s*[-*+]\s+/, '')); continue; }
    if (!line.trim()) { flush(); continue; }
    buf.push(line.trim());
  }
  flush();
  return out;
}

// Statuspage (status.openai.com, status.anthropic.com) : un composant cree avant l'annonce d'un produit (Claude Cowork : 8 jours).
export function parseStatusComponents(json) {
  const page = json?.page?.url ?? null;
  return (json?.components ?? []).filter(c => c.id && c.name).map(c => ({ key: c.id, title: c.name, url: page, event_at: iso(c.created_at), extra: { group: !!c.group, group_id: c.group_id ?? null, status: c.status ?? null, description: c.description ?? null } }));
}

// ---- Sous-lot 5b : signaux entreprise ----

// SIRENE (recherche-entreprises.api.gouv.fr) : creation d'une entite francaise portant le nom d'un labo. Personnes physiques exclues
// (nature juridique 1000), nom filtre par expression reguliere sur le nom complet. Aucune donnee de dirigeant personne physique conservee.
export function parseSirene(json, { match, lab }) {
  const re = new RegExp(match, 'i');
  return (json?.results ?? []).filter(r => r.siren && r.nature_juridique !== '1000' && re.test(r.nom_complet ?? '')).map(r => ({
    key: r.siren, title: `${r.nom_complet} (SIREN ${r.siren})`, url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${r.siren}`, event_at: iso(r.date_creation),
    extra: { lab, commune: r.siege?.libelle_commune ?? null, activite: r.activite_principale ?? null, nature_juridique: r.nature_juridique ?? null, etat: r.etat_administratif ?? null, dirigeants_personnes_morales: (r.dirigeants ?? []).filter(d => d.type_dirigeant === 'personne morale').map(d => d.denomination).filter(Boolean).slice(0, 3) },
  }));
}

// Offres d'emploi : Ashby (jobs[]) et Greenhouse (/departments avec jobs). On rend les postes (historises dans job_postings) et les equipes (cles du catalogue).
export function parseAshbyJobs(json, board) {
  const jobs = (json?.jobs ?? []).filter(j => j.id && j.title && j.isListed !== false).map(j => ({ job_id: String(j.id), title: j.title, department: j.department ?? null, team: j.team ?? null, location: j.location ?? null, published_at: iso(j.publishedAt), url: j.jobUrl ?? null }));
  return { jobs, entries: teamEntries(jobs, board, `https://jobs.ashbyhq.com/${board}`) };
}
export function parseGreenhouseDepartments(json, board) {
  const jobs = [];
  for (const d of json?.departments ?? []) for (const j of d.jobs ?? []) if (j.id && j.title) jobs.push({ job_id: String(j.id), title: j.title, department: d.name ?? null, team: null, location: j.location?.name ?? null, published_at: iso(j.first_published ?? j.updated_at), url: j.absolute_url ?? null });
  return { jobs, entries: teamEntries(jobs, board, `https://job-boards.greenhouse.io/${board}`) };
}
function teamEntries(jobs, board, url) {
  const m = new Map();
  for (const j of jobs) { const k = [j.department, j.team].filter(Boolean).join(' / '); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(j.title); }
  return [...m.entries()].map(([k, titles]) => ({ key: `team:${k}`, title: k, url, event_at: null, extra: { board, n: titles.length, titles: titles.slice(0, 5) } }));
}

// EDGAR full-text search, Form D uniquement : les SPV nommes d'apres la cible apparaissent avant l'annonce d'un tour.
export function parseEdgar(json, query) {
  return (json?.hits?.hits ?? []).map(h => h._source ?? {}).filter(x => x.adsh).map(x => { const cik = (x.ciks ?? [])[0] ?? null; return { key: x.adsh, title: (x.display_names ?? [])[0] ?? x.adsh, url: cik ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${x.adsh.replace(/-/g, '')}/${x.adsh}-index.htm` : 'https://efts.sec.gov/LATEST/search-index?q=' + encodeURIComponent(query) + '&forms=D', event_at: iso(x.file_date), extra: { query, ciks: x.ciks ?? [], states: x.biz_states ?? [], form: x.form ?? 'D' } }; });
}

// Polymarket Gamma API : la creation d'un marche « quand sortira X » est l'alerte. Bloque en France, lu depuis le runner GitHub seulement.
export const POLY_AI = /\b(AI|A\.I\.|GPT[- ]?\d*|OpenAI|ChatGPT|Anthropic|Claude|Gemini|DeepMind|Grok|xAI|Llama|Meta AI|DeepSeek|Qwen|Mistral|Nvidia|AGI|LLM|Sora|Midjourney|Hugging Face|Perplexity|Cursor|Copilot|model release|open[- ]source model)\b/i;
export function parsePolymarketEvents(json) {
  return (Array.isArray(json) ? json : json?.events ?? []).filter(e => e.id && e.title && POLY_AI.test(e.title)).map(e => ({ key: `event:${e.id}`, title: e.title, url: e.slug ? `https://polymarket.com/event/${e.slug}` : 'https://polymarket.com', event_at: iso(e.createdAt ?? e.creationDate ?? e.startDate), extra: { markets: (e.markets ?? []).length, end: e.endDate ?? null, volume: e.volume ?? null } }));
}

// Discourse : categories.json, une nouvelle categorie produit est un evenement. Discord : widget public, salons de scene visibles.
export function parseDiscourseCategories(json, host) {
  return (json?.category_list?.categories ?? []).filter(c => c.id && c.name).map(c => ({ key: `cat:${c.id}`, title: c.name, url: `https://${host}/c/${c.slug ?? ''}/${c.id}`, event_at: null, extra: { topics: c.topic_count ?? null, description: (c.description_text ?? '').slice(0, 200) } }));
}
export function parseDiscordWidget(json, guildId) {
  return (json?.channels ?? []).filter(c => c.id && c.name).map(c => ({ key: `channel:${c.id}`, title: c.name, url: `https://discord.com/channels/${guildId}/${c.id}`, event_at: null, extra: { guild: json?.name ?? null, presence: json?.presence_count ?? null } }));
}

export function diffEntries(prevKeys, entries) { const prev = new Set(prevKeys ?? []); return entries.filter(e => !prev.has(e.key)); }

// ---- Chargement et lecture ----

export function loadCatalogs(root) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'catalogs.json'), 'utf8'));
  const labs = JSON.parse(fs.readFileSync(path.join(root, 'config', 'labs.json'), 'utf8'));
  const out = [...cfg.catalogs];
  for (const lab of labs.labs) {
    for (const org of lab.hf ?? []) out.push({ id: `hf_org_${org.toLowerCase()}`, type: 'hf_org', org, lab: lab.id, url: `https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=${labs.hf_limit ?? 20}`, every_min: labs.hf_every_min ?? 30 });
    for (const org of lab.github ?? []) out.push({ id: `gh_org_${org.toLowerCase()}`, type: 'github_org', org, lab: lab.id, url: `https://api.github.com/orgs/${org}/repos?sort=created&direction=desc&per_page=${labs.github_limit ?? 20}&type=public`, every_min: labs.github_every_min ?? 60 });
    if (lab.sirene) out.push({ id: `sirene_${lab.id}`, type: 'sirene', lab: lab.id, name: lab.name, match: lab.sirene.match, url: `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(lab.sirene.q)}&per_page=25`, every_min: labs.sirene_every_min ?? 120 });
    if (lab.ashby) out.push({ id: `jobs_ashby_${lab.id}`, type: 'ashby_jobs', lab: lab.id, name: lab.name, board: lab.ashby, url: `https://api.ashbyhq.com/posting-api/job-board/${lab.ashby}?includeCompensation=false`, every_min: labs.jobs_every_min ?? 120 });
    if (lab.greenhouse) out.push({ id: `jobs_greenhouse_${lab.id}`, type: 'greenhouse_jobs', lab: lab.id, name: lab.name, board: lab.greenhouse, url: `https://boards-api.greenhouse.io/v1/boards/${lab.greenhouse}/departments`, every_min: labs.jobs_every_min ?? 120 });
    if (lab.edgar) out.push({ id: `edgar_${lab.id}`, type: 'edgar_form_d', lab: lab.id, name: lab.name, query: lab.edgar, url: `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + lab.edgar + '"')}&forms=D`, every_min: labs.edgar_every_min ?? 60 });
  }
  return out;
}

async function fetchCatalog(cat, http, { secrets = {}, lex = null, prevMeta = null }) {
  const gh = { headers: { ...(secrets.GITHUB_TOKEN ? { Authorization: `Bearer ${secrets.GITHUB_TOKEN}` } : {}), Accept: 'application/vnd.github+json' } };
  const json = r => { try { return JSON.parse(r.body); } catch (e) { throw new Error(`PARSE ${e.message}`); } };
  switch (cat.type) {
    case 'openrouter_stealth': { const r = await http(cat.url, { api: false, accept: 'text/html' }); if (r.error) return { error: r.error }; return { entries: parseStealthPage(r.body) }; }
    case 'litellm_prices': {
      const c = await http(`https://api.github.com/repos/${cat.repo}/commits?path=${encodeURIComponent(cat.path)}&per_page=1`, gh); if (c.error) return { error: c.error };
      const last = json(c)[0]; const sha = last?.sha ?? null; const commitAt = iso(last?.commit?.committer?.date);
      if (sha && prevMeta?.sha === sha) return { unchanged: true };
      const r = await http(`https://raw.githubusercontent.com/${cat.repo}/${sha ?? 'main'}/${cat.path}`, { hostDelay: 0 }); if (r.error) return { error: r.error };
      return { entries: parseLiteLlmKeys(json(r)).map(e => ({ ...e, event_at: commitAt })), meta: { sha, commit_at: commitAt }, datedByCommit: true };
    }
    case 'hf_org': { const r = await http(cat.url); if (r.error) return { error: r.error }; return { entries: parseHfOrg(json(r), cat.org) }; }
    case 'github_org': { const r = await http(cat.url, gh); if (r.error) return { error: r.error }; return { entries: parseGithubOrg(json(r), cat.org) }; }
    case 'inference_pulls': { const r = await http(`https://api.github.com/repos/${cat.repo}/pulls?state=open&sort=created&direction=desc&per_page=${cat.limit ?? 50}`, gh); if (r.error) return { error: r.error }; return { entries: parseInferencePulls(json(r), cat.repo, lex) }; }
    case 'sitemap': { const r = await http(cat.url, { hostDelay: 1000, accept: 'application/xml, text/xml;q=0.9, */*;q=0.5' }); if (r.error) return { error: r.error }; return { entries: parseSitemap(r.body) }; }
    case 'changelog_md': { const r = await http(cat.url, { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5' }); if (r.error) return { error: r.error }; return { entries: parseChangelogMd(r.body) }; }
    case 'status_components': { const r = await http(cat.url); if (r.error) return { error: r.error }; return { entries: parseStatusComponents(json(r)) }; }
    case 'sirene': { const r = await http(cat.url, { hostDelay: 1000 }); if (r.error) return { error: r.error }; return { entries: parseSirene(json(r), { match: cat.match, lab: cat.lab }) }; }
    case 'ashby_jobs': { const r = await http(cat.url); if (r.error) return { error: r.error }; return parseAshbyJobs(json(r), cat.board); }
    case 'greenhouse_jobs': { const r = await http(cat.url); if (r.error) return { error: r.error }; return parseGreenhouseDepartments(json(r), cat.board); }
    case 'edgar_form_d': { const r = await http(cat.url, { headers: { 'User-Agent': 'ai-radar research simon.saulay@brevo.com' }, hostDelay: 1000 }); if (r.error) return { error: r.error }; return { entries: parseEdgar(json(r), cat.query) }; }
    case 'polymarket_events': {
      // deux lectures : les derniers evenements crees, et ceux etiquetes IA ; l'instantane garde des comptes bruts et des titres temoins
      // pour diagnostiquer le format depuis le runner (l'API est injoignable depuis la France).
      const urls = [cat.url, ...(cat.extra_urls ?? [])]; const all = []; const meta = { raw: [], sample: [] }; let errors = 0;
      for (const u of urls) { const r = await http(u); if (r.error) { errors++; meta.raw.push(r.error); continue; } let j; try { j = json(r); } catch { meta.raw.push('PARSE'); continue; } const arr = Array.isArray(j) ? j : j?.events ?? j?.data ?? []; meta.raw.push(arr.length); meta.sample.push(...arr.slice(0, 3).map(e => String(e.title ?? e.question ?? Object.keys(e).slice(0, 5).join(',')).slice(0, 80))); all.push(...arr); }
      if (errors === urls.length) return { error: String(meta.raw[0]) };
      const seen = new Set(); return { entries: parsePolymarketEvents(all).filter(e => { if (seen.has(e.key)) return false; seen.add(e.key); return true; }), meta };
    }
    case 'discourse_categories': { const r = await http(cat.url); if (r.error) return { error: r.error }; return { entries: parseDiscourseCategories(json(r), new URL(cat.url).hostname) }; }
    case 'discord_widget': { const r = await http(cat.url); if (r.error) return { error: r.error }; return { entries: parseDiscordWidget(json(r), cat.guild) }; }
    default: return { error: `UNKNOWN_TYPE ${cat.type}` };
  }
}

// Enrichissement des seules nouvelles entrees (peu nombreuses) : OpenRouter donne la date de creation et le nom du modele stealth.
async function enrich(cat, fresh, http) {
  if (cat.type !== 'openrouter_stealth') return;
  for (const e of fresh) {
    const r = await http(`https://openrouter.ai/api/v1/models/${e.key}/endpoints`); if (r.error) continue;
    try { const d = JSON.parse(r.body).data ?? {}; e.event_at = d.created ? iso(d.created * 1000) : e.event_at; e.title = d.name ? `OpenRouter stealth : ${d.name}` : e.title; e.extra = { ...(e.extra ?? {}), name: d.name ?? null, description: (d.description ?? '').slice(0, 300), providers: (d.endpoints ?? []).map(x => x.provider_name).slice(0, 5), context_length: d.context_length ?? null }; } catch {}
  }
}

const fmtDate = s => s ? s.slice(0, 10) : 'date inconnue';
const ageH = (s, now) => s ? Math.round((Date.parse(now) - Date.parse(s)) / 3600e3) : null;
export function describe(cat, e, { now, firstPass = false }) {
  const age = ageH(e.event_at, now); const older = age !== null && age > 24 * 3;
  const created = e.event_at ? (older ? `créé le ${fmtDate(e.event_at)}, rendu visible bien après sa création` : `créé il y a ${age} h`) : 'date de création inconnue';
  switch (cat.type) {
    case 'openrouter_stealth': return `Nouveau modèle stealth sur OpenRouter : ${e.extra?.name ?? e.key} (${e.key}), ${created}${e.extra?.providers?.length ? `, fournisseur ${e.extra.providers.join(', ')}` : ''}. Précédents : GPT-4.1 et GPT-5 listés 8 à 12 jours avant l'annonce.`;
    case 'litellm_prices': return `Nouvelle clé dans le fichier de prix LiteLLM : ${e.key}${e.extra?.provider ? ` (fournisseur ${e.extra.provider})` : ''}, commit du ${fmtDate(e.event_at)}. Précédent : stealth/union-alpha présent 16 h avant sa révélation.`;
    case 'hf_org': return `Nouveau dépôt Hugging Face de ${e.extra?.org ?? cat.org} : ${e.key}, ${created}${e.extra?.pipeline ? ` (${e.extra.pipeline})` : ''}. Précédents : Gemma 3 visible 11 jours avant l'annonce, gpt-oss-safeguard 41 jours.`;
    case 'github_org': return `Nouveau dépôt GitHub de ${e.extra?.org ?? cat.org} : ${e.key}, ${created}${e.extra?.language ? ` (${e.extra.language})` : ''}.`;
    case 'inference_pulls': return `PR d'inférence dans ${e.extra?.repo ?? cat.repo} ajoutant un modèle : ${e.extra?.candidate ?? e.entity}${e.extra?.known?.length ? ` (entité connue : ${e.extra.known.join(', ')})` : ' (nom inconnu du lexique)'}, ouverte le ${fmtDate(e.event_at)} par ${e.extra?.author ?? '?'}. Précédents : Qwen3 38 jours avant, DeepSeek V4 17 jours.`;
    case 'sitemap': return `Nouvelle URL dans le sitemap de ${hostOf(cat.url)} : ${e.url.replace(/^https?:\/\/[^/]+/, '')}${firstPass ? '' : ' (absente au passage précédent)'}.`;
    case 'changelog_md': return `Nouvelle entrée de changelog (${hostOf(cat.url)}) sous « ${e.extra?.heading ?? ''} » : ${(e.extra?.text ?? '').slice(0, 200)}`;
    case 'sirene': return `Nouvelle entité au registre SIRENE au nom de ${cat.name ?? cat.lab} : ${e.title}, créée le ${fmtDate(e.event_at)}${e.extra?.commune ? `, ${e.extra.commune}` : ''}${e.extra?.activite ? `, activité ${e.extra.activite}` : ''}. Précédents : Anthropic France créée 261 jours avant l'annonce du bureau, OpenAI France 41 jours.`;
    case 'ashby_jobs': case 'greenhouse_jobs': return e.key.startsWith('jobs:') ? `${e.extra.n} nouvelle(s) offre(s) chez ${cat.name ?? cat.lab} (${cat.type === 'ashby_jobs' ? 'Ashby' : 'Greenhouse'}) : ${e.extra.titles.map(t => `« ${t} »`).join(', ')}${e.extra.n > e.extra.titles.length ? ', ...' : ''}. Précédent : les offres robotique d'OpenAI ont précédé de 20 mois la confirmation publique.` : `Nouvelle équipe dans les offres de ${cat.name ?? cat.lab} : ${e.title} (${e.extra?.n ?? '?'} poste(s) : ${(e.extra?.titles ?? []).join(' ; ')}).`;
    case 'edgar_form_d': return `Dépôt SEC Form D mentionnant ${cat.name ?? cat.lab} : ${e.title}, déposé le ${fmtDate(e.event_at)}${e.extra?.states?.length ? ` (${e.extra.states.join(', ')})` : ''}. Précédents : SPV Thinking Machines déposé 18 jours avant l'annonce, xAI 19 jours.`;
    case 'polymarket_events': return `Nouveau marché Polymarket sur l'IA : ${e.title}, ${created}${e.extra?.markets ? ` (${e.extra.markets} question(s))` : ''}. Précédents : marché Gemini 3 ouvert 5 jours avant la sortie, GPT-5 3 jours.`;
    case 'discourse_categories': return `Nouvelle catégorie sur le forum ${hostOf(cat.url)} : ${e.title}${e.extra?.topics !== null && e.extra?.topics !== undefined ? ` (${e.extra.topics} sujets)` : ''}.`;
    case 'discord_widget': return `Nouveau salon visible dans le widget Discord de ${e.extra?.guild ?? cat.id} : ${e.title}.`;
    case 'status_components': return `Nouveau composant sur la page de statut ${hostOf(cat.url)} : ${e.title}${e.extra?.group ? ' (groupe)' : ''}, ${created}. Précédent : composant Claude Cowork créé 8 jours avant la disponibilité générale.`;
    default: return `Nouvelle entrée dans ${cat.id} : ${e.title}`;
  }
}

function ingestJobs(store, cat, jobs, { now, nowMs, firstPass }) {
  const board = `${cat.type === 'ashby_jobs' ? 'ashby' : 'greenhouse'}:${cat.board}`;
  const find = store.db.prepare('SELECT 1 FROM job_postings WHERE board=? AND job_id=?');
  const ins = store.db.prepare('INSERT OR IGNORE INTO job_postings(board,job_id,title,department,team,location,published_at,url,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const upd = store.db.prepare('UPDATE job_postings SET last_seen_at=?, title=? WHERE board=? AND job_id=?');
  const fresh = [];
  store.tx(() => { for (const j of jobs) { if (find.get(board, j.job_id)) upd.run(now, j.title, board, j.job_id); else { ins.run(board, j.job_id, j.title, j.department, j.team, j.location, j.published_at, j.url, now, now); fresh.push(j); } } });
  // a l'amorcage, seuls les postes publies depuis moins de 48 h comptent ; ensuite tout nouveau poste
  const kept = firstPass ? fresh.filter(j => j.published_at && nowMs - Date.parse(j.published_at) <= FIRST_PASS_WINDOW_H * 3600e3) : fresh;
  if (!kept.length) return null;
  const url = cat.type === 'ashby_jobs' ? `https://jobs.ashbyhq.com/${cat.board}` : `https://job-boards.greenhouse.io/${cat.board}`;
  return { key: `jobs:${now.slice(0, 16)}`, title: `${kept.length} nouvelle(s) offre(s) chez ${cat.name ?? cat.lab}`, url, event_at: now, extra: { board, n: kept.length, titles: kept.slice(0, 6).map(j => j.title + (j.team || j.department ? ` (${j.team ?? j.department})` : '')), total: jobs.length } };
}

export async function catalogAll(store, http, { root = null, catalogs = null, lex = null, secrets = {}, only = null, force = false, now = store.now(), log = console.log } = {}) {
  ensureWeakSchema(store);
  const cats = catalogs ?? loadCatalogs(root);
  const nowMs = Date.parse(now); const summary = []; const events = [];
  const insert = store.db.prepare('INSERT OR IGNORE INTO weak_signals(detector,catalog_id,key,title,url,reason,entity,known_entity,event_at,detected_at,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const cat of cats) {
    if (only && !only.includes(cat.id)) continue;
    if (!force && !dueNow(store, cat, now)) { summary.push({ catalog: cat.id, status: 'NOT_DUE' }); continue; }
    const t0 = Date.now();
    // Polymarket est bloque en France : lu depuis le runner GitHub Actions seulement
    if (cat.runner_only && process.env.GITHUB_ACTIONS !== 'true') { store.run('INSERT INTO source_runs(run_ts,source_id,status,items_seen,items_new,items_updated,ms,error) VALUES (?,?,?,?,?,?,?,?)', now, cat.id, 'SKIPPED', 0, 0, 0, 0, 'SKIPPED_RUNNER_ONLY'); summary.push({ catalog: cat.id, status: 'SKIPPED', error: 'SKIPPED_RUNNER_ONLY' }); continue; }
    const snap = store.get('SELECT * FROM catalog_snapshots WHERE catalog_id=?', cat.id);
    const prevMeta = snap?.meta_json ? JSON.parse(snap.meta_json) : null;
    let res; try { res = await fetchCatalog(cat, http, { secrets, lex, prevMeta }); } catch (e) { res = { error: `EXCEPTION ${e.message}` }; }
    if (res.error) {
      store.run('INSERT INTO source_runs(run_ts,source_id,status,items_seen,items_new,items_updated,ms,error) VALUES (?,?,?,?,?,?,?,?)', now, cat.id, 'ERROR', 0, 0, 0, Date.now() - t0, res.error.slice(0, 300));
      summary.push({ catalog: cat.id, status: 'ERROR', error: res.error.slice(0, 120) }); log(`  ${cat.id}: ${res.error.slice(0, 100)}`); continue;
    }
    if (res.unchanged) { store.run('INSERT INTO source_runs(run_ts,source_id,status,items_seen,items_new,items_updated,ms) VALUES (?,?,?,?,?,?,?)', now, cat.id, 'OK', snap?.n ?? 0, 0, 0, Date.now() - t0); summary.push({ catalog: cat.id, status: 'OK', seen: snap?.n ?? 0, new: 0, unchanged: true }); continue; }
    const entries = res.entries ?? [];
    const firstPass = !snap;
    let fresh = firstPass ? entries : diffEntries(JSON.parse(snap.state_json), entries);
    if (fresh.length) await enrich(cat, fresh, http);
    // offres d'emploi : historisees dans job_postings ; un seul evenement groupe par passage pour les nouveaux postes
    if (res.jobs) { const g = ingestJobs(store, cat, res.jobs, { now, nowMs, firstPass }); if (g) fresh.push(g); }
    // amorcage : seules les entrees portant leur propre horodatage recent sortent ; une date heritee du commit (LiteLLM) ne compte pas
    if (firstPass) fresh = res.datedByCommit ? [] : fresh.filter(e => e.event_at && nowMs - Date.parse(e.event_at) <= FIRST_PASS_WINDOW_H * 3600e3);
    let created = 0;
    store.tx(() => {
      for (const e of fresh) {
        const known = e.extra?.known ?? (lex ? extractEntities(`${e.title} ${e.key}`, lex) : []);
        const reason = describe(cat, e, { now, firstPass });
        const r = insert.run(DETECTOR, cat.id, e.key, (e.title ?? e.key).slice(0, 300), e.url ?? cat.url ?? null, reason.slice(0, 600), e.entity ?? known[0] ?? null, known.length ? 1 : 0, e.event_at ?? now, now, JSON.stringify({ type: cat.type, ...(e.extra ?? {}) }).slice(0, 2000));
        if (r.changes) { created++; events.push({ catalog: cat.id, key: e.key, event_at: e.event_at ?? now, reason }); }
      }
      store.run('INSERT OR REPLACE INTO catalog_snapshots(catalog_id,taken_at,n,state_json,meta_json) VALUES (?,?,?,?,?)', cat.id, now, entries.length, JSON.stringify(entries.map(e => e.key)), JSON.stringify(res.meta ?? prevMeta ?? {}));
      store.run('INSERT INTO source_runs(run_ts,source_id,status,items_seen,items_new,items_updated,ms) VALUES (?,?,?,?,?,?,?)', now, cat.id, 'OK', entries.length, created, 0, Date.now() - t0);
    });
    summary.push({ catalog: cat.id, status: 'OK', seen: entries.length, new: created, first_pass: firstPass });
    log(`  ${cat.id}: ${entries.length} entrées${firstPass ? ' (amorçage)' : ''}, ${created} événement(s)`);
  }
  const ok = summary.filter(s => s.status === 'OK');
  return { now, summary, events, stats: { catalogs_ok: ok.length, catalogs_error: summary.filter(s => s.status === 'ERROR').length, catalogs_not_due: summary.filter(s => s.status === 'NOT_DUE').length, events: events.length, first_pass: ok.filter(s => s.first_pass).length } };
}
