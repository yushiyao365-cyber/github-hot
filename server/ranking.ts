import { channelIds, channelNames, type ChannelId, type Repo, type Settings } from '../shared/types.js';
import { growthRate, isRising, isNewProject } from '../shared/signals.js';
import { activeFocus, candidateFocusIds } from '../shared/focus.js';

export function matchesKeyword(text: string, keyword: string): boolean {
  if (/^[a-z0-9]+$/i.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
  }
  return text.includes(keyword);
}

export function classify(repo: Pick<Repo, 'fullName' | 'description' | 'topics'>, settings: Settings): ChannelId {
  const text = `${repo.fullName} ${repo.description}`.toLowerCase();
  let best: ChannelId = 'devtools';
  let bestScore = 0;
  for (const channel of ['agent', 'data', 'ai', 'devtools'] as ChannelId[]) {
    const config = settings.channels[channel];
    const score = config.topics.filter(topic => repo.topics.includes(topic)).length * 3 + config.keywords.filter(word => matchesKeyword(text, word)).length;
    if (score > bestScore) { best = channel; bestScore = score; }
  }
  return best;
}

export function rank(repo: Repo, settings: Settings, now = Date.now()): Repo {
  const channel = classify(repo, settings);
  const config = settings.channels[channel];
  const text = `${repo.fullName} ${repo.description}`.toLowerCase();
  const topic = config.topics.find(value => repo.topics.includes(value));
  const keyword = config.keywords.find(value => matchesKeyword(text, value));
  let score = topic ? 40 : keyword ? 30 : 0;
  const reasons: string[] = [];
  if (topic) reasons.push(`匹配 ${topic}`);
  else if (keyword) reasons.push(`匹配「${keyword}」`);
  const ageDays = (now - Date.parse(repo.createdAt)) / 86400000;
  if (ageDays >= 0 && ageDays <= 30) { score += 20; reasons.push('30 天内创建'); }
  const activityDays = (now - Date.parse(repo.pushedAt)) / 86400000;
  if (activityDays >= 0 && activityDays <= 90) { score += 10; reasons.push('近期有代码活动'); }
  if (repo.readme) score += 10;
  if (isNewProject(repo, settings, now)) { score += 5; reasons.push('新项目发现窗口内'); }
  if (isRising(repo, settings, now)) {
    const rate = growthRate(repo, now)!;
    score += Math.min(30, 10 + Math.log10(1 + rate) * 5);
    reasons.unshift(`实测区间日均新增 ${Math.round(rate)} Star`);
  }
  if (repo.topics.some(topic => ['awesome-list', 'interview-questions', 'leetcode', 'tutorials'].includes(topic))) score -= 20;
  score += repo.stars >= 10000 ? 5 : repo.stars >= 1000 ? 3 : repo.stars >= 100 ? 2 : repo.stars >= 10 ? 1 : 0;
  if ((!topic && !keyword) || settings.excludeKeywords.some(word => text.includes(word))) score = 0;
  if (settings.focus?.enabled) {
    const focusIds = candidateFocusIds(repo, settings);
    const metadataMatch = candidateFocusIds({ ...repo, readme: '', focusIds: [] }, settings).length > 0;
    const interest = Math.min(30, Math.log10(1 + Math.max(0, repo.stars)) * 7);
    const freshness = isNewProject(repo, settings, now) ? 6 : 0;
    const rising = isRising(repo, settings, now) ? Math.min(12, Math.log10(1 + growthRate(repo, now)!) * 4) : 0;
    score = focusIds.length && !settings.excludeKeywords.some(word => text.includes(word)) ? 60 + interest + freshness + rising + (metadataMatch ? 8 : 0) + (activityDays >= 0 && activityDays <= 90 ? 4 : 0) : 0;
    if (score && repo.topics.some(topic => ['awesome-list', 'interview-questions', 'leetcode', 'tutorials'].includes(topic))) score -= 20;
    reasons.unshift(...activeFocus(settings).filter(focus => focusIds.includes(focus.id)).map(focus => `专题候选：${focus.name}（待证据审核）`));
  }
  if (!reasons.length) reasons.push(`${channelNames[channel]} · 手动加入`);
  return { ...repo, channel, score, reasons };
}

export function allocate(limit: number, settings: Settings): Record<ChannelId, number> {
  const total = channelIds.reduce((sum, channel) => sum + settings.channels[channel].weight, 0);
  const rows = channelIds.map((channel, index) => {
    const exact = limit * (settings.channels[channel].weight / total);
    return { channel, amount: Math.floor(exact), remainder: exact - Math.floor(exact), index };
  });
  let remaining = limit - rows.reduce((sum, row) => sum + row.amount, 0);
  for (const row of [...rows].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remaining > 0 && settings.channels[row.channel].weight > 0) { row.amount++; remaining--; }
  }
  return Object.fromEntries(rows.map(row => [row.channel, row.amount])) as Record<ChannelId, number>;
}

export function selectFeatured(repos: Repo[], settings: Settings, now = Date.now()): number[] {
  const candidates = repos.filter(repo => !repo.ignored && !repo.read && !repo.archived && !repo.fork && repo.score >= 40 && (repo.description || repo.readme) && settings.channels[repo.channel].weight > 0 && now - Date.parse(repo.firstSeenAt) <= 7 * 86400000)
    .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt) || left.id - right.id);
  const quotas = allocate(Math.min(settings.dailyLimit, candidates.length), settings);
  const chosen = new Set<number>();
  for (const channel of channelIds) for (const repo of candidates.filter(item => item.channel === channel).slice(0, quotas[channel])) chosen.add(repo.id);
  for (const repo of candidates) {
    if (chosen.size >= settings.dailyLimit) break;
    chosen.add(repo.id);
  }
  return [...chosen];
}
