// Parseurs par type de source. Chaque parseur rend des items normalises :
// { external_id, url, title, text, author, published_at (ISO ou null), score_raw, comments, kind, lang, raw }
import { decodeEntities } from '../core/text.mjs';

// Contenu d'une balise : CDATA retire, entites decodees (le HTML echappe redevient du HTML), balises retirees, entites du texte decodees.
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); return m ? decodeEntities(decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''; };
const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

export function parseFeed(xml, feedUrl) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const isRdf = /<rdf:RDF/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    let link = '';
    if (isAtom) { const m = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ?? b.match(/<link[^>]*href=["']([^"']+)["']/i); link = m?.[1] ?? ''; }
    else link = tag(b, 'link') || (b.match(/<guid[^>]*>(https?:[^<]+)<\/guid>/i)?.[1] ?? '') || (isRdf ? (b.match(/rdf:about=["']([^"']+)["']/i)?.[1] ?? '') : '');
    try { link = new URL(decodeEntities(link.trim()), feedUrl).href; } catch {}
    const id = (isAtom ? tag(b, 'id') : tag(b, 'guid')) || link;
    const published = tag(b, isAtom ? 'published' : 'pubDate') || tag(b, isAtom ? 'updated' : 'dc:date');
    const source = tag(b, 'source');
    items.push({ external_id: id, url: link, title: tag(b, 'title'), text: (tag(b, isAtom ? 'summary' : 'description') || tag(b, 'content') || tag(b, 'content:encoded')).slice(0, 1200), author: tag(b, isAtom ? 'name' : 'dc:creator') || tag(b, 'author') || source || null, published_at: iso(published), kind: 'POST', raw: source ? { source } : null });
  }
  return items;
}

// Hacker News : liste d'ids (topstories/newstories) puis items ; le rang est conserve pour la normalisation d'attention.
export function parseHnItems(itemsJson, { withRank = false } = {}) {
  return itemsJson.filter(Boolean).filter(i => i.type === 'story' && !i.deleted && !i.dead).map((i, idx) => ({
    external_id: String(i.id), url: i.url || `https://news.ycombinator.com/item?id=${i.id}`, title: i.title ?? '', text: (i.text ?? '').replace(/<[^>]+>/g, ' ').slice(0, 1200), author: i.by ?? null,
    published_at: iso(i.time * 1000), score_raw: i.score ?? 0, comments: i.descendants ?? 0, kind: /^show hn/i.test(i.title ?? '') ? 'SHOW_HN' : /^launch hn/i.test(i.title ?? '') ? 'LAUNCH_HN' : /^ask hn/i.test(i.title ?? '') ? 'ASK_HN' : 'STORY', rank: withRank ? idx + 1 : null, raw: { hn_url: `https://news.ycombinator.com/item?id=${i.id}` },
  }));
}
export function parseHnAlgolia(json) {
  return (json.hits ?? []).map(h => ({ external_id: String(h.objectID), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, title: h.title ?? '', text: (h.story_text ?? '').replace(/<[^>]+>/g, ' ').slice(0, 1200), author: h.author ?? null, published_at: iso(h.created_at), score_raw: h.points ?? 0, comments: h.num_comments ?? 0, kind: 'STORY', raw: { hn_url: `https://news.ycombinator.com/item?id=${h.objectID}` } }));
}

// Hugging Face Hub : modeles, datasets, spaces tries par trendingScore
export function parseHfHub(json, kind) {
  const prefix = kind === 'DATASET' ? 'datasets/' : kind === 'SPACE' ? 'spaces/' : '';
  return (json ?? []).map(m => ({ external_id: m.id, url: `https://huggingface.co/${prefix}${m.id}`, title: m.id, text: [m.pipeline_tag, ...(m.tags ?? []).slice(0, 12)].filter(Boolean).join(', '), author: m.author ?? m.id.split('/')[0], published_at: iso(m.lastModified ?? m.createdAt), score_raw: m.trendingScore ?? m.likes ?? 0, comments: m.downloads ?? null, kind, raw: { likes: m.likes, downloads: m.downloads, trendingScore: m.trendingScore, createdAt: m.createdAt } }));
}
export function parseHfPapers(json) {
  return (json ?? []).map(p => { const a = p.paper ?? {}; return { external_id: a.id ?? p.paper?.id, url: `https://huggingface.co/papers/${a.id}`, title: a.title ?? p.title ?? '', text: (a.summary ?? '').slice(0, 1200), author: (a.authors ?? []).slice(0, 3).map(x => x.name).join(', ') || null, published_at: iso(p.publishedAt ?? a.publishedAt), score_raw: a.upvotes ?? p.upvotes ?? 0, comments: p.numComments ?? null, kind: 'PAPER', raw: { arxiv: a.id, githubRepo: a.githubRepo ?? null, githubStars: a.githubStars ?? null, submittedOnDailyAt: p.submittedOnDailyAt ?? null } }; });
}

// OpenRouter : catalogue de modeles API ; l'apparition d'un id est l'evenement
export function parseOpenRouter(json) {
  return (json.data ?? []).map(m => ({ external_id: m.id, url: `https://openrouter.ai/${m.id}`, title: m.name ?? m.id, text: (m.description ?? '').slice(0, 600), author: m.id.split('/')[0], published_at: iso((m.created ?? 0) * 1000), score_raw: null, kind: 'MODEL_LISTED', raw: { context_length: m.context_length, pricing: m.pricing } }));
}

