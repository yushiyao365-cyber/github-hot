import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { ContentStore } from '../server/content-store.js';
import { ContentService } from '../server/content-service.js';
import { publicIPv4, publicUrl, PublicReader } from '../server/public-reader.js';
import { arxivId, canonicalContentUrl, parseArticle, parseFeed } from '../server/content-reader.js';
import { contentAnalysisKey, contentPrompt, contentPromptFor, decorateContent, parseContentReport } from '../server/content-analysis.js';
import { validateSettings } from '../server/config.js';
import { makeApp } from '../server/app.js';
import { readingSelection, defaultContent } from '../shared/content.js';
import { dayKey } from '../server/summaries.js';
import { fixtureRepo } from './fixtures.js';
import { evidenceFor, parseAnalysis } from '../server/analyses.js';
import { analysisReply, testReadme } from './analysis-fixtures.js';
import { articleHtml, articleText, contentReply, contentSettings, fixtureContent, paperFeed, practiceFeed } from './content-fixtures.js';

const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };

test('内容来源拒绝内网、IP、凭据和危险重定向；每跳校验且不发送认证', async () => {
  for (const input of ['http://example.org/a', 'https://127.0.0.1/a', 'https://[::1]/', 'https://0x7f000001/', 'https://user:pass@example.org/', 'https://example.org:3000/', 'https://host.local/', 'https://docs.corp.kuaishou.com./', 'https://example.org/?api_key=secret']) assert.throws(() => publicUrl(input));
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.31.0.1', '192.168.1.2', '100.64.0.1', '198.19.0.1', '203.0.113.1', '224.0.0.1', '::1']) assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4('8.8.8.8'), true);
  let calls = 0;
  const reader = new PublicReader((async (_url, init) => { calls++; assert.equal(init?.redirect, 'manual'); assert.equal(new Headers(init?.headers).has('authorization'), false); return new Response(null, { status: 302, headers: { location: 'https://localhost/' } }); }) as typeof fetch);
  await assert.rejects(() => reader.read('https://example.org/feed'));
  assert.equal(calls, 1);
});

test('内容读取限制体积、重定向跳数、PDF 和失败响应', async () => {
  for (const response of [new Response('binary', { headers: { 'content-type': 'application/pdf' } }), new Response('x'.repeat(2_000_001)), new Response('limited', { status: 429 })]) {
    await assert.rejects(() => new PublicReader((async () => response) as typeof fetch).read('https://example.org/a'));
  }
  let calls = 0;
  await assert.rejects(() => new PublicReader((async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }); }) as typeof fetch).read('https://example.org/a'), /重定向过多/);
  assert.equal(calls, 4);
});

test('解析真实格式 Atom/RSS、CDATA、命名空间与作者，arXiv 版本去重', () => {
  const paper = parseFeed(paperFeed(), 'arXiv', 'https://export.arxiv.org/api/query', 'paper')[0];
  assert.equal(paper.url, 'https://arxiv.org/abs/2610.00001'); assert.equal(paper.version, 'v2'); assert.deepEqual(paper.authors, ['Test Author']); assert.equal(paper.coverage, 'abstract');
  const older = parseFeed(paperFeed().replaceAll('v2', 'v1'), 'arXiv', 'https://export.arxiv.org/api/query', 'paper')[0];
  assert.equal(paper.id, older.id);
  const practice = parseFeed(practiceFeed(), 'Blog', 'https://example.org/feed', 'practice')[0];
  assert.equal(practice.text, articleText); assert.equal(practice.coverage, 'feed'); assert.ok(practice.publishedAt);
  const xhtml = '<feed><entry><title>A &amp; B</title><link href="https://example.org/b"/><content><div>First <b>middle</b> last &#x1f680;</div></content></entry></feed>';
  const result = parseFeed(xhtml, 'Blog', 'https://example.org/feed', 'practice')[0];
  assert.equal(result.title, 'A & B'); assert.equal(result.text, 'First middle last 🚀');
  assert.equal(parseFeed('<rss><channel><item><title>AI workflow</title><link>https://example.org/no-summary</link></item></channel></rss>', 'Blog', 'https://example.org/feed', 'practice')[0].text, '');
  assert.ok(parseFeed(practiceFeed().replace('<p>', '<!DOCTYPE html><p>'), 'Blog', 'https://example.org/feed', 'practice').length);
  assert.equal(arxivId('https://arxiv.org/pdf/hep-th/9901001v2.pdf'), 'hep-th/9901001v2');
  assert.equal(canonicalContentUrl('https://example.org/post?utm_source=rss&b=2&a=1#top'), 'https://example.org/post?a=1&b=2');
});

