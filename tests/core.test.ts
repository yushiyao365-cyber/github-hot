import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, parseRepo, validateSettings } from '../server/config.js';
import { allocate, rank, selectFeatured } from '../server/ranking.js';
import { Store } from '../server/store.js';
import { fixtureRepo } from './fixtures.js';

test('每日精选上限可配置，非正数、分数和空值不能保存', () => {
  for (const dailyLimit of [1, 5, 12, 20, 100]) assert.equal(validateSettings({ ...defaultSettings, dailyLimit }).dailyLimit, dailyLimit);
  for (const dailyLimit of [0, -1, 1.5, '', null, Infinity, NaN, '20']) assert.throws(() => validateSettings({ ...defaultSettings, dailyLimit }));
});
test('模型每日调用上限允许 0 表示不限，拒绝非法值', () => {
  for (const dailyBudget of [0, 1, 12, 500]) assert.equal(validateSettings({ ...defaultSettings, model: { ...defaultSettings.model, dailyBudget } }).model.dailyBudget, dailyBudget);
  for (const dailyBudget of [-1, 501, 1.5, '', null, Infinity, NaN, '0']) assert.throws(() => validateSettings({ ...defaultSettings, model: { ...defaultSettings.model, dailyBudget } }));
});
test('权重配额支持非整除、小于频道数及关闭频道', () => {
  assert.deepEqual(allocate(12, defaultSettings), { ai: 3, agent: 3, devtools: 3, data: 3 });
  assert.deepEqual(allocate(5, defaultSettings), { ai: 2, agent: 1, devtools: 1, data: 1 });
  assert.deepEqual(allocate(1, defaultSettings), { ai: 1, agent: 0, devtools: 0, data: 0 });
  const settings = structuredClone(defaultSettings);
  settings.channels.ai.weight = 0;
  assert.equal(allocate(20, settings).ai, 0);
  assert.equal(Object.values(allocate(20, settings)).reduce((sum, value) => sum + value), 20);
  for (const config of Object.values(settings.channels)) config.weight = 0;
  assert.throws(() => validateSettings(settings));
});
test('精选不超上限、不凑数，低 Star 项目可入选，旧发现和忽略项目不反复推荐', () => {
  const repos = Array.from({ length: 40 }, (_, index) => rank(fixtureRepo(index + 1), defaultSettings));
  for (const dailyLimit of [1, 5, 12, 20, 100]) assert.equal(selectFeatured(repos, { ...defaultSettings, dailyLimit }).length, Math.min(dailyLimit, 40));
  const lowStars = rank(fixtureRepo(60, { stars: 0 }), defaultSettings);
  assert.ok(selectFeatured([lowStars], defaultSettings).includes(60));
  assert.deepEqual(selectFeatured([
    { ...lowStars, ignored: true }, { ...lowStars, id: 61, read: true },
    { ...lowStars, id: 62, firstSeenAt: '2020-01-01T00:00:00Z' },
  ], defaultSettings), []);
  const irrelevant = rank(fixtureRepo(70, { topics: [], description: 'A birthday greeting', fullName: 'test/greeting' }), defaultSettings);
  assert.equal(irrelevant.score, 0);
});
test('仅接受 GitHub 仓库引用，不接收任意 URL 或路径注入', () => {
  assert.equal(parseRepo(' https://github.com/example/repo.git/ '), 'example/repo');
  assert.equal(parseRepo('example/repo'), 'example/repo');
  for (const input of ['https://evil.test/example/repo', 'https://github.com@evil.test/a/b', '../repo', 'owner/../repo', 'https://github.com/a/b/issues', 'https://github.com/a/b?token=x']) assert.throws(() => parseRepo(input));
});
test('模型配置要求安全传输，不允许 URL 内嵌密钥', () => {
  const settings = structuredClone(defaultSettings);
  for (const endpoint of ['http://example.com/v1/chat/completions', 'https://key:secret@example.com/v1', 'https://example.com/v1?key=secret']) {
    settings.model.endpoint = endpoint;
    assert.throws(() => validateSettings(settings));
  }
});
test('本地配置、收藏与关注状态重启后保留，重新采集不覆盖用户状态', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-test-'));
  let store = new Store(directory);
  try {
    store.upsertRepo(fixtureRepo());
    const firstSeen = store.repo(1)!.firstSeenAt;
    store.patchRepo(1, { favorite: true, followed: true, ignored: true, read: true, notes: '私有备注' });
    store.upsertRepo(fixtureRepo(1, { stars: 9999 }));
    store.set('settings', { ...defaultSettings, dailyLimit: 20 });
    store.saveSecrets({ githubToken: 'test-secret' });
    store.close(); store = new Store(directory);
    const repo = store.repo(1)!;
    assert.equal(repo.favorite, true); assert.equal(repo.followed, true); assert.equal(repo.ignored, true); assert.equal(repo.read, true);
    assert.equal(repo.firstSeenAt, firstSeen); assert.equal(repo.notes, '私有备注'); assert.equal(repo.stars, 9999);
    assert.equal(store.settings().dailyLimit, 20); assert.equal(store.secret('githubToken'), 'test-secret');
    assert.equal(statSync(join(directory, 'secrets.json')).mode & 0o777, 0o600);
    store.patchRepo(1, { followed: false });
    assert.equal(store.repo(1)!.favorite, true); assert.equal(store.repo(1)!.notes, '私有备注');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('版本以来源 ID 去重，内容更新保留已读，新版本拥有独立状态', () => {
  const store = new Store(':memory:');
  try {
    store.upsertRepo(fixtureRepo());
    store.upsertRelease({ id: 10, repoId: 1, tag: 'v1', body: '原说明' }, true);
    store.patchRelease(10, { read: true });
    store.upsertRelease({ id: 10, repoId: 1, tag: 'v1', body: '修订说明' }, false);
    store.upsertRelease({ id: 11, repoId: 1, tag: 'v2' }, false);
    assert.equal(store.releases().length, 2);
    assert.equal(store.releases().find(item => item.id === 10)!.read, true);
    assert.equal(store.releases().find(item => item.id === 10)!.baseline, true);
    assert.equal(store.releases().find(item => item.id === 11)!.read, false);
    store.patchRepo(1, { followed: false });
    assert.equal(store.releases().length, 2);
  } finally { store.close(); }
});
