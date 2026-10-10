import { defaultContent, type ContentItem } from '../shared/content.js';
import { contentModule, moduleDescriptions, moduleIds, moduleNames, modulePreferences, repoModule, type ModuleId, type RadarBoard, type RadarEntry } from '../shared/radar.js';
import type { Repo, Settings } from '../shared/types.js';
import { growthRate } from '../shared/signals.js';
import { contentListItem } from './content-store.js';

export function radarApproved(repo: Repo) {
  const report = repo.analysis?.report;
  const module = repoModule(repo);
  if (repo.archived || repo.fork || repo.ignored || repo.analysis?.status !== 'done' || report?.verdict !== 'recommend' || report.confidence === 'low' || report.focusReview?.relevance !== 'direct') return false;
  if (!report.focusReview.relationship.length || !report.focusReview.benefit.length || !report.focusReview.trial.length) return false;
  return module === 'paimon' ? report.focusReview.topicId === 'paimon' : module === 'skills' ? Boolean(repo.skillPaths?.length) && report.focusReview.topicId === 'skills' : module === 'workflows' && ['workflows', 'work-tools', 'training-data'].includes(report.focusReview.topicId);
}
export function lightRepo(repo: Repo): Repo {
  return { ...repo, readme: '', ...(repo.analysis?.report ? { analysis: { ...repo.analysis, report: { ...repo.analysis.report, sources: repo.analysis.report.sources.map(source => ({ ...source, text: '' })) } } } : {}) };
}
export function radarBoard(repos: Repo[], contents: ContentItem[], settings: Settings, view: RadarBoard['view'], options: { sort?: string; library?: string; query?: string; now?: number } = {}): RadarBoard {
  const now = options.now ?? Date.now();
  const preferences = modulePreferences(settings);
  const window = (settings.content || defaultContent).windowDays * 86400000;
  const indexedRepos = new Set(contents.flatMap(item => item.skill ? [item.skill.repoId] : []));
  const repoMap = new Map(repos.map(repo => [repo.id, repo]));
  const relevant: RadarEntry[] = repos.flatMap(repo => { const module = repoModule(repo); return module && !(module === 'skills' && indexedRepos.has(repo.id) && (view === 'home' || view === 'hotlist')) ? [{ type: 'repo' as const, module, repo }] : []; });
  relevant.push(...contents.map(item => {
    const repo = item.skill && repoMap.get(item.skill.repoId);
    return { type: 'content' as const, module: contentModule(item), item, ...(view === 'hotlist' && repo ? { sourceRepo: { ...lightRepo(repo), analysis: undefined } } : {}) };
  }));
  const stateMatches = (entry: RadarEntry) => {
    const item = entry.type === 'repo' ? entry.repo : entry.item;
    if (view !== 'library') return !item.ignored;
    if (options.library === 'ignored') return item.ignored;
    if (options.library === 'read') return item.read;
    if (options.library === 'followed') return entry.type === 'repo' && entry.repo.followed;
    return item.favorite || entry.type === 'repo' && entry.repo.followed;
  };
  const approved = (entry: RadarEntry) => {
    if (entry.type === 'repo') return radarApproved(entry.repo) && (view !== 'home' || !entry.repo.read);
    const item = entry.item; const prefs = settings.content || defaultContent;
    const age = now - Date.parse(item.updatedAt || item.publishedAt || item.firstSeenAt);
    return (item.skill ? item.skill.active : prefs.enabled && prefs[item.kind].enabled && age >= -86400000 && age <= window) && !item.ignored && (view !== 'home' || !item.read) && item.analysisStatus === 'done' && item.report?.verdict === 'recommend' && item.report.confidence !== 'low' && item.report.relevance === 'direct';
  };
  const timestamp = (entry: RadarEntry) => entry.type === 'repo' ? entry.repo.pushedAt : entry.item.publishedAt || entry.item.firstSeenAt;
  const sort = (left: RadarEntry, right: RadarEntry) => {
    if (left.type === 'content' && right.type === 'content' && left.item.skill && right.item.skill) {
      const first = left.item.skill; const second = right.item.skill;
      if (options.sort === 'new') return second.observedAt.localeCompare(first.observedAt) || left.item.id.localeCompare(right.item.id);
      if (view === 'hotlist' && options.sort !== 'stars') return (second.starsPerDay ?? -Infinity) - (first.starsPerDay ?? -Infinity) || (second.stars || 0) - (first.stars || 0) || left.item.id.localeCompare(right.item.id);
      return (second.stars || 0) - (first.stars || 0) || left.item.id.localeCompare(right.item.id);
    }
    if (left.type === 'repo' && right.type === 'repo') {
      if (options.sort === 'stars') return right.repo.stars - left.repo.stars || left.repo.id - right.repo.id;
      if (options.sort === 'new') return right.repo.createdAt.localeCompare(left.repo.createdAt) || right.repo.score - left.repo.score;
      if (view === 'hotlist') return (growthRate(right.repo) ?? -Infinity) - (growthRate(left.repo) ?? -Infinity) || right.repo.stars - left.repo.stars;
      return right.repo.score - left.repo.score || right.repo.stars - left.repo.stars;
    }
    return timestamp(right).localeCompare(timestamp(left));
  };
  const query = options.query?.toLowerCase().trim() || '';
  const groups = moduleIds.map(id => {
    const config = preferences.modules[id];
    const entries = relevant.filter(entry => entry.module === id && stateMatches(entry));
    let selected = entries.filter(entry => view === 'library' || config.enabled && (view === 'candidates' || approved(entry)));
    const qualified = selected.length;
    if (view === 'hotlist' && id === 'skills') selected = selected.filter(entry => {
      if (entry.type === 'repo') return options.sort !== 'new' && (options.sort === 'stars' || (growthRate(entry.repo) ?? 0) > 0);
      const skill = entry.item.skill;
      if (!skill) return false;
      const age = now - Date.parse(skill.observedAt);
      return options.sort === 'new' ? skill.change !== 'baseline' && age >= 0 && age <= (settings.recommendations.newProjectDays ?? 30) * 86400000 : options.sort === 'stars' || (skill.starsPerDay ?? 0) > 0;
    });
    if (query) selected = selected.filter(entry => (entry.type === 'repo' ? `${entry.repo.fullName} ${entry.repo.description} ${entry.repo.analysis?.report?.overview || ''}` : `${entry.item.title} ${entry.item.report?.overview || ''}`).toLowerCase().includes(query));
    const limit = view === 'home' ? config.featuredLimit : view === 'hotlist' ? config.hotLimit : 24;
    const projects = selected.filter(entry => entry.type === 'repo').sort(sort);
    let articles = selected.filter(entry => entry.type === 'content').sort(sort);
    if (id === 'skills' && view === 'home') {
      const recent = articles.filter(entry => entry.item.skill && entry.item.skill.change !== 'baseline' && now - Date.parse(entry.item.skill.observedAt) <= (settings.recommendations.newProjectDays ?? 30) * 86400000);
      const recentIds = new Set(recent.map(entry => entry.item.id));
      const established = articles.filter(entry => !recentIds.has(entry.item.id));
      articles = Array.from({ length: Math.max(recent.length, established.length) }, (_, index) => [established[index], recent[index]]).flat().filter((entry): entry is typeof articles[number] => Boolean(entry));
    }
    const ordered: RadarEntry[] = [];
    for (let index = 0; index < Math.max(projects.length, articles.length); index++) {
      if (projects[index]) ordered.push(projects[index]);
      if (articles[index]) ordered.push(articles[index]);
    }
    const perRepo = new Map<number, number>();
    const diverse = id === 'skills' && (view === 'home' || view === 'hotlist') ? ordered.filter(entry => {
      const repoId = entry.type === 'repo' ? entry.repo.id : entry.item.skill?.repoId;
      if (repoId === undefined) return true;
      const count = perRepo.get(repoId) || 0;
      perRepo.set(repoId, count + 1);
      return count < (view === 'home' ? 1 : 2);
    }) : ordered;
    return { id, name: moduleNames[id], description: moduleDescriptions[id], enabled: config.enabled, candidates: entries.length, qualified, limit, total: selected.length, entries: diverse };
  });
  if (view === 'home') {
    const chosen = groups.map(() => [] as RadarEntry[]);
    let count = 0; let offset = 0;
    while (count < settings.dailyLimit && groups.some((group, index) => offset < group.entries.length && chosen[index].length < group.limit)) {
      for (const [index, group] of groups.entries()) if (count < settings.dailyLimit && group.entries[offset] && chosen[index].length < group.limit) { chosen[index].push(group.entries[offset]); count++; }
      offset++;
    }
    groups.forEach((group, index) => { group.entries = chosen[index]; });
  } else if (view === 'hotlist') groups.forEach(group => { group.entries = group.entries.slice(0, group.limit); });
  const unclassified = view === 'library' ? repos.filter(repo => !repoModule(repo) && stateMatches({ type: 'repo', module: 'workflows', repo }) && `${repo.fullName} ${repo.description}`.toLowerCase().includes(query)).map(lightRepo) : undefined;
  return { generatedAt: new Date(now).toISOString(), view, total: groups.reduce((sum, group) => sum + group.total, 0), unclassified, groups: groups.map(group => ({ ...group, entries: group.entries.map(entry => entry.type === 'repo' ? { ...entry, repo: lightRepo(entry.repo) } : { ...entry, item: contentListItem(entry.item) }) })) };
}
