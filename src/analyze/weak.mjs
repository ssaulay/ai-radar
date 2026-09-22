// Signaux faibles (lot 5c) : detecteurs sans LLM sur les nouveaux items, tables incrementales de termes, de paires et de vocabulaire
// par source, credibilite bayesienne par source, score et budget journalier. Vue separee : rien ici ne touche au score du radar.
// Chaque signal a une raison lisible et renvoie a son item. Mode fantome : rien n'est affiche avant l'etiquetage a 72 h (5d).
import fs from 'node:fs';
import path from 'node:path';
import { extractEntities } from './relevance.mjs';
import { cosine, fromBlob } from '../core/embed.mjs';
import { ensureWeakSchema } from '../collect/catalog.mjs';

// Priors de credibilite par famille (plan 10.3) : labos et pages release 0,7 ; HN 0,5 ; arXiv 0,4 ; agregateurs et newsletters 0,3 ; communautes 0,35.
export const FAMILY_PRIOR = { A: 0.3, B: 0.35, C: 0.35, D: 0.4, E: 0.5, F: 0.3, H: 0.4 };
export const PRIOR_STRENGTH = 8; // Beta(prior*8, (1-prior)*8) : huit observations valent le prior
export const DAILY_BUDGET = 20, COOLDOWN_H = 72, TERM_WINDOW_D = 30, VOCAB_WINDOW_D = 90, ERLANG_P = 1e-4, LABEL_AFTER_H = 72;
// « jamais vu » suppose un passe : D2 (termes) et D3 (paires) attendent 7 jours de corpus ; D6 attend 200 valeurs et 10 points au moins
export const D2_MIN_DAYS = 7, D3_MIN_DAYS = 7, D6_MIN_SAMPLES = 200, D6_MIN_POINTS = 10, D1_MIN_SAMPLES = 200;
const day = iso => iso.slice(0, 10);
const hours = (a, b) => (Date.parse(a) - Date.parse(b)) / 3600e3;

export function ensureWeakAnalysisSchema(store) {
  ensureWeakSchema(store);
  store.db.exec(`
CREATE TABLE IF NOT EXISTS term_daily(term TEXT, day TEXT, n INTEGER, families TEXT, sources TEXT, PRIMARY KEY(term, day));
CREATE TABLE IF NOT EXISTS term_last_ts(term TEXT PRIMARY KEY, first_ts TEXT, last_ts TEXT, n INTEGER, recent_json TEXT);
CREATE TABLE IF NOT EXISTS source_vocab(source_id TEXT, term TEXT, first_ts TEXT, last_ts TEXT, n INTEGER, PRIMARY KEY(source_id, term));
CREATE TABLE IF NOT EXISTS entity_mentions(entity TEXT, day TEXT, n INTEGER, PRIMARY KEY(entity, day));
CREATE TABLE IF NOT EXISTS entity_pairs(a TEXT, b TEXT, first_ts TEXT, last_ts TEXT, n INTEGER, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS source_stats(source_id TEXT PRIMARY KEY, first_seen_at TEXT, flagged INTEGER DEFAULT 0, confirmed INTEGER DEFAULT 0, leads_json TEXT, credibility REAL, precocity REAL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS weak_signal_outcomes(signal_id INTEGER PRIMARY KEY, labeled_at TEXT, outcome TEXT, via TEXT, lead_h REAL, cluster_id INTEGER);
CREATE TABLE IF NOT EXISTS cluster_popularity(cluster_id INTEGER, day TEXT, pop REAL, PRIMARY KEY(cluster_id, day));
CREATE TABLE IF NOT EXISTS weak_values(detector TEXT, ts TEXT, item_id INTEGER, value REAL);
CREATE INDEX IF NOT EXISTS idx_wv ON weak_values(detector, ts);
CREATE TABLE IF NOT EXISTS weak_runs(ts TEXT PRIMARY KEY, items INTEGER, signals INTEGER, selected INTEGER, stats_json TEXT);
CREATE TABLE IF NOT EXISTS weak_selection(day TEXT, signal_id INTEGER, rank INTEGER, score REAL, PRIMARY KEY(day, signal_id));
`);
  for (const col of ['cluster_id INTEGER', 'item_id INTEGER', 'families TEXT', 'bits REAL', 'credibility REAL', 'source_id TEXT']) { try { store.db.exec(`ALTER TABLE weak_signals ADD COLUMN ${col}`); } catch {} }
}

