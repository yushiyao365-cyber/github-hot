import type { Pool, Repo, Settings } from '../shared/types.js';
import { allocate } from './ranking.js';
import { channelIds } from '../shared/types.js';
import { isRising, isNewProject } from '../shared/signals.js';
import { candidateFocusIds } from '../shared/focus.js';

export function poolFor(repo: Repo, settings: Settings, now = Date.now()): Pool | null {
  if (settings.focus?.enabled) {
    if (repo.archived || repo.fork || repo.ignored || repo.score < 40 || !(repo.description || repo.readme) || !candidateFocusIds(repo, settings).length) return null;
    return repo.stars >= settings.recommendations.highStarMin ? 'highStars' : 'potential';
  }
  if (repo.archived || repo.fork || repo.ignored || repo.score < 40 || !(repo.description || repo.readme) || !settings.channels[repo.channel].weight) return null;
  if (repo.stars >= settings.recommendations.highStarMin) return 'highStars';
  const age = (now - Date.parse(repo.createdAt)) / 86400000;
  return (age >= 0 && age <= settings.recommendations.potentialMaxAgeDays) || isRising(repo, settings, now) ? 'potential' : null;
}

export function preciseCandidate(repo: Repo, settings: Settings): boolean {
  if (settings.focus?.enabled) return Boolean(repo.pool && candidateFocusIds(repo, settings).length);
  return Boolean(repo.pool && (repo.pool === 'highStars' || isRising(repo, settings) || isNewProject(repo, settings)));
}

export function verifiedCandidate(repo: Repo, settings: Settings): boolean {
  return preciseCandidate(repo, settings) && repo.analysis?.status === 'done' && repo.analysis.report?.verdict === 'recommend' && repo.analysis.report.confidence !== 'low';
}

function priority(repo: Repo): number {
  if (repo.analysis?.status !== 'done') return 1;
  return repo.analysis.report?.verdict === 'recommend' ? 3 : repo.analysis.report?.verdict === 'watch' ? 2 : 0;
}

export function poolCandidates(repos: Repo[], pool: Pool): Repo[] {
  return repos.filter(repo => repo.pool === pool && !repo.read && priority(repo) > 0)
    .sort((left, right) => priority(right) - priority(left) || right.score - left.score || right.createdAt.localeCompare(left.createdAt) || left.id - right.id);
}

function choose(repos: Repo[], limit: number, settings: Settings): Repo[] {
  const quotas = allocate(Math.min(limit, repos.length), settings);
  const chosen: Repo[] = [];
  const ids = new Set<number>();
  for (const channel of channelIds) {
    for (const repo of repos.filter(item => item.channel === channel).slice(0, quotas[channel])) {
      chosen.push(repo); ids.add(repo.id);
    }
  }
  for (const repo of repos) {
    if (chosen.length >= limit) break;
    if (!ids.has(repo.id)) { chosen.push(repo); ids.add(repo.id); }
  }
  return chosen;
}

export function selectPools(repos: Repo[], settings: Settings): Record<Pool, number[]> {
  const high = poolCandidates(repos, 'highStars');
  const potential = poolCandidates(repos, 'potential');
  const limit = Math.min(settings.dailyLimit, high.length + potential.length);
  let potentialLimit = Math.round(limit * settings.recommendations.potentialShare / 100);
  let highLimit = limit - potentialLimit;
  if (high.length < highLimit) potentialLimit = Math.min(potential.length, limit - high.length);
  if (potential.length < potentialLimit) highLimit = Math.min(high.length, limit - potential.length);
  return {
    highStars: choose(high, Math.min(highLimit, high.length), settings).map(repo => repo.id),
    potential: choose(potential, Math.min(potentialLimit, potential.length), settings).map(repo => repo.id),
  };
}
