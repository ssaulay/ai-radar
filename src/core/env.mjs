// Chargement de .env (jamais copie dans les exports) et configuration des fournisseurs LLM.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(root) {
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

// Catalogue de fournisseurs compatibles OpenAI. Tarifs publics indicatifs USD / million de tokens, a confirmer.
export function llmProviders(manifest) {
  const out = [];
  const openaiKey = process.env.openai_API_KEY ?? process.env.OPENAI_API_KEY;
  if (openaiKey) out.push({ name: 'openai', base: 'https://api.openai.com/v1', key: openaiKey, model: manifest?.llm?.openai_model ?? 'gpt-5.4-nano', textChars: 60000, minGapMs: 0, inUsd: 0.05, outUsd: 0.40, free: false, reasoning: 'minimal' });
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL) out.push({ name: 'groq', base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, textChars: 20000, minGapMs: 20000, inUsd: 0.15, outUsd: 0.60, free: true });
  const preferred = process.env.ECOSYSTEM_LLM ?? manifest?.llm?.default ?? 'openai';
  out.sort((a, b) => (a.name === preferred ? -1 : b.name === preferred ? 1 : 0));
  return out;
}
