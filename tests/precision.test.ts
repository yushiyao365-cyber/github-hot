import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { Github } from '../server/github.js';
import { SyncService } from '../server/sync.js';
import { makeApp } from '../server/app.js';
import { defaultSettings } from '../server/config.js';
import { automaticTick } from '../server/automation.js';
import { growthRate, isNewProject, isRising } from '../shared/signals.js';
import { fixtureRepo } from './fixtures.js';
import { analysisReply, testReadme } from './analysis-fixtures.js';
import type { EvidenceSource } from '../shared/types.js';

const settings = { ...defaultSettings, dailyLimit: 2, model: { ...defaultSettings.model, enabled: true, autoAnalyze: true, dailyBudget: 0, name: 'fixture', endpoint: 'https://model.test/v1/chat/completions' } };
const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };

function modelOnly(calls: string[], verdict = 'recommend'): typeof fetch {
  return (async (input, init) => {
    assert.ok(String(input).startsWith('https://model.test'), '缓存分析不应访问 GitHub');
    const body = String(init?.body);
    calls.push(body);
    const sources = JSON.parse(JSON.parse(body).messages[1].content).sources as EvidenceSource[];
    return Response.json({ choices: [{ message: { content: JSON.stringify(analysisReply(sources, verdict)) } }] });
  }) as typeof fetch;
}

