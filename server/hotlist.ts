import type { Hotlist, Repo, Settings, StarSample } from '../shared/types.js';
import { channelIds } from '../shared/types.js';
import { growthRate } from '../shared/signals.js';
import { activeFocus, candidateFocusIds } from '../shared/focus.js';
import { focusReviewAccepted } from './focus.js';
import { AppError } from './config.js';
import type { Store } from './store.js';

export function selectHotlist(repos: Repo[], settings: Settings, samples: (id: number) => StarSample[], topic = 'all', now = Date.now()): Hotlist {
  const focused = settings.focus?.enabled === true;
  const reviewRequired = focused || settings.model.enabled;
  const relevant = repos.filter(repo => {
    if (repo.ignored || repo.archived || repo.fork || !repo.pool || repo.score < 40) return false;
    if (focused && !candidateFocusIds(repo, settings).length) return false;
    const report = repo.analysis?.report;
    if (reviewRequired && (repo.analysis?.status !== 'done' || report?.verdict !== 'recommend' || report.confidence === 'low')) return false;
    if (focused && !focusReviewAccepted(report, settings)) return false;
    if (!focused && (!settings.channels[repo.channel].weight || repo.analysis?.status === 'done' && report?.verdict === 'skip')) return false;
    return topic === 'all' || (focused ? report?.focusReview?.topicId === topic : repo.channel === topic);
  });
  const measured = relevant.flatMap(repo => {
    const rate = growthRate(repo, now);
    return rate !== null && Number.isFinite(rate) && Number.isSafeInteger(repo.growth?.starsDelta) ? [{ repo, rate }] : [];
  });
  const growing = measured.filter(item => item.rate > 0).sort((left, right) => right.rate - left.rate || right.repo.score - left.repo.score || right.repo.stars - left.repo.stars || left.repo.id - right.repo.id);
  const entries = growing.slice(0, 10).map(({ repo, rate }, index) => {
    const report = repo.analysis?.status === 'done' ? repo.analysis.report : null;
    const focus = focused ? activeFocus(settings).find(item => item.id === report?.focusReview?.topicId) : undefined;
    return {
      rank: index + 1,
      repo: { id: repo.id, fullName: repo.fullName, url: repo.url, description: repo.description, stars: repo.stars, language: repo.language, favorite: repo.favorite, read: repo.read, channel: repo.channel, pool: repo.pool },
      topic: focus ? { id: focus.id, name: focus.name } : null,
      overview: report?.overview || repo.description,
      highlight: (report?.focusReview?.benefit[0] || report?.capabilities[0] || report?.why[0])?.text || '',
      analyzedAt: report?.analyzedAt || null,
      reviewed: report?.verdict === 'recommend' && report.confidence !== 'low',
      growth: repo.growth!, starsPerDay: rate, samples: samples(repo.id),
    };
  });
  return {
    generatedAt: new Date(now).toISOString(), latestSampleAt: entries.map(entry => entry.growth.to).sort().at(-1) || null,
    reviewRequired, relevantCount: relevant.length, measuredCount: measured.length, growingCount: growing.length, entries,
  };
}

export class HotlistService {
  private cache?: { revision: string; expiresAt: number; repos: Repo[]; now: number; results: Map<string, Hotlist> };
  constructor(private store: Store, private decorate: (repo: Repo, settings: Settings) => Repo) {}

  get(topic: unknown = 'all') {
    const settings = this.store.settings();
    const allowed = settings.focus?.enabled ? activeFocus(settings).map(item => item.id) : [...channelIds];
    if (typeof topic !== 'string' || topic !== 'all' && !allowed.includes(topic)) throw new AppError('请选择有效的专题或频道');
    const revision = this.store.revision();
    const now = Date.now();
    if (!this.cache || this.cache.revision !== revision || this.cache.expiresAt <= now) {
      this.cache = { revision, expiresAt: now + 15000, repos: this.store.repos().map(repo => this.decorate(repo, settings)), now, results: new Map() };
    }
    if (!this.cache.results.has(topic)) this.cache.results.set(topic, selectHotlist(this.cache.repos, settings, id => this.store.starSamples(id, this.cache!.now), topic, this.cache.now));
    return this.cache.results.get(topic)!;
  }
}
