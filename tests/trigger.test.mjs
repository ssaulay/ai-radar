import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildDispatchRequest, dispatchRun } from '../infra/cloudflare-trigger/src/index.mjs';

const env = { GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'ssaulay/ai-radar', WORKFLOW_FILE: 'radar.yml', GIT_REF: 'main', SOURCE: 'cloudflare-cron', TRIGGER_KEY: 'k' };

test('buildDispatchRequest : POST sur l’API dispatch avec jeton, version d’API, User-Agent et source', async () => {
  const req = buildDispatchRequest(env);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.github.com/repos/ssaulay/ai-radar/actions/workflows/radar.yml/dispatches');
  assert.equal(req.headers.get('authorization'), 'Bearer ghp_test');
  assert.equal(req.headers.get('accept'), 'application/vnd.github+json');
  assert.equal(req.headers.get('x-github-api-version'), '2022-11-28');
  assert.ok(req.headers.get('user-agent'), 'GitHub exige un User-Agent');
  assert.deepEqual(await req.json(), { ref: 'main', inputs: { source: 'cloudflare-cron' } });
});

test('buildDispatchRequest : sans jeton, erreur explicite', () => {
  assert.throws(() => buildDispatchRequest({ ...env, GITHUB_TOKEN: undefined }), /GITHUB_TOKEN/);
});

test('dispatchRun : 204 accepté, erreur HTTP remontée avec le statut', async () => {
  const ok = await dispatchRun(env, async () => new Response(null, { status: 204 }));
  assert.equal(ok.status, 204);
  await assert.rejects(dispatchRun(env, async () => new Response('{"message":"Bad credentials"}', { status: 401 })), /GitHub 401.*Bad credentials/);
});

test('fetch : GET renvoie une page d’état, POST /dispatch exige la clé', async () => {
  const home = await worker.fetch(new Request('https://x.workers.dev/'), env);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /7,37/);
  const noKey = await worker.fetch(new Request('https://x.workers.dev/dispatch', { method: 'POST' }), env);
  assert.equal(noKey.status, 401);
  const badKey = await worker.fetch(new Request('https://x.workers.dev/dispatch', { method: 'POST', headers: { 'x-trigger-key': 'nope' } }), env);
  assert.equal(badKey.status, 401);
  const noKeyConfigured = await worker.fetch(new Request('https://x.workers.dev/dispatch', { method: 'POST', headers: { 'x-trigger-key': 'k' } }), { ...env, TRIGGER_KEY: undefined });
  assert.equal(noKeyConfigured.status, 401, 'sans TRIGGER_KEY configurée, le déclenchement manuel est fermé');
});

test('fetch : POST /dispatch avec la clé déclenche le workflow', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (req) => { calls.push(req.url); return new Response(null, { status: 204 }); };
  try {
    const res = await worker.fetch(new Request('https://x.workers.dev/dispatch', { method: 'POST', headers: { 'x-trigger-key': 'k' } }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://api.github.com/repos/ssaulay/ai-radar/actions/workflows/radar.yml/dispatches']);
  } finally { globalThis.fetch = orig; }
});

test('scheduled : appelle dispatchRun et journalise le cron', async () => {
  const orig = globalThis.fetch; let called = 0;
  globalThis.fetch = async () => { called++; return new Response(null, { status: 204 }); };
  try {
    await worker.scheduled({ cron: '7,37 * * * *', scheduledTime: Date.now() }, env, { waitUntil() {} });
    assert.equal(called, 1);
  } finally { globalThis.fetch = orig; }
});
