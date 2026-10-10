import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { makeApp } from '../server/app.js';
import { parseContentReport } from '../server/content-analysis.js';
import { ContentHotlistService } from '../server/content-hotlist.js';
import { contentSettings, fixtureContent, contentReply } from './content-fixtures.js';
import { editionPreview } from '../src/history-layout.js';
import { fixtureRepo } from './fixtures.js';

const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };

test('论文实践榜独立选取各前10，不受首页配额/已读限制，不将观察和过期分析作为热点', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); settings.dailyLimit = 1; settings.content.paper.limit = 0; settings.content.practice.limit = 0; store.set('settings', settings);
  const { app, content, dashboard } = makeApp(store, { serveStatic: false, fetcher: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  try {
    for (const kind of ['paper', 'practice'] as const) for (let index = 1; index <= 14; index++) {
      const item = fixtureContent(kind, index); item.publishedAt = new Date(Date.now() - index * 3600000).toISOString();
      item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings);
      if (index === 11) item.report.verdict = 'watch';
      if (index === 12) item.text += 'updated text';
      if (index === 13) item.publishedAt = new Date(Date.now() - 60 * 86400000).toISOString();
      content.db.save(item); if (index === 1) content.db.patch(item.id, { read: true });
      if (index === 14) content.db.patch(item.id, { ignored: true });
    }
    assert.equal(dashboard().content?.featured.length, 0);
    const response = await app.inject({ url: '/api/content/hotlist', headers }); assert.equal(response.statusCode, 200);
    for (const kind of ['paper', 'practice'] as const) {
      const group = response.json().groups[kind]; assert.equal(group.entries.length, 10); assert.equal(group.qualified, 10);
      assert.equal(group.entries[0].title, `Test-only ${kind} 1`); assert.equal(group.entries[0].read, true);
      assert.ok(group.entries.every((item: { text: string }) => item.text === ''));
    }
    assert.deepEqual(content.db.days(), []);
    assert.equal(store.get('contentLastSyncAttempt', 0), 0);
    const first = response.json().groups.paper.entries[0]; content.db.patch(first.id, { ignored: true });
    const changed = await app.inject({ url: '/api/content/hotlist', headers: { ...headers, 'if-none-match': String(response.headers.etag) } });
    assert.equal(changed.statusCode, 200); assert.equal(changed.json().groups.paper.entries.length, 9);
    settings.content.practice.enabled = false; store.set('settings', settings);
    const disabled = (await app.inject({ url: '/api/content/hotlist', headers })).json(); assert.equal(disabled.groups.practice.enabled, false); assert.deepEqual(disabled.groups.practice.entries, []);
  } finally { await app.close(); store.close(); }
});

test('文章榜排序日期透明，未知日期置后；缓存可复用且过期后重算', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); store.set('settings', settings);
  const { app, content } = makeApp(store, { serveStatic: false });
  const originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  try {
    for (let index = 1; index <= 3; index++) {
      const item = fixtureContent('paper', index); item.publishedAt = index === 1 ? null : new Date(now - 1000).toISOString();
      item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings); content.db.save(item);
    }
    const hotlist = new ContentHotlistService(store, content); const first = hotlist.get();
    assert.equal(first.groups.paper.entries.at(-1)!.title, 'Test-only paper 1'); assert.equal(hotlist.get(), first);
    const response = await app.inject({ url: '/api/content/hotlist', headers });
    assert.equal((await app.inject({ url: '/api/content/hotlist', headers: { ...headers, 'if-none-match': String(response.headers.etag) } })).statusCode, 304);
    now += 16000; assert.notEqual(hotlist.get(), first);
    settings.content.paper.goal = 'Changed target'; store.set('settings', settings);
    assert.equal(hotlist.get().groups.paper.entries.length, 0);
  } finally { Date.now = originalNow; await app.close(); store.close(); }
});

test('日报导读先覆盖项目/论文/实践，不被大量项目挤占；缺失类型自然补位', () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ capturedAt: '2026-10-08', topic: null, repo: fixtureRepo(index + 1) }));
  const content = ['paper', 'practice'].map(kind => ({ capturedAt: '2026-10-08', item: fixtureContent(kind as 'paper' | 'practice') }));
  assert.deepEqual(editionPreview(entries, content).map(item => item.kind), ['project', 'paper', 'practice']);
  assert.deepEqual(editionPreview(entries, []).map(item => item.id), [1, 2, 3]);
  assert.equal(editionPreview([], content).length, 2);
  assert.deepEqual(editionPreview([], []), []);
});
