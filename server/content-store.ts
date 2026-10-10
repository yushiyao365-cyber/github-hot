import type { ContentItem, ContentSnapshot } from '../shared/content.js';
import type { FeaturedHistoryDay } from '../shared/types.js';
import type { Store } from './store.js';

export class ContentStore {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS content_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS content_history (day TEXT NOT NULL, id TEXT NOT NULL, captured_at TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(day,id));
      CREATE INDEX IF NOT EXISTS content_kind ON content_items(kind);`);
  }
  items(): ContentItem[] {
    return this.store.db.prepare('SELECT * FROM content_items').all().map(row => ({ ...JSON.parse(String(row.data)), favorite: Boolean(row.favorite), read: Boolean(row.read), ignored: Boolean(row.ignored) }));
  }
  count(): number { return Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM content_items').get()!.count); }
  item(id: string): ContentItem | null {
    const row = this.store.db.prepare('SELECT * FROM content_items WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.data)), favorite: Boolean(row.favorite), read: Boolean(row.read), ignored: Boolean(row.ignored) } : null;
  }
  save(item: ContentItem) {
    this.store.db.prepare('INSERT INTO content_items(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id, item.kind, JSON.stringify({ ...item, favorite: false, read: false, ignored: false }));
  }
  upsert(item: ContentItem) {
    const old = this.item(item.id);
    const keepExcerpt = old?.coverage === 'excerpt' && item.coverage === 'feed' && Boolean(item.feedFingerprint) && old.feedFingerprint === item.feedFingerprint;
    this.save({ ...item, ...(old ? { firstSeenAt: old.firstSeenAt, report: old.report, error: old.error } : {}), ...(keepExcerpt ? { text: old.text, coverage: old.coverage, fetchedAt: old.fetchedAt } : {}) });
  }
  patch(id: string, patch: Partial<Pick<ContentItem, 'favorite' | 'read' | 'ignored'>>) {
    for (const name of ['favorite', 'read', 'ignored'] as const) if (patch[name] !== undefined) this.store.db.prepare(`UPDATE content_items SET ${name}=? WHERE id=?`).run(Number(patch[name]), id);
  }
  capture(items: ContentItem[], day: string) {
    for (const item of items) {
      if (this.store.db.prepare('SELECT 1 FROM content_history WHERE day=? AND id=?').get(day, item.id)) continue;
      const capturedAt = new Date().toISOString();
      const full = this.item(item.id)!;
      const snapshot: ContentSnapshot = { capturedAt, item: { ...full, analysisStatus: 'done', report: item.report, favorite: false, read: false, ignored: false, error: '' } };
      this.store.db.prepare('INSERT OR IGNORE INTO content_history VALUES(?,?,?,?)').run(day, item.id, capturedAt, JSON.stringify(snapshot));
    }
  }
  days() {
    return this.store.db.prepare(`SELECT edition.*, substr(json_extract(lead.snapshot, '$.item.title'), 1, 160) AS leadTitle,
      substr(COALESCE(json_extract(lead.snapshot, '$.item.report.overview'), ''), 1, 160) AS leadSummary
      FROM (SELECT day, COUNT(*) AS count, MAX(captured_at) AS updatedAt FROM content_history GROUP BY day) edition
      JOIN content_history lead ON lead.rowid = (SELECT rowid FROM content_history WHERE day=edition.day ORDER BY captured_at,id LIMIT 1)
      ORDER BY edition.day DESC`).all() as unknown as FeaturedHistoryDay[];
  }
  history(day: string): ContentSnapshot[] { return this.store.db.prepare('SELECT snapshot FROM content_history WHERE day=? ORDER BY captured_at,id').all(day).map(row => JSON.parse(String(row.snapshot))); }
  snapshot(day: string, id: string): ContentSnapshot | null { const row = this.store.db.prepare('SELECT snapshot FROM content_history WHERE day=? AND id=?').get(day, id); return row ? JSON.parse(String(row.snapshot)) : null; }
}
export function contentListItem(item: ContentItem): ContentItem { return { ...item, text: '', report: item.report ? { ...item.report } : null }; }
