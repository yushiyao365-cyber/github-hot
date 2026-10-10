import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, validateSettings } from '../server/config.js';
import { makeApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { analysisKey, evidenceFor, parseAnalysis } from '../server/analyses.js';
import { rank, matchesKeyword } from '../server/ranking.js';
import { poolFor, selectPools } from '../server/recommendations.js';
import { fixtureRepo, githubFixture } from './fixtures.js';
import { analysisReply, testReadme } from './analysis-fixtures.js';
import { modelDay } from '../server/model.js';
import type { EvidenceSource, Repo } from '../shared/types.js';

const settings = { ...defaultSettings, model: { ...defaultSettings.model, enabled: true, name: 'test-model', endpoint: 'https://model.test/v1/chat/completions', dailyBudget: 3 } };
const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };

function provider(options: { badQuote?: boolean; status?: number; calls?: string[]; verdict?: string } = {}): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://model.test')) {
      const body = String(init?.body);
      options.calls?.push(body);
      if (options.status) return new Response(null, { status: options.status });
      const payload = JSON.parse(body);
      const inputData = JSON.parse(payload.input ? payload.input[0].content : payload.messages[payload.system ? 0 : 1].content) as { sources: EvidenceSource[] };
      const report = analysisReply(inputData.sources, options.verdict);
      if (options.badQuote) report.why[0].evidence[0].quote = '伪造的原文摘录，不存在于资料中';
      return Response.json(payload.input
        ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(report) }] }] }
        : payload.system ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(report) }] }
        : { choices: [{ message: { content: JSON.stringify(report) } }] });
    }
    if (url.includes('/readme')) return Response.json({ encoding: 'base64', content: Buffer.from(testReadme).toString('base64') });
    if (url.includes('/releases')) return Response.json([]);
    return Response.json(githubFixture());
  }) as typeof fetch;
}

test('双池区分高星与潜力：老高星不受首次发现7天限制，低星必须年轻或有实测增长', () => {
  const old = rank(fixtureRepo(1, { createdAt: '2020-01-01T00:00:00Z', firstSeenAt: '2020-01-01T00:00:00Z' }), settings);
  assert.equal(poolFor(old, settings), 'highStars');
  assert.equal(poolFor({ ...old, stars: 0 }, settings), null);
  assert.equal(poolFor(rank(fixtureRepo(2, { stars: 0 }), settings), settings), 'potential');
  assert.equal(poolFor({ ...old, stars: 0, growth: { from: new Date(Date.now() - 2 * 86400000).toISOString(), to: new Date().toISOString(), days: 2, starsDelta: 30 } }, settings), 'potential');
  assert.equal(poolFor({ ...old, ignored: true }, settings), null);
});

test('双池总量、占比和频道权重生效，同一仓库不重复，模型否定项目不进入首页', () => {
  const repos = Array.from({ length: 40 }, (_, index) => {
    const repo = rank(fixtureRepo(index + 1, { stars: index < 20 ? 5000 : 10 }), settings);
    return { ...repo, pool: poolFor(repo, settings) };
  });
  for (const dailyLimit of [1, 5, 12, 20, 100]) {
    const pools = selectPools(repos, { ...settings, dailyLimit });
    assert.equal(pools.highStars.length + pools.potential.length, Math.min(dailyLimit, repos.length));
    assert.equal(new Set([...pools.highStars, ...pools.potential]).size, Math.min(dailyLimit, repos.length));
  }
  assert.equal(selectPools(repos, settings).potential.length, 6);
  const adjusted = { ...settings, recommendations: { ...settings.recommendations, potentialShare: 75 } };
  assert.equal(selectPools(repos, adjusted).potential.length, 9);
  const report = { verdict: 'skip' } as NonNullable<Repo['analysis']>['report'];
  const rejected = { ...repos[0], analysis: { status: 'done' as const, report } };
  assert.ok(!selectPools([rejected, ...repos.slice(1)], settings).highStars.includes(rejected.id));
  const restored = { ...rejected, analysis: { status: 'stale' as const, report } };
  assert.ok(selectPools([restored], settings).highStars.includes(restored.id));
});

test('短关键词需要词边界，cli 不把 client 项目误召回', () => {
  assert.equal(matchesKeyword('client dashboard', 'cli'), false);
  assert.equal(matchesKeyword('fast-cli terminal', 'cli'), true);
  assert.equal(matchesKeyword('大数据工具', '大数据'), true);
});

test('旧版设置自动兼容，双池配置必须合法并保留用户每日上限', () => {
  const store = new Store(':memory:');
  try {
    store.set('settings', { dailyLimit: 20, channels: defaultSettings.channels, excludeKeywords: [], model: { enabled: false, endpoint: settings.model.endpoint, name: '', dailyBudget: 5 } });
    assert.equal(store.settings().dailyLimit, 20);
    assert.equal(store.settings().recommendations.highStarMin, 1000);
    assert.equal(store.settings().model.autoAnalyze, false);
    for (const recommendations of [{ ...settings.recommendations, highStarMin: 0 }, { ...settings.recommendations, potentialShare: 101 }, { ...settings.recommendations, potentialMaxAgeDays: 0.5 }]) assert.throws(() => validateSettings({ ...settings, recommendations }));
  } finally { store.close(); }
});

