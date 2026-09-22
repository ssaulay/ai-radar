// Verification active du statut presse : pour les meilleurs sujets, une requete Google News figee (EN + FR, 7 jours),
// rafraichie au plus une fois par heure. Le statut presse ne depend donc plus des seuls articles que le radar a collectes.
import { parseFeed } from '../collect/parsers.mjs';
import { normName, sha256 } from '../core/text.mjs';
import { cosine, toBlob, fromBlob } from '../core/embed.mjs';

// Un article ne compte que s'il parle du meme sujet : similarite d'embedding avec un item du sujet (meme seuil que le regroupement).
export const PRESS_MATCH = 0.60;

const GENERIC_TYPES = new Set(['TOPIC', 'REGULATION']);
const CAP_WORD = /^[A-Z][A-Za-z0-9.+-]{1,}$|^[A-Z0-9][A-Z0-9.+-]{1,}$/; // Jev, TypeSafe, GPT-6, MiMo-V2.6

// Requete presse : noms propres les plus recurrents dans les titres du sujet (hors stop words et mots generiques),
// puis entites nommees du lexique (labos, modeles, produits, personnes ; pas les themes), puis mots du libelle.
export function buildPressQuery(items, entities, lex, label = '') {
  const freq = new Map();
  for (const it of items ?? []) {
    const seen = new Set();
    for (const raw of (it.title ?? '').replace(/[“”"'’:;,()\[\]|]/g, ' ').split(/\s+/)) {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.+-]+$/g, '');
      if (w.length < 3 || !CAP_WORD.test(w) || lex.stop.has(w.toLowerCase()) || GENERIC_CAPS.has(w.toLowerCase()) || seen.has(w.toLowerCase())) continue;
      seen.add(w.toLowerCase()); freq.set(w.toLowerCase(), { w, n: (freq.get(w.toLowerCase())?.n ?? 0) + 1 });
    }
  }
  const minN = (items?.length ?? 0) >= 3 ? 2 : 1;
  const proper = [...freq.values()].filter(x => x.n >= minN).sort((a, b) => b.n - a.n).slice(0, 2).map(x => x.w);
  const named = (entities ?? []).map(e => e.e ?? e).filter(name => { const t = lex.entities.find(x => x.name === name)?.type; return t && !GENERIC_TYPES.has(t) && !proper.some(p => normName(name).includes(p.toLowerCase())); }).slice(0, 2 - Math.min(proper.length, 1));
  // deux termes au plus : Google News combine en ET, un troisieme terme fait chuter le rappel
  let terms = [...proper.map(p => (/\s/.test(p) ? `"${p}"` : p))];
  if (terms.length < 2) terms.push(...named.map(n => `"${n}"`).slice(0, 2 - terms.length));
  if (terms.length < 2) terms.push(...normName(label).split(' ').filter(w => w.length > 3 && !lex.stop.has(w) && !terms.some(t => t.toLowerCase().includes(w))).slice(0, 2 - terms.length));
  return terms.slice(0, 2).join(' ').trim();
}
const GENERIC_CAPS = new Set(['the', 'this', 'new', 'how', 'why', 'what', 'when', 'show', 'ask', 'tell', 'launch', 'introducing', 'announcing', 'meet', 'inside', 'here', 'from', 'with', 'and', 'for', 'openai', 'llm', 'llms', 'model', 'models', 'agent', 'agents', 'update', 'release', 'releases', 'hn', 'pdf', 'video', 'thread']);

export function ensurePressSchema(store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS press_checks(cluster_id INTEGER PRIMARY KEY, checked_at TEXT, query TEXT, total_7d INTEGER, last_24h INTEGER, first_at TEXT, last_at TEXT, sample_json TEXT, fetched_7d INTEGER); CREATE TABLE IF NOT EXISTS press_embeddings(url_hash TEXT PRIMARY KEY, vec BLOB, created_at TEXT);');
  try { store.db.exec('ALTER TABLE press_checks ADD COLUMN fetched_7d INTEGER'); } catch {}
}

export async function checkPress(store, http, results, lex, { top = 40, maxAgeMin = 60, now = store.now(), log = console.log, embedder = null } = {}) {
  ensurePressSchema(store);
  const nowMs = Date.parse(now); let queried = 0, cached = 0, skipped = 0; let embedDown = false;
  for (const r of results.slice(0, top)) {
    let row = store.get('SELECT * FROM press_checks WHERE cluster_id=?', r.cluster_id);
    if (!row || nowMs - Date.parse(row.checked_at) > maxAgeMin * 60000) {
      // embeddings en panne : on garde la verification precedente si elle existe, sinon on ne conclut rien (pas de comptage brut, il sur-confirme)
      if (embedDown) { if (row) cached++; else { skipped++; continue; } }
      else {
        const query = buildPressQuery(r.items, r.entities, lex, r.label); if (!query) continue;
        const q = encodeURIComponent(`${query} when:7d`);
        const arts = [];
        for (const u of [`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, `https://news.google.com/rss/search?q=${q}&hl=fr&gl=FR&ceid=FR:fr`]) { const res = await http(u, { hostDelay: 1500 }); if (!res.error) arts.push(...parseFeed(res.body, u)); }
        const seen = new Set(); let uniq = arts.filter(a => { const k = a.url || a.external_id; if (seen.has(k)) return false; seen.add(k); return true; }).filter(a => a.published_at);
        const fetched = uniq.length; let ok = true;
        // filtre thematique : garder les articles proches d'au moins un item du sujet
        if (embedder && uniq.length) {
          const members = store.all('SELECT e.vec FROM cluster_items ci JOIN embeddings e ON e.item_id=ci.item_id WHERE ci.cluster_id=?', r.cluster_id).map(x => fromBlob(x.vec));
          if (members.length) {
            const need = uniq.filter(a => !store.get('SELECT 1 FROM press_embeddings WHERE url_hash=?', sha256(a.url || a.title)));
            if (need.length) {
              let vecs = null; try { vecs = await embedder.embed(need.map(a => a.title)); } catch (e) { ok = false; embedDown = true; log(`  presse : embeddings indisponibles (${e.message.slice(0, 80)}), verdicts precedents conserves`); }
              if (vecs) store.tx(() => need.forEach((a, k) => store.run('INSERT OR REPLACE INTO press_embeddings(url_hash,vec,created_at) VALUES (?,?,?)', sha256(a.url || a.title), toBlob(vecs[k]), now)));
            }
            if (ok) uniq = uniq.filter(a => { const v = fromBlob(store.get('SELECT vec FROM press_embeddings WHERE url_hash=?', sha256(a.url || a.title)).vec); let m = 0; for (const mv of members) { const c = cosine(v, mv); if (c > m) m = c; if (m >= PRESS_MATCH) break; } return m >= PRESS_MATCH; });
          }
        }
        if (!ok) { if (row) cached++; else { skipped++; continue; } }
        else {
          const dates = uniq.map(a => a.published_at).sort();
          row = { cluster_id: r.cluster_id, checked_at: now, query, fetched_7d: fetched, total_7d: uniq.length, last_24h: uniq.filter(a => nowMs - Date.parse(a.published_at) <= 24 * 3600e3).length, first_at: dates[0] ?? null, last_at: dates[dates.length - 1] ?? null, sample_json: JSON.stringify(uniq.sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 5).map(a => ({ t: a.title.slice(0, 120), u: a.url, at: a.published_at, s: a.author }))) };
          store.run('INSERT OR REPLACE INTO press_checks(cluster_id,checked_at,query,total_7d,last_24h,first_at,last_at,sample_json,fetched_7d) VALUES (?,?,?,?,?,?,?,?,?)', row.cluster_id, row.checked_at, row.query, row.total_7d, row.last_24h, row.first_at, row.last_at, row.sample_json, row.fetched_7d);
          store.run('DELETE FROM press_embeddings WHERE created_at < ?', new Date(nowMs - 8 * 864e5).toISOString());
          queried++;
        }
      }
    } else cached++;
    r.press_check = { query: row.query, fetched_7d: row.fetched_7d, total_7d: row.total_7d, last_24h: row.last_24h, first_at: row.first_at, last_at: row.last_at, checked_at: row.checked_at, sample: JSON.parse(row.sample_json ?? '[]') };
    // le statut combine les articles collectes par le radar et la verification active
    const total = Math.max(r.press_count ?? 0, row.total_7d ?? 0);
    r.press_count = total; if (row.first_at && (!r.first_press_at || row.first_at < r.first_press_at)) r.first_press_at = row.first_at;
    r.status = total >= 3 ? 'CONFIRMED' : total >= 1 ? 'LIGHT_PRESS' : 'ANTICIPATION';
  }
  log(`  presse : ${queried} sujets vérifiés dans Google News, ${cached} en cache${skipped ? `, ${skipped} sans verdict (embeddings indisponibles)` : ''}`);
  return { queried, cached, skipped, embed_down: embedDown };
}
