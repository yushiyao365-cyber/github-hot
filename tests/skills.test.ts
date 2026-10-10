import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/store.js';
import { Github } from '../server/github.js';
import { collectSkills, readSkill, skillId, type SkillInventory } from '../server/skill-evidence.js';
import { ContentStore } from '../server/content-store.js';
import { contentAnalysisKey, decorateContent, parseContentReport } from '../server/content-analysis.js';
import { radarBoard } from '../server/radar.js';
import { installRadar, validateRadar } from '../server/radar-config.js';
import { makeApp } from '../server/app.js';
import { defaultRadar } from '../shared/radar.js';
import { skillLabel, type ContentItem } from '../shared/content.js';
import RadarHotlist from '../src/RadarHotlist.js';
import { fixtureRepo } from './fixtures.js';
import { articleText, contentReply, contentSettings } from './content-fixtures.js';

const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };
const file = (index: number, sha = index.toString(16).padStart(40, '0')) => ({ path: `skills/example-${index}/SKILL.md`, sha, type: 'blob', size: 500 });
function setup() {
  const store = new Store(':memory:'); store.set('settings', contentSettings()); installRadar(store);
  const repo = fixtureRepo(1, { fullName: 'test-only/agent-skills', url: 'https://github.com/test-only/agent-skills', description: 'Agent skills', readme: 'SKILL.md', createdAt: '2020-01-01T00:00:00Z' });
  store.upsertRepo(repo);
  return { store, repo, db: new ContentStore(store) };
}
function expireInventory(store: Store) {
  const old = store.get<SkillInventory>('skills:1', { paths: [], sources: [], fetchedAt: '', truncated: false });
  store.set('skills:1', { ...old, fetchedAt: '2020-01-01T00:00:00Z' });
}

test('独立 Skill 全量索引、懒读第四个文件；基线不冒充新发布，SHA 变化不丢收藏或历史', async () => {
  const { store, repo, db } = setup();
  let files = [1, 2, 3, 4, 5].map(index => file(index)); let truncated = false; const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    calls.push(String(input));
    return Response.json(String(input).includes('/git/trees/') ? { tree: files, truncated } : { encoding: 'base64', content: Buffer.from(articleText).toString('base64') });
  };
  const client = new Github('', () => {}, fetcher);
  try {
    await collectSkills(repo, client, store);
    assert.equal(db.items().length, 5); assert.equal(calls.length, 4);
    assert.ok(db.items().every(item => item.skill?.change === 'baseline' && item.publishedAt === null && !item.report));
    const id = skillId(repo.id, file(4).path); let fourth = db.item(id)!;
    assert.equal(fourth.text, '');
    fourth = await readSkill(fourth, client); fourth.report = parseContentReport(JSON.stringify(contentReply(fourth)), fourth, store.settings()); db.save(fourth);
    assert.equal(calls.length, 5); assert.equal(decorateContent(db.item(id)!, store.settings()).analysisStatus, 'done');
    assert.equal(skillLabel(fourth), '存量 Skill');
    db.patch(id, { favorite: true, read: true }); db.capture([fourth], '2026-10-09');
    const oldSnapshot = db.snapshot('2026-10-09', id);
    await collectSkills(repo, client, store); assert.equal(calls.length, 5);
    files = [file(1), file(2), file(3), file(4, 'f'.repeat(40)), file(5), file(6)]; expireInventory(store);
    await collectSkills(repo, client, store);
    const changed = db.item(id)!;
    assert.equal(changed.skill?.change, 'changed'); assert.equal(changed.text, '');
    assert.equal(changed.favorite, true); assert.equal(changed.read, true);
    assert.equal(changed.firstSeenAt, fourth.firstSeenAt);
    assert.equal(decorateContent(changed, store.settings()).analysisStatus, 'stale');
    assert.equal(db.item(skillId(repo.id, file(6).path))?.skill?.change, 'added');
    assert.deepEqual(db.snapshot('2026-10-09', id), oldSnapshot);
    files = [file(1)]; truncated = true; expireInventory(store); await collectSkills(repo, client, store);
    assert.equal(db.item(id)?.skill?.active, true);
    files = [file(1), file(7)]; truncated = false; expireInventory(store); await collectSkills(repo, client, store);
    assert.equal(db.item(id)?.skill?.active, false); assert.equal(db.item(id)?.favorite, true);
    assert.equal(db.item(skillId(repo.id, file(7).path))?.skill?.change, 'baseline');
  } finally { store.close(); }
});