test('增长只来自真实采样：首个样本和不足24小时不显示，跨日实测保留负值', () => {
  const store = new Store(':memory:');
  try {
    store.upsertRepo(fixtureRepo(1, { fetchedAt: '2026-09-20T23:00:00Z', stars: 100 }));
    assert.equal(store.growth(1), null);
    store.snapshot(1, 110, '2026-09-21T01:00:00Z');
    assert.equal(store.growth(1), null);
    store.snapshot(1, 120, '2026-09-27T23:00:00Z');
    assert.deepEqual(store.growth(1), { from: '2026-09-21T01:00:00Z', to: '2026-09-27T23:00:00Z', days: 6.9, starsDelta: 10, fromStars: 110, toStars: 120 });
    store.snapshot(1, 90, '2026-09-27T23:30:00Z');
    assert.equal(store.growth(1)!.starsDelta, -20);
  } finally { store.close(); }
});

test('模型分析通过异步 API 运行，保存可追溯证据，缓存复用且不发送个人信息', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo()); store.patchRepo(1, { notes: 'PRIVATE-NOTE-SECRET' });
  store.set('settings', settings); store.saveSecrets({ githubToken: 'GITHUB-SECRET', modelKey: 'MODEL-KEY-SECRET' });
  const calls: string[] = [];
  const { app, analyses, dashboard } = makeApp(store, { serveStatic: false, fetcher: provider({ calls }) });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/analyses', headers, payload: { repoId: 1 } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().started, true);
    await analyses.idle();
    const report = store.analysis(1)!;
    assert.ok(report); assert.equal(report.model, 'test-model'); assert.equal(report.verdict, 'recommend');
    assert.equal(report.sources.length, 2); assert.ok(report.why[0].evidence.length);
    assert.equal(dashboard().repos[0].analysis?.status, 'done');
    assert.equal(calls.length, 1);
    for (const secret of ['PRIVATE-NOTE-SECRET', 'GITHUB-SECRET', 'MODEL-KEY-SECRET']) assert.ok(!calls[0].includes(secret));
    analyses.start(1); await analyses.idle();
    assert.equal(calls.length, 1); assert.equal(analyses.status().cached, 1);
    store.patchRepo(1, { notes: 'Changed personal note', favorite: true });
    assert.equal(dashboard().repos[0].analysis?.status, 'done');
    store.patchRepo(1, { readme: 'Different public evidence' });
    assert.equal(dashboard().repos[0].analysis?.status, 'stale');
    const raw = (await app.inject({ url: '/api/dashboard', headers })).body;
    assert.ok(!raw.includes('GITHUB-SECRET')); assert.ok(!raw.includes('MODEL-KEY-SECRET'));
  } finally { await app.close(); store.close(); }
});

test('伪造来源、伪造摘录、错误 JSON 和错误枚举不会作为 AI 报告保存', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo()); store.set('settings', settings);
  const { app, analyses, dashboard } = makeApp(store, { serveStatic: false, fetcher: provider({ badQuote: true }) });
  try {
    analyses.start(1); await analyses.idle();
    assert.equal(store.analysis(1), null); assert.equal(dashboard().repos[0].analysis?.status, 'failed');
    assert.ok(analyses.status().errors[0].includes('摘录'));
    const repo = analyses.decorate(store.repo(1)!);
    const sources = evidenceFor(repo, store);
    assert.throws(() => parseAnalysis('not JSON', repo, settings, sources));
    const value = analysisReply(sources);
    value.why[0].evidence[0].sourceId = 'made-up';
    assert.throws(() => parseAnalysis(JSON.stringify(value), repo, settings, sources));
    assert.throws(() => parseAnalysis(JSON.stringify({ ...analysisReply(sources), verdict: ['recommend'] }), repo, settings, sources));
  } finally { await app.close(); store.close(); }
});

test('资料不足强制降为观察，未配置模型绝不调用，失败不生成假分析', async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo());
  const { app, analyses } = makeApp(store, { serveStatic: false, fetcher: provider({ status: 401 }) });
  try {
    assert.throws(() => analyses.start(1));
    store.set('settings', settings);
    const repo = analyses.decorate(store.repo(1)!);
    const sources = evidenceFor(repo, store);
    const report = parseAnalysis(JSON.stringify(analysisReply(sources)), repo, settings, sources);
    assert.equal(report.verdict, 'watch'); assert.equal(report.confidence, 'low');
    analyses.start(1); await analyses.idle();
    assert.equal(store.analysis(1), null); assert.ok(analyses.status().errors[0].includes('401'));
  } finally { await app.close(); store.close(); }
});