test('拒绝畸形 XML/DTD、不误收普通网页；正文不执行脚本且不绕过登录', () => {
  for (const input of ['<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed/>', '<feed><entry></feed>', '<feed/><rss/>', '<html>not feed</html>', '<feed><entry']) assert.throws(() => parseFeed(input, 'Blog', 'https://example.org/feed', 'practice'));
  const article = parseArticle(articleHtml, 'https://example.org/article-1', 'Blog');
  assert.equal(article.text, articleText); assert.equal(article.coverage, 'excerpt'); assert.deepEqual(article.authors, ['Test Author']);
  assert.throws(() => parseArticle('<html><body>Please log in</body></html>', 'https://example.org/private', 'Blog'), /正文不足/);
});

test('独立偏好校验、数量可配，短 AI 词不匹配 detail 或 email', () => {
  const store = new Store(':memory:');
  try {
    const settings = contentSettings(); settings.content.practice.terms = ['AI'];
    store.set('settings', validateSettings(settings)); const content = new ContentService(store);
    content.db.save({ ...fixtureContent('practice'), title: 'details', text: 'send email' });
    assert.equal(content.candidates().length, 0);
    for (const patch of [{ batchSize: 0 }, { windowDays: 2.5 }, { paper: { ...settings.content.paper, terms: ['term" OR all:*'] } }, { practice: { ...settings.content.practice, feeds: [{ name: 'bad', url: 'https://127.0.0.1/', enabled: true }] } }]) assert.throws(() => validateSettings({ ...settings, content: { ...settings.content, ...patch } }));
    assert.equal(validateSettings({ ...settings, content: undefined }).content?.enabled, false);
  } finally { store.close(); }
});

test('报告原文引用强校验；实践缺少步骤/正文、低可信或间接相关不进精选', () => {
  const settings = contentSettings(); const item = fixtureContent('practice'); const reply = contentReply(item);
  assert.equal(parseContentReport(JSON.stringify(reply), item, settings).verdict, 'recommend');
  assert.throws(() => parseContentReport(JSON.stringify({ ...reply, unknowns: [reply.problem[0]] }), item, settings), /unknowns\[0\].*非空字符串/);
  assert.throws(() => parseContentReport(JSON.stringify({ ...reply, problem: [{ text: 'x', quote: 'fabricated evidence' }] }), item, settings), /原文/);
  for (const patch of [{ workflow: [] }, { workflow: [reply.workflow[0], reply.workflow[0]] }, { tools: [] }, { confidence: 'low' }, { relevance: 'adjacent' }]) assert.equal(parseContentReport(JSON.stringify({ ...reply, ...patch }), item, settings).verdict, 'watch');
  assert.equal(parseContentReport(JSON.stringify(reply), { ...item, coverage: 'feed' }, settings).verdict, 'watch');
  const paper = fixtureContent(); const report = parseContentReport(JSON.stringify(contentReply(paper)), paper, settings);
  assert.ok(report.unknowns.some(value => value.includes('仅依据 arXiv 摘要')));
  assert.equal(report.key, contentAnalysisKey(paper, settings));
});

test('偏好/模型/正文变更使报告过期，数量与预算变更不重复分析', () => {
  const settings = contentSettings(); const item = fixtureContent(); item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings);
  assert.equal(decorateContent(item, settings).analysisStatus, 'done');
  assert.equal(decorateContent({ ...item, text: item.text + 'Changed' }, settings).analysisStatus, 'stale');
  assert.equal(decorateContent(item, { ...settings, model: { ...settings.model, name: 'other' } }).analysisStatus, 'stale');
  assert.equal(decorateContent(item, { ...settings, content: { ...settings.content, paper: { ...settings.content.paper, goal: 'Another goal' } } }).analysisStatus, 'stale');
  assert.equal(decorateContent(item, { ...settings, dailyLimit: 4, model: { ...settings.model, dailyBudget: 100 }, content: { ...settings.content, batchSize: 2, paper: { ...settings.content.paper, limit: 1 } } }).analysisStatus, 'done');
});

