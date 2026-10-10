import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Repo, StarSample } from '../shared/types.js';
import { growthDisplay } from './growth-display.js';
import { starTrend } from './star-trend.js';

export interface StarTrendEntry { repo: Pick<Repo, 'fullName' | 'growth'>; samples: StarSample[]; growth?: Repo['growth'] }
const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export function Trend({ entry, large = false, onClick }: { entry: StarTrendEntry; large?: boolean; onClick: () => void }) {
  const height = large ? 142 : 48;
  const trend = starTrend(entry.samples, 260, height);
  return <button className={`hot-trend ${large ? 'large' : ''}`} onClick={onClick} aria-label={`查看 ${entry.repo.fullName} 的采样明细`}>
    {trend ? <><svg viewBox={`0 0 260 ${height}`} role="img" aria-label={`${entry.repo.fullName} 的 Star 采样趋势，${trend.points.length} 个真实采样点`}>
      <title>横轴为实际采样时间，纵轴为该项目 Star 数；直线连接采样点，不代表中间时刻观测值。</title>
      <polygon points={trend.area} fill="currentColor" opacity=".07" />
      <polyline points={trend.line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {trend.coordinates.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={large ? 2.5 : index === trend.coordinates.length - 1 ? 3 : 1.5} fill="currentColor" />)}
    </svg>{large && <><span className="hot-trend-axis"><span>{dateTime(trend.points[0].observedAt)}</span><span>{dateTime(trend.points.at(-1)!.observedAt)}</span></span><span className="hot-trend-caption">{trend.minimum.toLocaleString()}–{trend.maximum.toLocaleString()} Stars · {trend.points.length} 次采样</span></>}</> : <span className="hot-trend-empty">趋势样本不足</span>}
  </button>;
}

export function Samples({ entry, close }: { entry: StarTrendEntry; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="detail-modal hot-samples" aria-label="Star 采样明细" onCancel={close} onClick={event => { if (event.currentTarget === event.target) close(); }}>
    <div className="modal-head"><span>Star 采样明细</span><button className="icon-button" aria-label="关闭采样明细" onClick={close}><X size={20} /></button></div>
    <div className="modal-body"><h2>{entry.repo.fullName}</h2><p>{growthDisplay({ growth: entry.growth }).description}</p><table><thead><tr><th>采样时间（本机时区）</th><th>Star 数</th></tr></thead><tbody>{entry.samples.map(sample => <tr key={sample.observedAt}><td>{new Date(sample.observedAt).toLocaleString('zh-CN', { hour12: false })}</td><td>{sample.stars.toLocaleString()}</td></tr>)}</tbody></table><p>仅显示近 30 天内本机实际记录。未采集的日期不补点；各项目图表使用自己的纵轴范围，不能用曲线斜率直接比较涨幅。</p></div>
  </dialog>;
}
