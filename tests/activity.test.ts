import test from 'node:test';
import assert from 'node:assert/strict';
import { activityFeed } from '../server/activity.js';
import { activityDays, activityTime, type ActivityFeed } from '../shared/activity.js';
import { fixtureRepo } from './fixtures.js';
import { fixtureContent } from './content-fixtures.js';
import { radarFixture } from './radar-fixtures.js';
import { Store } from '../server/store.js';
import { entryKey } from '../shared/radar.js';

const headers = { host: '127.0.0.1:4314' };
test('全部动态全局倒序分页，包含待分析与观察内容，不受精选上限影响', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  try {
    const settings = store.settings(); settings.dailyLimit = 1;
    const repos = Array.from({ length: 30 }, (_, index) => fixtureRepo(index + 10, { description: 'Apache Paimon integration', firstSeenAt: new Date(Date.UTC(2026, 9, 9, 0, index)).toISOString() }));
    const item = { ...fixtureContent('practice'), module: 'workflows' as const, publishedAt: '2026-10-09T01:00:00Z' };
    const options = { page: 1, now: Date.UTC(2026, 9, 9, 12) };
    const feed = activityFeed(repos, [item], settings, options);
    assert.equal(feed.total, 31); assert.equal(feed.entries.length, 24);
    assert.equal(feed.entries[0].entry.type, 'content');
    assert.equal(feed.entries[0].timeLabel, '原文发布');
    assert.ok(feed.entries.slice(1).every(row => row.entry.type === 'repo' && row.entry.repo.readme === ''));
    const second = activityFeed(repos, [item], settings, { ...options, page: 2 });
    assert.equal(second.entries.length, 7);
    assert.equal(new Set([...feed.entries, ...second.entries].map(row => entryKey(row.entry))).size, 31);
    assert.equal(activityFeed(repos, [item], settings, { ...options, module: 'workflows' }).total, 1);
    assert.equal(activityFeed(repos, [item], settings, { ...options, query: '无匹配字符串' }).total, 0);
    settings.radar!.modules.paimon.enabled = false;
    assert.equal(activityFeed(repos, [item], settings, options).total, 1);
    assert.equal(activityFeed([], [{ ...item, ignored: true }], settings, options).total, 0);
  } finally { await services.app.close(); store.close(); }
});

test('时间轴不拿抓取时间冒充发布时间，刷新采样不改变收录顺序', () => {
  const repo = fixtureRepo(1, { firstSeenAt: '2026-09-01T00:00:00Z', pushedAt: '2026-10-09T00:00:00Z' });
  assert.deepEqual(activityTime({ type: 'repo', module: 'paimon', repo }), { occurredAt: '2026-09-01T00:00:00.000Z', timeLabel: '本机收录' });
  const item = fixtureContent('practice'); item.publishedAt = null; item.firstSeenAt = '2026-09-01T00:00:00Z';
  item.skill = { repoId: 1, repository: repo.fullName, path: 'SKILL.md', sha: 'a'.repeat(40), active: true, firstObservedAt: item.firstSeenAt, change: 'baseline', observedAt: '2026-10-09T01:00:00Z' };
  assert.equal(activityTime({ type: 'content', module: 'skills', item }).occurredAt, '2026-09-01T00:00:00.000Z');
  item.skill.change = 'changed';
  assert.equal(activityTime({ type: 'content', module: 'skills', item }).timeLabel, '观测文件变更');
  const entry = { type: 'repo' as const, module: 'paimon' as const, repo };
  assert.equal(activityDays([{ entry, occurredAt: null, timeLabel: '本机收录' }])[0].day, '日期未知');
});

test('动态接口只读、复用 ETag，校验筛选与分页，忽略后退出时间轴', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  try {
    const first = await services.app.inject({ url: '/api/activity', headers });
    assert.equal(first.statusCode, 200);
    const feed = first.json<ActivityFeed>(); assert.equal(feed.total, 7);
    assert.equal((await services.app.inject({ url: '/api/activity', headers: { ...headers, 'if-none-match': String(first.headers.etag) } })).statusCode, 304);
    for (const query of ['page=0', 'page=1.5', 'page=10001', 'module=unknown', `query=${'x'.repeat(201)}`]) assert.equal((await services.app.inject({ url: `/api/activity?${query}`, headers })).statusCode, 400);
    const papers = (await services.app.inject({ url: '/api/activity?module=papers', headers })).json<ActivityFeed>();
    assert.equal(papers.total, 2);
    store.patchRepo(1, { ignored: true });
    const changed = await services.app.inject({ url: '/api/activity', headers: { ...headers, 'if-none-match': String(first.headers.etag) } });
    assert.equal(changed.statusCode, 200); assert.equal(changed.json<ActivityFeed>().total, 6);
    assert.equal((await services.app.inject({ url: '/api/activity', headers: { host: 'evil.test' } })).statusCode, 403);
    assert.equal(services.calls(), 0);
  } finally { await services.app.close(); store.close(); }
});
