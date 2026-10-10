import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { defaultContent, emptyContentJob, type ContentItem, type ContentJob, type ContentKind } from '../shared/content.js';
import type { Settings } from '../shared/types.js';
import type { Store } from './store.js';
import { ContentStore } from './content-store.js';
import { PublicReader, publicUrl } from './public-reader.js';
import { arxivId, canonicalContentUrl, contentRecord, parseArticle, parseFeed } from './content-reader.js';
import { contentModule, defaultReview, moduleIds, radarFocus, type ModuleId } from '../shared/radar.js';
import { contentAnalysisKey, contentPromptFor, decorateContent, parseContentReport } from './content-analysis.js';
import { callModel, ModelError } from './model.js';
import { AppError } from './config.js';
import { matchesKeyword } from './ranking.js';
import { GithubError } from './github.js';
import { growthRate } from '../shared/signals.js';

function practicePriority(item: ContentItem) {
  const signals = /\b(?:built|building|using|workflow|tutorial|steps|prompt|automated|prototype|experiment|tested)\b|how (?:i|we)|我用|步骤|实践|案例|落地|提示词|搭建/gi;
  return Math.min(4, [...item.title.matchAll(signals)].length) * 3 + Math.min(4, [...item.text.matchAll(signals)].length);
}

export class ContentService {
  readonly db: ContentStore;
  readonly reader: PublicReader;
  private active: Promise<void> | null = null;
  externalBusy = () => false;
  onUpdated = () => {};
  collectSkills: () => Promise<string[]> = async () => [];
  hydrateSkill: (item: ContentItem) => Promise<ContentItem> = async () => { throw new AppError('Skill 读取器未初始化'); };
  constructor(private store: Store, private fetcher?: typeof fetch, private ccSwitchDirectory?: string) {
    this.db = new ContentStore(store); this.reader = new PublicReader(fetcher);
    if (this.status().running) store.set('contentJob', { ...this.status(), running: false, current: '', errors: ['上次内容任务被中断，已完成资料保留'] });
  }
  status(): ContentJob { return this.store.get('contentJob', emptyContentJob); }
  private update(patch: Partial<ContentJob>) { this.store.set('contentJob', { ...this.status(), ...patch }); }
  items() {
    const settings = this.store.settings();
    const items = this.db.items();
    if (!items.some(item => item.skill)) return items.map(item => decorateContent(item, settings));
    const repos = new Map(this.store.repos().map(repo => [repo.id, repo]));
    const rates = new Map<number, number | null>();
    return items.map(item => {
      if (item.skill) {
        const repo = repos.get(item.skill.repoId);
        if (repo && !rates.has(repo.id)) rates.set(repo.id, growthRate({ ...repo, growth: this.store.growth(repo.id) }));
        item = { ...item, skill: { ...item.skill, active: item.skill.active && Boolean(repo && !repo.archived && !repo.fork && !repo.ignored), stars: repo?.stars, starsPerDay: repo ? rates.get(repo.id) : null } };
      }
      return decorateContent(item, settings);
    });
  }
  collectPaimonReleases() {
    if (!this.store.settings().radar?.modules.paimon.enabled) return;
    const repo = this.store.repos().find(repo => repo.fullName.toLowerCase() === 'apache/paimon');
    if (!repo) return;
    for (const release of this.store.repoReleases(repo.id, -1).filter(release => !release.prerelease && release.body.length >= 160)) {
      const item = contentRecord('practice', release.url, `Apache Paimon ${release.tag} · 能力迭代`, `Apache Paimon ${release.tag}\n${release.body}`, 'Apache Paimon Releases', 'excerpt', { module: 'paimon', publishedAt: release.publishedAt });
      const old = this.db.item(item.id);
      if (!old || old.text !== item.text) this.db.upsert(item);
    }
  }
  eligible(item: ContentItem, settings = this.store.settings()) {
    const prefs = settings.content || defaultContent;
    if (settings.radar && !settings.radar.modules[contentModule(item)].enabled) return false;
    if (item.skill) return Boolean(settings.radar?.modules.skills.enabled && item.skill.active && !item.ignored);
    if (!prefs.enabled || !prefs[item.kind].enabled || item.ignored) return false;
    const published = item.updatedAt || item.publishedAt || item.firstSeenAt;
    const age = Date.now() - Date.parse(published);
    return age >= -86400000 && age <= prefs.windowDays * 86400000;
  }
  candidates() {
    const settings = this.store.settings(); const prefs = settings.content || defaultContent;
    return this.items().filter(item => this.eligible(item, settings) && (item.skill || item.module === 'paimon' || prefs[item.kind].terms.some(term => matchesKeyword(`${item.title} ${item.text}`.toLowerCase(), term.toLowerCase())) || item.kind === 'practice' && !item.text && practicePriority(item) > 0)).sort((left, right) => left.kind.localeCompare(right.kind) || (left.kind === 'practice' ? practicePriority(right) - practicePriority(left) : 0) || (right.publishedAt || right.firstSeenAt).localeCompare(left.publishedAt || left.firstSeenAt));
  }
  featured() { return this.items().filter(item => this.eligible(item) && !item.read && item.analysisStatus === 'done' && item.report?.verdict === 'recommend' && item.report.confidence !== 'low' && item.report.relevance === 'direct').sort((left, right) => (right.publishedAt || right.firstSeenAt).localeCompare(left.publishedAt || left.firstSeenAt)); }
  async idle() { await this.active; }
  start(mode: 'sync' | 'analyze' | 'import' | 'skills', input?: { id?: string; url?: string; kind?: ContentKind; module?: ModuleId; automatic?: boolean }) {
    if (this.active || this.externalBusy()) throw new AppError('正在采集或分析其他内容，请等待本轮完成', 409);
    const prefs = this.store.settings().content || defaultContent;
    if (!prefs.enabled && !(this.store.settings().radar?.modules.skills.enabled && (mode === 'skills' || mode === 'analyze'))) throw new AppError('请先启用论文与实践');
    if (mode === 'analyze' && !this.store.settings().model.enabled) throw new AppError('请先启用分析模型');
    if (mode === 'import') {
      if (!input?.url || !['paper', 'practice'].includes(input.kind || '')) throw new AppError('请选择内容类型并填写原文链接');
      if (!prefs[input.kind!].enabled) throw new AppError('该内容类型未启用');
      publicUrl(input.url);
    }
    if (input?.id) {
      const item = this.db.item(input.id);
      if (!item) throw new AppError('内容不存在', 404);
      if ((!item.skill && !prefs[item.kind].enabled) || item.ignored || this.store.settings().radar?.modules[contentModule(item)].enabled === false || item.skill && !item.skill.active) throw new AppError('请先启用该类型，并恢复已忽略或不可用的内容');
    }
    this.update({ ...emptyContentJob, running: true, mode, startedAt: new Date().toISOString() });
    this.active = this.run(mode, input).finally(() => { this.active = null; });
    return { started: true };
  }
  private async arxiv(url: string) {
    const last = this.store.get('contentArxivLast', 0);
    if (!this.fetcher && Date.now() - last < 3100) await wait(3100 - (Date.now() - last));
    this.store.set('contentArxivLast', Date.now()); return this.reader.read(url);
  }
  private async sync(settings: Settings) {
    const prefs = settings.content || defaultContent;
    this.store.set('contentLastSyncAttempt', Date.now());
    const jobs: { name: string; read: () => Promise<ContentItem[]> }[] = [];
    if (prefs.paper.enabled && (!settings.radar || settings.radar.modules.papers.enabled)) jobs.push({ name: 'arXiv 大模型论文', read: async () => {
      const terms = prefs.paper.terms.slice(0, 12).map(term => `(ti:"${term}" OR abs:"${term}")`).join(' OR ');
      const since = new Date(Date.now() - prefs.windowDays * 86400000).toISOString().slice(0, 10).replaceAll('-', '') + '0000';
      const query = `(${terms}) AND (cat:cs.AI OR cat:cs.CL OR cat:cs.LG OR cat:cs.CV OR cat:stat.ML) AND submittedDate:[${since} TO ${new Date().toISOString().slice(0, 10).replaceAll('-', '')}2359]`;
      const response = await this.arxiv(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=30&sortBy=submittedDate&sortOrder=descending`);
      return parseFeed(response.text, 'arXiv', response.url, 'paper');
    } });
    if (prefs.practice.enabled && (!settings.radar || settings.radar.modules.paimon.enabled || settings.radar.modules.workflows.enabled)) for (const feed of prefs.practice.feeds.filter(feed => feed.enabled)) jobs.push({ name: feed.name, read: async () => {
      const key = `contentFeed:${createHash('sha256').update(feed.url).digest('hex')}`;
      const cache = this.store.get(key, { etag: '', modified: '' });
      const response = await this.reader.read(feed.url, { ...(cache.etag ? { 'If-None-Match': cache.etag } : {}), ...(cache.modified ? { 'If-Modified-Since': cache.modified } : {}) });
      if (response.status === 304) return [];
      const items = parseFeed(response.text, feed.name, response.url, 'practice');
      this.store.set(key, { etag: response.etag, modified: response.modified }); return items;
    } });
    this.update({ total: jobs.length });
    for (const job of jobs) {
      if (JSON.stringify(this.store.settings().content) !== JSON.stringify(settings.content)) break;
      this.update({ current: job.name });
      try { for (const item of await job.read()) this.db.upsert(item); }
      catch (error) { this.update({ errors: [...this.status().errors, `${job.name}：${error instanceof AppError ? error.message : '来源读取失败，未生成内容；请稍后重试'}`] }); }
      this.update({ completed: this.status().completed + 1 });
    }
  }
  private async importItem(url: string, kind: ContentKind, module?: ModuleId): Promise<string> {
    if (kind === 'paper' && arxivId(url)) {
      const id = arxivId(url)!;
      const response = await this.arxiv(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`);
      const item = parseFeed(response.text, 'arXiv', response.url, 'paper').find(item => item.url === canonicalContentUrl(url));
      if (!item) throw new AppError('arXiv 未返回这篇论文');
      this.db.upsert(item); return item.id;
    }
    const response = await this.reader.read(url, {}, kind === 'paper');
    const article = response.pdf ? contentRecord('paper', response.url, response.text.split('\n').map(line => line.trim()).find(Boolean) || '技术报告', response.text, new URL(response.url).hostname, 'excerpt') : parseArticle(response.text, response.url, new URL(response.url).hostname);
    const item = kind === 'paper' ? contentRecord('paper', article.url, article.title, article.text, article.source, 'excerpt', { publication: response.pdf ? 'PDF 前 30 页文字摘录（最多 24000 字符）；未核实同行评审' : '公开技术报告 / 白皮书正文摘录；未核实同行评审', publishedAt: article.publishedAt, module: 'papers' }) : { ...article, module: module || contentModule(article) };
    this.db.upsert(item); return item.id;
  }
  private async analyze(settings: Settings, id?: string, automatic = false) {
    const prefs = settings.content || defaultContent;
    const pending = this.candidates().filter(item => item.analysisStatus !== 'done' && (!item.read || item.skill && item.analysisStatus === 'stale') && (!automatic || (item.skill ? settings.model.autoAnalyze : prefs.autoAnalyze)));
    const queues = moduleIds.map(module => {
      const items = pending.filter(item => contentModule(item) === module);
      if (module !== 'skills') return items;
      const repositories = new Map<number, ContentItem[]>();
      for (const item of items.sort((left, right) => Number(right.skill?.change !== 'baseline') - Number(left.skill?.change !== 'baseline') || left.firstSeenAt.localeCompare(right.firstSeenAt) || left.id.localeCompare(right.id))) {
        const key = item.skill!.repoId;
        repositories.set(key, [...(repositories.get(key) || []), item]);
      }
      const groups = [...repositories.values()];
      return Array.from({ length: Math.max(0, ...groups.map(group => group.length)) }, (_, index) => groups.map(group => group[index])).flat().filter((item): item is ContentItem => Boolean(item));
    });
    const alternating = Array.from({ length: Math.max(0, ...queues.map(queue => queue.length)) }, (_, index) => queues.map(queue => queue[index])).flat().filter((item): item is ContentItem => Boolean(item));
    const list = id ? [decorateContent(this.db.item(id)!, settings)] : alternating.filter(item => {
      const failed = this.store.get(`contentFailure:${item.id}`, { key: '', at: 0 });
      return failed.key !== contentAnalysisKey(item, settings) || Date.now() - failed.at > 6 * 3600000;
    }).slice(0, settings.radar ? (settings.radar.review || defaultReview).batchSize : prefs.batchSize);
    this.update({ total: list.length, completed: 0 }); this.store.set('contentLastAnalyzeAttempt', Date.now());
    for (let item of list) {
      if (JSON.stringify(settings) !== JSON.stringify(this.store.settings())) break;
      this.update({ current: item.title });
      try {
        if (item.analysisStatus === 'done') continue;
        if (item.skill && !item.text) { item = await this.hydrateSkill(item); this.db.save(item); }
        if (!item.skill && item.kind === 'practice' && item.source !== 'Apache Paimon Releases' && (item.coverage !== 'excerpt' || Date.now() - Date.parse(item.fetchedAt) > 7 * 86400000)) {
          const response = await this.reader.read(item.url);
          const article = parseArticle(response.text, item.url, item.source);
          item = { ...item, title: article.title, text: article.text, coverage: article.coverage, fetchedAt: article.fetchedAt, publishedAt: article.publishedAt || item.publishedAt, updatedAt: article.updatedAt || item.updatedAt };
          this.db.save(item);
        }
        if (item.text.length < 160) throw new AppError('原文资料太少，暂不分析');
        const module = contentModule(item);
        const goal = module === 'skills' ? settings.focus?.topics.find(topic => topic.id === 'skills')?.goal || radarFocus[1].goal : module === 'paimon' ? radarFocus[0].goal : prefs[item.kind].goal;
        const raw = await callModel(this.store, settings, contentPromptFor(item.kind, module), JSON.stringify({ kind: item.kind, module, title: item.title, url: item.url, coverage: item.coverage, publishedAt: item.publishedAt, goal, text: item.text }), 4000, this.fetcher, this.ccSwitchDirectory);
        const report = parseContentReport(raw, item, settings);
        this.db.save({ ...item, report, error: '', analysisStatus: 'done' });
        this.update({ generated: this.status().generated + 1 }); this.onUpdated();
      } catch (error) {
        const message = error instanceof AppError ? error.message : '分析或原文读取未完成，原资料保留';
        this.db.save({ ...item, error: message });
        this.store.set(`contentFailure:${item.id}`, { key: contentAnalysisKey(item, settings), at: Date.now() });
        this.update({ errors: [...this.status().errors, `${item.title}：${message}`] });
        if (error instanceof ModelError && error.stopBatch || error instanceof GithubError && [401, 403, 429].includes(error.statusCode)) break;
      } finally { this.update({ completed: this.status().completed + 1 }); }
    }
  }
  private async run(mode: 'sync' | 'analyze' | 'import' | 'skills', input?: { id?: string; url?: string; kind?: ContentKind; module?: ModuleId; automatic?: boolean }) {
    try {
      const settings = this.store.settings(); let id = input?.id;
      if (mode === 'skills') { this.store.set('skillLastScanAttempt', Date.now()); this.update({ current: '发现独立 Skill 文件', errors: await this.collectSkills() }); }
      if (mode === 'sync') await this.sync(settings);
      if (mode === 'import') id = await this.importItem(input!.url!, input!.kind!, input?.module);
      if (mode === 'analyze' || settings.model.enabled && (mode === 'skills' ? settings.model.autoAnalyze : settings.content?.autoAnalyze)) await this.analyze(settings, id, mode !== 'analyze' || Boolean(input?.automatic));
    } catch (error) { this.update({ errors: [...this.status().errors, error instanceof AppError ? error.message : '内容任务未完成，已保存的资料保留'] }); }
    finally { this.update({ running: false, current: '', finishedAt: new Date().toISOString() }); this.onUpdated(); }
  }
  tick() {
    this.collectPaimonReleases();
    const settings = this.store.settings(); const prefs = settings.content || defaultContent;
    if ((!prefs.enabled && !settings.radar?.modules.skills.enabled) || this.active || this.externalBusy()) return false;
    const interval = (settings.radar?.review || defaultReview).intervalMinutes * 60000;
    if (settings.radar?.modules.skills.enabled && prefs.autoSync && Date.now() - this.store.get('skillLastScanAttempt', 0) >= interval) { this.start('skills'); return true; }
    if (prefs.enabled && prefs.autoSync && Date.now() - this.store.get('contentLastSyncAttempt', 0) >= 6 * 3600000) { this.start('sync'); return true; }
    if (settings.model.enabled && Date.now() - this.store.get('contentLastAnalyzeAttempt', 0) >= interval && this.candidates().some(item => {
      const failure = this.store.get(`contentFailure:${item.id}`, { key: '', at: 0 });
      return item.analysisStatus !== 'done' && (!item.read || item.skill && item.analysisStatus === 'stale') && (item.skill ? settings.model.autoAnalyze : prefs.autoAnalyze) && (failure.key !== contentAnalysisKey(item, settings) || Date.now() - failure.at >= 6 * 3600000);
    })) { this.start('analyze', { automatic: true }); return true; }
    return false;
  }
}
