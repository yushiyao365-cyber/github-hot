import { activeFocus, focusTerms } from '../shared/focus.js';
import type { Settings } from '../shared/types.js';

export interface DiscoveryTask { label: string; query: string; sort: string; order: number; topicId?: string }

export function focusDiscoveryTasks(settings: Settings, now = Date.now()): DiscoveryTask[] {
  const bucket = Math.floor(now / (6 * 3600000));
  const created = new Date(now - (settings.recommendations.newProjectDays ?? 30) * 86400000).toISOString().slice(0, 10);
  const active = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  const topics = activeFocus(settings);
  return topics.flatMap((topic, index) => [0, 1, 2].map(offset => {
    const clause = topic.terms[(bucket + offset) % topic.terms.length];
    const terms = focusTerms(clause).map(term => `"${term}"`).join(' ');
    const window = offset === 1 ? `created:>=${created}` : offset === 2 ? `pushed:>=${active}` : '';
    return { topicId: topic.id, label: `${topic.name} / ${['相关工具', '新项目', '近期活动'][offset]}`, query: `${terms} in:name,description,readme ${window} archived:false fork:false is:public`, sort: offset === 2 ? 'updated' : 'stars', order: offset * topics.length + index };
  })).sort((left, right) => left.order - right.order);
}
