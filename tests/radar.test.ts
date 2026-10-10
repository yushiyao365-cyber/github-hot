import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { installRadar, validateRadar } from '../server/radar-config.js';
import { radarBoard, radarApproved } from '../server/radar.js';
import { defaultRadar, repoModule } from '../shared/radar.js';
import { radarFixture } from './radar-fixtures.js';
import { fixtureRepo } from './fixtures.js';
import { ContentService } from '../server/content-service.js';
import { contentSettings, articleHtml } from './content-fixtures.js';
import { collectSkills } from '../server/skill-evidence.js';
import { Github } from '../server/github.js';
import { pdfExcerpt } from '../server/pdf-reader.js';
import { validateSettings } from '../server/config.js';
import { spawnSync } from 'node:child_process';
import type { RadarBoard } from '../shared/radar.js';

test('模块迁移只执行一次，备份原偏好，保留模型、数量、个人状态和令牌', () => {
  const store = new Store(':memory:');
  try {
    const settings = contentSettings(); settings.dailyLimit = 7; store.set('settings', settings); store.saveSecrets({ githubToken: 'test-only' });
    store.upsertRepo(fixtureRepo()); store.patchRepo(1, { favorite: true, notes: 'private' });
    assert.equal(installRadar(store), true); assert.equal(installRadar(store), false);
    assert.deepEqual(store.settings().model, settings.model); assert.equal(store.settings().dailyLimit, 7);
    assert.deepEqual(store.get('settingsBeforeRadarV1', null), settings);
    assert.equal(store.repo(1)?.notes, 'private'); assert.equal(store.repo(1)?.favorite, true); assert.equal(store.secret('githubToken'), 'test-only');
    assert.deepEqual(store.settings().focus?.topics.map(topic => topic.id), ['paimon', 'skills', 'workflows']);
    assert.throws(() => validateRadar({ ...defaultRadar, modules: { ...defaultRadar.modules, skills: { enabled: true, hotLimit: 1.5, featuredLimit: 3 } } }));
  } finally { store.close(); }
});

test('四模块共同分配首页，独立上限生效；未审核、已读和过期内容不凑数', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  try {
    const settings = store.settings(); settings.dailyLimit = 4;
    const repos = store.repos().map(repo => services.analyses.decorate(repo));
    const board = radarBoard(repos, services.content.items(), settings, 'home');
    assert.deepEqual(board.groups.map(group => group.entries.length), [1, 1, 1, 1]);
    settings.radar!.modules.skills.featuredLimit = 0;
    const changed = radarBoard(repos, services.content.items(), settings, 'home');
    assert.equal(changed.groups[1].entries.length, 0); assert.equal(changed.groups.flatMap(group => group.entries).length, 4);
    assert.equal(radarApproved({ ...repos[0], analysis: { ...repos[0].analysis!, status: 'stale' } }), false);
    const excluded = radarBoard(repos.map(repo => ({ ...repo, read: true })), [], settings, 'home');
    assert.equal(excluded.groups.flatMap(group => group.entries).length, 0);
  } finally { await services.app.close(); store.close(); }
});

test('Skill 三榜使用不同真实信号；没有样本不伪造增速', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  try {
    const settings = store.settings(); const repos = store.repos().map(repo => services.analyses.decorate(repo));
    const skills = (sort: string, input = repos) => radarBoard(input, [], settings, 'hotlist', { sort }).groups[1].entries;
    assert.equal(skills('growth').length, 1); assert.equal(skills('stars').length, 1); assert.equal(skills('new').length, 0);
    assert.equal(skills('growth', repos.map(repo => ({ ...repo, growth: null }))).length, 0);
    assert.equal(skills('stars', repos.map(repo => ({ ...repo, growth: null }))).length, 1);
    assert.equal(repoModule(fixtureRepo(99, { fullName: 'game/genshin-paimon', description: 'Genshin game' })), null);
    assert.equal(repoModule(fixtureRepo(99, { description: 'Basic developer skills tutorial', topics: [] })), null);
  } finally { await services.app.close(); store.close(); }
});

test('模块 API 缓存只读、分页与状态筛选，旧清单仍能访问', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  const headers = { host: '127.0.0.1:4314', 'x-radar-client': '1' };
  try {
    store.upsertRepo(fixtureRepo(100, { description: 'legacy item', topics: [] })); store.patchRepo(100, { favorite: true });
    const first = await services.app.inject({ url: '/api/radar', headers }); assert.equal(first.statusCode, 200);
    assert.equal(first.json().groups.length, 4);
    assert.equal((await services.app.inject({ url: '/api/radar', headers: { ...headers, 'if-none-match': String(first.headers.etag) } })).statusCode, 304);
    assert.equal((await services.app.inject({ url: '/api/radar?view=library', headers })).json().unclassified.length, 1);
    const library = await services.app.inject({ url: '/api/radar?view=library&query=absent', headers }); assert.equal(library.json().unclassified.length, 0);
    assert.equal((await services.app.inject({ url: '/api/radar?module=skills&view=candidates', headers })).json().groups.length, 1);
    for (const query of ['page=0', 'module=nope', 'view=nope', 'sort=nope', 'library=nope']) assert.equal((await services.app.inject({ url: `/api/radar?${query}`, headers })).statusCode, 400);
    assert.equal(services.calls(), 0);
    const reports = store.repos().filter(repo => repo.id < 4).map(repo => services.analyses.decorate(repo));
    store.set('settings', validateSettings(store.settings()));
    assert.deepEqual(reports.map(repo => services.analyses.decorate(store.repo(repo.id)!).analysis?.status), ['done', 'done', 'done']);
  } finally { await services.app.close(); store.close(); }
});

