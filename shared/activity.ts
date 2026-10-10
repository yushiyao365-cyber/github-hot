import type { RadarEntry } from './radar.js';

export interface ActivityEntry {
  entry: RadarEntry;
  occurredAt: string | null;
  timeLabel: string;
}
export interface ActivityFeed {
  generatedAt: string;
  total: number;
  page: number;
  pageSize: number;
  entries: ActivityEntry[];
}

export function activityTime(entry: RadarEntry): Pick<ActivityEntry, 'occurredAt' | 'timeLabel'> {
  const valid = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  if (entry.type === 'repo') return { occurredAt: valid(entry.repo.firstSeenAt), timeLabel: '本机收录' };
  const item = entry.item;
  if (item.skill && item.skill.change !== 'baseline' && valid(item.skill.observedAt)) return { occurredAt: valid(item.skill.observedAt), timeLabel: item.skill.change === 'added' ? '观测新增文件' : '观测文件变更' };
  return item.publishedAt && valid(item.publishedAt) ? { occurredAt: valid(item.publishedAt), timeLabel: '原文发布' } : { occurredAt: valid(item.firstSeenAt), timeLabel: '本机收录' };
}

export function activityDays(entries: ActivityEntry[]) {
  const groups = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const date = entry.occurredAt ? new Date(entry.occurredAt) : null;
    const day = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '日期未知';
    groups.set(day, [...(groups.get(day) || []), entry]);
  }
  return [...groups].map(([day, entries]) => ({ day, entries }));
}