test('论文按阅读价值推荐，摘要与实验未知不自动降级，但引用、贡献与相关性门槛保留', () => {
  const settings = contentSettings(); const item = fixtureContent(); const reply = contentReply(item);
  reply.unknowns = ['仅阅读摘要，实验、成本和同行评审尚未核实。'];
  const report = parseContentReport(JSON.stringify(reply), item, settings);
  assert.equal(report.verdict, 'recommend'); assert.ok(report.unknowns.some(value => value.includes('未核实全文实验')));
  assert.ok(contentPromptFor('paper').includes('recommend = 值得用户花时间阅读原文'));
  assert.ok(contentPromptFor('paper').includes('本身不是降为 watch 的理由'));
  assert.equal(contentPromptFor('practice'), contentPrompt);
  for (const patch of [{ contribution: [] }, { relevance: 'adjacent' }, { confidence: 'low' }]) assert.equal(parseContentReport(JSON.stringify({ ...reply, ...patch }), item, settings).verdict, 'watch');
  assert.equal(parseContentReport(JSON.stringify({ ...reply, verdict: 'watch' }), item, settings).verdict, 'watch');
  assert.equal(parseContentReport(JSON.stringify({ ...reply, verdict: 'skip' }), item, settings).verdict, 'skip');
  assert.throws(() => parseContentReport(JSON.stringify({ ...reply, contribution: [{ text: 'Unsupported', quote: 'fabricated contribution' }] }), item, settings), /原文/);
});

test('论文规则升级只失效论文旧报告，实践缓存与已存历史原样保留', () => {
  const store = new Store(':memory:'); const settings = contentSettings(); store.set('settings', settings); const content = new ContentStore(store);
  try {
    for (const kind of ['paper', 'practice'] as const) {
      const item = fixtureContent(kind); const preferences = settings.content[kind];
      const legacyKey = createHash('sha256').update(JSON.stringify(['content-v2', item.kind, item.url, item.title, item.text, item.coverage, preferences.goal, preferences.terms, settings.model.name, settings.model.endpoint, settings.model.ccSwitch])).digest('hex');
      item.report = { ...parseContentReport(JSON.stringify(contentReply(item)), item, settings), key: legacyKey };
      content.save(item); content.capture([item], dayKey());
      assert.equal(decorateContent(item, settings).analysisStatus, kind === 'paper' ? 'stale' : 'done');
      assert.equal(content.snapshot(dayKey(), item.id)!.item.report!.key, legacyKey);
      assert.equal(content.snapshot(dayKey(), item.id)!.item.analysisStatus, 'done');
    }
  } finally { store.close(); }
});

test('重启保留用户状态、更新去重、首次历史快照不被后来分析覆盖', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-content-'));
  let store = new Store(directory);
  try {
    const settings = contentSettings(); const item = fixtureContent(); item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings);
    const content = new ContentStore(store); content.save(item); content.patch(item.id, { read: true, favorite: true }); content.capture([item], dayKey());
    content.upsert({ ...item, title: 'Changed title', version: 'v3' }); content.capture([{ ...item, title: 'Changed title' }], dayKey());
    store.close(); store = new Store(directory); const restored = new ContentStore(store);
    assert.equal(restored.items().length, 1); assert.equal(restored.item(item.id)?.favorite, true); assert.equal(restored.item(item.id)?.read, true);
    assert.equal(restored.snapshot(dayKey(), item.id)?.item.title, item.title); assert.equal(restored.snapshot(dayKey(), item.id)?.item.favorite, false); assert.equal(restored.snapshot(dayKey(), item.id)?.item.text, item.text);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('混合精选受全局与类型上限约束、无合格内容不凑数', () => {
  const articles = [fixtureContent('paper', 1), fixtureContent('paper', 2), fixtureContent('practice', 1)];
  const selected = readingSelection([1, 2, 3, 4], articles, 4, { ...defaultContent, paper: { ...defaultContent.paper, limit: 1 } });
  assert.deepEqual(selected.repoIds, [1, 2]); assert.deepEqual(selected.articles.map(item => item.kind), ['paper', 'practice']);
  assert.equal(readingSelection([], articles, 12, defaultContent).articles.length, 3);
});

test('文章占用名额后重新按双池比例分配，不把潜力池直接裁掉', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); settings.dailyLimit = 4; store.set('settings', settings);
  for (let index = 1; index <= 8; index++) store.upsertRepo(fixtureRepo(index, { stars: index <= 4 ? 2000 : 100 }));
  const { app, content, dashboard } = makeApp(store, { serveStatic: false });
  try {
    for (const kind of ['paper', 'practice'] as const) { const item = fixtureContent(kind); item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings); content.db.save(item); }
    const data = dashboard(); assert.equal(data.content?.featured.length, 2); assert.equal(data.highStarIds.length, 1); assert.equal(data.potentialIds.length, 1);
  } finally { await app.close(); store.close(); }
});

