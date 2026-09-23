// Briefs bilingues par sujet : le LLM lit les titres et sources du cluster et rend nom, quoi, pourquoi maintenant, angle.
// Il ne decide jamais du score ni de l'existence du sujet. Regenere seulement si les items du cluster ont change. Plafond de cout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadProfile(root) { try { return JSON.parse(fs.readFileSync(path.join(root, 'config', 'profile.json'), 'utf8')); } catch { return null; } }

// Cout LLM deja depense aujourd'hui (UTC) pour les briefs, d'apres le journal des appels et les tarifs du fournisseur.
export function briefSpentToday(store, prov, now) {
  if (!prov) return 0;
  const r = store.get("SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c FROM llm_calls WHERE ok=1 AND purpose='brief' AND created_at >= ?", now.slice(0, 10));
  return (r.p / 1e6) * (prov.inUsd ?? 0) + (r.c / 1e6) * (prov.outUsd ?? 0);
}

// Budget : plafond par passage et par jour (le plan prevoit quatre generations par jour, pas une par passage), et un brief existant
// n'est regenere qu'apres minAgeH heures meme si les items du sujet ont change. Objectif : rester sous 2 USD par mois au total.
export async function writeBriefs(store, llm, results, { top = 30, maxUsdPerRun = 0.05, maxUsdPerDay = 0.05, minAgeH = 6, log = console.log, now = store.now(), profile = null } = {}) {
  try { store.db.exec('ALTER TABLE cluster_briefs ADD COLUMN meta_json TEXT'); } catch {}
  if (!llm.enabled) return { skipped: 'LLM_DISABLED', briefs: loadBriefs(store, results) };
  const spentToday = briefSpentToday(store, llm.provider, now);
  if (spentToday >= maxUsdPerDay) { log(`  briefs : budget journalier atteint (${spentToday.toFixed(3)} USD), aucun nouveau brief`); return { skipped: 'DAILY_BUDGET', spent_today: Number(spentToday.toFixed(4)), briefs: loadBriefs(store, results) }; }
  let generated = 0, reused = 0, fresh = 0, usd = 0;
  for (const r of results.slice(0, top)) {
    const hash = crypto.createHash('sha1').update(r.items.map(i => i.item_id ?? i.url).sort().join('|')).digest('hex').slice(0, 16);
    const ex = store.get('SELECT * FROM cluster_briefs WHERE cluster_id=?', r.cluster_id);
    if (ex && ex.items_hash === hash) { reused++; continue; }
    if (ex && ex.generated_at && (Date.parse(now) - Date.parse(ex.generated_at)) / 3600e3 < minAgeH) { fresh++; continue; }
    if (usd >= maxUsdPerRun || spentToday + usd >= maxUsdPerDay) break;
    const lines = r.items.slice().sort((a, b) => (b.score_raw ?? 0) - (a.score_raw ?? 0)).slice(0, 12).map(i => `- [${i.family}/${i.source_id}] ${i.title}${i.text && i.text !== i.title ? ` — ${i.text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n');
    const pressLine = r.press_check ? `${r.press_check.total_7d} article(s) de presse sur 7 jours (${r.press_check.last_24h} en 24 h)` : r.status === 'ANTICIPATION' ? 'aucun article de presse encore' : `${r.press_count} article(s) de presse`;
    const prof = profile ? `\nPROFIL DU CRÉATEUR (adapte l'angle, les accroches et l'appréciation d'adéquation à ce profil) :\n- Identité : ${profile.identity}\n- Positionnement : ${profile.positioning}\n- Audience FR : ${profile.audiences?.fr}\n- Audience EN : ${profile.audiences?.en}\n- Angles préférés : ${(profile.preferred_angles ?? []).join(' ; ')}\n- À éviter : ${(profile.avoid ?? []).join(' ; ')}\n` : '';
    const prompt = `Tu résumes un sujet d'actualité IA détecté automatiquement à partir des items ci-dessous (familles : A agrégateurs tech, B Reddit, C réseaux, D recherche, E code et modèles, F annonces officielles et blogs, G presse, H marchés de prédiction). Presse : ${pressLine}.${prof}
Règles : n'invente rien qui ne soit pas dans les items ; si les items sont hétérogènes, dis-le ; pas de superlatifs ; ne reprends pas un communiqué sans angle.
Réponds en JSON :
{"label":"nom du sujet en 6 à 10 mots, en anglais",
 "fr":"3 phrases : ce qui se passe ; pourquoi ça compte maintenant ; l'angle de publication le plus pertinent pour ce profil",
 "en":"same in English, 3 sentences",
 "hooks":{"fr":"une accroche LinkedIn FR d'une ligne","en":"one-line LinkedIn/X hook in English"},
 "fit":"HIGH|MEDIUM|LOW : adéquation du sujet au positionnement et aux angles du profil, avec 5 mots de justification après un tiret",
 "differentiation":"une phrase : ce que le créateur peut apporter que la presse (${pressLine}) n'a pas déjà dit ; si la presse a tout dit, l'écrire",
 "risk":"une phrase : risque à publier (rumeur non sourcée, sujet sensible, information fragile, hors sujet) ou 'faible'",
 "confidence":"HIGH|MEDIUM|LOW selon la cohérence des items"}

Items :
${lines}`;
    const res = await llm.json('brief', [{ role: 'user', content: prompt }], { maxOut: 500 });
    // on s'arrete seulement si le budget est epuise ou la cle refusee ; une erreur serveur passagere ne prive pas les autres sujets de brief
    if (res.error) { log(`  brief ${r.cluster_id}: ${res.error}`); if (/BUDGET|Incorrect API key|invalidated|credits|insufficient_quota/i.test(res.error)) break; continue; }
    const d = res.data ?? {};
    const meta = { hooks: d.hooks ?? null, fit: String(d.fit ?? '').slice(0, 160), differentiation: String(d.differentiation ?? '').slice(0, 400), risk: String(d.risk ?? '').slice(0, 300), confidence: d.confidence ?? null };
    store.run('INSERT OR REPLACE INTO cluster_briefs(cluster_id,lang_fr,lang_en,model,generated_at,items_hash,meta_json) VALUES (?,?,?,?,?,?,?)', r.cluster_id, String(d.fr ?? '').slice(0, 900), String(d.en ?? '').slice(0, 900), `${llm.provider.model}|${d.confidence ?? '?'}|${String(d.label ?? '').slice(0, 120)}`, now, hash, JSON.stringify(meta));
    if (d.label && String(d.label).length > 5) store.run('UPDATE clusters SET label=? WHERE cluster_id=?', String(d.label).slice(0, 140), r.cluster_id);
    generated++; usd = llm.counters?.llmUsd ?? usd;
  }
  log(`  briefs : ${generated} générés, ${reused} réutilisés, ${fresh} récents conservés, ${(spentToday + usd).toFixed(3)} USD aujourd'hui`);
  return { generated, reused, fresh, spent_today: Number((spentToday + usd).toFixed(4)), briefs: loadBriefs(store, results) };
}

export function loadBriefs(store, results) {
  const m = new Map();
  for (const r of results) { const b = store.get('SELECT * FROM cluster_briefs WHERE cluster_id=?', r.cluster_id); if (b) { const [model, confidence, label] = (b.model ?? '').split('|'); let meta = {}; try { meta = JSON.parse(b.meta_json ?? '{}'); } catch {} m.set(r.cluster_id, { fr: b.lang_fr, en: b.lang_en, model, confidence, generated_at: b.generated_at, ...meta }); if (label) r.label = label; } }
  return m;
}
