// Client LLM compatible OpenAI. Le modele propose ; il ne prouve jamais rien. Chaque appel est journalise avec tokens et cout indicatif.
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeLlm(store, providers, { runId = null, maxCalls = Infinity, counters = {} } = {}) {
  const ctx = { runId };
  const lastAt = new Map(); counters.llmCalls = counters.llmCalls ?? 0; counters.llmUsd = counters.llmUsd ?? 0;
  if (!providers.length) return { enabled: false, ctx, counters, json: async () => ({ error: 'LLM_DISABLED' }), provider: null };
  const prov = providers[0];

  async function json(purpose, messages, { documentUrl = null, textChars = prov.textChars, maxOut = 4000, attempt = 0 } = {}) {
    if (attempt === 0) { if (counters.llmCalls >= maxCalls) return { error: 'LLM_BUDGET_EXHAUSTED' }; counters.llmCalls++; }
    const gap = prov.minGapMs - (Date.now() - (lastAt.get(prov.name) ?? 0)); if (gap > 0) await sleep(gap); lastAt.set(prov.name, Date.now());
    const isReasoning = /^(gpt-5|o\d)/.test(prov.model);
    const body = { model: prov.model, response_format: { type: 'json_object' }, messages };
    if (isReasoning) { body.max_completion_tokens = maxOut + 2000; if (prov.reasoning) body.reasoning_effort = prov.reasoning; } else { body.temperature = 0; body.max_tokens = maxOut; }
    const started = Date.now();
    try {
      const r = await fetch(`${prov.base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${prov.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const j = await r.json();
      if (j.error) {
        const msg = j.error.message ?? JSON.stringify(j.error);
        store.run('INSERT INTO llm_calls(run_id,purpose,provider,model,document_url,ms,ok,error,created_at) VALUES (?,?,?,?,?,?,0,?,?)', ctx.runId, purpose, prov.name, prov.model, documentUrl, Date.now() - started, msg.slice(0, 200), store.now());
        if (attempt < 3 && (r.status === 429 || /rate limit/i.test(msg))) { const w = msg.match(/try again in ([\d.]+)s/i); await sleep(((w ? Number(w[1]) : 20) + 2) * 1000); return json(purpose, messages, { documentUrl, textChars, maxOut, attempt: attempt + 1 }); }
        if (attempt < 1 && /reasoning_effort|unsupported/i.test(msg)) { prov.reasoning = undefined; return json(purpose, messages, { documentUrl, textChars, maxOut, attempt: attempt + 1 }); }
        return { error: /too large|context/i.test(msg) ? 'TOO_LARGE' : `LLM_ERROR ${msg.slice(0, 120)}` };
      }
      const usd = ((j.usage?.prompt_tokens ?? 0) / 1e6) * prov.inUsd + ((j.usage?.completion_tokens ?? 0) / 1e6) * prov.outUsd;
      counters.llmUsd += prov.free ? 0 : usd;
      store.run('INSERT INTO llm_calls(run_id,purpose,provider,model,document_url,prompt_tokens,completion_tokens,ms,ok,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)', ctx.runId, purpose, prov.name, prov.model, documentUrl, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0, Date.now() - started, store.now());
      const content = j.choices?.[0]?.message?.content ?? '{}';
      try { return { data: JSON.parse(content) }; } catch { try { return { data: JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) }; } catch { return { error: 'LLM_ERROR JSON_PARSE' }; } }
    } catch (e) {
      store.run('INSERT INTO llm_calls(run_id,purpose,provider,model,document_url,ms,ok,error,created_at) VALUES (?,?,?,?,?,?,0,?,?)', ctx.runId, purpose, prov.name, prov.model, documentUrl, Date.now() - started, e.name, store.now());
      return { error: `LLM_ERROR ${e.name}` };
    }
  }
  return { enabled: true, ctx, provider: prov, json, counters };
}
