import type { FeaturedHistoryDay, FeaturedHistoryEntry, Repo, Settings } from '../shared/types.js';
import type { Store } from './store.js';
import { AppError } from './config.js';
import { dayKey } from './summaries.js';

export function validateHistoryDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day || day > dayKey()) {
    throw new AppError('请选择有效日期，不能晚于今天');
  }
  return day;
}

export class FeaturedHistory {
  constructor(private store: Store) {}

  capture(repos: Repo[], featuredIds: number[], settings: Settings, now = new Date()) {
    if (!featuredIds.length) return;
    const day = now.toLocaleDateString('en-CA');
    const capturedAt = now.toISOString();
    const existing = new Set(this.store.db.prepare('SELECT repo_id FROM featured_history WHERE day = ?').all(day).map(row => Number(row.repo_id)));
    if (featuredIds.every(id => existing.has(id))) return;
    const byId = new Map(repos.map(repo => [repo.id, repo]));
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO featured_history VALUES (?, ?, ?, ?, ?)');
    this.store.db.exec('BEGIN');
    try {
      for (const id of featuredIds) {
        const repo = byId.get(id);
        if (!repo || existing.has(id)) continue;
        const topic = settings.focus?.enabled ? settings.focus.topics.find(item => item.id === repo.analysis?.report?.focusReview?.topicId) : undefined;
        const snapshot: FeaturedHistoryEntry = {
          capturedAt, topic: topic ? { id: topic.id, name: topic.name } : null,
          repo: { ...repo, favorite: false, followed: false, ignored: false, read: false, notes: '', releaseBaselineAt: null },
        };
        insert.run(day, id, capturedAt, existing.size, JSON.stringify(snapshot));
        existing.add(id);
      }
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  days(): FeaturedHistoryDay[] {
    return this.store.db.prepare(`
      SELECT edition.*,
        substr(json_extract(lead.snapshot, '$.repo.fullName'), 1, 160) AS leadTitle,
        substr(COALESCE(NULLIF(json_extract(lead.snapshot, '$.repo.analysis.report.overview'), ''), json_extract(lead.snapshot, '$.repo.description')), 1, 160) AS leadSummary
      FROM (SELECT day, COUNT(*) AS count, MAX(captured_at) AS updatedAt FROM featured_history GROUP BY day) edition
      JOIN featured_history lead ON lead.rowid = (
        SELECT rowid FROM featured_history WHERE day = edition.day ORDER BY position, repo_id LIMIT 1
      )
      ORDER BY edition.day DESC
    `).all() as unknown as FeaturedHistoryDay[];
  }

  entries(day: string): FeaturedHistoryEntry[] {
    return this.store.db.prepare('SELECT snapshot FROM featured_history WHERE day = ? ORDER BY position, repo_id').all(day).map(row => {
      const entry = JSON.parse(String(row.snapshot)) as FeaturedHistoryEntry;
      entry.repo.readme = '';
      if (entry.repo.analysis?.report) entry.repo.analysis.report.sources = entry.repo.analysis.report.sources.map(source => ({ ...source, text: '' }));
      return entry;
    });
  }

  entry(day: string, repoId: number): FeaturedHistoryEntry | null {
    const row = this.store.db.prepare('SELECT snapshot FROM featured_history WHERE day = ? AND repo_id = ?').get(day, repoId);
    return row ? JSON.parse(String(row.snapshot)) as FeaturedHistoryEntry : null;
  }
}
