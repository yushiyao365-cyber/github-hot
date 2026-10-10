import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { makeApp } from '../server/app.js';
import { fixtureRepo } from './fixtures.js';
import { analysisReply, testReadme } from './analysis-fixtures.js';
import { evidenceFor, parseAnalysis } from '../server/analyses.js';
import { createDashboardClient } from '../src/dashboard-client.js';
import type { Dashboard } from '../shared/types.js';

const headers = { host: '127.0.0.1:4310' };

test('项目证据按仓库查询正式版本，排序保持一致，不扫描全库版本表', async () => {
  const store = new Store(':memory:');
  for (const id of [1, 2]) store.upsertRepo(fixtureRepo(id));
  for (const [id, repoId, prerelease, publishedAt] of [[11, 1, false, '2026-09-01'], [12, 1, false, '2026-09-02'], [13, 1, true, '2026-09-04'], [21, 2, false, '2026-09-05']] as const) {
    store.upsertRelease({ id, repoId, tag: `v${id}`, body: `Release ${id}`, prerelease, publishedAt, url: `https://github.com/test-org/project-${repoId}/releases/tag/v${id}` }, false);
  }
  const { app, analyses } = makeApp(store, { serveStatic: false });
  try {
    assert.deepEqual(store.repoReleases(1).map(release => release.id), [12, 11]);
    store.releases = () => { throw new Error('不应扫描完整版本表'); };
    const repo = analyses.decorate(store.repo(1)!);
    assert.equal(repo.analysis?.status, 'pending');
    assert.deepEqual(evidenceFor(repo, store).filter(source => source.id.startsWith('release-')).map(source => source.id), ['release-12', 'release-11']);
  } finally { await app.close(); store.close(); }
});

test('列表不携带报告原文，详情保留完整证据；未关注版本不重复传输，关注可恢复', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo(1));
  store.patchRepo(1, { readme: testReadme });
  store.upsertRelease({ id: 10, repoId: 1, tag: 'v1', body: 'public release notes', publishedAt: '2026-09-30', prerelease: false }, false);
  const { app, analyses, dashboard } = makeApp(store, { serveStatic: false });
  try {
    const repo = analyses.decorate(store.repo(1)!);
    const sources = evidenceFor(repo, store);
    const report = parseAnalysis(JSON.stringify(analysisReply(sources)), repo, store.settings(), sources);
    store.saveAnalysis(report);
    const data = dashboard();
    assert.equal(data.repos[0].analysis?.status, 'done');
    assert.ok(data.repos[0].analysis?.report?.sources.every(source => source.text === ''));
    assert.equal(data.repos[0].analysis?.report?.overview, report.overview);
    assert.equal(data.releases.length, 0);
    assert.equal(store.releases().length, 1);
    const detail = await app.inject({ url: '/api/repos/1', headers });
    assert.ok(detail.json().repo.analysis.report.sources.some((source: { text: string }) => source.text === testReadme));
    assert.equal(detail.json().repo.readme, testReadme);
    store.patchRepo(1, { followed: true });
    assert.equal(dashboard().releases[0].body, 'public release notes');
  } finally { await app.close(); store.close(); }
});

test('未变化请求返回304不重算，读状态、设置、分析和外部数据库写入都使缓存失效', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-dashboard-test-'));
  const store = new Store(directory);
  store.upsertRepo(fixtureRepo(1));
  const { app } = makeApp(store, { serveStatic: false });
  try {
    let fullScans = 0;
    const releases = store.releases.bind(store);
    store.releases = () => { fullScans++; return releases(); };
    const first = await app.inject({ url: '/api/dashboard', headers });
    assert.equal(first.statusCode, 200);
    let etag = String(first.headers.etag);
    assert.ok(etag);
    const unchanged = await app.inject({ url: '/api/dashboard', headers: { ...headers, 'if-none-match': etag } });
    assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, ''); assert.equal(fullScans, 1);
    for (const mutate of [
      () => store.patchRepo(1, { read: true }),
      () => store.set('settings', { ...store.settings(), dailyLimit: 5 }),
      () => store.set('analysisJob', { running: true, completed: 1, total: 2, generated: 1 }),
      () => { const external = new DatabaseSync(join(directory, 'radar.sqlite')); external.prepare('UPDATE repos SET favorite=1 WHERE id=1').run(); external.close(); },
    ]) {
      mutate();
      const updated = await app.inject({ url: '/api/dashboard', headers: { ...headers, 'if-none-match': etag } });
      assert.equal(updated.statusCode, 200);
      assert.notEqual(updated.headers.etag, etag);
      etag = String(updated.headers.etag);
    }
    const final = await app.inject({ url: '/api/dashboard', headers });
    assert.equal(final.json().repos[0].favorite, true);
    assert.equal(final.json().repos[0].read, true);
    assert.equal(final.json().settings.dailyLimit, 5);
    assert.equal(final.headers['cache-control'], 'no-store');
    const forbidden = await app.inject({ url: '/api/dashboard', headers: { host: 'evil.test', 'if-none-match': etag } });
    assert.equal(forbidden.statusCode, 403);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('列表缓存过期后重算，防止时间相关信号永久停留在旧状态', async () => {
  const store = new Store(':memory:');
  const { app } = makeApp(store, { serveStatic: false });
  const originalNow = Date.now;
  try {
    let reads = 0;
    const repos = store.repos.bind(store);
    store.repos = () => { reads++; return repos(); };
    const first = await app.inject({ url: '/api/dashboard', headers });
    const start = originalNow();
    Date.now = () => start + 16000;
    await app.inject({ url: '/api/dashboard', headers: { ...headers, 'if-none-match': String(first.headers.etag) } });
    assert.equal(reads, 2);
  } finally { Date.now = originalNow; await app.close(); store.close(); }
});

test('浏览器刷新合并并发请求，304复用对象，写操作后必须再读一次', async () => {
  const responses: ((response: Response) => void)[] = [];
  const requests: RequestInit[] = [];
  const client = createDashboardClient((async (_url, init) => {
    requests.push(init!);
    return new Promise<Response>(resolve => responses.push(resolve));
  }) as typeof fetch);
  const first = client.refresh();
  assert.equal(client.refresh(), first); assert.equal(requests.length, 1);
  responses[0](Response.json({ repos: [], modelUsage: 0 }, { headers: { etag: 'v1' } }));
  const original = await first;
  const poll = client.refresh();
  const afterMutation = client.refresh(true);
  assert.equal(requests.length, 2);
  responses[1](new Response(null, { status: 304 }));
  assert.equal(await poll, original);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  responses[2](Response.json({ repos: [], modelUsage: 1 }, { headers: { etag: 'v2' } }));
  assert.equal((await afterMutation as Dashboard).modelUsage, 1);
  assert.equal(new Headers(requests[1].headers).get('if-none-match'), 'v1');
});

test('刷新失败会释放请求，不用错误响应覆盖已缓存数据', async () => {
  let calls = 0;
  const client = createDashboardClient((async () => {
    calls++;
    if (calls === 1) return Response.json({ repos: [] }, { headers: { etag: 'v1' } });
    if (calls === 2) return Response.json({ error: '暂时不可用' }, { status: 503 });
    return new Response(null, { status: 304 });
  }) as typeof fetch);
  const original = await client.refresh();
  await assert.rejects(client.refresh(), /暂时不可用/);
  assert.equal(await client.refresh(), original);
});
