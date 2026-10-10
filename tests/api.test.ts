import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../server/app.js';
import { defaultSettings } from '../server/config.js';
import { Store } from '../server/store.js';
import { Github } from '../server/github.js';
import { fixtureRepo, githubFixture } from './fixtures.js';
import { SyncService } from '../server/sync.js';
import { Summaries, summaryInput } from '../server/summaries.js';

const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };
test('全新实例没有默认订阅或虚构项目', async () => {
  const store = new Store(':memory:');
  const { app } = makeApp(store, { serveStatic: false });
  try {
    const response = await app.inject({ url: '/api/dashboard', headers });
    const data = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(data.repos, []); assert.deepEqual(data.featuredIds, []); assert.deepEqual(data.releases, []);
    assert.equal(data.settings.dailyLimit, 12);
  } finally { await app.close(); store.close(); }
});
test('保存数量立即改变精选，秘密不回传，非法输入不会覆盖已保存设置', async () => {
  const store = new Store(':memory:');
  for (let id = 1; id <= 32; id++) store.upsertRepo(fixtureRepo(id));
  const { app } = makeApp(store, { serveStatic: false });
  try {
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings: { ...defaultSettings, dailyLimit: 20 }, githubToken: 'secret-should-not-leak', modelKey: 'model-secret-should-not-leak' } });
    assert.equal(saved.statusCode, 200);
    const response = await app.inject({ url: '/api/dashboard', headers });
    assert.equal(response.json().featuredIds.length, 20);
    assert.equal(response.json().hasGithubToken, true);
    assert.ok(!response.body.includes('secret-should-not-leak'));
    const invalid = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings: { ...defaultSettings, dailyLimit: 0 }, githubToken: 'changed' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(store.settings().dailyLimit, 20); assert.equal(store.secret('githubToken'), 'secret-should-not-leak');
  } finally { await app.close(); store.close(); }
});
test('拒绝跨站写入、缺失客户端校验和 DNS rebinding Host', async () => {
  const store = new Store(':memory:');
  const { app } = makeApp(store, { serveStatic: false });
  try {
    for (const unsafe of [{ ...headers, origin: 'https://evil.example' }, { host: '127.0.0.1:4310' }, { ...headers, host: 'evil.example' }]) {
      const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: unsafe, payload: { settings: defaultSettings } });
      assert.equal(response.statusCode, 403);
    }
  } finally { await app.close(); store.close(); }
});
test('关注任意仓库，初次版本标为历史，重复同步去重且不读取 Tag', async () => {
  const store = new Store(':memory:');
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/repos/example/anything')) return Response.json({ ...githubFixture(), full_name: 'example/anything' });
    if (url.includes('/releases')) return Response.json([{ id: 101, tag_name: 'release-custom', name: 'A release', body: 'notes', published_at: '2020-01-01T00:00:00Z', draft: false, prerelease: false, html_url: 'https://github.com/example/anything/releases/tag/release-custom' }]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const { app, sync } = makeApp(store, { fetcher, serveStatic: false });
  try {
    const added = await app.inject({ method: 'POST', url: '/api/follows', headers, payload: { repository: 'example/anything' } });
    assert.equal(added.statusCode, 200);
    await sync.idle();
    assert.equal(store.repo(1)!.followed, true); assert.equal(store.releases()[0].baseline, true);
    sync.start('releases'); await sync.idle();
    assert.equal(store.releases().length, 1);
    assert.ok(requests.every(url => !url.includes('/tags')));
    await app.inject({ method: 'PATCH', url: '/api/repos/1', headers, payload: { favorite: true, followed: false } });
    const previous = requests.length; sync.start('releases'); await sync.idle();
    assert.equal(requests.length, previous); assert.equal(store.repo(1)!.favorite, true); assert.equal(store.releases().length, 1);
  } finally { await app.close(); store.close(); }
});
test('限流时记录恢复时间和不完整状态，不丢失缓存且禁止立即重试', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo()); store.patchRepo(1, { followed: true });
  const fetcher = (async () => new Response(null, { status: 429, headers: { 'retry-after': '60' } })) as typeof fetch;
  const sync = new SyncService(store, fetcher);
  try {
    sync.start('releases'); await sync.idle();
    assert.equal(store.repos().length, 1); assert.equal(store.status().incomplete, true); assert.equal(store.status().running, false);
    assert.ok(store.status().retryAt); assert.throws(() => sync.start('releases'));
  } finally { store.close(); }
});
test('GitHub Token 只放请求头且不跟随重定向', async () => {
  let options: RequestInit | undefined;
  let url = '';
  const client = new Github('private-token', () => {}, (async (input, init) => { url = String(input); options = init; return Response.json({}); }) as typeof fetch);
  await client.get('/repos/example/repo');
  assert.ok(url.startsWith('https://api.github.com/')); assert.ok(!url.includes('private-token'));
  assert.equal(options?.redirect, 'error');
});
test('模型默认不调用，开启后遵守预算与缓存，不发送个人备注或 GitHub 密钥', async () => {
  const store = new Store(':memory:');
  const repo = fixtureRepo(1, { notes: 'PRIVATE-NOTES' });
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    const body = String(init?.body);
    assert.ok(!body.includes('PRIVATE-NOTES')); assert.ok(!body.includes('GITHUB-SECRET'));
    return Response.json({ choices: [{ message: { content: '这是基于公开资料生成的测试摘要。' } }] });
  }) as typeof fetch;
  const summaries = new Summaries(store, fetcher);
  try {
    await assert.rejects(summaries.generate([repo])); assert.equal(calls, 0);
    store.saveSecrets({ githubToken: 'GITHUB-SECRET' });
    store.set('settings', { ...defaultSettings, model: { ...defaultSettings.model, enabled: true, name: 'test', dailyBudget: 1 } });
    assert.ok(!summaryInput(repo).includes('PRIVATE-NOTES'));
    const first = await summaries.generate([repo, fixtureRepo(2)]);
    assert.equal(first.generated, 1); assert.equal(calls, 1);
    const second = await summaries.generate([repo]); assert.equal(second.cached, 1); assert.equal(calls, 1);
    store.set('settings', { ...store.settings(), model: { ...store.settings().model, dailyBudget: 0 } });
    const unlimited = await summaries.generate(Array.from({ length: 15 }, (_, index) => fixtureRepo(index + 2)));
    assert.equal(unlimited.generated, 15); assert.equal(calls, 16);
  } finally { store.close(); }
});

