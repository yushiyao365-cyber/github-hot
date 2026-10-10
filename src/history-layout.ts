import { channelNames, type FeaturedHistoryEntry } from '../shared/types.js';
import type { ContentSnapshot } from '../shared/content.js';
import { repoTitle, contentTitle } from '../shared/titles.js';

export function editionPreview(entries: FeaturedHistoryEntry[], content: ContentSnapshot[]) {
  const projects = entries.map(entry => ({ kind: 'project' as const, id: entry.repo.id, title: repoTitle(entry.repo), summary: entry.repo.analysis?.report?.overview || entry.repo.description }));
  const articles = content.map(entry => ({ kind: entry.item.kind, id: entry.item.id, title: contentTitle(entry.item), summary: entry.item.report?.overview || '' }));
  const queues = [projects, articles.filter(item => item.kind === 'paper'), articles.filter(item => item.kind === 'practice')];
  const result: (typeof projects[number] | typeof articles[number])[] = [];
  for (let index = 0; result.length < 3 && queues.some(queue => queue[index]); index++) {
    for (const queue of queues) if (queue[index] && result.length < 3) result.push(queue[index]);
  }
  return result;
}

export function calendarDays(day: string): (string | null)[] {
  const [year, month] = day.split('-').map(Number);
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const count = new Date(year, month, 0).getDate();
  return [...Array<null>(firstWeekday).fill(null), ...Array.from({ length: count }, (_, index) => `${day.slice(0, 7)}-${String(index + 1).padStart(2, '0')}`)];
}

export function editionSections(entries: FeaturedHistoryEntry[]) {
  const sections = new Map<string, { id: string; name: string; entries: FeaturedHistoryEntry[] }>();
  for (const entry of entries) {
    const id = entry.topic ? `topic:${entry.topic.id}` : `channel:${entry.repo.channel}`;
    if (!sections.has(id)) sections.set(id, { id, name: entry.topic?.name || channelNames[entry.repo.channel], entries: [] });
    sections.get(id)!.entries.push(entry);
  }
  return [...sections.values()];
}
