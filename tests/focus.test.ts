import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, validateSettings } from '../server/config.js';
import { suggestedFocus, candidateFocusIds, focusSignature } from '../shared/focus.js';
import { Store } from '../server/store.js';
import { makeApp } from '../server/app.js';
import { rank } from '../server/ranking.js';
import { poolFor } from '../server/recommendations.js';
import { analysisKey, evidenceFor, parseAnalysis } from '../server/analyses.js';
import { selectFocus, withFocusHints } from '../server/focus.js';
import { focusDiscoveryTasks } from '../server/focus-discovery.js';
import { SyncService } from '../server/sync.js';
import { fixtureRepo, githubFixture } from './fixtures.js';
import { analysisReply } from './analysis-fixtures.js';
import type { Analysis, EvidenceSource, Repo, Settings } from '../shared/types.js';

const settings: Settings = { ...defaultSettings, focus: suggestedFocus, dailyLimit: 6, model: { ...defaultSettings.model, enabled: true, autoAnalyze: true, dailyBudget: 0, endpoint: 'https://model.test/v1/chat/completions', name: 'fixture-model' } };
const readme = '# Paimon integration fixture\nThis test-only tool writes data to Paimon and inspects failed ingestion jobs. Install with npm install and run the example to inspect an ingestion job. It can reduce manual diagnosis steps. This is a test fixture, not a real product claim.';

function focusedRepo(id = 1, patch: Partial<Repo> = {}): Repo {
  const repo = rank(fixtureRepo(id, { description: 'A Paimon CDC diagnostic tool', topics: ['paimon'], readme, createdAt: '2020-01-01T00:00:00Z', stars: 40, ...patch }), settings);
  return { ...repo, pool: poolFor(repo, settings) };
}

function reply(sources: EvidenceSource[], topicId = 'paimon', relevance = 'direct') {
  const base = analysisReply(sources);
  const finding = { text: '测试判断：减少 Paimon 数据接入排障步骤。', evidence: [{ sourceId: 'readme', quote: sources.find(source => source.id === 'readme')!.text.split('\n')[1].slice(0, 120) }] };
  return { ...base, focusReview: { topicId, relevance, task: '数据接入排障', relationship: [finding], benefit: [finding], trial: [finding], timeliness: [] } };
}

test('专题配置可编辑和关闭，校验重复 ID、空条件、搜索操作符和禁用全部专题', () => {
  assert.deepEqual(validateSettings(settings).focus, suggestedFocus);
  const change = (patch: object) => ({ ...settings, focus: { enabled: true, topics: [{ ...suggestedFocus.topics[0], ...patch }] } });
  for (const patch of [{ terms: [] }, { terms: ['paimon repo:secret/private'] }, { terms: ['paimon +'] }, { goal: '' }, { weight: 0 }, { enabled: false }]) assert.throws(() => validateSettings(change(patch)));
  assert.throws(() => validateSettings({ ...settings, focus: { enabled: true, topics: [suggestedFocus.topics[0], suggestedFocus.topics[0]] } }));
  assert.equal(validateSettings({ ...settings, focus: { enabled: false, topics: [] } }).focus?.enabled, false);
});

test('高星泛项目不通过专题门槛，组合条件必须同时满足，老低星直接相关项目可评审', () => {
  const generic = rank(fixtureRepo(2, { stars: 100000, description: 'A generic database and AI agent', topics: ['database', 'ai-agents'], readme: '' }), settings);
  assert.equal(generic.score, 0);
  assert.equal(poolFor(generic, settings), null);
  assert.deepEqual(candidateFocusIds(focusedRepo(), settings), ['paimon']);
  assert.equal(focusedRepo().pool, 'potential');
  const combination = { ...settings, focus: { enabled: true, topics: [{ ...suggestedFocus.topics[1], terms: ['dataset + deduplication'] }] } };
  assert.deepEqual(candidateFocusIds(fixtureRepo(1, { description: 'dataset tools', readme: '', topics: [] }), combination), []);
  assert.deepEqual(candidateFocusIds(fixtureRepo(1, { description: 'deduplication tools for a dataset', readme: '', topics: [] }), combination), ['training-data']);
  assert.deepEqual(candidateFocusIds(fixtureRepo(1, { description: 'notpaimon', readme: '', topics: [] }), settings), []);
  assert.deepEqual(candidateFocusIds(fixtureRepo(1, { fullName: 'example/paimon-bot', description: 'A game chatbot named Paimon', readme: '', topics: [] }), settings), []);
  assert.ok(focusedRepo(1, { fullName: 'apache/paimon', stars: 5000 }).score > focusedRepo(2, { stars: 1, createdAt: new Date().toISOString() }).score);
});

