import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { makeApp } from '../server/app.js';
import { defaultSettings } from '../server/config.js';
import { HotlistService, selectHotlist } from '../server/hotlist.js';
import { fixtureRepo } from './fixtures.js';
import { starTrend } from '../src/star-trend.js';
import type { Analysis, Repo, Settings } from '../shared/types.js';

const now = Date.parse('2026-10-08T12:00:00Z');
const day = 86400000;
const headers = { host: '127.0.0.1:4310' };
const finding = { text: 'Test-only finding', evidence: [] };
function candidate(id: number, delta = 10, days = 2, patch: Partial<Repo> = {}): Repo {
  return fixtureRepo(id, {
    pool: 'highStars', score: 75, growth: { from: new Date(now - days * day).toISOString(), to: new Date(now).toISOString(), days, starsDelta: delta, fromStars: 100, toStars: 100 + delta }, ...patch,
  });
}
function report(id: number, topicId = 'paimon'): Analysis {
  return { repoId: id, key: 'test', pool: 'highStars', model: 'test-model', provider: 'test-provider', analyzedAt: new Date(now).toISOString(), verdict: 'recommend', confidence: 'high', overview: 'Test-only overview', why: [finding], capabilities: [finding], useCases: [], risks: [], unknowns: [], sources: [], focusReview: { topicId, topicName: 'Test topic', relevance: 'direct', task: 'test-task', relationship: [finding], benefit: [finding], trial: [finding], timeliness: [] } };
}
const focused: Settings = { ...defaultSettings, model: { ...defaultSettings.model, enabled: true }, focus: { enabled: true, topics: [{ id: 'paimon', name: 'Paimon test', goal: 'Test-only', terms: ['paimon'], exclusions: [], enabled: true, weight: 1 }, { id: 'other', name: 'Other', goal: 'Test', terms: ['other'], exclusions: [], enabled: true, weight: 1 }] } };

