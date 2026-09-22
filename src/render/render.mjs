// Rendu statique : index.html (radar, briefs, flux), radar.json, radar.xml. Aucune dependance, aucun appel externe a l'affichage.
import fs from 'node:fs';
import path from 'node:path';

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const FAMILY_NAMES = { A: 'Agrégateurs', B: 'Reddit', C: 'Réseaux', D: 'Recherche', E: 'Code & modèles', F: 'Officiel & experts', G: 'Presse', H: 'Marchés' };
const ago = (iso, now) => { const m = Math.round((Date.parse(now) - Date.parse(iso)) / 60000); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} j`; };
const spark = (arr, w = 96, h = 22) => { const max = Math.max(1, ...arr); const pts = arr.map((v, i) => `${(i / (arr.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' '); return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="items par heure sur 24 h"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}"/></svg>`; };

export function renderAll(store, results, { root, now, stats = {}, briefs = new Map(), coverage = {} }) {
  const out = path.join(root, 'public'); fs.mkdirSync(out, { recursive: true });
  const top = results.slice(0, 60); const totalActive = results.length;
  const json = { generated_at: now, total_active_topics: totalActive, shown: top.length, definitions: { score: 'Somme de composantes observables (familles indépendantes sur 6 h, burst de terme, vélocité HN, étoiles GitHub, upvotes HF, annonce officielle, posts sociaux). Poids manuels v1, affichés par sujet.', status: { ANTICIPATION: 'aucun article de presse dans le sujet', CONFIRMED: 'au moins un article de presse', PRESS_ONLY: 'vu uniquement dans la presse' } }, stats, coverage, topics: top.map(r => ({ cluster_id: r.cluster_id, label: r.label, score: r.score, status: r.status, first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, n_items: r.n_items, families: r.components.families.list, entities: r.entities, components: r.components, press_count: r.press_count, first_press_at: r.first_press_at, velocity: r.velocity, hourly: r.hourly, brief: briefs.get(r.cluster_id) ?? null, items: r.items.map(i => ({ source: i.source_id, family: i.family, kind: i.kind, title: i.title, url: i.url, author: i.author, at: i.evt_at, score: i.score_raw })) })) };
  fs.writeFileSync(path.join(out, 'radar.json'), JSON.stringify(json));
  fs.writeFileSync(path.join(out, 'radar.xml'), rss(top.slice(0, 25), now));
  fs.writeFileSync(path.join(out, 'index.html'), html(json, store, now));
  return { dir: out, topics: top.length };
}

function rss(top, now) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>ai-radar</title><link>https://example.invalid/</link><description>Sujets IA émergents, score explicable</description><lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>${top.map(r => `<item><title>${esc(`[${Math.round(r.score)}] ${r.label}`)}</title><link>${esc(r.items.find(i => i.family !== 'G')?.url ?? r.items[0]?.url ?? '')}</link><guid isPermaLink="false">cluster-${r.cluster_id}-${r.first_seen_at}</guid><pubDate>${new Date(r.first_seen_at).toUTCString()}</pubDate><description>${esc(`${r.status} ; ${r.n_items} items ; familles ${r.components.families.list.join(', ')} ; ${r.items.slice(0, 5).map(i => `${i.source_id}: ${i.title}`).join(' | ')}`)}</description></item>`).join('')}</channel></rss>`;
}

