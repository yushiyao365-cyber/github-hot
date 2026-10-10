import { createHash } from 'node:crypto';
import { AppError } from './config.js';
import { Github, GithubError, mapRelease, mapRepo, type GithubRelease, type GithubRepo } from './github.js';
import { rank } from './ranking.js';
import { Store } from './store.js';
import { channelIds, channelNames, type Repo, type SyncStatus } from '../shared/types.js';
import { poolFor, selectPools, preciseCandidate } from './recommendations.js';
import { activeFocus, focusSignature } from '../shared/focus.js';
import { focusDiscoveryTasks, type DiscoveryTask } from './focus-discovery.js';
import { selectFocus, withFocusHints } from './focus.js';
import { collectSkills, isSkillRepo, readSkill } from './skill-evidence.js';
import type { ContentItem } from '../shared/content.js';

export interface PreparedEvidence { cached: boolean; note?: string }

export class SyncService {
  private active: Promise<void> | null = null;
  private adding = false;
  externalBusy: () => boolean = () => false;
  onDiscovery: () => void = () => {};
  constructor(private store: Store, private fetcher: typeof fetch = fetch, private pause = (delay: number) => new Promise<void>(resolve => setTimeout(resolve, delay))) {}
  private client() {
    return new Github(this.store.secret('githubToken'), () => {
      const status = this.store.status();
      this.store.set('sync', { ...status, requestCount: status.requestCount + 1 });
    }, this.fetcher, this.store);
  }
  private status(patch: Partial<SyncStatus>) { this.store.set('sync', { ...this.store.status(), ...patch }); }
  private available() {
    const retryAt = this.store.status().retryAt;
    if (retryAt && Date.parse(retryAt) > Date.now()) throw new AppError(`额度尚未恢复，请在 ${new Date(retryAt).toLocaleTimeString()} 后重试`, 429);
  }
  start(mode: 'all' | 'releases' | 'discovery' = 'all'): boolean {
    if (this.active || this.adding || this.externalBusy()) return false;
    this.available();
    this.active = this.run(mode).finally(() => { this.active = null; });
    return true;
  }
  async idle() { await this.active; }
  async collectSkillBatch() {
    this.available();
    const candidates = this.store.repos().filter(repo => isSkillRepo(repo) && !repo.ignored && !repo.archived && !repo.fork)
      .sort((left, right) => this.store.get(`skillScan:${left.id}`, 0) - this.store.get(`skillScan:${right.id}`, 0) || right.stars - left.stars)
      .filter(repo => Date.now() - this.store.get(`skillScan:${repo.id}`, 0) >= 6 * 3600000).slice(0, 8);
    const errors: string[] = [];
    for (const repo of candidates) {
      this.store.set(`skillScan:${repo.id}`, Date.now());
      try {
        const client = this.client();
        if (Date.now() - Date.parse(repo.fetchedAt) >= 86400000) {
          const latest = await client.get<GithubRepo>(`/repos/${repo.fullName}`, 86400000);
          if (latest.private || latest.id !== repo.id) throw new AppError('来源仓库已非公开或标识变化，停止采集');
          this.store.upsertRepo(mapRepo(latest), repo.baseline);
        }
        await collectSkills(this.store.repo(repo.id)!, client, this.store);
      }
      catch (error) {
        if (error instanceof GithubError && error.retryAt) this.status({ retryAt: error.retryAt });
        if (error instanceof GithubError && [401, 403, 429].includes(error.statusCode)) throw error;
        errors.push(`${repo.fullName}：Skill 索引未完成，稍后重试`);
      }
    }
    return errors;
  }
  async hydrateSkill(item: ContentItem) {
    this.available();
    const repo = item.skill && this.store.repo(item.skill.repoId);
    if (!repo || repo.archived || repo.ignored) throw new AppError('来源仓库不可用或已忽略');
    try { return await readSkill(item, this.client()); }
    catch (error) {
      if (error instanceof GithubError && error.retryAt) this.status({ retryAt: error.retryAt });
      throw error;
    }
  }
  async add(name: string): Promise<Repo> {
    if (this.active || this.adding || this.externalBusy()) throw new AppError('同步或分析进行中，请稍后添加关注', 409);
    this.available();
    this.adding = true;
    let id: number;
    try {
      const data = await this.client().get<GithubRepo>(`/repos/${name}`);
      if (data.private) throw new AppError('仅支持公开仓库，不采集私有仓库资料');
      id = data.id;
      this.store.upsertRepo(mapRepo(data), true);
      const repo = this.store.repo(id)!;
      if (!repo.followed) this.store.patchRepo(id, { followed: true, releaseBaselineAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof GithubError && error.retryAt) this.status({ retryAt: error.retryAt });
      throw error;
    } finally { this.adding = false; }
    this.start('releases');
    return this.store.repo(id)!;
  }
  async hydrate(id: number, refresh = false): Promise<void> {
    const repo = this.store.repo(id);
    if (!repo || (repo.readme && !refresh)) return;
    this.available();
    const readme = await this.client().get<{ content?: string; encoding?: string }>(`/repos/${repo.fullName}/readme`);
    if (readme.encoding === 'base64' && readme.content) {
      this.store.patchRepo(id, { readme: Buffer.from(readme.content, 'base64').toString('utf8').slice(0, 40000) });
      this.store.set(`readmeFetched:${id}`, new Date().toISOString());
    }
  }
  hasEvidence(id: number): boolean {
    return (this.store.repo(id)?.readme.trim().length || 0) >= 100 || this.store.repoReleases(id, -1).some(release => release.body.trim().length >= 100) || this.store.get<{ sources: { text: string }[] }>(`skills:${id}`, { sources: [] }).sources.some(source => source.text.length >= 100);
  }
  async prepareEvidence(id: number): Promise<PreparedEvidence> {
    let repo = this.store.repo(id);
    if (!repo) throw new AppError('项目不存在', 404);
    const client = this.client();
    try {
      this.available();
      if (Date.now() - Date.parse(repo.fetchedAt) >= 24 * 3600000) {
        const value = await client.get<GithubRepo>(`/repos/${repo.fullName}`);
        if (value.private) throw new AppError('仓库已非公开，停止读取和分析资料', 403);
        if (value.id !== id) throw new AppError('仓库标识发生变化，未合并不相关资料');
        this.store.upsertRepo(mapRepo(value), repo.baseline);
        repo = this.store.repo(id)!;
      }
      const readmeTime = this.store.get<string | null>(`readmeFetched:${id}`, null);
      if (!readmeTime || Date.now() - Date.parse(readmeTime) > 7 * 86400000 || Date.parse(repo.pushedAt) > Date.parse(readmeTime)) {
        try { await this.hydrate(id, true); }
        catch (error) {
          if (!(error instanceof GithubError) || error.statusCode !== 404) throw error;
          this.store.patchRepo(id, { readme: '' });
          this.store.set(`readmeFetched:${id}`, new Date().toISOString());
        }
      }
      const releasesTime = this.store.get<string | null>(`evidenceReleases:${id}`, null);
      await collectSkills(this.store.repo(id)!, client, this.store);
      if (!releasesTime || Date.now() - Date.parse(releasesTime) > 24 * 3600000) {
        const releases = await client.get<GithubRelease[]>(`/repos/${repo.fullName}/releases?per_page=5`);
        for (const release of releases) {
          if (!release.draft && release.published_at) this.store.upsertRelease(mapRelease(release, id), !repo.followed || Date.parse(release.published_at) <= Date.parse(repo.releaseBaselineAt || new Date().toISOString()));
        }
        this.store.set(`evidenceReleases:${id}`, new Date().toISOString());
      }
      if (!this.hasEvidence(id)) throw new AppError('公开 README / 发布资料不足，暂不生成精选亮点', 422);
      return { cached: false };
    } catch (error) {
      if (error instanceof GithubError && error.retryAt) this.status({ retryAt: error.retryAt });
      const canFallback = error instanceof GithubError && [403, 429, 502, 503].includes(error.statusCode) || error instanceof AppError && error.statusCode === 429;
      if (canFallback && this.hasEvidence(id)) return { cached: true, note: 'GitHub 暂时不可刷新，本报告基于本地已缓存的公开资料；请结合各来源的采集时间阅读，最新版本和 Star 可能尚未更新。' };
      if (canFallback) throw new AppError('等待 GitHub 额度或网络恢复：本项目缺少可用缓存，先处理其他有资料的项目', 429);
      throw error;
    }
  }
  private async run(mode: 'all' | 'releases' | 'discovery') {
    this.status({ running: true, phase: '正在连接 GitHub', errors: [], incomplete: !this.store.secret('githubToken'), lastAttemptAt: new Date().toISOString(), requestCount: 0, retryAt: null });
    const client = this.client();
    try {
      if (mode !== 'discovery') await this.releases(client);
      if (mode !== 'releases') await this.discover(client);
      const status = this.store.status();
      if (!status.errors.length) this.status({ lastSuccessAt: new Date().toISOString() });
    } catch (error) {
      this.status({ errors: [...this.store.status().errors, error instanceof Error ? error.message : '同步失败'], incomplete: true, retryAt: error instanceof GithubError ? error.retryAt : null });
    } finally {
      this.status({ running: false, phase: this.store.status().errors.length ? '部分同步未完成，缓存可继续使用' : '同步完成' });
      if (mode !== 'releases') this.onDiscovery();
    }
  }
  private async releases(client: Github) {
    for (const repo of this.store.repos().filter(item => item.followed)) {
      try {
      this.status({ phase: `检查 ${repo.fullName} 的版本` });
      const key = `releaseCursor:${repo.id}`;
      const checkpoint = this.store.get(key, { page: 1, scanStartedAt: new Date().toISOString() });
      let page = checkpoint.page;
      const previousScan = this.store.get<string | null>(`releaseChecked:${repo.id}`, null);
      let complete = false;
      for (let request = 0; request < 3; request++, page++) {
        if (!this.store.repo(repo.id)?.followed) break;
        const values = await client.get<GithubRelease[]>(`/repos/${repo.fullName}/releases?per_page=30&page=${page}`);
        for (const value of values) {
          if (!value.draft && value.published_at) this.store.upsertRelease(mapRelease(value, repo.id), Date.parse(value.published_at) <= Date.parse(repo.releaseBaselineAt || checkpoint.scanStartedAt));
        }
        const oldest = values.filter(item => item.published_at).reduce((minimum, item) => Math.min(minimum, Date.parse(item.published_at!)), Infinity);
        if (values.length < 30 || (previousScan && oldest < Date.parse(previousScan) - 7 * 86400000)) { complete = true; break; }
        this.store.set(key, { ...checkpoint, page: page + 1 });
      }
      if (complete) {
        this.store.set(`releaseChecked:${repo.id}`, checkpoint.scanStartedAt);
        this.store.set(key, { page: 1, scanStartedAt: new Date().toISOString() });
      } else this.status({ incomplete: true });
      } catch (error) {
        if (!(error instanceof GithubError) || [401, 403, 429].includes(error.statusCode)) throw error;
        this.status({ incomplete: true, errors: [...this.store.status().errors, `${repo.fullName}：${error.message}`] });
      }
    }
    this.status({ lastReleasesAt: new Date().toISOString() });
  }
  private async discover(client: Github) {
    const settings = this.store.settings();
    if (settings.radar) {
      for (const name of ['apache/paimon', 'anthropics/skills', 'vercel-labs/agent-skills']) {
        if (!settings.radar.modules[name === 'apache/paimon' ? 'paimon' : 'skills'].enabled) continue;
        const key = `radarSeed:${name}`;
        if (Date.now() - this.store.get(key, 0) < 24 * 3600000) continue;
        try {
          const repo = await client.get<GithubRepo>(`/repos/${name}`, 6 * 3600000);
          if (!repo.private) this.store.upsertRepo(mapRepo(repo), true);
          this.store.set(key, Date.now());
        } catch (error) {
          if (!(error instanceof GithubError) || [401, 403, 429].includes(error.statusCode)) throw error;
          this.status({ incomplete: true, errors: [...this.store.status().errors, `${name}：${error.message}`] });
        }
      }
    }
    const date = new Date().toISOString().slice(0, 10);
    const recent = new Date(Date.now() - settings.recommendations.potentialMaxAgeDays * 86400000).toISOString().slice(0, 10);
    const newlyCreated = new Date(Date.now() - (settings.recommendations.newProjectDays ?? 30) * 86400000).toISOString().slice(0, 10);
    const active = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const digest = createHash('sha256').update(JSON.stringify(['precision-v4', settings.channels, settings.recommendations, settings.focus])).digest('hex').slice(0, 12);
    const tasks: DiscoveryTask[] = settings.focus?.enabled ? focusDiscoveryTasks(settings) : channelIds.flatMap((channel, channelIndex) => {
      const config = settings.channels[channel];
      if (!config.weight) return [];
      const signals = [...config.topics.map(topic => `topic:${topic}`), ...config.keywords.map(word => `"${word.replace(/["\\]/g, '')}"`)];
      if (!signals.length) return [];
      const day = Math.floor(Date.now() / 86400000);
      return [
        { channel, query: `${signals[day % signals.length]} stars:>=${settings.recommendations.highStarMin} pushed:>=${active} archived:false fork:false is:public`, sort: 'stars', order: channelIndex + ((channelIndex + day) % 2 ? 4 : 0), label: '高星项目' },
        { channel, query: `${signals[day % signals.length]} created:>=${newlyCreated} archived:false fork:false is:public`, sort: 'stars', order: channelIndex + ((channelIndex + day) % 2 ? 0 : 4), label: '新建项目 · 初步关注' },
        { channel, query: `${signals[(day + 1) % signals.length]} stars:<${settings.recommendations.highStarMin} created:>=${recent} archived:false fork:false is:public`, sort: 'stars', order: 8 + channelIndex, label: '潜力候选 · 初步关注' },
      ];
    }).map(task => ({ ...task, label: `${channelNames[task.channel]} / ${task.label}` })).sort((left, right) => left.order - right.order);
    const key = `discovery:${date}:${Math.floor(Date.now() / (6 * 3600000))}:${digest}`;
    const done = this.store.get<number[]>(key, []);
    const authenticated = Boolean(this.store.secret('githubToken'));
    const budget = authenticated ? tasks.length : 4;
    let requests = 0;
    const baseline = !this.store.get('discoveryInitialized', false);
    for (let index = 0; index < tasks.length && requests < budget; index++) {
      if (done.includes(index)) continue;
      const task = tasks[index];
      this.status({ phase: `${task.label} · ${done.length + 1}/${tasks.length}` });
      const result = await client.get<{ items: GithubRepo[]; total_count: number; incomplete_results: boolean }>(`/search/repositories?q=${encodeURIComponent(task.query)}&sort=${task.sort}&order=desc&per_page=30`);
      for (const item of result.items) if (!item.private) {
        this.store.upsertRepo(mapRepo(item), baseline);
        const topic = activeFocus(settings).find(topic => topic.id === task.topicId);
        if (topic) this.store.set(`focusDiscovery:${item.id}`, { ...this.store.get(`focusDiscovery:${item.id}`, {}), [topic.id]: focusSignature(topic) });
      }
      if (result.incomplete_results || result.total_count > result.items.length) {
        this.status({ incomplete: true });
        this.store.set('discoveryCoverageIncomplete', true);
      }
      done.push(index);
      this.store.set(key, done);
      requests++;
      if (index < tasks.length - 1 && requests < budget) await this.pause(authenticated ? 2500 : 7000);
    }
    if (done.length < tasks.length) this.status({ incomplete: true });
    if (done.length >= tasks.length) {
      this.store.set('discoveryInitialized', true);
      this.status({ lastDiscoveryAt: new Date().toISOString() });
    }
    const ranked = this.store.repos().map(repo => {
      const result = rank({ ...withFocusHints(repo, settings, this.store), growth: this.store.growth(repo.id) }, settings);
      result.pool = poolFor(result, settings);
      return result;
    });
    const watchLimit = Math.min(60, settings.dailyLimit * 3);
    const pools = selectPools(ranked.filter(repo => preciseCandidate(repo, settings)), { ...settings, dailyLimit: watchLimit });
    const watched = new Set(settings.focus?.enabled ? selectFocus(ranked, { ...settings, dailyLimit: watchLimit }, false).flatMap(section => section.repoIds) : [...pools.highStars, ...pools.potential]);
    const observed = ranked.filter(repo => !repo.ignored && (repo.followed || watched.has(repo.id)) && Date.now() - Date.parse(repo.fetchedAt) >= 24 * 3600000)
      .sort((left, right) => left.fetchedAt.localeCompare(right.fetchedAt)).slice(0, authenticated ? watchLimit : 3);
    for (const repo of observed) {
      const value = await client.get<GithubRepo>(`/repos/${repo.fullName}`);
      if (value.id === repo.id && !value.private) this.store.upsertRepo(mapRepo(value), repo.baseline);
      await this.pause(authenticated ? 200 : 1000);
    }
  }
}
