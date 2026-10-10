import type { Dashboard, Repo } from '../shared/types.js';

export function featuredRepos(data: Pick<Dashboard, 'repos' | 'featuredIds' | 'settings' | 'focusSections'>, matches: (repo: Repo) => boolean, topic = 'all'): Repo[] {
  const byId = new Map(data.repos.map(repo => [repo.id, repo]));
  const topicIds = data.settings.focus?.enabled && topic !== 'all'
    ? new Set(data.focusSections?.find(section => section.topicId === topic)?.repoIds ?? []) : null;
  return [...new Set(data.featuredIds)].flatMap(id => {
    const repo = byId.get(id);
    return repo && (!topicIds || topicIds.has(id)) && matches(repo) ? [repo] : [];
  });
}

export function featuredTime(repo: Repo): { value: string; label: string; day: string } {
  const analyzed = repo.analysis?.status === 'done' && repo.analysis.report?.analyzedAt;
  const value = analyzed || repo.fetchedAt;
  const valid = Number.isFinite(Date.parse(value));
  return { value: valid ? value : '', label: analyzed ? '分析' : '采集', day: valid ? new Date(value).toLocaleDateString('en-CA') : 'unknown' };
}

export function featuredDays(repos: Repo[]) {
  const groups = new Map<string, Repo[]>();
  for (const repo of repos) {
    const day = featuredTime(repo).day;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(repo);
  }
  return [...groups].sort(([left], [right]) => left === 'unknown' ? 1 : right === 'unknown' ? -1 : right.localeCompare(left)).map(([day, items]) => ({
    day, repos: [...items].sort((left, right) => Date.parse(featuredTime(right).value) - Date.parse(featuredTime(left).value) || repos.indexOf(left) - repos.indexOf(right)),
  }));
}
