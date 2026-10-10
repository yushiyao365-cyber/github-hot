import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { FeaturedHistory, validateHistoryDay } from '../server/history.js';
import { makeApp } from '../server/app.js';
import { dayKey } from '../server/summaries.js';
import { evidenceFor, parseAnalysis } from '../server/analyses.js';
import { analysisReply, testReadme } from './analysis-fixtures.js';
import { fixtureRepo, githubFixture } from './fixtures.js';
import type { EvidenceSource } from '../shared/types.js';

const headers = { host: '127.0.0.1:4310' };
const recordedAt = new Date('2026-09-28T10:00:00');

test('每日只保存首次入选快照，日内补位去重，次日独立记录，不伪造空白日期', () => {
  const store = new Store(':memory:');
  const history = new FeaturedHistory(store);
  try {
    const repo = fixtureRepo(1);
    history.capture([repo], [], store.settings(), recordedAt);
    assert.deepEqual(history.days(), []);
    history.capture([repo], [1], store.settings(), recordedAt);
    const original = history.entry('2026-09-28', 1);
    const revision = store.revision();
    history.capture([{ ...repo, stars: 99999, read: true }], [1], store.settings(), recordedAt);
    assert.equal(store.revision(), revision);
    assert.deepEqual(history.entry('2026-09-28', 1), original);
    history.capture([], [], store.settings(), recordedAt);
    history.capture([fixtureRepo(2)], [2, 2], { ...store.settings(), dailyLimit: 1 }, recordedAt);
    assert.deepEqual(history.entries('2026-09-28').map(entry => entry.repo.id), [1, 2]);
    history.capture([{ ...repo, stars: 99999 }], [1], store.settings(), new Date('2026-09-30T10:00:00'));
    assert.equal(history.entry('2026-09-30', 1)?.repo.stars, 99999);
    assert.equal(history.entry('2026-09-28', 1)?.repo.stars, repo.stars);
    assert.deepEqual(history.days().map(day => [day.day, day.count]), [['2026-09-30', 1], ['2026-09-28', 2]]);
    assert.deepEqual(history.entries('2026-09-29'), []);
  } finally { store.close(); }
});

test('历史跨服务重启保留，不依赖当前仓库是否存在', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-history-'));
  let store = new Store(directory);
  try {
    const repo = fixtureRepo(1);
    new FeaturedHistory(store).capture([repo], [1], store.settings(), recordedAt);
    store.close();
    store = new Store(directory);
    assert.equal(store.repo(1), undefined);
    assert.equal(new FeaturedHistory(store).entry('2026-09-28', 1)?.repo.fullName, repo.fullName);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('归档保存当时专题与完整证据，不复制用户备注、状态或连接配置', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo(1));
  store.patchRepo(1, { readme: testReadme, notes: 'private-note', favorite: true, followed: true });
  const { app, analyses } = makeApp(store, { serveStatic: false });
  try {
    const repo = analyses.decorate(store.repo(1)!);
    const sources = evidenceFor(repo, store);
    const report = parseAnalysis(JSON.stringify(analysisReply(sources)), repo, store.settings(), sources);
    report.focusReview = { topicId: 'old-topic', topicName: '旧专题', relevance: 'direct', task: '旧任务', relationship: [], benefit: [], trial: [], timeliness: [] };
    repo.analysis = { status: 'done', report };
    const settings = { ...store.settings(), focus: { enabled: true, topics: [{ id: 'old-topic', name: '旧专题', enabled: true, weight: 1, goal: '旧目标', terms: [], exclusions: [] }] } };
    const history = new FeaturedHistory(store);
    history.capture([repo], [1], settings, recordedAt);
    report.overview = '新的判断';
    settings.focus.topics[0].name = '新专题';
    store.saveAnalysis(report);
    history.capture([repo], [1], settings, recordedAt);
    const entry = history.entry('2026-09-28', 1)!;
    assert.equal(entry.topic?.name, '旧专题');
    assert.notEqual(entry.repo.analysis?.report?.overview, '新的判断');
    assert.equal(entry.repo.readme, testReadme);
    assert.ok(entry.repo.analysis?.report?.sources.some(source => source.text === testReadme));
    assert.equal(entry.repo.notes, '');
    assert.equal(entry.repo.favorite, false);
    assert.equal(entry.repo.followed, false);
    assert.ok(!JSON.stringify(entry).includes('private-note'));
    assert.ok(!JSON.stringify(entry).includes(settings.model.endpoint));
    const list = history.entries('2026-09-28');
    assert.equal(list[0].repo.readme, '');
    assert.ok(list[0].repo.analysis?.report?.sources.every(source => source.text === ''));
    assert.equal(history.entry('2026-09-28', 1)?.repo.readme, testReadme);
  } finally { await app.close(); store.close(); }
});

