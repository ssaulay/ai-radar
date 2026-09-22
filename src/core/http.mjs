// Client HTTP leger et poli : User-Agent identifiable, robots.txt pour les pages HTML, delai par hote, timeout, 429 classe TEMPORARY.
// Pas de cache disque : les flux changent en continu et les reponses sont petites.
const UA = 'ai-radar/0.1 (+https://github.com/simon-saulay/ai-radar; research; contact simon.saulay@brevo.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeHttp({ hostDelayMs = 700, timeoutMs = 20000, counters = {} } = {}) {
  const lastHit = new Map(); const robots = new Map();
  counters.requests = counters.requests ?? 0; counters.errors = counters.errors ?? 0;

  async function allowed(url) {
    const u = new URL(url); const key = u.origin;
    if (!robots.has(key)) {
      const rules = [];
      try {
        const r = await fetch(`${key}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (r.ok) { let applies = false; for (const raw of (await r.text()).split('\n')) { const line = raw.replace(/#.*/, '').trim(); if (!line) continue; const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(); if (/^user-agent$/i.test(k)) applies = v === '*'; else if (applies && /^disallow$/i.test(k) && v) rules.push(new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'))); } }
      } catch {}
      robots.set(key, rules);
    }
    const p = u.pathname + u.search; return !robots.get(key).some(re => re.test(p));
  }

  // opts.api = true : appel d'API ou de flux publie pour les machines, robots.txt non applicable
  return async function get(url, { accept = 'application/json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5', headers = {}, api = true, hostDelay = hostDelayMs } = {}) {
    let host; try { host = new URL(url).host; } catch { return { url, error: 'PERMANENT_BAD_URL' }; }
    if (!api && !(await allowed(url))) return { url, error: 'RESTRICTED_ROBOTS' };
    const wait = hostDelay - (Date.now() - (lastHit.get(host) ?? 0)); if (wait > 0) await sleep(wait); lastHit.set(host, Date.now());
    const started = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en,fr;q=0.8', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      counters.requests++;
      const body = await r.text();
      if (r.status === 429) { counters.errors++; return { url, status: 429, error: 'TEMPORARY_RATE_LIMIT', retryAfter: r.headers.get('retry-after'), ms: Date.now() - started }; }
      if (!r.ok) { counters.errors++; return { url, status: r.status, error: r.status >= 500 ? `TEMPORARY_HTTP_${r.status}` : r.status === 403 || r.status === 401 ? `RESTRICTED_HTTP_${r.status}` : `PERMANENT_HTTP_${r.status}`, body, ms: Date.now() - started }; }
      return { url, finalUrl: r.url, status: r.status, body, contentType: r.headers.get('content-type') ?? '', headers: r.headers, ms: Date.now() - started };
    } catch (e) {
      counters.errors++;
      return { url, error: e.name === 'TimeoutError' ? 'TEMPORARY_TIMEOUT' : `TEMPORARY_${e.cause?.code ?? e.name}`, ms: Date.now() - started };
    }
  };
}