test('专题搜索覆盖 README、每个专题先一条、使用组合条件，不混入旧泛频道搜索', () => {
  const tasks = focusDiscoveryTasks(settings, Date.parse('2026-09-30T00:00:00Z'));
  assert.equal(tasks.length, 9);
  assert.deepEqual(tasks.slice(0, 3).map(task => task.topicId), ['paimon', 'training-data', 'work-tools']);
  assert.ok(tasks.every(task => task.query.includes('in:name,description,readme') && !task.query.includes('topic:database')));
  const combined = focusDiscoveryTasks({ ...settings, focus: { enabled: true, topics: [{ ...suggestedFocus.topics[1], terms: ['dataset + deduplication'] }] } });
  assert.ok(combined.every(task => task.query.startsWith('"dataset" "deduplication"')));
});

test('仅 README 搜索命中的候选保留来源提示，修改专题后旧提示失效', async () => {
  const store = new Store(':memory:');
  store.set('settings', { ...settings, model: { ...settings.model, enabled: false } });
  store.saveSecrets({ githubToken: 'fixture-only' });
  const urls: string[] = [];
  const sync = new SyncService(store, (async input => {
    urls.push(String(input));
    const query = new URL(String(input)).searchParams.get('q')!;
    return Response.json({ items: query.includes('paimon') ? [githubFixture(1)] : [], total_count: query.includes('paimon') ? 1 : 0, incomplete_results: false });
  }) as typeof fetch, async () => {});
  try {
    sync.start('discovery'); await sync.idle();
    assert.equal(urls.length, 9);
    assert.deepEqual(candidateFocusIds(withFocusHints(store.repo(1)!, settings, store), settings), ['paimon']);
    const changed = { ...settings, focus: { enabled: true, topics: [{ ...suggestedFocus.topics[0], terms: ['other-focus'] }] } };
    assert.deepEqual(candidateFocusIds(withFocusHints(store.repo(1)!, changed, store), changed), []);
  } finally { store.close(); }
});

test('专题评审要求直接关联、具体工作价值和使用证据，不接受泛旧报告或伪造专题', () => {
  const store = new Store(':memory:');
  try {
    const repo = focusedRepo();
    const sources = evidenceFor(repo, store);
    assert.equal(parseAnalysis(JSON.stringify(reply(sources)), repo, settings, sources).verdict, 'recommend');
    assert.equal(parseAnalysis(JSON.stringify(reply(sources, 'paimon', 'adjacent')), repo, settings, sources).verdict, 'watch');
    assert.equal(parseAnalysis(JSON.stringify(reply(sources, 'paimon', 'unrelated')), repo, settings, sources).verdict, 'watch');
    const noTrial = reply(sources); noTrial.focusReview.trial = [];
    assert.equal(parseAnalysis(JSON.stringify(noTrial), repo, settings, sources).verdict, 'watch');
    const metadataOnly = reply(sources);
    metadataOnly.focusReview.relationship[0].evidence = [{ sourceId: 'repository', quote: sources[0].text.slice(0, 50) }];
    assert.equal(parseAnalysis(JSON.stringify(metadataOnly), repo, settings, sources).verdict, 'watch');
    assert.throws(() => parseAnalysis(JSON.stringify(analysisReply(sources)), repo, settings, sources));
    assert.throws(() => parseAnalysis(JSON.stringify(reply(sources, 'invented-focus')), repo, settings, sources));
    const fabricated = reply(sources); fabricated.focusReview.benefit[0].evidence[0].quote = 'This quote does not exist in any input document';
    assert.throws(() => parseAnalysis(JSON.stringify(fabricated), repo, settings, sources));
  } finally { store.close(); }
});