test('历史接口按日期读取、不访问网络或当前报告，并校验日期和来源', async () => {
  const store = new Store(':memory:');
  const history = new FeaturedHistory(store);
  history.capture([fixtureRepo(1)], [1], store.settings(), recordedAt);
  const { app } = makeApp(store, { serveStatic: false, fetcher: (async () => { throw new Error('历史不得访问网络'); }) as typeof fetch });
  try {
    store.repos = () => { throw new Error('历史不读取当前项目库'); };
    store.analysis = () => { throw new Error('历史不读取当前分析'); };
    const listing = await app.inject({ url: '/api/history', headers });
    assert.equal(listing.json().days[0].count, 1);
    assert.equal(listing.json().days[0].leadTitle, fixtureRepo(1).fullName);
    assert.equal(listing.json().days[0].leadSummary, fixtureRepo(1).description);
    assert.equal(listing.json().today, dayKey());
    const day = await app.inject({ url: '/api/history/2026-09-28', headers });
    assert.equal(day.statusCode, 200);
    assert.equal(day.json().entries[0].repo.id, 1);
    const detail = await app.inject({ url: '/api/history/2026-09-28/repos/1', headers });
    assert.equal(detail.statusCode, 200);
    assert.ok(detail.json().repo.readme);
    assert.equal((await app.inject({ url: '/api/history/2026-09-28/repos/2', headers })).statusCode, 404);
    for (const invalid of ['2026-02-30', '2099-01-01', '2026-9-28', 'invalid']) {
      assert.equal((await app.inject({ url: `/api/history/${invalid}`, headers })).statusCode, 400);
    }
    assert.deepEqual((await app.inject({ url: '/api/history/2026-09-27', headers })).json().entries, []);
    assert.equal((await app.inject({ url: '/api/history', headers: { host: 'evil.test' } })).statusCode, 403);
    assert.equal(listing.headers['cache-control'], 'no-store');
    assert.doesNotThrow(() => validateHistoryDay('2024-02-29'));
  } finally { await app.close(); store.close(); }
});

test('往期目录只读取首条快照摘要，不带全文，后来修改仓库不会改写目录', () => {
  const store = new Store(':memory:');
  const history = new FeaturedHistory(store);
  try {
    const repo = fixtureRepo(8, { description: 'archive-summary'.repeat(100), notes: 'private-note', readme: 'full-source' });
    history.capture([fixtureRepo(1), repo], [8, 1], store.settings(), recordedAt);
    store.upsertRepo({ ...repo, description: 'latest description', fullName: 'new/name' });
    const days = history.days();
    assert.equal(days[0].leadTitle, repo.fullName);
    assert.equal(days[0].leadSummary, repo.description.slice(0, 160));
    assert.equal(days[0].count, 2);
    assert.ok(!JSON.stringify(days).includes('full-source'));
    assert.ok(!JSON.stringify(days).includes('private-note'));
  } finally { store.close(); }
});

test('首页自动归档实际精选，已读不抹除，存档写入不会破坏304缓存', async () => {
  const store = new Store(':memory:');
  for (const id of [1, 2, 3]) store.upsertRepo(fixtureRepo(id));
  const { app } = makeApp(store, { serveStatic: false });
  try {
    const first = await app.inject({ url: '/api/dashboard', headers });
    const featured = first.json().featuredIds as number[];
    assert.ok(featured.length);
    const history = new FeaturedHistory(store);
    assert.deepEqual(history.entries(dayKey()).map(entry => entry.repo.id), featured);
    const unchanged = await app.inject({ url: '/api/dashboard', headers: { ...headers, 'if-none-match': String(first.headers.etag) } });
    assert.equal(unchanged.statusCode, 304);
    const original = history.entry(dayKey(), featured[0]);
    store.patchRepo(featured[0], { read: true, ignored: true });
    const updated = await app.inject({ url: '/api/dashboard', headers });
    assert.ok(!updated.json().featuredIds.includes(featured[0]));
    assert.deepEqual(history.entry(dayKey(), featured[0]), original);
    assert.ok(!('history' in updated.json()));
  } finally { await app.close(); store.close(); }
});

test('后台分析完成即归档，无须打开网页，不额外调用模型', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo(1));
  store.set('settings', { ...store.settings(), model: { ...store.settings().model, enabled: true, autoAnalyze: true, name: 'test-model', endpoint: 'https://model.test/v1/chat/completions' } });
  store.saveSecrets({ modelKey: 'test-only' });
  let calls = 0;
  const fetcher = (async (input, init) => {
    if (String(input).startsWith('https://model.test')) {
      calls++;
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as { sources: EvidenceSource[] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(analysisReply(payload.sources)) } }] });
    }
    if (String(input).includes('/readme')) return Response.json({ encoding: 'base64', content: Buffer.from(testReadme).toString('base64') });
    if (String(input).includes('/releases')) return Response.json([]);
    return Response.json(githubFixture());
  }) as typeof fetch;
  const { app, analyses } = makeApp(store, { serveStatic: false, fetcher });
  try {
    assert.equal(analyses.start(1), true);
    await analyses.idle();
    assert.equal(calls, 1);
    const entry = new FeaturedHistory(store).entry(dayKey(), 1);
    assert.equal(entry?.repo.analysis?.status, 'done');
    assert.equal(entry?.repo.analysis?.report?.verdict, 'recommend');
  } finally { await app.close(); store.close(); }
});
