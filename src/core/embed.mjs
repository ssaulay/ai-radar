// Embeddings : OpenAI text-embedding-3-small par lots (0,02 USD par million de tokens), avec repli hors ligne par hachage de tokens
// (sans reseau, qualite moindre) pour les tests et l'absence de cle. Les vecteurs sont normalises (norme 1).
import { normName } from './text.mjs';

export function hashEmbed(text, dim = 512) {
  const v = new Float32Array(dim);
  const toks = normName(text).split(' ').filter(Boolean);
  const grams = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
  for (const g of grams) { let h = 2166136261; for (let i = 0; i < g.length; i++) { h ^= g.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } v[h % dim] += (h & 1) ? 1 : -1; }
  return normalize(v);
}
export function normalize(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; }
export function cosine(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
export const toBlob = v => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = b => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

export function makeEmbedder({ apiKey = process.env.OPENAI_API_KEY, model = 'text-embedding-3-small', dim = 512, counters = {}, forceHash = false } = {}) {
  // 512 dimensions suffisent pour des titres et divisent l'etat par trois par rapport a 1536
  counters.embedTokens = counters.embedTokens ?? 0; counters.embedUsd = counters.embedUsd ?? 0; counters.embedCalls = counters.embedCalls ?? 0;
  if (!apiKey || forceHash) return { name: 'hash', dim: 512, embed: async texts => texts.map(t => hashEmbed(t)) };
  return {
    name: model, dim,
    async embed(texts) {
      const out = new Array(texts.length);
      for (let i = 0; i < texts.length; i += 100) {
        const batch = texts.slice(i, i + 100).map(t => t.slice(0, 1500));
        let j; let attempt = 0;
        while (true) {
          const r = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: batch, dimensions: dim }), signal: AbortSignal.timeout(60000) });
          j = await r.json(); counters.embedCalls++;
          if (!j.error) break;
          if (attempt++ >= 2) throw new Error(`embeddings: ${j.error.message}`);
          await new Promise(res => setTimeout(res, 3000 * attempt));
        }
        counters.embedTokens += j.usage?.total_tokens ?? 0; counters.embedUsd += ((j.usage?.total_tokens ?? 0) / 1e6) * 0.02;
        for (const d of j.data) out[i + d.index] = normalize(Float32Array.from(d.embedding));
      }
      return out;
    },
  };
}