test('热点榜仅为上榜仓库附加真实采样，切换与304复用缓存，不增加首页负载或外网请求', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  const headers = { host: '127.0.0.1:4314', 'x-radar-client': '1' };
  const original = store.starSamples.bind(store); const sampled: number[] = [];
  store.starSamples = (id, now) => { sampled.push(id); return original(id, now); };
  try {
    const home = (await services.app.inject({ url: '/api/radar', headers })).json<RadarBoard>();
    assert.ok(home.groups.flatMap(group => group.entries).every(entry => !('samples' in entry)));
    assert.equal(sampled.length, 0);
    const first = await services.app.inject({ url: '/api/radar?view=hotlist&module=skills', headers });
    const entries = first.json<RadarBoard>().groups[0].entries;
    assert.deepEqual(sampled, [2]);
    assert.equal(entries.length, 1); assert.equal(entries[0].type, 'repo');
    if (entries[0].type !== 'repo') throw new Error('Expected skill repository');
    assert.deepEqual(entries[0].samples, original(2).map(sample => ({ ...sample }))); assert.equal(entries[0].samples!.length, 2);
    assert.equal(entries[0].repo.readme, '');
    assert.ok(entries[0].repo.analysis?.report?.sources.every(source => source.text === ''));
    assert.equal((await services.app.inject({ url: '/api/radar?view=hotlist&module=skills', headers: { ...headers, 'if-none-match': String(first.headers.etag) } })).statusCode, 304);
    await services.app.inject({ url: '/api/radar?view=hotlist&module=skills&sort=stars', headers });
    assert.deepEqual(sampled, [2]);
    const papers = (await services.app.inject({ url: '/api/radar?view=hotlist&module=papers', headers })).json<RadarBoard>();
    assert.ok(papers.groups[0].entries.every(entry => entry.type === 'content' && !('samples' in entry)));
    assert.deepEqual(sampled, [2]);
    store.starSamples = id => { sampled.push(id); return []; };
    store.patchRepo(2, { favorite: true });
    const missing = (await services.app.inject({ url: '/api/radar?view=hotlist&module=skills&sort=stars', headers })).json<RadarBoard>();
    assert.equal(missing.groups[0].entries.length, 1);
    assert.deepEqual(missing.groups[0].entries[0].type === 'repo' && missing.groups[0].entries[0].samples, []);
    assert.deepEqual(sampled, [2, 2]);
    assert.equal(services.calls(), 0);
  } finally { await services.app.close(); store.close(); }
});

test('公开 HTML 白皮书使用论文 ID 与正文覆盖标记，不误称 arXiv 摘要', async () => {
  const store = new Store(':memory:'); const settings = contentSettings(); settings.content.autoAnalyze = false; store.set('settings', settings);
  const service = new ContentService(store, (async () => new Response(articleHtml, { headers: { 'content-type': 'text/html' } })) as typeof fetch);
  try {
    service.start('import', { url: 'https://example.org/report', kind: 'paper', module: 'papers' }); await service.idle();
    const item = service.items()[0]; assert.equal(item.kind, 'paper'); assert.equal(item.coverage, 'excerpt'); assert.equal(item.module, 'papers'); assert.match(item.publication, /白皮书/);
    assert.equal(service.status().errors.length, 0);
    assert.throws(() => service.start('import', { url: 'https://127.0.0.1/private', kind: 'paper' }));
    await assert.rejects(pdfExcerpt(new Response('not a pdf')), /有效 PDF/);
    await assert.rejects(pdfExcerpt(new Response(new Uint8Array(2_000_001))), /2 MB/);
  } finally { await service.idle(); store.close(); }
});

test('Skill 索引全部五个文件，初始只预读三个且复用缓存，不执行内容', async () => {
  const store = new Store(':memory:'); installRadar(store); let calls = 0;
  const repo = fixtureRepo(1, { description: 'Agent skills', readme: 'SKILL.md' });
  const fetcher = (async (input: string | URL | Request) => {
    calls++;
    return new Response(JSON.stringify(String(input).includes('/git/trees/') ? { tree: Array.from({ length: 5 }, (_, index) => ({ path: `skills/test-${index}/SKILL.md`, type: 'blob', sha: String(index).repeat(40), size: 300 })), truncated: false } : { content: Buffer.from('Test-only skill content. Never execute.').toString('base64'), encoding: 'base64' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new Github('', () => {}, fetcher, store); await collectSkills(repo, client, store); await collectSkills(repo, client, store);
    const saved = store.get<{ paths: string[]; sources: unknown[] }>('skills:1', { paths: [], sources: [] });
    assert.equal(saved.paths.length, 5); assert.equal(saved.sources.length, 3); assert.equal(calls, 4);
  } finally { store.close(); }
});

test('PDF 白皮书提取真实可复制文字，缺少本机解析器时明确跳过此环境检查', { skip: spawnSync('pdftotext', ['-v']).error?.message }, async () => {
  const stream = 'BT /F1 12 Tf 30 700 Td ' + Array.from({ length: 8 }, () => '(Test-only language model whitepaper extraction fixture.) Tj 0 -18 Td').join(' ') + ' ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const text = await pdfExcerpt(new Response(pdf));
  assert.match(text, /Test-only language model whitepaper/); assert.ok(text.length >= 160);
});
