// Pertinence IA d'un item et extraction d'entites / termes a partir du lexique. Aucun LLM.
import fs from 'node:fs';
import path from 'node:path';
import { normName } from '../core/text.mjs';

const AI_GENERIC = /\b(ai|a\.i\.|ia|artificial intelligence|intelligence artificielle|machine learning|apprentissage (automatique|profond)|deep learning|neural|llm|llms|gpt|chatgpt|openai|anthropic|claude|gemini|mistral|deepseek|llama|copilot|transformer|diffusion|generative|génératif|générative|agentic|agents?|rag|embedding|fine-?tun\w*|inference|inférence|foundation model|open[- ]weights?|hugging ?face|nvidia|gpu|tpu|robot\w*|autonomous|autonome|alignment|agi|superintelligen\w*|chatbot|vision model|speech model|text-to-\w+|multimodal|reasoning model|benchmark|tokens?|prompt\w*|hallucinat\w*|deepfake|synthetic (data|media)|compute|datacenter|data center)\b/i;

// Sources deja specialisees IA : tout ce qu'elles publient est pertinent. Les autres sont filtrees par mots-cles.
const AI_ONLY_PREFIX = /^(hn_algolia_ai|lobsters_ai|reddit_|bsky_search|hf_|arxiv_|openrouter_|github_new_ai|github_releases|blog_openai|blog_anthropic|blog_deepmind|blog_google_ai|blog_hf|blog_mistral|blog_nvidia_dev|blog_simonwillison|blog_latentspace|blog_interconnects|blog_importai|blog_rundown|blog_tldr_ai|blog_oneusefulthing|blog_lesswrong|forum_openai|forum_hf|forum_perplexity|forum_googleai|gnews_|press_techcrunch_ai|press_verge_ai|press_mittr_ai|press_wired_ai|press_lemonde_ia|press_actuia|manifold_|kalshi_)/;

export function loadLexicon(root) {
  const lex = JSON.parse(fs.readFileSync(path.join(root, 'config', 'lexicon.json'), 'utf8'));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entities = lex.entities.map(e => ({ name: e.name, type: e.type, re: new RegExp(`(^|[^\\p{L}\\p{N}])(${[e.name, ...e.aliases].map(a => esc(a.toLowerCase())).sort((a, b) => b.length - a.length).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu') }));
  return { entities, stop: new Set([...(lex.stopwords_extra ?? []), ...STOP]) };
}

const STOP = ['a', 'an', 'of', 'in', 'on', 'to', 'is', 'are', 'be', 'by', 'at', 'as', 'it', 'its', "it's", 'or', 'not', 'no', 'we', 'i', 'my', 'me', 'he', 'she', 'they', 'his', 'her', 'their', 'than', 'then', 'there', 'here', 'about', 'after', 'before', 'over', 'under', 'up', 'down', 'out', 'more', 'most', 'less', 'just', 'now', 'today', 'first', 'last', 'one', 'two', 'all', 'any', 'can', 'could', 'will', 'would', 'should', 'has', 'have', 'had', 'do', 'does', 'did', 'was', 'were', 'been', 'being', 'get', 'got', 'make', 'made', 'like', 'also', 'but', 'if', 'so', 'vs', 'via', 'le', 'la', 'l', 'de', 'du', 'd', 'et', 'en', 'au', 'aux', 'un', 'une', 'ce', 'ces', 'cette', 'que', 'qui', 'quoi', 'ne', 'pas', 'plus', 'est', 'sont', 'son', 'sa', 'ses', 'leur', 'leurs', 'par', 'chez', 'vers', 'entre', 'comment', 'pourquoi', 'quand', 'où', 'ou', 'mais', 'donc', 'car', 'ni', 'y', 'on', 'nous', 'vous', 'ils', 'elles', 'il', 'elle', 'je', 'tu', 'show', 'hn', 'ask', 'launch', 'tell', 'new', 'says', 'said', 'report', 'reports', 'announces', 'launches', 'introduces', 'unveils', 'releases', 'released', 'update', 'updates', 'open', 'source', 'using', 'used', 'use', 'how', 'what', 'why', 'when', 'who', 'which', 'this', 'that', 'these', 'those', 'from', 'with', 'for', 'and', 'the', 'your', 'you', 'our', 'into', 'per', 'off', 'each', 'other', 'some', 'such', 'very', 'much', 'many', 'own', 'same', 'too', 'only', 'yet', 'still', 'even', 'ever', 'never', 'while', 'where', 'let', 'lets', 'us', 'them', 'him', 'against', 'between', 'through', 'during', 'without', 'within', 'along', 'across', 'behind', 'beyond', 'toward', 'towards', 'upon', 'among', 'around', 'back', 'best', 'top', 'big', 'small', 'good', 'bad', 'high', 'low', 'long', 'short', 'real', 'full', 'free', 'next', 'week', 'day', 'days', 'year', 'years', 'time', 'times', 'way', 'ways', 'thing', 'things', 'part', 'guide', 'introduction', 'review', 'overview', 'analysis', 'paper', 'papers', 'model', 'models', 'modèle', 'modèles', 'ai', 'ia', 'article', 'blog', 'post', 'news', 'video', 'thread', 'megathread', 'weekly', 'daily', 'monthly', 'edition', 'issue', 'episode', 'part'];

export function isAiRelevant(item) {
  if (AI_ONLY_PREFIX.test(item.source_id)) return true;
  return AI_GENERIC.test(`${item.title ?? ''} ${(item.text ?? '').slice(0, 300)}`);
}

export function extractEntities(text, lex) {
  const t = (text ?? '').toLowerCase(); const out = [];
  for (const e of lex.entities) if (e.re.test(t)) out.push(e.name);
  return out;
}

// Termes : entites du lexique + bigrammes de mots significatifs (hors stop words), pour capter des sujets absents du lexique.
export function extractTerms(title, lex) {
  const ents = extractEntities(title, lex).map(e => `@${e}`);
  const toks = normName(title).split(' ').filter(w => w.length > 2 && !lex.stop.has(w) && !/^\d+$/.test(w));
  const grams = new Set();
  for (let i = 0; i < toks.length - 1; i++) grams.add(`${toks[i]} ${toks[i + 1]}`);
  return [...new Set([...ents, ...grams])];
}
