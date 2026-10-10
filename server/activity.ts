import { activityTime, type ActivityFeed } from '../shared/activity.js';
import { contentModule, entryKey, modulePreferences, repoModule, type ModuleId, type RadarEntry } from '../shared/radar.js';
import { contentTitle, repoTitle } from '../shared/titles.js';
import type { ContentItem } from '../shared/content.js';
import type { Repo, Settings } from '../shared/types.js';
import { lightRepo } from './radar.js';
import { contentListItem } from './content-store.js';

export function activityFeed(repos: Repo[], contents: ContentItem[], settings: Settings, options: { page: number; module?: ModuleId; query?: string; now: number }): ActivityFeed {
  const modules = modulePreferences(settings).modules;
  const candidates: RadarEntry[] = [];
  for (const repo of repos) {
    const module = repoModule(repo);
    if (module && modules[module].enabled && !repo.ignored && !repo.fork && !repo.archived) candidates.push({ type: 'repo', module, repo });
  }
  for (const item of contents) {
    const module = contentModule(item);
    if (modules[module].enabled && !item.ignored && (item.skill ? item.skill.active : settings.content?.enabled && settings.content[item.kind].enabled)) candidates.push({ type: 'content', module, item });
  }
  const query = options.query?.toLowerCase().trim() || '';
  const entries = candidates.filter(entry => (!options.module || options.module === entry.module) && (!query || (entry.type === 'repo'
    ? `${repoTitle(entry.repo)} ${entry.repo.fullName} ${entry.repo.description} ${entry.repo.analysis?.status === 'done' ? entry.repo.analysis.report?.overview || '' : ''}`
    : `${contentTitle(entry.item)} ${entry.item.title} ${entry.item.source} ${entry.item.analysisStatus === 'done' ? entry.item.report?.overview || '' : ''}`).toLowerCase().includes(query)))
    .map(entry => ({ entry, ...activityTime(entry) }))
    .sort((left, right) => (right.occurredAt || '').localeCompare(left.occurredAt || '') || entryKey(left.entry).localeCompare(entryKey(right.entry)));
  const pageSize = 24;
  return { generatedAt: new Date(options.now).toISOString(), total: entries.length, page: options.page, pageSize, entries: entries.slice((options.page - 1) * pageSize, options.page * pageSize).map(row => ({ ...row, entry: row.entry.type === 'repo' ? { ...row.entry, repo: lightRepo(row.entry.repo) } : { ...row.entry, item: contentListItem(row.entry.item) } })) };
}