test('HTTP 缓存按 Token 隔离，支持 TTL 和 ETag 304，不暴露凭据', async () => {
  const store = new Store(':memory:');
  let requests = 0;
  const seen: Headers[] = [];
  const fetcher = (async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return seen.length === 2 ? new Response(null, { status: 304 }) : Response.json({ stars: 42 }, { headers: { etag: 'version-1', 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1800000000' } });
  }) as typeof fetch;
  try {
    const client = new Github('PRIVATE-TOKEN', () => requests++, fetcher, store);
    assert.deepEqual(await client.get('/repos/example/tool'), { stars: 42 });
    await client.get('/repos/example/tool', 60000);
    assert.equal(requests, 1);
    assert.deepEqual(await client.get('/repos/example/tool'), { stars: 42 });
    assert.equal(seen[1].get('if-none-match'), 'version-1');
    await new Github('OTHER-TOKEN', () => requests++, fetcher, store).get('/repos/example/tool', 60000);
    assert.equal(requests, 3);
    assert.equal(seen[2].get('if-none-match'), null);
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM kv').all()).includes('PRIVATE-TOKEN'));
    assert.equal(store.get('githubRate:core', { remaining: 0 }).remaining, 4999);
  } finally { store.close(); }
});

test('新建依据真实创建时间，日均增速仅用新鲜且至少24小时的快照', () => {
  const now = Date.now();
  const sample = (days: number, delta: number, stale = 0) => ({ growth: { from: new Date(now - (days + stale) * 86400000).toISOString(), to: new Date(now - stale * 86400000).toISOString(), days, starsDelta: delta } });
  assert.equal(growthRate(sample(2, 40), now), 20);
  assert.equal(isRising(sample(2, 40), settings, now), true);
  assert.equal(isRising(sample(2, 10), settings, now), false);
  assert.equal(growthRate(sample(0.5, 100), now), null);
  assert.equal(growthRate(sample(2, 100, 4), now), null);
  assert.equal(growthRate(sample(15, 100), now), null);
  assert.equal(growthRate(sample(2, -20), now), -10);
  assert.equal(growthRate({ growth: null }, now), null);
  assert.equal(isNewProject(fixtureRepo(1, { createdAt: new Date(now - 31 * 86400000).toISOString() }), settings, now), false);
  assert.equal(isNewProject(fixtureRepo(1, { createdAt: new Date(now - 31 * 86400000).toISOString() }), { ...settings, recommendations: { ...settings.recommendations, newProjectDays: 60 } }, now), true);
});

test('限流时自动分析缓存；缺资料项目等待但不阻塞有证据的项目，首页只展示完成报告', async () => {
  const store = new Store(':memory:');
  store.set('settings', settings);
  store.upsertRepo(fixtureRepo(1, { stars: 20000, readme: '' }));
  store.upsertRepo(fixtureRepo(2, { stars: 2000, readme: testReadme }));
  store.patchRepo(2, { readme: testReadme });
  store.set('sync', { ...store.status(), retryAt: new Date(Date.now() + 3600000).toISOString() });
  const calls: string[] = [];
  const { app, sync, analyses, dashboard } = makeApp(store, { serveStatic: false, fetcher: modelOnly(calls) });
  try {
    assert.equal(dashboard().highStarIds.length, 0);
    automaticTick(store, sync, analyses);
    await analyses.idle();
    assert.equal(calls.length, 1);
    assert.equal(analyses.decorate(store.repo(1)!).analysis?.status, 'waiting');
    assert.equal(store.analysis(1), null);
    assert.ok(store.analysis(2)?.evidenceNote?.includes('缓存'));
    assert.deepEqual(dashboard().highStarIds, [2]);
    analyses.start(2); await analyses.idle();
    assert.equal(calls.length, 1);
    automaticTick(store, sync, analyses); await analyses.idle();
    assert.equal(calls.length, 1);
  } finally { await app.close(); store.close(); }
});

test('自动精选不拿 watch 报告凑数，单轮候选数量有限且定时轮询不会反复调用', async () => {
  const store = new Store(':memory:');
  store.set('settings', settings);
  for (let id = 1; id <= 8; id++) {
    store.upsertRepo(fixtureRepo(id));
    store.patchRepo(id, { readme: testReadme });
  }
  store.set('sync', { ...store.status(), retryAt: new Date(Date.now() + 3600000).toISOString() });
  const calls: string[] = [];
  const { app, analyses, dashboard } = makeApp(store, { serveStatic: false, fetcher: modelOnly(calls, 'watch') });
  try {
    assert.equal(analyses.autoStart(), true); await analyses.idle();
    assert.equal(calls.length, 8);
    assert.equal(dashboard().highStarIds.length, 0);
    assert.equal(analyses.autoStart(), false);
    assert.equal(calls.length, 8);
  } finally { await app.close(); store.close(); }
});

test('绑定新 Token 清除旧匿名退避，保留偏好且不向浏览器回传 Token', async () => {
  const store = new Store(':memory:');
  store.set('settings', settings);
  store.set('sync', { ...store.status(), retryAt: new Date(Date.now() + 3600000).toISOString(), lastDiscoveryAt: new Date().toISOString() });
  const { app } = makeApp(store, { serveStatic: false });
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings, githubToken: 'PERSONAL-SECRET' } });
    assert.equal(response.statusCode, 200);
    assert.equal(store.secret('githubToken'), 'PERSONAL-SECRET');
    assert.equal(store.status().retryAt, null);
    assert.equal(store.status().lastDiscoveryAt, null);
    assert.equal(store.settings().model.dailyBudget, 0);
    assert.equal(store.settings().dailyLimit, 2);
    assert.ok(!response.body.includes('PERSONAL-SECRET'));
    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    assert.ok(!dashboard.body.includes('PERSONAL-SECRET'));
  } finally { await app.close(); store.close(); }
});

test('搜索新项目不设 Star 上限，搜索只拉元数据，不为所有候选读取 README', async () => {
  const store = new Store(':memory:');
  store.saveSecrets({ githubToken: 'fixture-token' });
  const urls: string[] = [];
  const sync = new SyncService(store, (async input => {
    urls.push(String(input));
    return Response.json({ items: [], total_count: 0, incomplete_results: false });
  }) as typeof fetch, async () => {});
  try {
    sync.start('discovery'); await sync.idle();
    assert.equal(urls.length, 12);
    assert.ok(urls.every(url => new URL(url).pathname === '/search/repositories'));
    const queries = urls.map(url => new URL(url).searchParams.get('q')!);
    assert.equal(queries.filter(query => query.includes('created:>=') && !query.includes('stars:')).length, 4);
  } finally { store.close(); }
});
