import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError, parseRepo, record, validateSettings } from './config.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';
import { dayKey, Summaries, summaryKey } from './summaries.js';
import { Analyses } from './analyses.js';
import { poolCandidates, selectPools, verifiedCandidate } from './recommendations.js';
import { assertCCSwitchModel, readCCSwitch } from './cc-switch.js';
import type { Dashboard, GithubRate, StarSample } from '../shared/types.js';
import { selectFocus } from './focus.js';
import { createHash } from 'node:crypto';
import { FeaturedHistory, validateHistoryDay } from './history.js';
import { HotlistService } from './hotlist.js';
import { ContentHotlistService } from './content-hotlist.js';
import { ContentService } from './content-service.js';
import { contentListItem } from './content-store.js';
import { defaultContent, readingSelection, type ContentKind } from '../shared/content.js';
import { decorateContent } from './content-analysis.js';
import { radarBoard } from './radar.js';
import { moduleIds, type ModuleId } from '../shared/radar.js';
import { activityFeed } from './activity.js';

export function makeApp(store: Store, options: { port?: number; fetcher?: typeof fetch; serveStatic?: boolean; ccSwitchDirectory?: string } = {}) {
  const port = options.port || 4310;
  const app = Fastify({ logger: false, bodyLimit: 100_000, requestTimeout: 120_000 });
  const sync = new SyncService(store, options.fetcher);
  const summaries = new Summaries(store, options.fetcher, options.ccSwitchDirectory);
  const analyses = new Analyses(store, sync, options.fetcher, options.ccSwitchDirectory);
  const history = new FeaturedHistory(store);
  const content = new ContentService(store, options.fetcher, options.ccSwitchDirectory);
  content.collectSkills = () => sync.collectSkillBatch();
  content.hydrateSkill = item => sync.hydrateSkill(item);
  const contentHotlist = new ContentHotlistService(store, content);
  const hotlist = new HotlistService(store, (repo, settings) => analyses.decorate(repo, settings));
  sync.externalBusy = () => analyses.status().running || content.status().running || summaries.busy;
  analyses.externalBusy = () => content.status().running || summaries.busy;
  content.externalBusy = () => store.status().running || analyses.status().running || summaries.busy;
  sync.onDiscovery = () => {
    captureFeatured();
    if (store.settings().model.enabled && store.settings().model.autoAnalyze) {
      try { analyses.autoStart(); } catch { }
    }
  };
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);
  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHosts.has(request.headers.host || '')) return reply.code(403).send({ error: '只允许本机访问' });
    const origin = request.headers.origin;
    if (origin && ![...allowedHosts].some(host => origin === `http://${host}`)) return reply.code(403).send({ error: '请求来源不被允许' });
    if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-radar-client'] !== '1') return reply.code(403).send({ error: '缺少本机客户端校验' });
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
    reply.code(status).send({ error: (status < 500 || error instanceof AppError) && error instanceof Error ? error.message : '操作未完成，请稍后重试；本地数据已保留' });
  });
  const captureFeatured = () => {
    const settings = store.settings();
    const rankedRepos = store.repos().map(repo => analyses.decorate(repo, settings));
    if (settings.radar) {
      const board = radarBoard(rankedRepos, content.items(), settings, 'home');
      const selected = board.groups.flatMap(group => group.entries);
      const featuredIds = selected.flatMap(entry => entry.type === 'repo' ? [entry.repo.id] : []);
      const contentIds = new Set(selected.flatMap(entry => entry.type === 'content' ? [entry.item.id] : []));
      const articles = content.items().filter(item => contentIds.has(item.id));
      history.capture(rankedRepos, featuredIds, settings);
      content.db.capture(articles, dayKey());
      return { settings, rankedRepos, pools: { highStars: featuredIds.filter(id => rankedRepos.find(repo => repo.id === id)?.pool === 'highStars'), potential: featuredIds.filter(id => rankedRepos.find(repo => repo.id === id)?.pool !== 'highStars') }, focusSections: undefined, featuredIds, articles };
    }
    const precise = settings.model.enabled && settings.model.autoAnalyze;
    const projectCandidates = precise ? rankedRepos.filter(repo => verifiedCandidate(repo, settings)) : rankedRepos;
    let pools = selectPools(projectCandidates, settings);
    let focusSections = settings.focus?.enabled ? selectFocus(rankedRepos, settings) : undefined;
    const projectIds = focusSections ? focusSections.flatMap(section => section.repoIds) : [...pools.highStars, ...pools.potential];
    const selected = readingSelection(projectIds, content.featured(), settings.dailyLimit, settings.content || defaultContent);
    if (selected.articles.length) {
      const projectSettings = { ...settings, dailyLimit: settings.dailyLimit - selected.articles.length };
      pools = selectPools(projectCandidates, projectSettings);
      if (focusSections) focusSections = selectFocus(rankedRepos, projectSettings);
    }
    const featuredIds = focusSections ? focusSections.flatMap(section => section.repoIds) : [...pools.highStars, ...pools.potential];
    const selectedIds = new Set(featuredIds);
    pools.highStars = pools.highStars.filter(id => selectedIds.has(id));
    pools.potential = pools.potential.filter(id => selectedIds.has(id));
    history.capture(rankedRepos, featuredIds, settings);
    content.db.capture(selected.articles, dayKey());
    return { settings, rankedRepos, pools, focusSections, featuredIds, articles: selected.articles };
  };
  const dashboard = (): Dashboard => {
    const { settings, rankedRepos, pools, focusSections, featuredIds, articles } = captureFeatured();
    const repos = rankedRepos.map(repo => {
      const ranked = repo;
      const analysis = ranked.analysis;
      return { ...ranked, summary: store.summary(summaryKey(ranked, settings)), readme: '', ...(analysis?.report ? { analysis: { ...analysis, report: { ...analysis.report, sources: analysis.report.sources.map(source => ({ ...source, text: '' })) } } } : {}) };
    });
    const followed = new Set(rankedRepos.filter(repo => repo.followed).map(repo => repo.id));
    const releases = store.releases().filter(release => followed.has(release.repoId)).map(release => ({ ...release, summary: store.summary(summaryKey(release, settings)) }));
    return {
      repos, releases, settings, status: { ...store.status(), incomplete: store.status().incomplete || store.get('discoveryCoverageIncomplete', false) },
      featuredIds, focusSections,
      initialIds: [], highStarIds: pools.highStars, potentialIds: pools.potential,
      poolCounts: {
        highStars: { candidates: poolCandidates(rankedRepos, 'highStars').length, analyzed: poolCandidates(rankedRepos, 'highStars').filter(repo => repo.analysis?.status === 'done').length },
        potential: { candidates: poolCandidates(rankedRepos, 'potential').length, analyzed: poolCandidates(rankedRepos, 'potential').filter(repo => repo.analysis?.status === 'done').length },
      },
      analysisJob: analyses.status(),
      content: { featured: articles.map(contentListItem), job: content.status(), count: content.db.count() },
      hasGithubToken: Boolean(store.secret('githubToken')), hasModelKey: Boolean(store.secret('modelKey')),
      modelUsage: store.get(`modelUsage:${dayKey()}`, 0), today: dayKey(),
      githubRate: ['core', 'search'].map(resource => store.get<GithubRate | null>(`githubRate:${resource}`, null)).filter((value): value is GithubRate => value !== null),
    };
  };
  let dashboardCache: { revision: string; expiresAt: number; body: string; etag: string } | undefined;
  app.get('/api/dashboard', async (request, reply) => {
    const now = Date.now();
    const revision = `${store.revision()}:${dayKey()}`;
    if (!dashboardCache || dashboardCache.revision !== revision || dashboardCache.expiresAt <= now) {
      const body = JSON.stringify(dashboard());
      dashboardCache = { revision: `${store.revision()}:${dayKey()}`, expiresAt: now + 15000, body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
    }
    reply.header('ETag', dashboardCache.etag);
    if (request.headers['if-none-match'] === dashboardCache.etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(dashboardCache.body);
  });
  app.get('/api/health', async () => ({ ok: true }));
  let radarCache: { revision: string; expires: number; repos: ReturnType<typeof store.repos>; items: ReturnType<typeof content.items>; samples: Map<number, StarSample[]> } | undefined;
  app.get<{ Querystring: { module?: string; query?: string; page?: string } }>('/api/activity', async (request, reply) => {
    const query = request.query;
    const page = Number(query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || (query.query?.length || 0) > 200 || query.module && !moduleIds.includes(query.module as ModuleId)) throw new AppError('动态筛选或分页条件不正确');
    const now = Date.now(); const revision = `${store.revision()}:${dayKey()}`;
    if (!radarCache || radarCache.revision !== revision || radarCache.expires < now) radarCache = { revision, expires: now + 15000, repos: store.repos().map(repo => analyses.decorate(repo)), items: content.items(), samples: new Map() };
    const body = JSON.stringify(activityFeed(radarCache.repos, radarCache.items, store.settings(), { page, query: query.query, module: query.module as ModuleId | undefined, now: radarCache.expires - 15000 }));
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });
  app.get<{ Querystring: { view?: string; sort?: string; library?: string; query?: string; module?: string; page?: string } }>('/api/radar', async (request, reply) => {
    const query = request.query;
    if (query.view && !['home', 'hotlist', 'library', 'candidates'].includes(query.view) || query.sort && !['growth', 'stars', 'new'].includes(query.sort) || query.module && !moduleIds.includes(query.module as ModuleId) || query.library && !['saved', 'followed', 'read', 'ignored'].includes(query.library)) throw new AppError('模块筛选条件不正确');
    const page = Number(query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || (query.query?.length || 0) > 200) throw new AppError('分页或搜索条件不正确');
    const now = Date.now(); const revision = `${store.revision()}:${dayKey()}`;
    if (!radarCache || radarCache.revision !== revision || radarCache.expires < now) radarCache = { revision, expires: now + 15000, repos: store.repos().map(repo => analyses.decorate(repo)), items: content.items(), samples: new Map() };
    const board = radarBoard(radarCache.repos, radarCache.items, store.settings(), (query.view || 'home') as 'home' | 'hotlist' | 'library', query);
    if (query.module) { board.groups = board.groups.filter(group => group.id === query.module); board.unclassified = []; }
    if (query.view === 'library' || query.view === 'candidates') board.groups = board.groups.map(group => ({ ...group, entries: group.entries.slice((page - 1) * 24, page * 24) }));
    if (board.unclassified) { board.unclassifiedTotal = board.unclassified.length; board.unclassified = board.unclassified.slice((page - 1) * 24, page * 24); }
    if (query.view === 'hotlist') for (const group of board.groups) for (const entry of group.entries) {
      const repo = entry.type === 'repo' ? entry.repo : entry.sourceRepo;
      if (!repo) continue;
      if (!radarCache.samples.has(repo.id)) radarCache.samples.set(repo.id, store.starSamples(repo.id, radarCache.expires - 15000));
      entry.samples = radarCache.samples.get(repo.id)!;
    }
    board.generatedAt = new Date(radarCache.expires - 15000).toISOString();
    const body = JSON.stringify(board); const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });
  app.get('/api/content/hotlist', async (request, reply) => {
    const body = JSON.stringify(contentHotlist.get());
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });
  app.get<{ Querystring: { topic?: string } }>('/api/hotlist', async (request, reply) => {
    const body = JSON.stringify(hotlist.get(request.query.topic));
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });
  app.get('/api/history', async () => {
    const days = new Map(history.days().map(item => [item.day, item]));
    for (const edition of content.db.days()) {
      const previous = days.get(edition.day);
      days.set(edition.day, { ...edition, count: edition.count + (previous?.count || 0), updatedAt: [edition.updatedAt, previous?.updatedAt || ''].sort().at(-1)!, leadTitle: previous?.leadTitle || edition.leadTitle, leadSummary: previous?.leadSummary || edition.leadSummary });
    }
    return { days: [...days.values()].sort((left, right) => right.day.localeCompare(left.day)), today: dayKey() };
  });
  app.get<{ Params: { day: string } }>('/api/history/:day', async request => {
    const day = validateHistoryDay(request.params.day);
    return { day, entries: history.entries(day), content: content.db.history(day).map(entry => ({ ...entry, item: contentListItem(entry.item) })) };
  });
  app.get<{ Params: { day: string; id: string } }>('/api/history/:day/content/:id', async request => {
    const entry = content.db.snapshot(validateHistoryDay(request.params.day), request.params.id);
    if (!entry) throw new AppError('该日期没有此内容的精选记录', 404);
    return entry;
  });
  app.get<{ Querystring: { kind?: string; view?: string; page?: string } }>('/api/content', async request => {
    const { kind, view = 'candidates' } = request.query;
    const page = Number(request.query.page || 1);
    if (kind && !['paper', 'practice'].includes(kind) || !['candidates', 'library', 'all'].includes(view) || !Number.isSafeInteger(page) || page < 1) throw new AppError('内容筛选参数不正确');
    const items = (view === 'candidates' ? content.candidates() : content.items()).filter(item => (!kind || item.kind === kind) && (view !== 'library' || item.favorite));
    return { items: items.slice((page - 1) * 24, page * 24).map(contentListItem), total: items.length, page, job: content.status() };
  });
  app.get<{ Params: { id: string } }>('/api/content/:id', async request => {
    const item = content.db.item(request.params.id);
    if (!item) throw new AppError('内容不存在', 404);
    return { item: decorateContent(item, store.settings()) };
  });
  app.patch<{ Params: { id: string } }>('/api/content/:id', async request => {
    if (!content.db.item(request.params.id)) throw new AppError('内容不存在', 404);
    const body = record(request.body);
    const patch: { favorite?: boolean; read?: boolean; ignored?: boolean } = {};
    for (const key of ['favorite', 'read', 'ignored'] as const) if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw new AppError('内容状态不正确');
      patch[key] = body[key];
    }
    content.db.patch(request.params.id, patch);
    return { ok: true };
  });
  app.post('/api/content/sync', async () => content.start('sync'));
  app.post('/api/content/analyses', async request => {
    const body = record(request.body);
    if (body.id !== undefined && typeof body.id !== 'string') throw new AppError('内容 ID 不正确');
    return content.start('analyze', { id: body.id as string | undefined });
  });
  app.post('/api/content/import', async request => {
    const body = record(request.body);
    if (typeof body.url !== 'string' || !['paper', 'practice'].includes(String(body.kind))) throw new AppError('请选择内容类型并填写原文链接');
    if (body.module !== undefined && !['paimon', 'papers', 'workflows'].includes(String(body.module))) throw new AppError('文章模块不正确');
    if (body.module && (body.module === 'papers') !== (body.kind === 'paper')) throw new AppError('模块与资料类型不一致');
    return content.start('import', { url: body.url, kind: body.kind as ContentKind, module: body.module as ModuleId | undefined });
  });
  app.get<{ Params: { day: string; id: string } }>('/api/history/:day/repos/:id', async request => {
    const day = validateHistoryDay(request.params.day);
    const entry = history.entry(day, Number(request.params.id));
    if (!entry) throw new AppError('该日期没有此项目的精选记录', 404);
    return entry;
  });
  app.get('/api/cc-switch/models', async () => readCCSwitch(options.ccSwitchDirectory));
  app.put('/api/settings', async request => {
    const body = record(request.body);
    const settings = validateSettings(body.settings);
    if (settings.model.enabled) assertCCSwitchModel(settings, options.ccSwitchDirectory);
    const updates: Record<string, string> = {};
    if (new URL(settings.model.endpoint).origin !== new URL(store.settings().model.endpoint).origin && body.modelKey === undefined) updates.modelKey = '';
    for (const name of ['githubToken', 'modelKey']) {
      if (body[name] !== undefined) {
        if (typeof body[name] !== 'string' || body[name].length > 2000 || /[\r\n]/.test(body[name])) throw new AppError('凭据格式不正确');
        updates[name] = body[name].trim();
      }
    }
    if (settings.model.ccSwitch) updates.modelKey = '';
    const changedToken = updates.githubToken !== undefined && updates.githubToken !== store.secret('githubToken');
    if (Object.keys(updates).length) store.saveSecrets(updates);
    if (changedToken) {
      store.set('githubCredentialVersion', store.get('githubCredentialVersion', 0) + 1);
      store.set('githubRate:core', null); store.set('githubRate:search', null);
      store.set('sync', { ...store.status(), retryAt: null, lastAttemptAt: null, lastDiscoveryAt: null });
    }
    if (JSON.stringify(settings.focus) !== JSON.stringify(store.settings().focus)) store.set('sync', { ...store.status(), lastDiscoveryAt: null, lastAttemptAt: null });
    store.set('settings', settings);
    return { ok: true };
  });
  app.post('/api/sync', async request => {
    const mode = record(request.body).mode;
    if (!['all', 'discovery', 'releases'].includes(String(mode))) throw new AppError('同步模式不正确');
    if (analyses.status().running) throw new AppError('项目分析进行中，请在完成后同步。', 409);
    if (content.status().running) throw new AppError('论文与实践任务进行中，请在完成后同步。', 409);
    return { started: sync.start(mode as 'all' | 'discovery' | 'releases') };
  });
  app.post('/api/analyses', async request => {
    const body = record(request.body);
    if (body.repoId !== undefined && (!Number.isSafeInteger(body.repoId) || Number(body.repoId) < 1)) throw new AppError('项目 ID 不正确');
    return { started: analyses.start(body.repoId as number | undefined) };
  });
  app.post('/api/follows', async request => {
    const name = parseRepo(record(request.body).repository);
    return { repo: await sync.add(name) };
  });
  app.patch<{ Params: { id: string } }>('/api/repos/:id', async request => {
    const id = Number(request.params.id);
    const repo = store.repo(id);
    if (!repo) throw new AppError('项目不存在', 404);
    const body = record(request.body);
    const patch: Record<string, unknown> = {};
    for (const key of ['favorite', 'followed', 'ignored', 'read']) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') throw new AppError('项目状态格式不正确');
        patch[key] = body[key];
      }
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || body.notes.length > 10000) throw new AppError('备注不能超过 10000 字');
      patch.notes = body.notes;
    }
    if (body.followed === true && !repo.followed) patch.releaseBaselineAt = new Date().toISOString();
    store.patchRepo(id, patch);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/repos/:id', async request => {
    const repo = store.repo(Number(request.params.id));
    if (!repo) throw new AppError('项目不存在', 404);
    const ranked = analyses.decorate(repo);
    return { repo: { ...ranked, summary: store.summary(summaryKey(ranked, store.settings())) } };
  });
  app.post<{ Params: { id: string } }>('/api/repos/:id/readme', async request => {
    await sync.hydrate(Number(request.params.id));
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>('/api/releases/:id', async request => {
    const id = Number(request.params.id);
    if (!store.releases().some(release => release.id === id)) throw new AppError('版本记录不存在', 404);
    const body = record(request.body);
    const patch: { read?: boolean; hidden?: boolean } = {};
    for (const key of ['read', 'hidden'] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') throw new AppError('版本状态格式不正确');
        patch[key] = body[key];
      }
    }
    store.patchRelease(id, patch);
    return { ok: true };
  });
  app.post('/api/summaries', async request => {
    if (content.status().running || analyses.status().running) throw new AppError('内容分析进行中，请稍候', 409);
    const body = record(request.body);
    const data = dashboard();
    if (body.repoId !== undefined) {
      const repo = store.repo(Number(body.repoId));
      if (!repo) throw new AppError('项目不存在', 404);
      return summaries.generate([repo]);
    }
    const selected = new Set([...data.featuredIds, ...data.initialIds]);
    const followed = new Set(data.repos.filter(repo => repo.followed).map(repo => repo.id));
    const items = [
      ...store.releases().filter(release => followed.has(release.repoId) && !release.baseline && !release.read && !release.hidden).slice(0, 10),
      ...store.repos().filter(repo => selected.has(repo.id)),
    ];
    return summaries.generate(items);
  });
  const staticPath = resolve('dist');
  if (options.serveStatic !== false && existsSync(staticPath)) {
    app.register(fastifyStatic, { root: staticPath });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
  }
  analyses.onUpdated = () => { captureFeatured(); };
  content.onUpdated = () => { captureFeatured(); };
  return { app, sync, summaries, analyses, content, dashboard, captureFeatured };
}
