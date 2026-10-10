import type { Repo, Settings } from './types.js';

export function growthRate(repo: Pick<Repo, 'growth'>, now = Date.now()): number | null {
  const growth = repo.growth;
  if (!growth) return null;
  const start = Date.parse(growth.from);
  const end = Date.parse(growth.to);
  const days = (end - start) / 86400000;
  if (!Number.isFinite(days) || days < 1 || days > 14 || end > now || now - end > 3 * 86400000) return null;
  return growth.starsDelta / days;
}

export function isRising(repo: Pick<Repo, 'growth'>, settings: Settings, now = Date.now()): boolean {
  const rate = growthRate(repo, now);
  return rate !== null && rate >= (settings.recommendations.growthMinStarsPerDay ?? 10);
}

export function isNewProject(repo: Pick<Repo, 'createdAt'>, settings: Settings, now = Date.now()): boolean {
  const age = (now - Date.parse(repo.createdAt)) / 86400000;
  return age >= 0 && age <= (settings.recommendations.newProjectDays ?? 30);
}