test('混合精选保留各项目专题权重，不按专题数组前缀截断', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); settings.dailyLimit = 5;
  settings.focus = { enabled: true, topics: ['alpha', 'beta', 'gamma'].map(id => ({ id, name: id, goal: 'Test goal', enabled: true, weight: 1, terms: [id], exclusions: [] })) }; store.set('settings', settings);
  const { app, content, analyses, dashboard } = makeApp(store, { serveStatic: false });
  try {
    for (let index = 1; index <= 9; index++) {
      const topicId = settings.focus.topics[Math.floor((index - 1) / 3)].id;
      store.upsertRepo(fixtureRepo(index, { description: `${topicId} AI tool`, topics: [topicId] })); store.patchRepo(index, { readme: testReadme });
      const repo = analyses.decorate(store.repo(index)!); const sources = evidenceFor(repo, store); const reply = analysisReply(sources); const finding = reply.capabilities[0];
      store.saveAnalysis(parseAnalysis(JSON.stringify({ ...reply, focusReview: { topicId, task: `task-${index}`, relevance: 'direct', relationship: [finding], benefit: [finding], trial: [finding], timeliness: [] } }), repo, settings, sources));
    }
    for (const kind of ['paper', 'practice'] as const) { const item = fixtureContent(kind); item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings); content.db.save(item); }
    const data = dashboard(); assert.equal(data.content?.featured.length, 2); assert.deepEqual(data.focusSections?.map(section => section.repoIds.length), [1, 1, 1]);
  } finally { await app.close(); store.close(); }
});

