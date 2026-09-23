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
// Stockage : int8 quantifie avec une echelle float32 par vecteur (4 octets + dim octets), quatre fois plus compact que float32 ;
// erreur de cosinus inferieure a 0,005 sur des vecteurs unitaires de 512 dimensions, sans effet sur les seuils 0,62 / 0,74.
// Les anciens blobs float32 (dim x 4 octets) restent lisibles ; la purge les convertit.
export const toBlob = v => { let m = 0; for (const x of v) { const a = Math.abs(x); if (a > m) m = a; } const scale = m / 127 || 1; const out = Buffer.alloc(4 + v.length); out.writeFloatLE(scale, 0); for (let i = 0; i < v.length; i++) out.writeInt8(Math.max(-127, Math.min(127, Math.round(v[i] / scale))), 4 + i); return out; };
export const isFloat32Blob = b => b.byteLength % 4 === 0 && (b.byteLength === 2048 || b.byteLength === 6144 || b.byteLength === 1024);
export const fromBlob = b => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (isFloat32Blob(buf)) { const f = new Float32Array(buf.byteLength / 4); for (let i = 0; i < f.length; i++) f[i] = buf.readFloatLE(i * 4); return f; }
  const scale = buf.readFloatLE(0); const n = buf.byteLength - 4; const v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = buf.readInt8(4 + i) * scale; return v;
};
// conversion des anciens blobs float32 vers int8 (embeddings, centroides, embeddings presse) ; idempotente
export function compactVectors(store) {
  let n = 0;
  for (const [table, key, col] of [['embeddings', 'item_id', 'vec'], ['clusters', 'cluster_id', 'centroid'], ['press_embeddings', 'url_hash', 'vec']]) {
    try { const rows = store.all(`SELECT ${key} k, ${col} v FROM ${table} WHERE ${col} IS NOT NULL AND length(${col}) IN (1024, 2048, 6144)`); store.tx(() => { for (const r of rows) { store.run(`UPDATE ${table} SET ${col}=? WHERE ${key}=?`, toBlob(fromBlob(r.v)), r.k); n++; } }); } catch {}
  }
  return n;
}

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