function html(json, store, now) {
  const feed = store.all("SELECT source_id, family, kind, title, url, evt_at, score_raw FROM items WHERE relevant=1 AND evt_at >= ? ORDER BY evt_at DESC LIMIT 600", new Date(Date.parse(now) - 24 * 3600e3).toISOString());
  const srcHealth = store.all("SELECT source_id, status, error, items_new, run_ts FROM source_runs s WHERE id IN (SELECT MAX(id) FROM source_runs GROUP BY source_id) ORDER BY status, source_id");
  const okCount = srcHealth.filter(s => s.status === 'OK').length;
  const topic = r => {
    const c = r.components; const fams = ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'G'].filter(f => r.items.some(i => i.family === f));
    const badge = f => { const its = r.items.filter(i => i.family === f); const best = its.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]; return `<a class="badge f${f}" href="${esc(best.url)}" target="_blank" rel="noopener" title="${esc(FAMILY_NAMES[f])} : ${its.length} item(s). ${esc(best.title)}">${esc(FAMILY_NAMES[f])} ${its.length}</a>`; };
    const comp = Object.entries(c).filter(([, v]) => v.points > 0).map(([k, v]) => `${k} +${v.points.toFixed(0)}${k === 'burst' && v.term ? ` (${esc(v.term)} z=${v.z})` : k === 'families' ? ` (${v.list.join(',')})` : k === 'hn' ? ` (${v.points_per_hour}/h)` : k === 'github' ? ` (+${v.stars_24h} ★)` : k === 'hf' ? ` (${v.paper_upvotes} upvotes${v.trending ? ', trending' : ''})` : k === 'social' ? ` (${v.posts_6h} posts 6 h)` : ''}`).join(' · ');
    const press = r.status === 'ANTICIPATION' ? '<span class="pill antic">pas encore dans la presse</span>' : r.status === 'PRESS_ONLY' ? '<span class="pill press">presse uniquement</span>' : `<span class="pill conf">repris : ${r.press_count} article(s), premier il y a ${ago(r.first_press_at, now)}</span>`;
    const brief = r.brief ? `<div class="brief"><div class="fr"><b>FR</b> ${esc(r.brief.fr)}</div><div class="en"><b>EN</b> ${esc(r.brief.en)}</div></div>` : '';
    return `<article class="topic" data-status="${r.status}" data-first="${r.first_seen_at}" data-score="${r.score}"><div class="head"><span class="score" title="${esc(comp)}">${Math.round(r.score)}</span><div class="ttl"><h3>${esc(r.label)}</h3><div class="meta">${press} · détecté il y a ${ago(r.first_seen_at, now)} · ${r.n_items} items · ${r.velocity.recent3h}↑ sur 3 h (${r.velocity.prev3h} avant)</div><div class="badges">${fams.map(badge).join('')}</div>${r.entities?.length ? `<div class="ents">${r.entities.map(e => `<span>${esc(e.e)}</span>`).join('')}</div>` : ''}</div>${spark(r.hourly)}</div><div class="comp">${comp}</div>${brief}<details><summary>Sources (${r.items.length})</summary><ul>${r.items.slice().sort((a, b) => b.at.localeCompare(a.at)).map(i => `<li><span class="f f${i.family}">${i.family}</span> <a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a> <small>${esc(i.source)}${i.score !== null && i.score !== undefined ? ` · ${i.score}` : ''} · ${ago(i.at, now)}</small></li>`).join('')}</ul></details></article>`;
  };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ai-radar</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--txt:#e6e6e6;--mut:#9aa3ad;--acc:#7cc4ff;--ok:#5ad38a;--warn:#ffb454;--bad:#ff6b6b;--line:#262b35}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--card:#fff;--txt:#111;--mut:#5c6570;--acc:#0a66c2;--line:#e2e6ea}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:12px;align-items:baseline}header h1{margin:0;font-size:20px}header .sub{color:var(--mut);font-size:13px}
