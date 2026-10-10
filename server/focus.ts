import { activeFocus, candidateFocusIds, focusSignature } from '../shared/focus.js';
import type { Analysis, Repo, Settings } from '../shared/types.js';
import type { Store } from './store.js';

export function withFocusHints(repo: Repo, settings: Settings, store: Store): Repo {
  const hints = store.get<Record<string, string>>(`focusDiscovery:${repo.id}`, {});
  return { ...repo, focusIds: activeFocus(settings).filter(topic => hints[topic.id] === focusSignature(topic)).map(topic => topic.id) };
}

export function focusReviewAccepted(report: Analysis | null | undefined, settings: Settings): boolean {
  const review = report?.focusReview;
  return Boolean(report?.verdict === 'recommend' && report.confidence !== 'low' && review?.relevance === 'direct' && review.relationship.length && review.benefit.length && review.trial.length && activeFocus(settings).some(topic => topic.id === review.topicId));
}

export function selectFocus(repos: Repo[], settings: Settings, verified = true) {
  const topics = activeFocus(settings);
  const eligible = repos.filter(repo => !repo.ignored && !repo.read && !repo.archived && !repo.fork && repo.score >= 40 && (repo.description || repo.readme));
  const sections = topics.map(topic => {
    const candidates = eligible.filter(repo => candidateFocusIds(repo, settings).includes(topic.id));
    return { topicId: topic.id, name: topic.name, goal: topic.goal, repoIds: [] as number[], candidates: candidates.length, reviewed: candidates.filter(repo => repo.analysis?.status === 'done').length };
  });
  const queues = topics.map(topic => eligible.filter(repo => verified
    ? repo.analysis?.status === 'done' && focusReviewAccepted(repo.analysis.report, settings) && repo.analysis.report?.focusReview?.topicId === topic.id
    : candidateFocusIds(repo, settings).includes(topic.id)
  ).sort((left, right) => right.score - left.score || right.stars - left.stars || left.id - right.id));
  const selected = new Set<number>();
  const tasks = new Set<string>();
  while (selected.size < settings.dailyLimit) {
    const next = topics.map((topic, index) => ({ index, ratio: sections[index].repoIds.length / topic.weight }))
      .filter(item => queues[item.index].length).sort((left, right) => left.ratio - right.ratio || left.index - right.index)[0];
    if (!next) break;
    const repo = queues[next.index].shift()!;
    const task = verified ? `${topics[next.index].id}:${repo.analysis?.report?.focusReview?.task.toLowerCase().replace(/\s+/g, '')}` : '';
    if (selected.has(repo.id) || task && tasks.has(task)) continue;
    selected.add(repo.id);
    if (task) tasks.add(task);
    sections[next.index].repoIds.push(repo.id);
  }
  return sections;
}
