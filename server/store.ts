import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSettings } from './config.js';
import { defaultContent } from '../shared/content.js';
import type { Analysis, AnalysisJob, Growth, Release, Repo, Settings, StarSample, SyncStatus } from '../shared/types.js';

type Row = Record<string, unknown>;
export const emptyStatus: SyncStatus = { running: false, phase: '等待同步', lastAttemptAt: null, lastSuccessAt: null, lastDiscoveryAt: null, lastReleasesAt: null, errors: [], incomplete: false, requestCount: 0, retryAt: null };
export const emptyAnalysisJob: AnalysisJob = { running: false, total: 0, completed: 0, generated: 0, cached: 0, current: '', startedAt: null, finishedAt: null, errors: [], message: '尚未进行项目分析' };

export class Store {
  db: DatabaseSync;
  secretPath: string | null;
  private secrets: Record<string, string> = {};

  constructor(directory: string) {
    const memory = directory === ':memory:';
    if (!memory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.secretPath = memory ? null : join(directory, 'secrets.json');
    const path = memory ? ':memory:' : join(directory, 'radar.sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY, data TEXT NOT NULL, first_seen TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0, followed INTEGER NOT NULL DEFAULT 0,
        ignored INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '', readme TEXT NOT NULL DEFAULT '',
        baseline INTEGER NOT NULL DEFAULT 0, release_baseline TEXT
      );
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repos(id),
        data TEXT NOT NULL, first_seen TEXT NOT NULL, baseline INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS releases_repo ON releases(repo_id);
      CREATE TABLE IF NOT EXISTS summaries (cache_key TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repo_snapshots (repo_id INTEGER NOT NULL REFERENCES repos(id), day TEXT NOT NULL, observed_at TEXT NOT NULL, stars INTEGER NOT NULL, PRIMARY KEY(repo_id, day));
      CREATE TABLE IF NOT EXISTS analyses (repo_id INTEGER PRIMARY KEY REFERENCES repos(id), report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS featured_history (
        day TEXT NOT NULL, repo_id INTEGER NOT NULL, captured_at TEXT NOT NULL,
        position INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(day, repo_id)
      );
      PRAGMA user_version = 3;
    `);
    if (!memory) {
      chmodSync(directory, 0o700);
      chmodSync(path, 0o600);
      if (this.secretPath && existsSync(this.secretPath)) {
        chmodSync(this.secretPath, 0o600);
        this.secrets = JSON.parse(readFileSync(this.secretPath, 'utf8'));
      }
    }
    const previous = this.get<SyncStatus>('sync', emptyStatus);
    if (previous.running) this.set('sync', { ...previous, running: false, phase: '上次同步被中断，可继续同步', incomplete: true });
    const analysis = this.get('analysisJob', emptyAnalysisJob);
    if (analysis.running) this.set('analysisJob', { ...analysis, running: false, current: '', message: '上次分析中断，可重新开始；已完成报告仍保留' });
  }

  get<Type>(key: string, fallback: Type): Type {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) as Type : structuredClone(fallback);
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings {
    const settings = this.get('settings', defaultSettings);
    return { ...settings, content: settings.content ?? structuredClone(defaultContent), focus: settings.focus ?? { enabled: false, topics: [] }, recommendations: { ...defaultSettings.recommendations, ...settings.recommendations }, model: { ...defaultSettings.model, ...settings.model } };
  }
  status(): SyncStatus { return this.get('sync', emptyStatus); }
  secret(name: string): string { return this.secrets[name] || ''; }
  saveSecrets(updates: Record<string, string>) {
    const secrets = { ...this.secrets, ...updates };
    if (this.secretPath) {
      writeFileSync(`${this.secretPath}.tmp`, JSON.stringify(secrets), { mode: 0o600 });
      renameSync(`${this.secretPath}.tmp`, this.secretPath);
      chmodSync(this.secretPath, 0o600);
    }
    this.secrets = secrets;
  }
  private toRepo(row: Row): Repo {
    return { ...JSON.parse(String(row.data)), firstSeenAt: row.first_seen, favorite: Boolean(row.favorite), followed: Boolean(row.followed), ignored: Boolean(row.ignored), read: Boolean(row.read), notes: row.notes, readme: row.readme, baseline: Boolean(row.baseline), releaseBaselineAt: row.release_baseline, summary: '', score: 0, reasons: [] } as Repo;
  }
  repos(): Repo[] { return (this.db.prepare('SELECT * FROM repos ORDER BY first_seen DESC, id DESC').all() as Row[]).map(row => this.toRepo(row)); }
  repo(id: number): Repo | undefined { const row = this.db.prepare('SELECT * FROM repos WHERE id=?').get(id); return row ? this.toRepo(row) : undefined; }
  upsertRepo(repo: Partial<Repo> & { id: number }, baseline = false) {
    this.db.prepare('INSERT INTO repos(id,data,first_seen,baseline) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(repo.id, JSON.stringify(repo), new Date().toISOString(), Number(baseline));
    if (typeof repo.stars === 'number' && repo.fetchedAt) this.snapshot(repo.id, repo.stars, repo.fetchedAt);
  }
  patchRepo(id: number, patch: Record<string, unknown>) {
    const columns: Record<string, string> = { favorite: 'favorite', followed: 'followed', ignored: 'ignored', read: 'read', notes: 'notes', readme: 'readme', releaseBaselineAt: 'release_baseline' };
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (column) this.db.prepare(`UPDATE repos SET ${column}=? WHERE id=?`).run(typeof value === 'boolean' ? Number(value) : value as string | null, id);
    }
  }
  upsertRelease(release: Partial<Release> & { id: number; repoId: number }, baseline: boolean) {
    this.db.prepare('INSERT INTO releases(id,repo_id,data,first_seen,baseline) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(release.id, release.repoId, JSON.stringify(release), new Date().toISOString(), Number(baseline));
  }
  releases(): Release[] {
    return (this.db.prepare('SELECT releases.*, repos.data AS repo_data FROM releases JOIN repos ON repos.id=releases.repo_id ORDER BY json_extract(releases.data,\'$.publishedAt\') DESC').all() as Row[]).map(row => ({ ...JSON.parse(String(row.data)), fullName: JSON.parse(String(row.repo_data)).fullName, firstSeenAt: row.first_seen, baseline: Boolean(row.baseline), read: Boolean(row.read), hidden: Boolean(row.hidden), summary: '' }));
  }
  repoReleases(id: number, limit = 2): Release[] {
    return (this.db.prepare("SELECT releases.*, json_extract(repos.data, '$.fullName') AS full_name FROM releases JOIN repos ON repos.id=releases.repo_id WHERE releases.repo_id=? AND COALESCE(json_extract(releases.data, '$.prerelease'), 0)=0 ORDER BY json_extract(releases.data, '$.publishedAt') DESC LIMIT ?").all(id, limit) as Row[]).map(row => ({ ...JSON.parse(String(row.data)), fullName: String(row.full_name), firstSeenAt: row.first_seen, baseline: Boolean(row.baseline), read: Boolean(row.read), hidden: Boolean(row.hidden), summary: '' }));
  }
  revision(): string {
    const version = this.db.prepare('PRAGMA data_version').get();
    const changes = this.db.prepare('SELECT total_changes() AS changes').get();
    return `${version?.data_version}:${changes?.changes}:${Boolean(this.secret('githubToken'))}:${Boolean(this.secret('modelKey'))}`;
  }
  patchRelease(id: number, patch: { read?: boolean; hidden?: boolean }) {
    if (patch.read !== undefined) this.db.prepare('UPDATE releases SET read=? WHERE id=?').run(Number(patch.read), id);
    if (patch.hidden !== undefined) this.db.prepare('UPDATE releases SET hidden=? WHERE id=?').run(Number(patch.hidden), id);
  }
  summary(key: string): string { return String(this.db.prepare('SELECT content FROM summaries WHERE cache_key=?').get(key)?.content || ''); }
  saveSummary(key: string, content: string) { this.db.prepare('INSERT OR REPLACE INTO summaries VALUES(?,?,?)').run(key, content, new Date().toISOString()); }
  snapshot(id: number, stars: number, observedAt: string) {
    this.db.prepare('INSERT INTO repo_snapshots VALUES(?,?,?,?) ON CONFLICT(repo_id,day) DO UPDATE SET observed_at=excluded.observed_at,stars=excluded.stars WHERE excluded.observed_at > repo_snapshots.observed_at').run(id, observedAt.slice(0, 10), observedAt, stars);
  }
  growth(id: number): Growth | null {
    const samples = this.db.prepare('SELECT observed_at,stars FROM repo_snapshots WHERE repo_id=? ORDER BY observed_at DESC LIMIT 31').all(id);
    const latest = samples[0];
    if (!latest) return null;
    const end = Date.parse(String(latest.observed_at));
    const previous = samples.slice(1).filter(sample => end - Date.parse(String(sample.observed_at)) >= 86400000 && end - Date.parse(String(sample.observed_at)) <= 30 * 86400000)
      .sort((left, right) => end - Date.parse(String(left.observed_at)) - (end - Date.parse(String(right.observed_at))))[0];
    if (!previous) return null;
    return { from: String(previous.observed_at), to: String(latest.observed_at), days: Math.round((end - Date.parse(String(previous.observed_at))) / 8640000) / 10, starsDelta: Number(latest.stars) - Number(previous.stars), fromStars: Number(previous.stars), toStars: Number(latest.stars) };
  }
  starSamples(id: number, now = Date.now()): StarSample[] {
    return this.db.prepare('SELECT observed_at AS observedAt, stars FROM repo_snapshots WHERE repo_id = ? AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 31')
      .all(id, new Date(now - 30 * 86400000).toISOString(), new Date(now).toISOString()).reverse() as unknown as StarSample[];
  }
  analysis(id: number): Analysis | null {
    const row = this.db.prepare('SELECT report FROM analyses WHERE repo_id=?').get(id);
    return row ? JSON.parse(String(row.report)) : null;
  }
  saveAnalysis(report: Analysis) { this.db.prepare('INSERT OR REPLACE INTO analyses VALUES(?,?)').run(report.repoId, JSON.stringify(report)); }
  close() { this.db.close(); }
}