nav{display:flex;gap:6px;padding:10px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}nav button,.filters button{background:var(--card);color:var(--txt);border:1px solid var(--line);border-radius:999px;padding:6px 12px;cursor:pointer}nav button.on,.filters button.on{border-color:var(--acc);color:var(--acc)}
main{max-width:1100px;margin:0 auto;padding:16px 20px}.view{display:none}.view.on{display:block}.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;font-size:13px}
.topic{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}.head{display:flex;gap:14px;align-items:flex-start}.score{font-size:28px;font-weight:700;min-width:48px;text-align:center;color:var(--acc);cursor:help}.ttl{flex:1}h3{margin:0 0 4px;font-size:16px;line-height:1.3}.meta{color:var(--mut);font-size:13px}.badges{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px}.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--txt);text-decoration:none}.badge.fG{opacity:.7}.ents{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}.ents span{font-size:12px;color:var(--mut);border:1px dashed var(--line);border-radius:6px;padding:1px 6px}
.spark{color:var(--acc);flex-shrink:0}.comp{font-size:12px;color:var(--mut);margin-top:8px}.pill{padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid}.pill.antic{color:var(--ok);border-color:var(--ok)}.pill.conf{color:var(--warn);border-color:var(--warn)}.pill.press{color:var(--mut);border-color:var(--mut)}
.brief{margin-top:10px;font-size:14px;border-left:3px solid var(--acc);padding-left:10px}.brief .en{color:var(--mut);margin-top:4px}details{margin-top:8px}summary{cursor:pointer;color:var(--mut);font-size:13px}details ul{margin:6px 0 0;padding-left:18px}details li{margin:3px 0;font-size:13px}details small{color:var(--mut)}
.f{display:inline-block;width:16px;text-align:center;font-size:11px;border-radius:4px;background:var(--line)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}td.t{color:var(--mut);white-space:nowrap}
.health{font-size:12px;color:var(--mut)}.health .bad{color:var(--bad)}footer{padding:20px;color:var(--mut);font-size:12px;border-top:1px solid var(--line);max-width:1100px;margin:0 auto}
a{color:inherit}
</style></head><body>
<header><h1>ai-radar</h1><span class="sub">généré le ${esc(now.slice(0, 16).replace('T', ' '))} UTC · ${json.total_active_topics} sujets actifs, ${json.topics.length} affichés · ${okCount}/${srcHealth.length} sources OK · <a href="radar.json">JSON</a> · <a href="radar.xml">RSS</a></span></header>
<nav><button class="on" data-view="radar">Radar</button><button data-view="briefs">Briefs</button><button data-view="flux">Flux 24 h</button><button data-view="sante">Couverture</button></nav>
<main>
<section id="radar" class="view on"><div class="filters"><button class="on" data-f="all">Tous</button><button data-f="ANTICIPATION">Pas encore dans la presse</button><button data-f="6">Détectés &lt; 6 h</button><button data-f="24">&lt; 24 h</button></div>${json.topics.map(topic).join('')}</section>
<section id="briefs" class="view">${json.topics.filter(t => t.brief).length ? json.topics.filter(t => t.brief).map(topic).join('') : '<p class="meta">Aucun brief généré pour l’instant (lot 3 : LLM bon marché, plafonné).</p>'}</section>
<section id="flux" class="view"><table><thead><tr><th>Quand</th><th>Fam.</th><th>Source</th><th>Titre</th><th>Score</th></tr></thead><tbody>${feed.map(i => `<tr><td class="t">${ago(i.evt_at, now)}</td><td><span class="f f${i.family}">${i.family}</span></td><td class="t">${esc(i.source_id)}</td><td><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></td><td class="t">${i.score_raw ?? ''}</td></tr>`).join('')}</tbody></table></section>
<section id="sante" class="view"><p class="meta">Chaque chiffre du radar mesure ce que l’on écoute, pas l’activité réelle du monde. Sources en erreur ou sautées :</p><table><thead><tr><th>Source</th><th>Statut</th><th>Dernier passage</th><th>Nouveaux</th><th>Erreur</th></tr></thead><tbody>${srcHealth.map(s => `<tr><td>${esc(s.source_id)}</td><td class="${s.status === 'OK' ? '' : 'bad'}">${esc(s.status)}</td><td class="t">${ago(s.run_ts, now)}</td><td>${s.items_new ?? ''}</td><td class="health ${s.status === 'OK' ? '' : 'bad'}">${esc((s.error ?? '').slice(0, 120))}</td></tr>`).join('')}</tbody></table></section>
</main>
<footer>Score v1 = familles indépendantes sur 6 h (25) + burst de terme (20) + vélocité HN (15) + étoiles GitHub 24 h (10) + upvotes HF (10) + annonce officielle (10) + posts sociaux 6 h (10). Les composantes sont visibles au survol du score. La presse (G) ne compte jamais dans le score : elle date la reprise. Un sujet sans presse est une anticipation, pas une certitude. Sources : API publiques et flux RSS uniquement.</footer>
<script>
const views=[...document.querySelectorAll('nav button')];views.forEach(b=>b.onclick=()=>{views.forEach(x=>x.classList.toggle('on',x===b));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('on',v.id===b.dataset.view));});
const fb=[...document.querySelectorAll('.filters button')];fb.forEach(b=>b.onclick=()=>{fb.forEach(x=>x.classList.toggle('on',x===b));const f=b.dataset.f;const now=Date.parse(${JSON.stringify(now)});document.querySelectorAll('#radar .topic').forEach(t=>{let show=true;if(f==='ANTICIPATION')show=t.dataset.status==='ANTICIPATION';else if(f==='6'||f==='24')show=(now-Date.parse(t.dataset.first))<=Number(f)*3600e3;t.style.display=show?'':'none';});});
</script></body></html>`;
}