// ---- Termes : noms propres des titres (mots capitalises, sigles, versions) et bigrammes de noms propres consecutifs ; entites du lexique prefixees @ ----
const GENERIC = new Set(['the', 'this', 'that', 'these', 'those', 'new', 'how', 'why', 'what', 'when', 'where', 'who', 'which', 'show', 'ask', 'tell', 'launch', 'introducing', 'announcing', 'meet', 'inside', 'here', 'there', 'from', 'with', 'and', 'for', 'but', 'not', 'you', 'your', 'our', 'its', 'all', 'any', 'one', 'two', 'first', 'last', 'next', 'best', 'top', 'more', 'most', 'less', 'just', 'now', 'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'sources', 'source', 'report', 'reports', 'exclusive', 'breaking', 'opinion', 'analysis', 'review', 'update', 'updates', 'release', 'releases', 'released', 'introduces', 'launches', 'unveils', 'announces', 'says', 'said', 'llm', 'llms', 'model', 'models', 'agent', 'agents', 'agentic', 'api', 'sdk', 'app', 'apps', 'web', 'open', 'source', 'free', 'paper', 'papers', 'arxiv', 'github', 'video', 'thread', 'pdf', 'part', 'guide', 'tutorial', 'lessons', 'notes', 'why', 'using', 'use', 'build', 'building', 'built', 'make', 'making', 'get', 'getting', 'run', 'running', 'stop', 'start', 'after', 'before', 'over', 'under', 'into', 'about', 'against', 'between', 'through', 'without', 'within', 'ceo', 'cto', 'vp', 'chief', 'president', 'prime', 'minister', 'senator', 'governor', 'judge', 'court', 'house', 'senate', 'congress', 'white', 'black', 'red', 'blue', 'green', 'big', 'small', 'high', 'low', 'long', 'short', 'real', 'full', 'good', 'bad', 'great', 'super', 'pro', 'max', 'mini', 'plus', 'ultra', 'lite', 'flash', 'beta', 'alpha', 'preview', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'usa', 'eu', 'uk', 'us', 'un', 'ai', 'ia', 'ml', 'nlp', 'gpu', 'gpus', 'cpu', 'tpu', 'saas', 'b2b', 'ipo', 'ceo', 'faq', 'diy', 'rfc', 'poc', 'mvp', 'ok', 'hn', 'pm', 'am', 'utc', 'et', 'pt', 'q1', 'q2', 'q3', 'q4', 'et', 'la', 'le', 'les', 'des', 'une', 'pour', 'avec', 'sur', 'dans', 'chez', 'vers', 'comment', 'pourquoi', 'quand', 'selon', 'après', 'avant', 'apres', 'contre', 'entre', 'sans', 'sous', 'mais', 'donc', 'car', 'cette', 'ces', 'son', 'ses', 'leur', 'leurs', 'notre', 'nos', 'votre', 'vos', 'exclusif', 'enquête', 'enquete', 'tribune', 'chronique', 'décryptage', 'decryptage', 'entretien', 'interview', 'live', 'direct', 'edito', 'édito', 'data', 'every', 'everyone', 'everything', 'nothing', 'something', 'anyone', 'someone', 'people', 'humans', 'human', 'world', 'life', 'time', 'work', 'jobs', 'job', 'money', 'business', 'company', 'companies', 'startup', 'startups', 'founder', 'founders', 'engineer', 'engineers', 'developer', 'developers', 'devs', 'software', 'hardware', 'chip', 'chips', 'robot', 'robots', 'robotics', 'car', 'cars', 'energy', 'power', 'bank', 'banks', 'market', 'markets', 'stock', 'stocks', 'tech', 'technology', 'digital', 'cloud', 'security', 'privacy', 'health', 'medical', 'medicine', 'law', 'legal', 'policy', 'politics', 'government', 'state', 'states', 'city', 'country', 'national', 'global', 'international', 'american', 'americans', 'european', 'europeans', 'chinese', 'french', 'british', 'german', 'indian', 'japanese', 'korean', 'china', 'europe', 'america', 'france', 'germany', 'india', 'japan', 'korea', 'russia', 'canada', 'australia', 'israel', 'taiwan', 'california', 'texas', 'york', 'london', 'paris', 'berlin', 'tokyo', 'beijing', 'shanghai', 'washington', 'boston', 'seattle', 'austin', 'valley', 'silicon', 'windows', 'linux', 'macos', 'android', 'ios', 'iphone', 'ipad', 'chrome', 'firefox', 'safari', 'python', 'rust', 'java', 'javascript', 'typescript', 'golang', 'swift', 'kotlin', 'ruby', 'php', 'sql', 'html', 'css', 'json', 'yaml', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'code', 'coding', 'programming', 'programmers', 'science', 'scientists', 'research', 'researchers', 'study', 'students', 'university', 'school', 'college', 'internet', 'online', 'email', 'search', 'browser', 'phone', 'phones', 'laptop', 'computer', 'computers', 'computing', 'quantum', 'space', 'nasa', 'dna', 'brain', 'climate', 'nuclear', 'solar', 'electric', 'vision', 'voice', 'audio', 'music', 'image', 'images', 'photo', 'photos', 'text', 'chat', 'chatbot', 'chatbots', 'assistant', 'assistants', 'copilot', 'agentic', 'reasoning', 'thinking', 'learning', 'training', 'inference', 'benchmark', 'benchmarks', 'dataset', 'datasets', 'weights', 'tokens', 'context', 'memory', 'compute', 'cluster', 'datacenter', 'datacenters', 'server', 'servers', 'terminal', 'shell', 'editor', 'plugin', 'plugins', 'extension', 'library', 'framework', 'tool', 'tools', 'product', 'products', 'platform', 'service', 'services', 'feature', 'features', 'version', 'edition', 'series', 'season', 'episode', 'weekly', 'daily', 'monthly', 'annual', 'summer', 'winter', 'spring', 'fall', 'autumn', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'dear', 'hello', 'hi', 'thanks', 'thank', 'welcome', 'please', 'help', 'question', 'questions', 'answer', 'answers', 'idea', 'ideas', 'thoughts', 'tips', 'tricks', 'lessons', 'mistakes', 'problems', 'problem', 'solution', 'solutions', 'story', 'stories', 'history', 'future', 'past', 'present', 'end', 'beginning', 'rise', 'fall', 'death', 'birth', 'war', 'peace', 'love', 'hate', 'truth', 'lies', 'fact', 'facts', 'myth', 'myths', 'reality', 'dream', 'dreams', 'nightmare', 'hype', 'bubble', 'boom', 'bust', 'crash', 'crisis', 'revolution', 'evolution', 'age', 'era', 'century', 'decade']);
// Titres en Title Case (arXiv, une partie de la presse) : chaque mot est capitalise, donc seuls les jetons de type nom de modele
// (chiffre, majuscule interne, sigle, trait d'union) sont retenus ; sinon les mots capitalises ordinaires comptent.
export const MODEL_LIKE = /\d|[a-z][A-Z]|^[A-Z0-9][A-Z0-9.+-]{2,}$|-/;
export function properNouns(title, lex) {
  const toks = String(title ?? '').replace(/[“”"'’():,;|[\]{}!?]/g, ' ').replace(/\s[-–—]\s/g, ' ').split(/\s+/).map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.+-]+$/g, '')).filter(Boolean);
  const words = toks.filter(w => /^[A-Za-z]/.test(w)); const capRatio = words.length ? words.filter(w => /^[A-Z]/.test(w)).length / words.length : 0;
  const titleCase = words.length >= 4 && capRatio >= 0.6;
  const out = []; let prev = null;
  for (const w of toks) {
    const cap = /^[A-Z][A-Za-z0-9.+-]{2,}$/.test(w) || /^[A-Z0-9][A-Z0-9.+-]{2,}$/.test(w) && /[A-Z]/.test(w);
    const ok = cap && !/^\d+[.,]?\d*[A-Za-z]{0,2}$/.test(w) && !lex.stop.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase()) && (!titleCase || MODEL_LIKE.test(w));
    if (ok) { out.push(w); if (prev) out.push(`${prev} ${w}`); prev = w; } else prev = null;
  }
  return [...new Set(out)];
}
export const itemTerms = (title, lex) => ({ proper: properNouns(title, lex), entities: extractEntities(title, lex) });

// ---- Credibilite et precocite par source ----
let SRC_META = null;
export function loadSourceMeta(root) { if (!root) return new Map(); if (!SRC_META) { try { const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'sources.json'), 'utf8')); SRC_META = new Map(cfg.sources.map(s => [s.id, s])); } catch { SRC_META = new Map(); } } return SRC_META; }
export function priorCredibility(sourceId, family, meta = new Map()) {
  const m = meta.get(sourceId); if (m?.official) return 0.7; if (sourceId?.startsWith('hn_')) return 0.5; return FAMILY_PRIOR[family] ?? 0.3;
}
export function credibility(store, sourceId, family, meta) {
  const row = store.get('SELECT credibility, precocity FROM source_stats WHERE source_id=?', sourceId);
  return { cred: row?.credibility ?? priorCredibility(sourceId, family, meta), prec: row?.precocity ?? null };
}