test('真实服务路径用隔离模拟源验证采集、补正文、分析、ETag 和缓存；无个人数据外发', async () => {
  const store = new Store(':memory:'); store.set('settings', contentSettings()); store.saveSecrets({ githubToken: 'DO-NOT-SEND-GITHUB', modelKey: 'MODEL-KEY' });
  let models = 0; let articles = 0; let feeds = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); assert.ok(!String(init?.body).includes('DO-NOT-SEND-GITHUB'));
    if (url.hostname === '127.0.0.1') {
      models++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer MODEL-KEY');
      const request = JSON.parse(String(init?.body)); const source = JSON.parse(request.messages[1].content);
      assert.equal(request.messages[0].content, contentPromptFor(source.kind));
      assert.ok(!('favorite' in source)); assert.ok(!('read' in source));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(contentReply(source)) } }] });
    }
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    if (url.hostname === 'export.arxiv.org') { await gate; return new Response(paperFeed()); }
    if (url.pathname === '/feed') { feeds++; if (feeds > 1) { assert.equal(new Headers(init?.headers).get('if-none-match'), 'v1'); return new Response(null, { status: 304 }); } return new Response(practiceFeed(), { headers: { etag: 'v1' } }); }
    articles++; return new Response(articleHtml);
  }) as typeof fetch;
  const { app, content, analyses, sync } = makeApp(store, { serveStatic: false, fetcher });
  try {
    const start = await app.inject({ url: '/api/content/sync', method: 'POST', headers, payload: {} }); assert.equal(start.statusCode, 200);
    assert.throws(() => analyses.start(), /其他内容/); assert.equal(sync.start(), false);
    release();
    await content.idle(); assert.deepEqual(content.status().errors, []); assert.equal(content.featured().length, 2); assert.equal(models, 2); assert.equal(articles, 1);
    content.start('sync'); await content.idle(); assert.equal(models, 2); assert.equal(articles, 1); assert.equal(feeds, 2);
    const response = await app.inject({ url: '/api/content?kind=paper', headers }); assert.equal(response.json().items[0].text, '');
    const dashboard = (await app.inject({ url: '/api/dashboard', headers })).json(); assert.equal(dashboard.content.featured.length, 2); assert.ok(dashboard.content.featured.every((item: { text: string }) => item.text === ''));
    const days = (await app.inject({ url: '/api/history', headers })).json().days; assert.equal(days[0].count, 2); assert.ok(days[0].leadTitle);
    const entry = content.featured()[0]; const snapshot = (await app.inject({ url: `/api/history/${dayKey()}/content/${entry.id}`, headers })).json(); assert.ok(snapshot.item.text);
    await app.inject({ url: `/api/content/${entry.id}`, method: 'PATCH', headers, payload: { read: true, favorite: true } });
    assert.equal((await app.inject({ url: '/api/content?view=library', headers })).json().total, 1);
    assert.equal((await app.inject({ url: `/api/history/${dayKey()}`, headers })).json().content.length, 2);
  } finally { release(); await content.idle(); await app.close(); store.close(); }
});

test('单源失败不阻塞其他来源；分析预算共享且失败不伪造报告', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); settings.model.dailyBudget = 1; store.set('settings', settings);
  let calls = 0;
  const service = new ContentService(store, (async input => {
    if (String(input).includes('export.arxiv.org')) return new Response('no', { status: 503 });
    if (String(input).includes('127.0.0.1')) { calls++; return new Response('malformed json'); }
    return new Response(practiceFeed());
  }) as typeof fetch);
  try {
    settings.content.autoAnalyze = false; store.set('settings', settings); service.start('sync'); await service.idle();
    assert.equal(service.items().length, 1); assert.equal(service.status().errors.length, 1);
    const item = fixtureContent(); service.db.save(item); service.db.save(fixtureContent('paper', 2));
    service.start('analyze'); await service.idle(); assert.equal(calls, 1); assert.equal(service.featured().length, 0); assert.ok(service.status().errors.length);
    assert.equal(service.tick(), false);
  } finally { await service.idle(); store.close(); }
});

test('混合首页/历史缓存不联网，设置更改马上移除旧分析，项目名额正常补位', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); settings.dailyLimit = 3; store.set('settings', settings);
  for (let index = 1; index <= 5; index++) store.upsertRepo(fixtureRepo(index));
  const { app, content } = makeApp(store, { serveStatic: false, fetcher: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  try {
    for (const kind of ['paper', 'practice'] as const) { const item = fixtureContent(kind); item.report = parseContentReport(JSON.stringify(contentReply(item)), item, settings); content.db.save(item); }
    const first = await app.inject({ url: '/api/dashboard', headers }); assert.equal(first.json().featuredIds.length, 1); assert.equal(first.json().content.featured.length, 2);
    assert.equal((await app.inject({ url: '/api/dashboard', headers: { ...headers, 'if-none-match': first.headers.etag! } })).statusCode, 304);
    store.set('settings', { ...settings, content: { ...settings.content, paper: { ...settings.content.paper, goal: 'Changed' } } });
    const second = (await app.inject({ url: '/api/dashboard', headers })).json(); assert.equal(second.content.featured.length, 1); assert.equal(second.featuredIds.length, 2);
    const history = (await app.inject({ url: `/api/history/${dayKey()}`, headers })).json(); assert.equal(history.content.length, 2);
    assert.equal((await app.inject({ url: '/api/content?page=0', headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/content/import', method: 'POST', headers, payload: { kind: 'paper', url: 'http://127.0.0.1/a.pdf' } })).statusCode, 400);
  } finally { await app.close(); store.close(); }
});