test('独立 Skill 不继承仓库审核；实质步骤及引用不足不精选，展示配置不使报告过期', async () => {
  const { store, repo, db } = setup();
  const client = new Github('', () => {}, async input => Response.json(String(input).includes('/git/trees/') ? { tree: [file(1)] } : { encoding: 'base64', content: Buffer.from(articleText).toString('base64') }));
  try {
    await collectSkills(repo, client, store); const item = db.items()[0];
    assert.equal(item.report, null);
    const report = parseContentReport(JSON.stringify(contentReply(item)), item, store.settings()); assert.equal(report.verdict, 'recommend');
    const insufficient = contentReply(item); insufficient.workflow = [insufficient.workflow[0]];
    assert.equal(parseContentReport(JSON.stringify(insufficient), item, store.settings()).verdict, 'watch');
    const fabricated = contentReply(item); fabricated.takeaway[0] = { text: 'fake', quote: 'nonexistent source quotation' };
    assert.throws(() => parseContentReport(JSON.stringify(fabricated), item, store.settings()), /引用/);
    const settings = store.settings();
    assert.equal(contentAnalysisKey(item, settings), contentAnalysisKey(item, { ...settings, dailyLimit: 1, radar: { ...settings.radar!, review: { batchSize: 50, intervalMinutes: 5 } } }));
    assert.notEqual(contentAnalysisKey(item, settings), contentAnalysisKey({ ...item, skill: { ...item.skill!, sha: 'b'.repeat(40) } }, settings));
  } finally { store.close(); }
});

test('Skill 分批逐条真实走模型协议、超出首页配额、收藏与轻量 API 和紧凑榜单保留', async () => {
  const { store, repo } = setup();
  const settings = store.settings(); settings.dailyLimit = 1; settings.radar!.review = { batchSize: 4, intervalMinutes: 5 }; settings.model.endpoint = 'https://model.test/v1/chat/completions'; store.set('settings', settings);
  let modelCalls = 0; const blobPaths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://model.test')) {
      modelCalls++; const body = JSON.parse(String(init?.body)); const submitted = JSON.parse(body.messages[1].content);
      assert.equal(submitted.module, 'skills'); assert.equal(submitted.text, articleText);
      return Response.json({ choices: [{ message: { content: JSON.stringify(contentReply({ ...submitted, kind: 'practice' } as ContentItem)) } }] });
    }
    if (url.includes('/git/trees/')) return Response.json({ tree: [1, 2, 3, 4, 5].map(index => file(index)) });
    if (url.includes('/git/blobs/')) { blobPaths.push(url); return Response.json({ encoding: 'base64', content: Buffer.from(articleText).toString('base64') }); }
    throw new Error(`Unexpected request ${url}`);
  };
  const services = makeApp(store, { fetcher, serveStatic: false });
  try {
    await collectSkills(repo, new Github('', () => {}, fetcher), store);
    services.content.start('analyze'); await services.content.idle();
    assert.deepEqual(services.content.status().errors, []); assert.equal(modelCalls, 4);
    services.content.start('analyze'); await services.content.idle(); assert.equal(modelCalls, 5); assert.equal(blobPaths.length, 5);
    services.content.start('analyze'); await services.content.idle(); assert.equal(modelCalls, 5);
    const id = services.content.items()[0].id;
    assert.equal((await services.app.inject({ method: 'PATCH', url: `/api/content/${id}`, headers, payload: { favorite: true } })).statusCode, 200);
    const home = (await services.app.inject({ url: '/api/radar?module=skills', headers })).json();
    assert.equal(home.groups[0].entries.length, 1); assert.equal(home.groups[0].entries[0].type, 'content'); assert.equal(home.groups[0].entries[0].item.text, '');
    const response = await services.app.inject({ url: '/api/radar?view=hotlist&module=skills&sort=stars', headers }); const board = response.json();
    assert.equal(board.groups[0].entries.length, 2);
    assert.ok(board.groups[0].entries.every((entry: { item: ContentItem }) => entry.item.skill?.stars === repo.stars));
    assert.equal((await services.app.inject({ url: '/api/radar?view=hotlist&module=skills&sort=stars', headers: { ...headers, 'if-none-match': String(response.headers.etag) } })).statusCode, 304);
    const markup = renderToStaticMarkup(createElement(RadarHotlist, { board, sort: 'stars', busy: false, onOpen: () => {}, onPatch: () => {} }));
    assert.match(markup, /独立 Skill/); assert.match(markup, /来源仓库 Star/); assert.doesNotMatch(markup, /radar-story/);
    const library = (await services.app.inject({ url: '/api/radar?view=library&module=skills', headers })).json();
    assert.equal(library.groups[0].entries[0].item.id, id);
  } finally { await services.app.close(); store.close(); }
});