// ---- Statistiques ----
export const poissonTail3 = mu => Math.max(0, 1 - Math.exp(-mu) * (1 + mu + mu * mu / 2)); // P(Poisson(mu) >= 3)
export function percentile(values, p) { if (!values.length) return null; const v = [...values].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; }
// Adamic-Adar entre deux entites : somme sur les voisins communs de 1/ln(degre) ; grand = paire predite par le voisinage, pas un signal
export function adamicAdar(store, a, b) {
  const nb = e => new Set(store.all('SELECT a x, b y FROM entity_pairs WHERE a=? OR b=?', e, e).map(r => r.x === e ? r.y : r.x));
  const na = nb(a), nbb = nb(b); let s = 0;
  for (const z of na) if (nbb.has(z)) { const deg = nb(z).size; if (deg > 1) s += 1 / Math.log(deg); }
  return s;
}

// ---- Passage ----
export function weakPass(store, lex, { now = store.now(), root = null, log = console.log, backfillDays = 14, detectHours = 6 } = {}) {
  ensureWeakAnalysisSchema(store);
  const meta = loadSourceMeta(root); const nowMs = Date.parse(now);
  const last = store.get('SELECT MAX(ts) ts FROM weak_runs')?.ts; const firstPass = !last;
  const since = last ?? new Date(nowMs - backfillDays * 864e5).toISOString();
  const detectSince = firstPass ? new Date(nowMs - detectHours * 3600e3).toISOString() : since;
  const items = store.all("SELECT i.item_id, i.source_id, i.family, i.title, i.url, i.first_seen_at, i.evt_at, i.score_raw, ci.cluster_id FROM items i LEFT JOIN cluster_items ci ON ci.item_id=i.item_id WHERE i.relevant=1 AND i.family<>'G' AND i.first_seen_at > ? AND i.first_seen_at <= ? ORDER BY i.first_seen_at", since, now);
  const corpusStart = store.get('SELECT MIN(first_seen_at) t FROM items')?.t ?? now;
  const daysObserved = Math.max(1, hours(now, corpusStart) / 24);
  const sig = []; const counts = {};
  const emit = (detector, ns, key, it, reason, bits, extra = {}) => { sig.push({ detector, catalog_id: ns, key, item: it, reason, bits, ...extra }); counts[detector] = (counts[detector] ?? 0) + 1; };

  // corpus d'embeddings pour D1 (items anterieurs), charge une fois, 60 000 produits scalaires par item au plus
  const emb = new Map(store.all('SELECT e.item_id, e.vec, i.first_seen_at FROM embeddings e JOIN items i ON i.item_id=e.item_id ORDER BY i.first_seen_at').map(r => [r.item_id, { v: fromBlob(r.vec), t: r.first_seen_at }]));
  const corpus = [...emb.values()];
  const prevValues = det => store.all('SELECT value FROM weak_values WHERE detector=? AND ts >= ?', det, new Date(nowMs - 14 * 864e5).toISOString()).map(r => r.value);
  const d1Hist = prevValues('D1'), d6Hist = prevValues('D6');

  const upTermDaily = store.db.prepare('INSERT INTO term_daily(term,day,n,families,sources) VALUES (?,?,1,?,?) ON CONFLICT(term,day) DO UPDATE SET n=n+1, families=?, sources=?');
  const getTD = store.db.prepare('SELECT families, sources FROM term_daily WHERE term=? AND day=?');
  const getTL = store.db.prepare('SELECT * FROM term_last_ts WHERE term=?');
  const upTL = store.db.prepare('INSERT INTO term_last_ts(term,first_ts,last_ts,n,recent_json) VALUES (?,?,?,1,?) ON CONFLICT(term) DO UPDATE SET last_ts=?, n=n+1, recent_json=?');
  const getSV = store.db.prepare('SELECT 1 FROM source_vocab WHERE source_id=? AND term=?');
  const upSV = store.db.prepare('INSERT INTO source_vocab(source_id,term,first_ts,last_ts,n) VALUES (?,?,?,?,1) ON CONFLICT(source_id,term) DO UPDATE SET last_ts=?, n=n+1');
  const upEM = store.db.prepare('INSERT INTO entity_mentions(entity,day,n) VALUES (?,?,1) ON CONFLICT(entity,day) DO UPDATE SET n=n+1');
  const getEP = store.db.prepare('SELECT n FROM entity_pairs WHERE a=? AND b=?');
  const upEP = store.db.prepare('INSERT INTO entity_pairs(a,b,first_ts,last_ts,n) VALUES (?,?,?,?,1) ON CONFLICT(a,b) DO UPDATE SET last_ts=?, n=n+1');
  const insVal = store.db.prepare('INSERT INTO weak_values(detector,ts,item_id,value) VALUES (?,?,?,?)');
  const srcFirst = store.db.prepare('INSERT INTO source_stats(source_id,first_seen_at,updated_at) VALUES (?,?,?) ON CONFLICT(source_id) DO NOTHING');
  const mentions30 = store.db.prepare('SELECT COALESCE(SUM(n),0) n FROM entity_mentions WHERE entity=? AND day >= ?');
  const totalMentions = () => store.get('SELECT COALESCE(SUM(n),0) n FROM entity_mentions WHERE day >= ?', day(new Date(nowMs - 30 * 864e5).toISOString())).n;

  store.tx(() => {
    for (const it of items) {
      const ts = it.first_seen_at; const d = day(ts); const detect = ts >= detectSince;
      const { cred, prec } = credibility(store, it.source_id, it.family, meta);
      srcFirst.run(it.source_id, ts, now);
      const { proper, entities } = itemTerms(it.title, lex);
      const srcDays = Math.max(0, hours(now, store.get('SELECT first_seen_at FROM source_stats WHERE source_id=?', it.source_id)?.first_seen_at ?? ts) / 24);
      // D2 et D4 sur les noms propres hors lexique
      for (const term of proper) {
        const known = entities.some(e => term.toLowerCase().includes(e.toLowerCase()));
        const tl = getTL.get(term);
        const td = getTD.get(term, d); const fams = new Set(td ? JSON.parse(td.families) : []); fams.add(it.family); const srcs = new Set(td ? JSON.parse(td.sources) : []); srcs.add(it.source_id);
        upTermDaily.run(term, d, JSON.stringify([...fams]), JSON.stringify([...srcs]), JSON.stringify([...fams]), JSON.stringify([...srcs]));
        const recent = tl ? JSON.parse(tl.recent_json ?? '[]') : []; recent.push({ ts, f: it.family, s: it.source_id, c: cred, id: it.item_id }); while (recent.length > 6) recent.shift();
        upTL.run(term, ts, ts, JSON.stringify(recent), ts, JSON.stringify(recent));
        if (detect && !known && daysObserved >= D2_MIN_DAYS) {
          // jamais vu : premiere apparition du terme depuis moins de 48 h (term_last_ts garde 30 jours, donc un terme deja present est connu)
          const isNew = !tl || hours(ts, tl.first_ts) <= 48; const firstDay = day(tl?.first_ts ?? ts);
          if (isNew) {
            const r3 = recent.slice(-3);
            if (r3.length >= 3) {
              const span = Math.max(1 / 24, hours(r3[2].ts, r3[0].ts) / 24); const mu = (3 / daysObserved) * span; const p = poissonTail3(mu);
              if (p < ERLANG_P) emit('D2', 'term', `${term}|${firstDay}`, it, `Terme jamais vu « ${term} » : ${recent.length} mentions dont 3 en ${(span * 24).toFixed(1)} h, alors qu'aucune n'était apparue en ${Math.round(daysObserved)} jours de corpus (test d'Erlang, p = ${p.toExponential(1)}). Familles : ${[...new Set(recent.map(x => x.f))].join(', ')}. Dernier titre : « ${(it.title ?? '').slice(0, 100)} ».`, Math.min(20, -Math.log2(Math.max(p, 1e-12))), { families: [...new Set(recent.map(x => x.f))], entity: term });
            }
            const in24 = recent.filter(x => hours(ts, x.ts) <= 24); const fams24 = new Set(in24.map(x => x.f));
            if (fams24.size >= 2 && in24.reduce((a, x) => a + x.c, 0) / in24.length >= 0.5) emit('D2', 'term', `${term}|${firstDay}`, it, `Terme jamais vu « ${term} » repris par ${fams24.size} familles indépendantes en 24 h (${[...fams24].join(', ')}), crédibilité moyenne ${(in24.reduce((a, x) => a + x.c, 0) / in24.length).toFixed(2)} ; aucune mention auparavant en ${Math.round(daysObserved)} jours. Dernier titre : « ${(it.title ?? '').slice(0, 100)} ».`, 6, { families: [...fams24], entity: term });
          }
        }
        if (detect && cred >= 0.6 && srcDays >= 7 && !getSV.get(it.source_id, term) && !known) emit('D4', `vocab:${it.source_id}`, term, it, `Vocabulaire nouveau pour une source crédible : « ${term} » n'était jamais apparu chez ${it.source_id} (crédibilité ${cred.toFixed(2)}, ${Math.round(srcDays)} jours observés). Titre : « ${(it.title ?? '').slice(0, 100)} ».`, Math.log2(1 + srcDays), { entity: term });
        if (cred >= 0.6) upSV.run(it.source_id, term, ts, ts, ts);
      }
      // D3 : paire d'entites connues jamais vue, non predite par les voisins communs
      const ents = [...new Set(entities)].sort();
      for (const e of ents) upEM.run(e, d);
      const from30 = day(new Date(nowMs - 30 * 864e5).toISOString());
      for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
        const a = ents[i], b = ents[j]; const existed = getEP.get(a, b);
        if (detect && !existed && daysObserved >= D3_MIN_DAYS) {
          const na = mentions30.get(a, from30).n, nb = mentions30.get(b, from30).n;
          if (na >= 5 && nb >= 5) {
            const N = Math.max(1, totalMentions()); const surprise = Math.log2((N * N) / Math.max(1, na * nb)); const aa = adamicAdar(store, a, b);
            if (aa < 1 && surprise >= 3) emit('D3', 'pair', `${a}|${b}`, it, `Paire d'entités inédite : « ${a} » et « ${b} » (${na} et ${nb} mentions sur 30 jours) jamais citées ensemble, et non prédite par leurs voisins communs (Adamic-Adar ${aa.toFixed(2)}). Surprise ${surprise.toFixed(1)} bits.`, surprise / (1 + aa), { entity: `${a} + ${b}` });
          }
        }
        upEP.run(a, b, ts, ts, ts);
      }
      // D5 : item isole d'une source precoce
      if (detect && prec !== null && cred * prec >= 0.6) { const n = it.cluster_id ? store.get('SELECT n FROM clusters WHERE cluster_id=?', it.cluster_id)?.n ?? 1 : 1; if (n <= 1) emit('D5', 'isolated', String(it.item_id), it, `Item isolé d'une source précoce : ${it.source_id} (crédibilité ${cred.toFixed(2)}, précocité ${prec.toFixed(2)}) publie seul un sujet que personne d'autre ne relaie encore : « ${(it.title ?? '').slice(0, 100)} ».`, 4, { entity: entities[0] ?? proper[0] ?? null }); }
      // D6 : nouveautes HN, points / (age + 2)^1.8 sur les items de moins de 2 h a l'observation
      if (it.source_id.startsWith('hn_') && it.evt_at && (it.score_raw ?? 0) > 0) {
        const age = hours(ts, it.evt_at);
        if (age >= 0 && age <= 2) { const v = (it.score_raw ?? 0) / Math.pow(age + 2, 1.8); insVal.run('D6', ts, it.item_id, v); const p95 = d6Hist.length >= D6_MIN_SAMPLES ? percentile(d6Hist, 0.95) : null; if (detect && p95 !== null && v >= p95 && (it.score_raw ?? 0) >= D6_MIN_POINTS) emit('D6', 'hn', String(it.item_id), it, `Nouveauté Hacker News au-dessus du 95e percentile : « ${(it.title ?? '').slice(0, 100)} », ${it.score_raw} points en ${age.toFixed(1)} h (indice ${v.toFixed(2)}, seuil ${p95.toFixed(2)} sur ${d6Hist.length} valeurs de 14 jours).`, 4 + 4 * Math.log2(v / Math.max(p95, 1e-6)), { entity: entities[0] ?? proper[0] ?? null }); d6Hist.push(v); }
      }
      // D1 : nouveaute semantique = 1 - max cos contre le corpus anterieur
      const e = emb.get(it.item_id);
      if (e) {
        let best = -1, n = 0; for (const c of corpus) { if (c.t >= ts) break; const s = cosine(e.v, c.v); if (s > best) best = s; if (++n >= 60000) break; }
        if (n >= 200) { const nov = 1 - best; insVal.run('D1', ts, it.item_id, nov); const p97 = d1Hist.length >= D1_MIN_SAMPLES ? percentile(d1Hist, 0.97) : null; if (detect && p97 !== null && nov >= p97) emit('D1', 'novelty', String(it.item_id), it, `Nouveauté sémantique : « ${(it.title ?? '').slice(0, 100)} » ne ressemble à rien du corpus (similarité maximale ${best.toFixed(2)} sur ${n} items, nouveauté ${nov.toFixed(2)} au-dessus du 97e percentile ${p97.toFixed(2)}).`, 4 + 8 * (nov - p97) / Math.max(1e-6, 1 - p97), { entity: entities[0] ?? proper[0] ?? null }); d1Hist.push(nov); }
      }
    }
  });

  // insertion des signaux avec score = bits x credibilite x (0,5 + precocite) x diversite des familles
  const ins = store.db.prepare('INSERT OR IGNORE INTO weak_signals(detector,catalog_id,key,title,url,reason,entity,known_entity,event_at,detected_at,raw_json,score,item_id,cluster_id,families,bits,credibility,source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let inserted = 0;
  store.tx(() => {
    for (const s of sig) {
      const it = s.item; const { cred, prec } = credibility(store, it.source_id, it.family, meta);
      const fams = s.families ?? [it.family]; const score = s.bits * cred * (0.5 + (prec ?? 0)) * Math.max(1, fams.length);
      const r = ins.run(s.detector, s.catalog_id, s.key, (it.title ?? '').slice(0, 300), it.url, s.reason.slice(0, 600), s.entity ?? null, extractEntities(it.title, lex).length ? 1 : 0, it.first_seen_at, now, JSON.stringify({ source: it.source_id, family: it.family }), Number(score.toFixed(3)), it.item_id, it.cluster_id ?? null, fams.join(''), Number(s.bits.toFixed(3)), cred, it.source_id);
      if (r.changes) inserted++;
    }
    // D7 (catalogues) detectes depuis le dernier passage : score avec les memes facteurs, credibilite 0,7 (sources officielles), diversite 1
    for (const w of store.all("SELECT signal_id, raw_json, bits FROM weak_signals WHERE detector='D7' AND score IS NULL")) { const t = JSON.parse(w.raw_json ?? '{}').type; const bits = D7_BITS[t] ?? 4; store.run('UPDATE weak_signals SET score=?, bits=?, credibility=0.7 WHERE signal_id=?', Number((bits * 0.7 * 0.5).toFixed(3)), bits, w.signal_id); }
    // purges : termes et valeurs au-dela des fenetres
    store.run('DELETE FROM term_daily WHERE day < ?', day(new Date(nowMs - TERM_WINDOW_D * 864e5).toISOString()));
    store.run('DELETE FROM term_last_ts WHERE last_ts < ?', new Date(nowMs - TERM_WINDOW_D * 864e5).toISOString());
    store.run('DELETE FROM term_last_ts WHERE n = 1 AND last_ts < ?', new Date(nowMs - 14 * 864e5).toISOString());
    store.run('DELETE FROM source_vocab WHERE last_ts < ?', new Date(nowMs - VOCAB_WINDOW_D * 864e5).toISOString());
    store.run('DELETE FROM entity_mentions WHERE day < ?', day(new Date(nowMs - 30 * 864e5).toISOString()));
    store.run('DELETE FROM weak_values WHERE ts < ?', new Date(nowMs - 14 * 864e5).toISOString());
  });
  const daily = dailyPass(store, { now });
  const labels = labelOutcomes(store, { now });
  const selected = selectBudget(store, { now });
  const stats = { items: items.length, first_pass: firstPass, days_observed: Number(daysObserved.toFixed(1)), d2_active: daysObserved >= D2_MIN_DAYS, d3_active: daysObserved >= D3_MIN_DAYS, detected: counts, inserted, selected: selected.length, daily, labels };
  store.run('INSERT OR REPLACE INTO weak_runs(ts,items,signals,selected,stats_json) VALUES (?,?,?,?,?)', now, items.length, inserted, selected.length, JSON.stringify(stats));
  log(`  signaux faibles : ${items.length} items, ${inserted} signaux (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'aucun'}), ${selected.length} retenus aujourd'hui`);
  return { stats, selected };
}
const D7_BITS = { openrouter_stealth: 8, litellm_prices: 6, hf_org: 5, github_org: 3, inference_pulls: 6, sitemap: 4, changelog_md: 3, status_components: 6, sirene: 7, ashby_jobs: 2, greenhouse_jobs: 2, edgar_form_d: 6, polymarket_events: 5, discourse_categories: 4, discord_widget: 4 };