test('每日预算约束批量分析，缓存结果不会重复调用，剩余项目继续显示待分析', async () => {
  const store = new Store(':memory:');
  for (let id = 1; id <= 4; id++) store.upsertRepo(fixtureRepo(id, { stars: id % 2 ? 5000 : 20 }));
  store.set('settings', { ...settings, model: { ...settings.model, dailyBudget: 1 } });
  const calls: string[] = [];
  const { app, analyses, dashboard } = makeApp(store, { serveStatic: false, fetcher: provider({ calls }) });
  try {
    analyses.start(); await analyses.idle();
    assert.equal(calls.length, 1); assert.equal(dashboard().repos.filter(repo => repo.analysis?.status === 'done').length, 1);
    analyses.start(); await analyses.idle();
    assert.equal(calls.length, 1); assert.ok(analyses.status().message.includes('预算'));
  } finally { await app.close(); store.close(); }
});

test('不限调用时自动分析可超过首页数量，批量独立配置并复用已完成报告', async () => {
  const store = new Store(':memory:');
  for (let id = 1; id <= 16; id++) store.upsertRepo(fixtureRepo(id, { stars: id % 2 ? 5000 : 20 }));
  const calls: string[] = [];
  const { app, sync, analyses } = makeApp(store, { serveStatic: false, fetcher: provider({ calls }) });
  try {
    const configured = { ...settings, dailyLimit: 1, model: { ...settings.model, dailyBudget: 0, autoAnalyze: true } };
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings: configured } });
    assert.equal(response.statusCode, 200);
    store.set(`modelUsage:${modelDay()}`, 12);
    sync.onDiscovery(); await analyses.idle();
    assert.equal(analyses.status().total, 16);
    assert.equal(analyses.status().generated, 16);
    assert.equal(calls.length, 16);
    assert.equal(store.get(`modelUsage:${modelDay()}`, 0), 28);
    sync.onDiscovery(); await analyses.idle();
    assert.equal(calls.length, 16);
    analyses.start(); await analyses.idle();
    assert.equal(calls.length, 16);
    sync.onDiscovery(); await analyses.idle();
    assert.equal(calls.length, 16);
    store.upsertRepo(fixtureRepo(17));
    store.set('settings', { ...configured, model: { ...configured.model, autoAnalyze: false } });
    sync.onDiscovery(); await analyses.idle();
    assert.equal(calls.length, 16);
    store.set('settings', { ...configured, model: { ...configured.model, enabled: false } });
    sync.onDiscovery(); await analyses.idle();
    assert.equal(calls.length, 16);
  } finally { await app.close(); store.close(); }
});

for (const protocol of ['responses', 'messages']) test(`${protocol} 分析经过证据校验后保存，重复请求复用报告`, async () => {
  const store = new Store(':memory:');
  store.upsertRepo(fixtureRepo(1));
  store.set('settings', { ...settings, model: { ...settings.model, endpoint: `https://model.test/v1/${protocol}`, name: 'test-deployment' } });
  const calls: string[] = [];
  const { app, analyses } = makeApp(store, { serveStatic: false, fetcher: provider({ calls }) });
  try {
    analyses.start(1); await analyses.idle();
    assert.equal(store.analysis(1)?.verdict, 'recommend');
    assert.equal(store.analysis(1)?.model, 'test-deployment');
    assert.equal(analyses.status().errors.length, 0);
    analyses.start(1); await analyses.idle();
    assert.equal(calls.length, 1);
  } finally { await app.close(); store.close(); }
});

test('更换模型服务域名时不把旧服务密钥发送给新服务', async () => {
  const store = new Store(':memory:');
  store.set('settings', settings); store.saveSecrets({ modelKey: 'OLD-PROVIDER-KEY' });
  const { app } = makeApp(store, { serveStatic: false });
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings: { ...settings, model: { ...settings.model, endpoint: 'https://other-model.test/v1/chat/completions' } } } });
    assert.equal(response.statusCode, 200); assert.equal(store.secret('modelKey'), '');
  } finally { await app.close(); store.close(); }
});

test('分析报告与增长样本重启保留，模型或兴趣变化后标记旧报告过期', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-analysis-'));
  let store = new Store(directory);
  store.set('settings', settings); store.upsertRepo(fixtureRepo());
  const runtime = makeApp(store, { serveStatic: false, fetcher: provider() });
  try {
    runtime.analyses.start(1); await runtime.analyses.idle();
    await runtime.app.close(); store.close();
    store = new Store(directory);
    const restored = makeApp(store, { serveStatic: false, fetcher: provider() });
    try {
      assert.equal(restored.dashboard().repos[0].analysis?.status, 'done');
      const repo = restored.analyses.decorate(store.repo(1)!);
      assert.equal(store.analysis(1)!.key, analysisKey(repo, settings, evidenceFor(repo, store)));
      store.set('settings', { ...settings, model: { ...settings.model, name: 'new-model' } });
      assert.equal(restored.dashboard().repos[0].analysis?.status, 'stale');
      assert.equal(store.analysis(1)!.model, 'test-model');
    } finally { await restored.app.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
