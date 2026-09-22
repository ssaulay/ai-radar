// Briefs bilingues par sujet : le LLM lit les titres et sources du cluster et rend nom, quoi, pourquoi maintenant, angle.
// Il ne decide jamais du score ni de l'existence du sujet. Regenere seulement si les items du cluster ont change. Plafond de cout.
import crypto from 'node:crypto';

export async function writeBriefs(store, llm, results, { top = 30, maxUsdPerRun = 0.05, log = console.log, now = store.now() } = {}) {
  if (!llm.enabled) return { skipped: 'LLM_DISABLED', briefs: loadBriefs(store, results) };
  let generated = 0, reused = 0, usd = 0;
  for (const r of results.slice(0, top)) {
    const hash = crypto.createHash('sha1').update(r.items.map(i => i.item_id ?? i.url).sort().join('|')).digest('hex').slice(0, 16);
    const ex = store.get('SELECT * FROM cluster_briefs WHERE cluster_id=?', r.cluster_id);
    if (ex && ex.items_hash === hash) { reused++; continue; }
    if (usd >= maxUsdPerRun) break;
    const lines = r.items.slice().sort((a, b) => (b.score_raw ?? 0) - (a.score_raw ?? 0)).slice(0, 12).map(i => `- [${i.family}/${i.source_id}] ${i.title}${i.text && i.text !== i.title ? ` — ${i.text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n');
    const prompt = `Tu résumes un sujet d'actualité IA détecté automatiquement à partir des items ci-dessous (familles : A agrégateurs tech, B Reddit, C réseaux, D recherche, E code et modèles, F annonces officielles et blogs, G presse, H marchés de prédiction). Statut presse : ${r.status === 'ANTICIPATION' ? 'aucun article de presse encore' : `${r.press_count} article(s) de presse`}.
Règles : n'invente rien qui ne soit pas dans les items ; si les items sont hétérogènes, dis-le ; pas de superlatifs ; le lecteur est un product manager qui veut publier vite sur LinkedIn.
Réponds en JSON : {"label":"nom du sujet en 6 à 10 mots, en anglais","fr":"3 phrases : ce qui se passe ; pourquoi ça compte maintenant ; un angle de publication","en":"same in English, 3 sentences","confidence":"HIGH|MEDIUM|LOW selon la cohérence des items"}

Items :
${lines}`;
    const res = await llm.json('brief', [{ role: 'user', content: prompt }], { maxOut: 500 });
    if (res.error) { log(`  brief ${r.cluster_id}: ${res.error}`); if (/BUDGET|LLM_ERROR/.test(res.error)) break; continue; }
    const d = res.data ?? {};
    store.run('INSERT OR REPLACE INTO cluster_briefs(cluster_id,lang_fr,lang_en,model,generated_at,items_hash) VALUES (?,?,?,?,?,?)', r.cluster_id, String(d.fr ?? '').slice(0, 900), String(d.en ?? '').slice(0, 900), `${llm.provider.model}|${d.confidence ?? '?'}|${String(d.label ?? '').slice(0, 120)}`, now, hash);
    if (d.label && String(d.label).length > 5) store.run('UPDATE clusters SET label=? WHERE cluster_id=?', String(d.label).slice(0, 140), r.cluster_id);
    generated++; usd = llm.counters?.llmUsd ?? usd;
  }
  log(`  briefs : ${generated} générés, ${reused} réutilisés`);
  return { generated, reused, briefs: loadBriefs(store, results) };
}

export function loadBriefs(store, results) {
  const m = new Map();
  for (const r of results) { const b = store.get('SELECT * FROM cluster_briefs WHERE cluster_id=?', r.cluster_id); if (b) { const [model, confidence, label] = (b.model ?? '').split('|'); m.set(r.cluster_id, { fr: b.lang_fr, en: b.lang_en, model, confidence, generated_at: b.generated_at }); if (label) r.label = label; } }
  return m;
}