test('热点榜按日均净增而非总 Star 或区间总量排序，包含已读，不受首页限额影响，最多10个', () => {
  const repos = [candidate(1, 100, 10, { stars: 999999 }), candidate(2, 40, 2, { read: true, stars: 200 }), ...Array.from({ length: 12 }, (_, index) => candidate(index + 3, 4, 2))];
  let sampleCalls = 0;
  const data = selectHotlist(repos, { ...defaultSettings, dailyLimit: 1 }, () => { sampleCalls++; return []; }, 'all', now);
  assert.equal(data.entries.length, 10);
  assert.equal(data.entries[0].repo.id, 2);
  assert.equal(data.entries[0].repo.read, true);
  assert.equal(data.entries[0].growth.starsDelta, 40);
  assert.equal(data.entries[0].starsPerDay, 20);
  assert.equal(data.entries[1].repo.id, 1);
  assert.equal(data.growingCount, 14);
  assert.equal(sampleCalls, 10);
  assert.deepEqual(data.entries.map(entry => entry.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('忽略、归档、fork、不相关、无样本、零增长、下降及过期或未来样本不会凑榜', () => {
  const repos = [candidate(1), candidate(2, 1, 2, { ignored: true }), candidate(3, 1, 2, { archived: true }), candidate(4, 1, 2, { fork: true }), candidate(5, 1, 2, { pool: null }), candidate(6, 0), candidate(7, -10), candidate(8, 1, 2, { growth: null }), candidate(9, 1, .5), candidate(10, 1, 15), candidate(11, NaN)];
  repos.push(candidate(12, 1, 2, { growth: { from: new Date(now - 6 * day).toISOString(), to: new Date(now - 4 * day).toISOString(), days: 2, starsDelta: 5 } }));
  repos.push(candidate(13, 1, 2, { growth: { from: new Date(now - day).toISOString(), to: new Date(now + day).toISOString(), days: 2, starsDelta: 5 } }));
  const data = selectHotlist(repos, defaultSettings, () => [], 'all', now);
  assert.deepEqual(data.entries.map(entry => entry.repo.id), [1]);
  assert.equal(data.measuredCount, 3);
  assert.equal(data.entries[0].reviewed, false);
  assert.equal(selectHotlist([], defaultSettings, () => [], 'all', now).entries.length, 0);
});

test('专题榜必须当前审核直接相关，排除低置信、陈旧/待审核报告，不混用候选标签', () => {
  const reviewed = candidate(1, 10, 2, { description: 'paimon other integration', topics: ['paimon', 'other'], analysis: { status: 'done', report: report(1) } });
  const skipped = structuredClone(reviewed); skipped.id = 2; skipped.analysis!.report!.verdict = 'skip';
  const low = structuredClone(reviewed); low.id = 3; low.analysis!.report!.confidence = 'low';
  const adjacent = structuredClone(reviewed); adjacent.id = 4; adjacent.analysis!.report!.focusReview!.relevance = 'adjacent';
  const stale = { ...reviewed, id: 5, analysis: { status: 'stale' as const, report: report(5) } };
  const pending = { ...reviewed, id: 6, analysis: undefined };
  const irrelevant = { ...reviewed, id: 7, description: 'generic popularity', topics: [], focusIds: [] };
  const repos = [reviewed, skipped, low, adjacent, stale, pending, irrelevant];
  assert.deepEqual(selectHotlist(repos, focused, () => [], 'paimon', now).entries.map(entry => entry.repo.id), [1]);
  assert.deepEqual(selectHotlist(repos, focused, () => [], 'other', now).entries, []);
  assert.equal(selectHotlist(repos, focused, () => [], 'all', now).entries[0].highlight, finding.text);
  assert.equal(selectHotlist(repos, { ...focused, focus: { ...focused.focus!, enabled: false } }, () => [], 'all', now).entries.some(entry => entry.repo.id === 6), false);
});

test('热点榜接口只查本机数据，趋势只查询前10名，不回传备注/原文，不变时304，写操作失效', async () => {
  const store = new Store(':memory:');
  for (let id = 1; id <= 12; id++) {
    store.upsertRepo(fixtureRepo(id));
    store.snapshot(id, 100, new Date(Date.now() - 2 * day).toISOString());
    store.patchRepo(id, { notes: 'private-note', readme: 'large-private-test-readme' });
  }
  const { app } = makeApp(store, { serveStatic: false, fetcher: (async () => { throw new Error('不得访问外部服务'); }) as typeof fetch });
  try {
    let reads = 0;
    const read = store.starSamples.bind(store);
    store.starSamples = (...args) => { reads++; return read(...args); };
    const first = await app.inject({ url: '/api/hotlist', headers });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().entries.length, 10);
    assert.equal(first.json().entries[0].samples.length, 2);
    assert.ok(!first.body.includes('private-note'));
    assert.ok(!first.body.includes('large-private-test-readme'));
    assert.equal(reads, 10);
    const unchanged = await app.inject({ url: '/api/hotlist', headers: { ...headers, 'if-none-match': String(first.headers.etag) } });
    assert.equal(unchanged.statusCode, 304); assert.equal(reads, 10);
    const id = first.json().entries[0].repo.id;
    store.patchRepo(id, { ignored: true });
    const changed = await app.inject({ url: '/api/hotlist', headers: { ...headers, 'if-none-match': String(first.headers.etag) } });
    assert.equal(changed.statusCode, 200);
    assert.ok(!changed.json().entries.some((entry: { repo: { id: number } }) => entry.repo.id === id));
    const filtered = await app.inject({ url: '/api/hotlist?topic=ai', headers });
    assert.ok(filtered.json().entries.every((entry: { repo: { channel: string } }) => entry.repo.channel === 'ai'));
    assert.equal((await app.inject({ url: '/api/hotlist?topic=missing', headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/hotlist?topic=ai&topic=data', headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/hotlist', headers: { host: 'evil.test' } })).statusCode, 403);
  } finally { await app.close(); store.close(); }
});

test('榜单15秒重检时间边界，外部无需写入也会剔除过期样本；近30天趋势不补假日期', () => {
  const store = new Store(':memory:');
  const originalNow = Date.now;
  try {
    store.upsertRepo(fixtureRepo(1));
    const decorated = candidate(1);
    const service = new HotlistService(store, () => decorated);
    Date.now = () => now;
    assert.equal(service.get().entries.length, 1);
    Date.now = () => now + 4 * day;
    assert.equal(service.get().entries.length, 0);
    store.snapshot(1, 50, new Date(now - 35 * day).toISOString());
    store.snapshot(1, 100, new Date(now - 10 * day).toISOString());
    store.snapshot(1, 200, new Date(now - 3 * day).toISOString());
    store.snapshot(1, 300, new Date(now + day).toISOString());
    const samples = store.starSamples(1, now);
    assert.ok(samples.every(sample => Date.parse(sample.observedAt) >= now - 30 * day && Date.parse(sample.observedAt) <= now));
    assert.ok(samples.some(sample => sample.stars === 100));
    assert.ok(!samples.some(sample => sample.stars === 50 || sample.stars === 300));
  } finally { Date.now = originalNow; store.close(); }
});

test('趋势图按真实时间距离连线，保留下降/持平，不足两点不生成曲线', () => {
  const points = [{ observedAt: '2026-10-01T00:00:00Z', stars: 100 }, { observedAt: '2026-10-02T00:00:00Z', stars: 110 }, { observedAt: '2026-10-08T00:00:00Z', stars: 105 }];
  const trend = starTrend(points)!;
  assert.ok(trend.coordinates[1].x - trend.coordinates[0].x < (trend.coordinates[2].x - trend.coordinates[1].x) / 5);
  assert.equal(trend.points.length, 3);
  assert.ok(trend.coordinates[2].y > trend.coordinates[1].y);
  assert.equal(starTrend([]), null);
  assert.equal(starTrend(points.slice(0, 1)), null);
  assert.equal(starTrend([points[0], points[0]]), null);
  assert.equal(starTrend(points.map(point => ({ ...point, stars: 100 })))!.coordinates[0].y, 35);
});