test('专题内容变化使报告过期，显示数量和专题权重变化复用报告', () => {
  const store = new Store(':memory:');
  try {
    const repo = focusedRepo(); const sources = evidenceFor(repo, store);
    const key = analysisKey(repo, settings, sources);
    const changed = { ...settings, focus: { enabled: true, topics: settings.focus!.topics.map(topic => ({ ...topic, goal: `${topic.goal} 额外要求` })) } };
    assert.notEqual(analysisKey(repo, changed, sources), key);
    const weighted = { ...settings, dailyLimit: 30, focus: { enabled: true, topics: settings.focus!.topics.map(topic => ({ ...topic, weight: 10 })) } };
    assert.equal(analysisKey(repo, weighted, sources), key);
  } finally { store.close(); }
});

test('专题首页按权重分配、全局去重且同一任务只保留一个，不用待审核项目补位', () => {
  const repos: Repo[] = [];
  for (const [index, topic] of suggestedFocus.topics.entries()) {
    for (let offset = 0; offset < 5; offset++) {
      const id = index * 10 + offset + 1;
      const repo = focusedRepo(id, { focusIds: [topic.id] });
      const review = { ...reply([{ id: 'readme', text: readme } as EvidenceSource], topic.id).focusReview, topicName: topic.name, task: offset < 2 ? '重复任务' : `任务-${offset}` };
      const sources = [{ id: 'readme', text: readme, title: '测试资料', url: repo.url, fetchedAt: repo.fetchedAt }];
      const report: Analysis = { ...analysisReply(sources), repoId: id, key: `fixture-${id}`, pool: 'potential', model: 'fixture', provider: 'https://model.test', analyzedAt: repo.fetchedAt, verdict: 'recommend', confidence: 'high', focusReview: { ...review, relevance: 'direct' }, sources };
      repos.push({ ...repo, analysis: { status: 'done', report } });
    }
  }
  const weighted = { ...settings, dailyLimit: 4, focus: { enabled: true, topics: suggestedFocus.topics.map((topic, index) => ({ ...topic, weight: index === 0 ? 2 : 1 })) } };
  const sections = selectFocus(repos, weighted);
  assert.deepEqual(sections.map(section => section.repoIds.length), [2, 1, 1]);
  assert.equal(new Set(sections.flatMap(section => section.repoIds)).size, 4);
  assert.ok(!sections[0].repoIds.includes(2));
  assert.equal(selectFocus([focusedRepo()], settings).flatMap(section => section.repoIds).length, 0);
});

test('自动专题评审到首页全链路：过滤泛高星，发送专题目标但不发送私人备注，缓存复用', async () => {
  const store = new Store(':memory:');
  store.set('settings', settings);
  store.upsertRepo(focusedRepo(1)); store.patchRepo(1, { readme, notes: 'PRIVATE-NOTE-NOT-FOR-MODEL' });
  store.upsertRepo(fixtureRepo(2, { description: 'A generic database', topics: ['database'], stars: 100000 }));
  store.set('sync', { ...store.status(), retryAt: new Date(Date.now() + 3600000).toISOString() });
  const calls: string[] = [];
  const fetcher = (async (input, init) => {
    assert.ok(String(input).startsWith('https://model.test'));
    calls.push(String(init?.body));
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.deepEqual(payload.focusTopics.map((topic: { id: string }) => topic.id), ['paimon']);
    assert.ok(!String(init?.body).includes('PRIVATE-NOTE-NOT-FOR-MODEL'));
    return Response.json({ choices: [{ message: { content: JSON.stringify(reply(payload.sources)) } }] });
  }) as typeof fetch;
  const { app, analyses, dashboard } = makeApp(store, { serveStatic: false, fetcher });
  try {
    assert.deepEqual(dashboard().featuredIds, []);
    analyses.autoStart(); await analyses.idle();
    assert.equal(calls.length, 1);
    assert.deepEqual(dashboard().featuredIds, [1]);
    assert.equal(dashboard().focusSections?.[0].name, 'Paimon 及其周边');
    assert.ok(dashboard().repos.find(repo => repo.id === 1)?.analysis?.report?.focusReview?.trial.length);
    analyses.start(1); await analyses.idle();
    assert.equal(calls.length, 1);
    const changed = { ...settings, focus: { enabled: true, topics: [{ ...suggestedFocus.topics[0], goal: '只关注新的运维能力' }] } };
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: { host: '127.0.0.1:4310', 'x-radar-client': '1' }, payload: { settings: changed } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(dashboard().featuredIds, []);
    assert.equal(dashboard().repos.find(repo => repo.id === 1)?.analysis?.status, 'stale');
    assert.ok(store.status().retryAt);
  } finally { await app.close(); store.close(); }
});