// ---- Une fois par jour : carte frequence / croissance et popularite des sujets avec decroissance ----
export function dailyPass(store, { now = store.now() } = {}) {
  const today = day(now);
  if (store.get("SELECT 1 FROM weak_runs WHERE substr(ts,1,10)=? AND stats_json LIKE '%\"daily_done\":true%'", today)) return { skipped: 'already_today' };
  const nowMs = Date.parse(now); const out = { daily_done: true, map_signals: 0, popularity_signals: 0 };
  // carte frequence contre croissance (Yoon, Ebadi) sur 14 jours de bins journaliers, axes : mentions et sources distinctes
  const days = store.all('SELECT DISTINCT day FROM term_daily WHERE day < ? ORDER BY day', today).map(r => r.day);
  if (days.length >= 7) {
    const half = Math.floor(days.length / 2); const recentDays = new Set(days.slice(half)), oldDays = new Set(days.slice(0, half));
    const rows = store.all('SELECT term, day, n, sources FROM term_daily WHERE day < ?', today);
    const agg = new Map();
    for (const r of rows) { const a = agg.get(r.term) ?? { nOld: 0, nNew: 0, sOld: new Set(), sNew: new Set(), total: 0 }; const srcs = JSON.parse(r.sources ?? '[]'); a.total += r.n; if (recentDays.has(r.day)) { a.nNew += r.n; srcs.forEach(s => a.sNew.add(s)); } else if (oldDays.has(r.day)) { a.nOld += r.n; srcs.forEach(s => a.sOld.add(s)); } agg.set(r.term, a); }
    const totals = [...agg.values()].map(a => a.total).sort((a, b) => a - b); const medianFreq = totals[Math.floor(totals.length / 2)] ?? 1;
    const ins = store.db.prepare('INSERT OR IGNORE INTO weak_signals(detector,catalog_id,key,title,url,reason,entity,known_entity,event_at,detected_at,raw_json,score,bits,credibility,families) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    store.tx(() => { for (const [term, a] of agg) { if (a.total > medianFreq || a.nNew < 3) continue; const g = (a.nNew + 1) / (a.nOld + 1), gs = (a.sNew.size + 1) / (a.sOld.size + 1); if (g >= 3 && gs >= 2 && a.sNew.size >= 2) { const bits = Math.log2(g) + Math.log2(gs); const r = ins.run('D8', 'map', `${term}|${today}`, term, null, `Carte fréquence-croissance : « ${term} » reste rare (${a.total} mentions sur ${days.length} jours, sous la médiane ${medianFreq}) mais croît ×${g.toFixed(1)} en mentions et ×${gs.toFixed(1)} en sources distinctes (${a.sNew.size}) sur la seconde moitié de la fenêtre.`, term, 0, now, now, JSON.stringify({ n_old: a.nOld, n_new: a.nNew, sources_new: [...a.sNew].slice(0, 6) }), Number((bits * 0.5 * 0.5 * Math.max(1, a.sNew.size)).toFixed(3)), Number(bits.toFixed(3)), 0.5, ''); if (r.changes) out.map_signals++; } } });
  } else out.map_skipped = `${days.length} jours de termes, 7 requis`;
  // popularite des sujets avec decroissance (lambda = 0,01 par heure) et classement par percentiles ; faible = P10 a P50 avec pente positive
  const yesterday = day(new Date(nowMs - 864e5).toISOString());
  const clusters = store.all("SELECT c.cluster_id, c.label, (SELECT COUNT(*) FROM cluster_items ci JOIN items i ON i.item_id=ci.item_id WHERE ci.cluster_id=c.cluster_id AND substr(i.first_seen_at,1,10)=?) n_today FROM clusters c WHERE c.merged_into IS NULL AND c.n>0 AND c.last_seen_at >= ?", yesterday, new Date(nowMs - 3 * 864e5).toISOString());
  const pops = [];
  store.tx(() => { for (const c of clusters) { const prev = store.get('SELECT pop FROM cluster_popularity WHERE cluster_id=? AND day<? ORDER BY day DESC LIMIT 1', c.cluster_id, yesterday)?.pop ?? 0; const pop = prev * Math.exp(-0.01 * 24) + c.n_today; store.run('INSERT OR REPLACE INTO cluster_popularity(cluster_id,day,pop) VALUES (?,?,?)', c.cluster_id, yesterday, pop); pops.push({ ...c, pop, prev }); } store.run('DELETE FROM cluster_popularity WHERE day < ?', day(new Date(nowMs - 90 * 864e5).toISOString())); });
  const hist = store.all('SELECT cluster_id, day, pop FROM cluster_popularity WHERE day >= ? ORDER BY day', day(new Date(nowMs - 4 * 864e5).toISOString()));
  const byC = new Map(); for (const h of hist) { if (!byC.has(h.cluster_id)) byC.set(h.cluster_id, []); byC.get(h.cluster_id).push(h.pop); }
  const vals = pops.map(p => p.pop).filter(v => v > 0); const p10 = percentile(vals, 0.1), p50 = percentile(vals, 0.5);
  if (vals.length >= 30 && p10 !== null) {
    const ins = store.db.prepare('INSERT OR IGNORE INTO weak_signals(detector,catalog_id,key,title,url,reason,entity,known_entity,event_at,detected_at,raw_json,score,bits,credibility,families,cluster_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    store.tx(() => { for (const p of pops) { const series = byC.get(p.cluster_id) ?? []; if (series.length < 3) continue; const slopeUp = series[series.length - 1] > series[series.length - 2] && series[series.length - 2] > series[series.length - 3]; if (p.pop >= p10 && p.pop <= p50 && slopeUp) { const bits = 3; const r = ins.run('D9', 'popularity', `${p.cluster_id}|${yesterday}`, p.label, null, `Sujet à popularité faible mais croissante trois jours de suite (popularité ${p.pop.toFixed(1)} entre P10 ${p10.toFixed(1)} et P50 ${p50.toFixed(1)}, décroissance λ = 0,01/h).`, null, 0, now, now, JSON.stringify({ series: series.slice(-3) }), Number((bits * 0.5 * 0.5).toFixed(3)), bits, 0.5, '', p.cluster_id); if (r.changes) out.popularity_signals++; } } });
  } else out.popularity_skipped = `${vals.length} sujets avec popularité, 30 requis`;
  return out;
}

// ---- 5d : etiquetage a 72 h. Confirme si le sujet atteint ensuite le top 20 du radar, deux familles ou la presse. ----
export function labelOutcomes(store, { now = store.now() } = {}) {
  const nowMs = Date.parse(now); const cutoff = new Date(nowMs - LABEL_AFTER_H * 3600e3).toISOString();
  const due = store.all('SELECT w.* FROM weak_signals w LEFT JOIN weak_signal_outcomes o ON o.signal_id=w.signal_id WHERE o.signal_id IS NULL AND w.detected_at <= ? ORDER BY w.detected_at LIMIT 500', cutoff);
  let confirmed = 0;
  store.tx(() => {
    for (const w of due) {
      let outcome = 'NOT_CONFIRMED', via = null, lead = null; let cid = w.cluster_id ?? (w.item_id ? store.get('SELECT cluster_id FROM cluster_items WHERE item_id=?', w.item_id)?.cluster_id : null) ?? null;
      const horizon = new Date(Date.parse(w.detected_at) + LABEL_AFTER_H * 3600e3).toISOString();
      if (cid) {
        const d = store.get('SELECT best_rank, first_scored_at FROM detections WHERE cluster_id=?', cid);
        if (d && d.best_rank <= 20 && (!d.first_scored_at || d.first_scored_at >= w.detected_at)) { outcome = 'CONFIRMED'; via = 'TOP20'; lead = d.first_scored_at ? hours(d.first_scored_at, w.detected_at) : null; }
        const fams = store.all("SELECT DISTINCT i.family f FROM cluster_items ci JOIN items i ON i.item_id=ci.item_id WHERE ci.cluster_id=? AND i.family<>'G' AND i.first_seen_at > ? AND i.first_seen_at <= ?", cid, w.detected_at, horizon).map(r => r.f);
        if (outcome !== 'CONFIRMED' && fams.length >= 2) { outcome = 'CONFIRMED'; via = 'FAMILIES'; const t2 = store.get("SELECT MIN(i.first_seen_at) t FROM cluster_items ci JOIN items i ON i.item_id=ci.item_id WHERE ci.cluster_id=? AND i.family<>'G' AND i.family<>? AND i.first_seen_at > ?", cid, JSON.parse(w.raw_json ?? '{}').family ?? '', w.detected_at)?.t; lead = t2 ? hours(t2, w.detected_at) : null; }
        const pc = store.get('SELECT first_at, total_7d FROM press_checks WHERE cluster_id=?', cid);
        if (outcome !== 'CONFIRMED' && pc && pc.total_7d >= 1 && pc.first_at && pc.first_at > w.detected_at && pc.first_at <= horizon) { outcome = 'CONFIRMED'; via = 'PRESS'; lead = hours(pc.first_at, w.detected_at); }
      }
      if (outcome !== 'CONFIRMED' && w.entity) {
        // sans cluster (D7, D8) : le terme est-il repris par deux familles dans les 72 h suivant la detection ?
        const rows = store.all('SELECT families FROM term_daily WHERE term=? AND day >= ? AND day <= ?', w.entity, day(w.detected_at), day(horizon));
        const fams = new Set(); rows.forEach(r => JSON.parse(r.families ?? '[]').forEach(f => fams.add(f)));
        if (fams.size >= 2) { outcome = 'CONFIRMED'; via = 'FAMILIES_TERM'; }
      }
      if (outcome === 'CONFIRMED') confirmed++;
      store.run('INSERT OR REPLACE INTO weak_signal_outcomes(signal_id,labeled_at,outcome,via,lead_h,cluster_id) VALUES (?,?,?,?,?,?)', w.signal_id, now, outcome, via, lead === null ? null : Number(lead.toFixed(1)), cid);
    }
  });
  if (due.length) updateSourceStats(store, { now });
  return { labeled: due.length, confirmed };
}

// Credibilite bayesienne (a + confirmes) / (a + b + signales) avec priors par famille ; precocite = mediane des avances, normalisee sur 24 h.
export function updateSourceStats(store, { now = store.now(), meta = new Map() } = {}) {
  const rows = store.all("SELECT w.source_id, JSON_EXTRACT(w.raw_json,'$.family') family, o.outcome, o.lead_h FROM weak_signals w JOIN weak_signal_outcomes o ON o.signal_id=w.signal_id WHERE w.source_id IS NOT NULL AND w.detector IN ('D1','D2','D3','D4','D5','D6')");
  const by = new Map();
  for (const r of rows) { const s = by.get(r.source_id) ?? { family: r.family, flagged: 0, confirmed: 0, leads: [] }; s.flagged++; if (r.outcome === 'CONFIRMED') { s.confirmed++; if (r.lead_h !== null) s.leads.push(r.lead_h); } by.set(r.source_id, s); }
  store.tx(() => { for (const [sid, s] of by) { const prior = priorCredibility(sid, s.family, meta); const a = prior * PRIOR_STRENGTH, b = (1 - prior) * PRIOR_STRENGTH; const cred = (a + s.confirmed) / (a + b + s.flagged); const med = s.leads.length ? percentile(s.leads, 0.5) : null; const prec = med === null ? null : Math.min(1, Math.max(0, med) / 24); store.run('INSERT INTO source_stats(source_id,first_seen_at,flagged,confirmed,leads_json,credibility,precocity,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET flagged=?, confirmed=?, leads_json=?, credibility=?, precocity=?, updated_at=?', sid, now, s.flagged, s.confirmed, JSON.stringify(s.leads.slice(-50)), cred, prec, now, s.flagged, s.confirmed, JSON.stringify(s.leads.slice(-50)), cred, prec, now); } });
  return by.size;
}

// ---- Budget : au plus 20 signaux par jour, dedoublonnes par sujet et par entite, refroidissement 72 h ----
export function selectBudget(store, { now = store.now(), budget = DAILY_BUDGET } = {}) {
  const today = day(now); const nowMs = Date.parse(now);
  const already = store.all('SELECT s.signal_id, w.cluster_id, w.entity, w.key, w.catalog_id FROM weak_selection s JOIN weak_signals w ON w.signal_id=s.signal_id WHERE s.day >= ?', day(new Date(nowMs - COOLDOWN_H * 3600e3).toISOString()));
  const todayCount = store.get('SELECT COUNT(*) n FROM weak_selection WHERE day=?', today).n;
  const usedC = new Set(already.map(a => a.cluster_id).filter(Boolean)), usedE = new Set(already.map(a => (a.entity ?? '').toLowerCase()).filter(Boolean)), usedK = new Set(already.map(a => `${a.catalog_id}|${a.key}`));
  const cands = store.all('SELECT * FROM weak_signals WHERE detected_at >= ? AND score IS NOT NULL ORDER BY score DESC LIMIT 400', new Date(nowMs - 24 * 3600e3).toISOString());
  const picked = []; let rank = todayCount;
  store.tx(() => {
    for (const c of cands) {
      if (rank >= budget) break;
      if (usedK.has(`${c.catalog_id}|${c.key}`)) continue;
      if (c.cluster_id && usedC.has(c.cluster_id)) continue;
      const e = (c.entity ?? '').toLowerCase(); if (e && usedE.has(e)) continue;
      rank++; store.run('INSERT OR IGNORE INTO weak_selection(day,signal_id,rank,score) VALUES (?,?,?,?)', today, c.signal_id, rank, c.score);
      usedK.add(`${c.catalog_id}|${c.key}`); if (c.cluster_id) usedC.add(c.cluster_id); if (e) usedE.add(e); picked.push({ rank, signal_id: c.signal_id, detector: c.detector, score: c.score, title: c.title, reason: c.reason, url: c.url, event_at: c.event_at });
    }
  });
  return picked;
}

// ---- Metriques (5d) : taux de detection precoce, avance mediane, taux de confirmation par detecteur et par source ----
export function weakMetrics(store, { now = store.now(), days = 14 } = {}) {
  ensureWeakAnalysisSchema(store);
  const since = new Date(Date.parse(now) - days * 864e5).toISOString();
  const byDet = store.all("SELECT w.detector, COUNT(*) n, SUM(o.outcome='CONFIRMED') confirmed, SUM(o.via='PRESS' OR o.via='TOP20') early FROM weak_signals w JOIN weak_signal_outcomes o ON o.signal_id=w.signal_id WHERE w.detected_at >= ? GROUP BY w.detector ORDER BY w.detector", since);
  const leads = store.all("SELECT w.detector, o.lead_h FROM weak_signals w JOIN weak_signal_outcomes o ON o.signal_id=w.signal_id WHERE o.lead_h IS NOT NULL AND w.detected_at >= ?", since);
  const med = det => { const v = leads.filter(l => l.detector === det).map(l => l.lead_h); return v.length ? percentile(v, 0.5) : null; };
  const bySource = store.all("SELECT w.source_id, COUNT(*) n, SUM(o.outcome='CONFIRMED') confirmed FROM weak_signals w JOIN weak_signal_outcomes o ON o.signal_id=w.signal_id WHERE w.source_id IS NOT NULL AND w.detected_at >= ? GROUP BY w.source_id ORDER BY n DESC LIMIT 30", since);
  const totals = store.get('SELECT COUNT(*) n, MIN(detected_at) first FROM weak_signals').n;
  return { window_days: days, signals_total: totals, labeled: byDet.reduce((a, d) => a + d.n, 0), selected_today: store.get('SELECT COUNT(*) n FROM weak_selection WHERE day=?', day(now)).n, by_detector: byDet.map(d => ({ detector: d.detector, labeled: d.n, confirmed: d.confirmed, confirmation_rate: d.n ? Number((d.confirmed / d.n).toFixed(2)) : null, early_detection_rate: d.n ? Number((d.early / d.n).toFixed(2)) : null, lead_median_h: med(d.detector) })), by_source: bySource.map(s => ({ source: s.source_id, labeled: s.n, confirmed: s.confirmed, confirmation_rate: Number((s.confirmed / s.n).toFixed(2)) })) };
}

// ---- Donnees pour la page : mode fantome jusqu'au 6 octobre 2026 18:00 UTC (deux semaines apres la mise en route), puis onglet ----
export const GHOST_UNTIL = process.env.WEAK_GHOST_UNTIL ?? '2026-10-06T18:00:00.000Z';
export function weakPageData(store, { now = store.now(), days = 3 } = {}) {
  ensureWeakAnalysisSchema(store);
  const metrics = weakMetrics(store, { now });
  const ghost = now < GHOST_UNTIL;
  const rows = ghost ? [] : store.all(`SELECT sel.day, sel.rank, sel.score, w.signal_id, w.detector, w.title, w.reason, w.url, w.event_at, w.detected_at, w.entity, w.source_id, o.outcome, o.via, o.lead_h
    FROM weak_selection sel JOIN weak_signals w ON w.signal_id=sel.signal_id LEFT JOIN weak_signal_outcomes o ON o.signal_id=w.signal_id WHERE sel.day >= ? ORDER BY sel.day DESC, sel.rank`, day(new Date(Date.parse(now) - days * 864e5).toISOString()));
  const byDet = new Map(metrics.by_detector.map(d => [d.detector, d]));
  return { mode: ghost ? 'ghost' : 'visible', ghost_until: GHOST_UNTIL, note: ghost ? 'Vue séparée en mode fantôme : compteurs et taux seulement, aucun signal affiché avant étiquetage à 72 h sur deux semaines.' : 'Vue séparée du radar, jugée sur le taux de détection précoce, pas sur sa précision brute. Les taux affichés sont ceux du détecteur sur 14 jours.', ...metrics, rows: rows.map(r => ({ ...r, detector_rates: byDet.get(r.detector) ?? null })) };
}
