import type { ContentService } from './content-service.js';
import type { Store } from './store.js';
import { contentListItem } from './content-store.js';
import { defaultContent, type ContentHotlist } from '../shared/content.js';

export class ContentHotlistService {
  private cache?: { revision: string; expiresAt: number; result: ContentHotlist };
  constructor(private store: Store, private content: ContentService) {}

  get(): ContentHotlist {
    const revision = this.store.revision();
    const now = Date.now();
    if (this.cache?.revision === revision && this.cache.expiresAt > now) return this.cache.result;
    const settings = this.store.settings();
    const preferences = settings.content || defaultContent;
    const eligible = this.content.items().filter(item => this.content.eligible(item, settings));
    const groups = (kind: 'paper' | 'practice') => {
      const items = eligible.filter(item => item.kind === kind);
      const reviewed = items.filter(item => item.analysisStatus === 'done');
      const qualified = reviewed.filter(item => item.report?.verdict === 'recommend' && item.report.relevance === 'direct' && item.report.confidence !== 'low');
      qualified.sort((left, right) => Number(Boolean(right.publishedAt)) - Number(Boolean(left.publishedAt)) || (right.publishedAt || right.firstSeenAt).localeCompare(left.publishedAt || left.firstSeenAt) || left.id.localeCompare(right.id));
      return { enabled: preferences.enabled && preferences[kind].enabled, eligible: items.length, reviewed: reviewed.length, qualified: qualified.length, entries: qualified.slice(0, 10).map(contentListItem) };
    };
    const result: ContentHotlist = { generatedAt: new Date(now).toISOString(), enabled: preferences.enabled, windowDays: preferences.windowDays, limit: 10, groups: { paper: groups('paper'), practice: groups('practice') } };
    this.cache = { revision, expiresAt: now + 15000, result };
    return result;
  }
}
