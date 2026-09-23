// Déclencheur externe du radar : un Worker Cloudflare (plan gratuit) appelle workflow_dispatch de radar.yml
// aux minutes 7 et 37 de chaque heure (UTC), parce que le cron GitHub n'exécute le workflow qu'environ toutes les 3 h.
// Le garde-fou du workflow (job « garde ») saute le passage si l'état a été sauvegardé il y a moins de 20 min,
// donc cron GitHub et Worker peuvent se doubler sans coût.
//
// Variables (wrangler.jsonc) : GITHUB_REPO, WORKFLOW_FILE, GIT_REF, SOURCE.
// Secrets (wrangler secret put) : GITHUB_TOKEN (jeton à granularité fine, dépôt ai-radar seul, permission Actions : écriture),
//                                 TRIGGER_KEY (clé pour le déclenchement manuel POST /dispatch ; sans elle, l'endpoint est fermé).

const API_VERSION = '2022-11-28';
const USER_AGENT = 'ai-radar-trigger (+https://github.com/ssaulay/ai-radar)';

export function buildDispatchRequest(env) {
  if (!env?.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN manquant : wrangler secret put GITHUB_TOKEN');
  const repo = env.GITHUB_REPO ?? 'ssaulay/ai-radar';
  const workflow = env.WORKFLOW_FILE ?? 'radar.yml';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  return new Request(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': USER_AGENT,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GIT_REF ?? 'main', inputs: { source: env.SOURCE ?? 'cloudflare-cron' } }),
  });
}

export async function dispatchRun(env, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(buildDispatchRequest(env));
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
  return { status: res.status, body: body.slice(0, 200) };
}

export default {
  async scheduled(controller, env) {
    const at = new Date(controller.scheduledTime ?? Date.now()).toISOString();
    try {
      const r = await dispatchRun(env);
      console.log(JSON.stringify({ ok: true, cron: controller.cron, at, status: r.status }));
    } catch (e) {
      console.error(JSON.stringify({ ok: false, cron: controller.cron, at, error: String(e.message ?? e) }));
      throw e; // visible comme échec dans les journaux Cloudflare
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/dispatch') {
      const key = request.headers.get('x-trigger-key');
      if (!env.TRIGGER_KEY || !key || key !== env.TRIGGER_KEY) return new Response('non autorisé', { status: 401 });
      try { return Response.json(await dispatchRun(env)); } catch (e) { return new Response(String(e.message ?? e), { status: 502 }); }
    }
    return new Response(`ai-radar-trigger : cron 7,37 * * * * (UTC) -> workflow_dispatch ${env.WORKFLOW_FILE ?? 'radar.yml'} sur ${env.GITHUB_REPO ?? 'ssaulay/ai-radar'} (source ${env.SOURCE ?? 'cloudflare-cron'})\n`, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
