import type { Repo } from '../shared/types.js';
import { growthRate } from '../shared/signals.js';

export function growthDisplay(repo: Pick<Repo, 'growth'>, now = Date.now()) {
  const growth = repo.growth;
  const rate = growthRate(repo, now);
  if (!growth || rate === null || !Number.isFinite(rate) || !Number.isSafeInteger(growth.starsDelta)) {
    return {
      label: growth ? '旧快照 · 待更新' : '增速待采样',
      description: '暂无可用增速：需要相隔 1–14 天的两个实测快照，且最新快照不超过 3 天。不把未知增长显示为零。',
      direction: 'unknown' as const,
    };
  }
  const days = (Date.parse(growth.to) - Date.parse(growth.from)) / 86400000;
  const duration = days.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const delta = `${growth.starsDelta > 0 ? '+' : ''}${growth.starsDelta.toLocaleString('zh-CN')}`;
  const average = `${rate > 0 ? '+' : ''}${rate.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  const date = (value: string) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const counts = Number.isSafeInteger(growth.fromStars) && Number.isSafeInteger(growth.toStars)
    ? `；Star ${growth.fromStars!.toLocaleString('zh-CN')} → ${growth.toStars!.toLocaleString('zh-CN')}` : '';
  return {
    label: `${duration} 天 ${delta} ★`,
    description: `采样区间：${date(growth.from)} 至 ${date(growth.to)}（本机时间）。约 ${duration} 天净变化 ${delta} Star${counts}。日均 ${average} ★/天，仅为区间平均，不是今日新增或精确 24 小时涨幅。`,
    direction: growth.starsDelta > 0 ? 'up' as const : growth.starsDelta < 0 ? 'down' as const : 'flat' as const,
  };
}