test('新兴榜依据单个文件观测而非老仓库创建时间，存量优选不受文章时间窗排除', () => {
  const { store, repo } = setup();
  try {
    const now = Date.now();
    const item: ContentItem = {
      id: 'test-skill', module: 'skills', kind: 'practice', title: 'Test Skill', url: `${repo.url}/blob/HEAD/SKILL.md`, authors: [], source: repo.fullName,
      publishedAt: null, updatedAt: null, fetchedAt: new Date(now).toISOString(), firstSeenAt: '2020-01-01T00:00:00Z', text: articleText, coverage: 'excerpt', version: 'test', publication: '', favorite: false, read: false, ignored: false, report: null, analysisStatus: 'done', error: '',
      skill: { repoId: repo.id, repository: repo.fullName, path: 'SKILL.md', sha: 'a'.repeat(40), active: true, firstObservedAt: '2020-01-01T00:00:00Z', change: 'baseline', observedAt: '2020-01-01T00:00:00Z', stars: 1000, starsPerDay: null },
    };
    item.report = parseContentReport(JSON.stringify(contentReply(item)), item, store.settings());
    const board = (sort: string, entry = item) => radarBoard([repo], [entry], store.settings(), 'hotlist', { sort, now }).groups[1];
    assert.equal(board('stars').entries.length, 1); assert.equal(board('growth').entries.length, 0); assert.equal(board('new').entries.length, 0);
    const added = { ...item, skill: { ...item.skill!, change: 'added' as const, observedAt: new Date(now - 60000).toISOString() } };
    assert.equal(board('new', added).entries.length, 1);
    assert.equal(board('new', { ...added, analysisStatus: 'pending', report: null }).entries.length, 0);
    assert.equal(board('new', { ...added, skill: { ...added.skill, active: false } }).entries.length, 0);
    assert.equal(board('new', { ...added, skill: { ...added.skill, observedAt: new Date(now + 60000).toISOString() } }).entries.length, 0);
    assert.equal(board('stars', { ...item, skill: { ...item.skill!, stars: 0 } }).entries.length, 1);
  } finally { store.close(); }
});

test('独立审核配置校验与旧配置兼容，正文只读且限制大小', async () => {
  assert.equal(validateRadar(defaultRadar).review, undefined);
  assert.deepEqual(validateRadar({ ...defaultRadar, review: { batchSize: 42, intervalMinutes: 10 } }).review, { batchSize: 42, intervalMinutes: 10 });
  for (const review of [{ batchSize: 0, intervalMinutes: 10 }, { batchSize: 2.5, intervalMinutes: 10 }, { batchSize: 24, intervalMinutes: 0 }]) assert.throws(() => validateRadar({ ...defaultRadar, review }));
  const item = { skill: { active: true, repository: 'test-only/skills', sha: 'a'.repeat(40) } } as ContentItem;
  await assert.rejects(readSkill(item, new Github('', () => {}, async () => Response.json({ encoding: 'base64', size: 200000, content: 'a' }))), /过大/);
});

test('自动 Skill 审核尊重模型开关；失败退避六小时，不在每轮重复消耗调用', async () => {
  const { store, repo } = setup();
  const settings = store.settings(); settings.model.endpoint = 'https://model.test/v1/chat/completions'; settings.model.autoAnalyze = false; settings.content!.autoSync = false; settings.content!.autoAnalyze = true; store.set('settings', settings);
  let calls = 0;
  const fetcher: typeof fetch = async input => {
    if (String(input).startsWith('https://model.test')) { calls++; return Response.json({ choices: [{ message: { content: '{}' } }] }); }
    return Response.json(String(input).includes('/git/trees/') ? { tree: [file(1)] } : { encoding: 'base64', content: Buffer.from(articleText).toString('base64') });
  };
  const services = makeApp(store, { fetcher, serveStatic: false });
  try {
    await collectSkills(repo, new Github('', () => {}, fetcher), store);
    assert.equal(services.content.tick(), false); assert.equal(calls, 0);
    services.content.start('analyze'); await services.content.idle(); assert.equal(calls, 1); assert.equal(services.content.status().generated, 0);
    services.content.start('analyze'); await services.content.idle(); assert.equal(calls, 1);
    const id = services.content.items()[0].id;
    store.set('settings', { ...settings, model: { ...settings.model, autoAnalyze: true } });
    store.set('contentLastAnalyzeAttempt', 0); assert.equal(services.content.tick(), false);
    store.set(`contentFailure:${id}`, { ...store.get(`contentFailure:${id}`, {}), at: 0 });
    assert.equal(services.content.tick(), true); await services.content.idle(); assert.equal(calls, 2);
  } finally { await services.app.close(); store.close(); }
});