// GitHub search repositories
export function parseGithubSearch(json) {
  return (json.items ?? []).map(r => ({ external_id: String(r.id), url: r.html_url, title: `${r.full_name}: ${r.description ?? ''}`.slice(0, 300), text: (r.description ?? '') + (r.topics?.length ? ` [${r.topics.join(', ')}]` : ''), author: r.owner?.login ?? null, published_at: iso(r.created_at), score_raw: r.stargazers_count ?? 0, comments: r.forks_count ?? null, kind: 'REPO', raw: { language: r.language, pushed_at: r.pushed_at, topics: r.topics } }));
}

// Lobste.rs JSON
export function parseLobsters(json) {
  return (json ?? []).map(s => ({ external_id: s.short_id, url: s.url || s.comments_url, title: s.title, text: (s.description ?? '').replace(/<[^>]+>/g, ' ').slice(0, 600), author: s.submitter_user?.username ?? s.submitter_user ?? null, published_at: iso(s.created_at), score_raw: s.score ?? 0, comments: s.comment_count ?? 0, kind: 'STORY', raw: { tags: s.tags, comments_url: s.comments_url } }));
}

// Mastodon timelines / trends links
export function parseMastodonStatuses(json, instance) {
  return (json ?? []).map(s => ({ external_id: s.uri ?? s.id, url: s.url ?? s.uri, title: s.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200), text: s.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200), author: s.account?.acct ? `${s.account.acct}@${instance}` : null, published_at: iso(s.created_at), score_raw: (s.reblogs_count ?? 0) + (s.favourites_count ?? 0), comments: s.replies_count ?? 0, kind: 'POST', lang: s.language ?? null, raw: { tags: (s.tags ?? []).map(t => t.name) } }));
}
export function parseMastodonLinks(json) {
  return (json ?? []).map(l => ({ external_id: l.url, url: l.url, title: l.title ?? '', text: (l.description ?? '').slice(0, 600), author: l.provider_name ?? null, published_at: iso(l.published_at) ?? null, score_raw: (l.history ?? []).slice(0, 2).reduce((a, h) => a + Number(h.uses ?? 0), 0), comments: (l.history ?? []).slice(0, 2).reduce((a, h) => a + Number(h.accounts ?? 0), 0), kind: 'TREND_LINK', raw: null }));
}

// Bluesky (public sans compte : trends, author feed ; search avec compte)
export function parseBskyPosts(json) {
  const posts = (json.posts ?? json.feed?.map(f => f.post) ?? []);
  return posts.filter(Boolean).map(p => { const rkey = p.uri.split('/').pop(); const handle = p.author?.handle ?? 'unknown'; return { external_id: p.uri, url: `https://bsky.app/profile/${handle}/post/${rkey}`, title: (p.record?.text ?? '').replace(/\s+/g, ' ').slice(0, 200), text: (p.record?.text ?? '').slice(0, 1200), author: handle, published_at: iso(p.record?.createdAt ?? p.indexedAt), score_raw: (p.likeCount ?? 0) + (p.repostCount ?? 0) * 2, comments: p.replyCount ?? 0, kind: 'POST', lang: (p.record?.langs ?? [])[0] ?? null, raw: { likes: p.likeCount, reposts: p.repostCount, quotes: p.quoteCount, embed_url: p.embed?.external?.uri ?? null } }; });
}
export function parseBskyTrends(json) {
  return (json.trends ?? json.topics ?? []).map(t => ({ external_id: `trend:${t.topic ?? t.displayName}:${(t.startedAt ?? '').slice(0, 10)}`, url: t.link ? `https://bsky.app${t.link}` : 'https://bsky.app', title: t.displayName ?? t.topic ?? '', text: (t.category ? `catégorie ${t.category}` : ''), author: null, published_at: iso(t.startedAt), score_raw: t.postCount ?? null, kind: 'TREND', raw: { status: t.status, category: t.category } }));
}

// Marches de prediction
export function parseManifold(json) {
  return (json ?? []).map(m => ({ external_id: m.id, url: m.url, title: m.question, text: `p=${(m.probability ?? 0).toFixed(2)} volume24h=${Math.round(m.volume24Hours ?? 0)} bettors=${m.uniqueBettorCount ?? 0}`, author: m.creatorUsername ?? null, published_at: iso(m.lastUpdatedTime ?? m.createdTime), score_raw: m.volume24Hours ?? 0, comments: m.uniqueBettorCount ?? null, kind: 'MARKET', raw: { probability: m.probability, closeTime: m.closeTime, volume: m.volume } }));
}
export function parseKalshi(json) {
  return (json.markets ?? []).map(m => ({ external_id: m.ticker, url: `https://kalshi.com/markets/${(m.event_ticker ?? m.ticker).toLowerCase()}`, title: m.title ?? m.ticker, text: `yes=${m.yes_bid ?? '?'}/${m.yes_ask ?? '?'} volume24h=${m.volume_24h ?? 0} status=${m.status}`, author: 'kalshi', published_at: iso(m.open_time), score_raw: m.volume_24h ?? 0, comments: null, kind: 'MARKET', raw: { yes_bid: m.yes_bid, yes_ask: m.yes_ask, last_price: m.last_price, close_time: m.close_time, event_ticker: m.event_ticker } }));
}