test('首次发现建立基线，查询失败后从断点继续且不重复完成的查询', async () => {
  const store = new Store(':memory:');
  const queried: string[] = [];
  let id = 1;
  const fetcher = (async input => {
    const url = String(input);
    if (url.includes('/readme')) return new Response(null, { status: 404 });
    queried.push(url);
    if (queried.length === 2) return new Response(null, { status: 503 });
    return Response.json({ items: [githubFixture(id++)], total_count: 500, incomplete_results: true });
  }) as typeof fetch;
  const sync = new SyncService(store, fetcher, async () => {});
  try {
    sync.start('discovery'); await sync.idle();
    assert.equal(store.repos().length, 1); assert.equal(store.status().errors.length, 1);
    const completedQuery = queried[0];
    sync.start('discovery'); await sync.idle();
    sync.start('discovery'); await sync.idle();
    sync.start('discovery'); await sync.idle();
    assert.equal(queried.filter(url => url === completedQuery).length, 1);
    assert.equal(store.repos().length, 12);
    assert.ok(store.repos().every(repo => repo.baseline));
    assert.equal(store.get('discoveryInitialized', false), true);
    assert.equal(store.status().incomplete, true);
    assert.ok(queried.every(url => decodeURIComponent(url).includes('is:public')));
  } finally { store.close(); }
});

test('单个失效仓库不阻塞其他仓库更新', async () => {
  const store = new Store(':memory:');
  for (let id = 1; id <= 2; id++) { store.upsertRepo(fixtureRepo(id)); store.patchRepo(id, { followed: true }); }
  const fetcher = (async input => String(input).includes('/project-1/')
    ? new Response(null, { status: 404 })
    : Response.json([{ id: 200, tag_name: 'v2', name: 'v2', body: 'changes', published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false, html_url: 'https://github.com/test-org/project-2/releases/tag/v2' }])) as typeof fetch;
  const sync = new SyncService(store, fetcher);
  try {
    sync.start('releases'); await sync.idle();
    assert.equal(store.releases().length, 1);
    assert.equal(store.releases()[0].repoId, 2);
    assert.equal(store.status().errors.length, 1);
    assert.equal(store.status().incomplete, true);
  } finally { store.close(); }
});

test('版本分页超出单轮预算时保存游标，下一轮继续', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo()); store.patchRepo(1, { followed: true });
  const pages: number[] = [];
  const fetcher = (async input => {
    const page = Number(new URL(String(input)).searchParams.get('page')); pages.push(page);
    return Response.json(page < 4 ? Array.from({ length: 30 }, (_, index) => ({ id: page * 100 + index, tag_name: `v${page}.${index}`, name: null, body: '', published_at: '2020-01-01T00:00:00Z', draft: false, prerelease: false, html_url: 'https://github.com/test-org/project-1/releases' })) : []);
  }) as typeof fetch;
  const sync = new SyncService(store, fetcher);
  try {
    sync.start('releases'); await sync.idle();
    assert.equal(store.releases().length, 90); assert.equal(store.status().incomplete, true);
    sync.start('releases'); await sync.idle();
    assert.deepEqual(pages, [1, 2, 3, 4]); assert.equal(store.releases().length, 90);
  } finally { store.close(); }
});
