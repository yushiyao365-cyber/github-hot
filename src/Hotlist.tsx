import { useEffect, useRef, useState } from 'react';
import { Bookmark, Flame, LoaderCircle, RefreshCw, Star } from 'lucide-react';
import { channelIds, channelNames, type Dashboard, type Hotlist as HotlistData, type HotlistEntry } from '../shared/types.js';
import { activeFocus } from '../shared/focus.js';
import { growthDisplay } from './growth-display.js';
import { Trend, Samples } from './StarTrend.js';
import './hotlist.css';

const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const average = (entry: HotlistEntry) => entry.starsPerDay.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function Metric({ entry }: { entry: HotlistEntry }) {
  const display = growthDisplay({ growth: entry.growth });
  const duration = ((Date.parse(entry.growth.to) - Date.parse(entry.growth.from)) / 86400000).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return <div className="hot-metric" title={display.description}><strong>+{entry.growth.starsDelta.toLocaleString()}</strong><span>{duration} 天净增 Star</span><small>日均 +{average(entry)} · 排序依据</small></div>;
}

export default function Hotlist({ data, busy, onOpen, onPatch, onDiscover, onSettings }: { data: Dashboard; busy: boolean; onOpen: (id: number) => void; onPatch: (id: number, patch: Record<string, unknown>) => void; onDiscover: () => void; onSettings: () => void }) {
  const [topic, setTopic] = useState('all');
  const [result, setResult] = useState<{ topic: string; list: HotlistData } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [sampleEntry, setSampleEntry] = useState<HotlistEntry | null>(null);
  const topics = data.settings.focus?.enabled ? activeFocus(data.settings).map(item => ({ id: item.id, name: item.name })) : channelIds.map(id => ({ id, name: channelNames[id] }));
  const selected = topic === 'all' || topics.some(item => item.id === topic) ? topic : 'all';
  const list = result?.topic === selected ? result.list : null;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let etag = '';
    setError('');
    const load = async () => {
      if (inFlight || controller.signal.aborted || document.hidden) return;
      inFlight = true; setLoading(true);
      try {
        const response = await fetch(`/api/hotlist?topic=${encodeURIComponent(selected)}`, { headers: etag ? { 'If-None-Match': etag } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        if (response.status !== 304) {
          if (!response.ok) throw new Error('榜单读取失败，请稍后刷新');
          const next = await response.json() as HotlistData;
          if (!controller.signal.aborted) { setResult({ topic: selected, list: next }); etag = response.headers.get('etag') || ''; }
        }
        if (!controller.signal.aborted) setError('');
      } catch { if (!controller.signal.aborted) setError('暂时无法读取榜单；若有旧结果，其采样时间仍保留。'); }
      finally {
        inFlight = false;
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void load(), 15000); }
      }
    };
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void load(); } };
    void load(); document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [selected, reload, data]);
  const changeTopic = (next: string) => { setTopic(next); setSampleEntry(null); };
  const favorite = (entry: HotlistEntry) => data.repos.find(repo => repo.id === entry.repo.id)?.favorite ?? entry.repo.favorite;
  const saveButton = (entry: HotlistEntry) => <button className={`icon-button ${favorite(entry) ? 'active' : ''}`} aria-label={`${favorite(entry) ? '取消收藏' : '收藏'} ${entry.repo.fullName}`} aria-pressed={favorite(entry)} disabled={busy} onClick={() => onPatch(entry.repo.id, { favorite: !favorite(entry) })}><Bookmark size={15} fill={favorite(entry) ? 'currentColor' : 'none'} /></button>;
  const entries = list?.entries ?? [];
  return <div className="hotlist-page">
    <header className="hotlist-header"><div><span className="hotlist-eyebrow"><Flame size={13} />真实增长 · 本机观察</span><h1>开源热点榜</h1><p>你的关注方向里，哪些项目正在获得更多关注？</p></div><div className="hotlist-refresh"><span>{list ? `${dateTime(list.generatedAt)} 计算 · 按日均净增 Star 排序` : '读取本机采样记录'}</span><button className="text-button" disabled={loading} onClick={() => setReload(reload + 1)}><RefreshCw size={13} className={loading ? 'spin' : ''} />刷新榜单</button></div></header>
    <div className="hotlist-toolbar"><div className="tabs" role="group" aria-label="热点榜专题筛选"><button className={selected === 'all' ? 'selected' : ''} aria-pressed={selected === 'all'} onClick={() => changeTopic('all')}>全部</button>{topics.map(item => <button key={item.id} className={selected === item.id ? 'selected' : ''} aria-pressed={selected === item.id} onClick={() => changeTopic(item.id)}>{item.name}</button>)}</div><details className="hotlist-rules"><summary>上榜规则</summary><div><p>与当前专题直接相关、通过有效模型推荐审核，再按采样区间日均净增 Star 降序取前 10。未启用专题且模型关闭时，使用规则候选并明确标注。</p><p>要求两个样本相隔 1–14 天，最新样本不超过 3 天，净增长大于 0。同速按相关性评分、总 Star、仓库 ID 排序。大数字是区间净增，不是热度分；不同项目的采样间隔可能不同。</p><p>从本机全部合格项目选取，不局限于今日精选。已读可继续上榜，忽略/归档/分叉项目不上榜；不改变首页限额，不增加 GitHub 或模型调用。</p></div></details></div>
    {error && <div role="alert" className="notice error">{error}<button className="text-button" onClick={() => setReload(reload + 1)}>重试</button></div>}
    {!list && !error ? <div className="empty" role="status"><LoaderCircle className="spin" />正在计算本机增长榜…</div> : list && <>
      <div className="hotlist-coverage"><span>{list.relevantCount} 个{list.reviewRequired ? '已审核相关项目' : '规则候选'} · {list.measuredCount} 个有有效采样 · {list.growingCount} 个正增长</span><span>{list.latestSampleAt ? `榜内最新采样 ${dateTime(list.latestSampleAt)}` : '暂未形成增长榜'} · 非全 GitHub 实时榜</span></div>
      {entries.length ? <>
        <section className={`hotlist-podium count-${Math.min(entries.length, 3)}`} aria-label="增长榜前三名">{entries.slice(0, 3).map(entry => <article className={`hot-card ${entry.rank === 1 ? 'hot-leader' : ''}`} key={entry.repo.id}>
          <div className="hot-card-heading"><span className="hot-rank">NO.{String(entry.rank).padStart(2, '0')}</span><span className={`hot-reviewed ${entry.reviewed ? '' : 'unreviewed'}`}>{entry.reviewed ? '已审核 · 正增长' : '规则候选 · 未审核'}</span>{saveButton(entry)}</div>
          <div className="hot-card-content"><div><button className="hot-title" onClick={() => onOpen(entry.repo.id)}>{entry.repo.fullName}</button><p className="hot-overview">{entry.overview}</p>{entry.rank === 1 && entry.highlight && <p className="hot-highlight"><strong>值得看</strong>{entry.highlight}</p>}</div>{entry.rank === 1 && <Trend entry={entry} large onClick={() => setSampleEntry(entry)} />}</div>
          <div className="hot-card-footer"><div className="hot-repo-meta"><span>{entry.topic?.name || channelNames[entry.repo.channel]}</span><span><Star size={12} />{entry.repo.stars.toLocaleString()} · {entry.repo.language || '未标注语言'}</span><button className="text-button" onClick={() => onOpen(entry.repo.id)}>亮点与证据 →</button></div>{entry.rank !== 1 && <Trend entry={entry} onClick={() => setSampleEntry(entry)} />}<Metric entry={entry} /></div>
        </article>)}</section>
        {entries.length > 3 && <section className="hotlist-rest"><div className="hotlist-rest-heading"><h2>继续看 <span>No.04–{String(entries.length).padStart(2, '0')}</span></h2><span>真实 Star 趋势 · 采样区间净增</span></div><ol start={4}>{entries.slice(3).map(entry => <li className="hot-row" key={entry.repo.id}><span className="hot-row-rank">{String(entry.rank).padStart(2, '0')}</span><div className="hot-row-copy"><button className="hot-title" onClick={() => onOpen(entry.repo.id)}>{entry.repo.fullName}</button><p>{entry.overview}</p><small>{entry.topic?.name || channelNames[entry.repo.channel]} · {entry.reviewed ? '已审核' : '规则候选 · 未审核'}</small></div>{saveButton(entry)}<Trend entry={entry} onClick={() => setSampleEntry(entry)} /><Metric entry={entry} /></li>)}</ol></section>}
        <p className="hotlist-note">曲线仅连接近 30 天真实采样点，点击可查看原始记录。日均值是区间平均，不是今天新增；数量不足不凑榜。</p>
      </> : <div className="hotlist-empty"><Flame size={29} /><h2>{list.relevantCount ? '相关项目还没有有效的正增长记录' : '当前方向暂无符合上榜条件的项目'}</h2><p>{list.relevantCount ? `${list.relevantCount - list.measuredCount} 个项目还缺有效增长样本；无增长、下降或过期数据不补进榜单。` : '先发现相关项目并完成审核；有有效增长采样后会自动出现。'}没有样本时不伪造趋势或热度。</p><div><button className="secondary-button" onClick={onDiscover}>查看项目发现</button><button className="text-button" onClick={onSettings}>调整专题与模型 →</button></div></div>}
    </>}
    {sampleEntry && <Samples entry={sampleEntry} close={() => setSampleEntry(null)} />}
  </div>;
}
