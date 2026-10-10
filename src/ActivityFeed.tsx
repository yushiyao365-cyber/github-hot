import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, ExternalLink, EyeOff, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { Dashboard } from '../shared/types.js';
import { activityDays, type ActivityFeed as ActivityData } from '../shared/activity.js';
import { entryKey, moduleNames, type ModuleId, type RadarEntry } from '../shared/radar.js';
import { repoTitle, contentTitle } from '../shared/titles.js';
import { ModuleTabs } from './RadarView.js';
import { ContentDetail, type ContentAction } from './ContentViews.js';
import { api } from './api.js';
import './activity.css';

export function ActivityTimeline({ feed, busy, onOpen, onPatch }: { feed: ActivityData; busy: boolean; onOpen: (entry: RadarEntry) => void; onPatch: (entry: RadarEntry, changes: Record<string, boolean>) => void }) {
  return <div className="activity-timeline">{activityDays(feed.entries).map(group => <section className="activity-day" key={group.day}>
    <header><h2>{group.day === '日期未知' ? group.day : new Date(`${group.day}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</h2><span>{group.day === '日期未知' ? '' : new Date(`${group.day}T12:00:00`).toLocaleDateString('zh-CN', { year: 'numeric', weekday: 'long' })} · 本页 {group.entries.length} 条</span></header>
    <ol>{group.entries.map(({ entry, occurredAt, timeLabel }) => {
      const repo = entry.type === 'repo' ? entry.repo : null;
      const item = entry.type === 'content' ? entry.item : null;
      const state = repo || item!;
      const status = repo?.analysis?.status || item?.analysisStatus || 'pending';
      const report = status === 'done' ? repo?.analysis?.report || item?.report : null;
      const title = repo ? repoTitle(repo) : contentTitle(item!);
      const original = repo?.fullName || item!.title;
      const label = report ? report.verdict === 'recommend' ? '分析 · 值得了解' : report.verdict === 'watch' ? '分析 · 观察' : '分析 · 不推荐' : status === 'stale' ? '待更新分析' : status === 'failed' ? '分析失败' : status === 'running' ? '正在分析' : '待分析';
      return <li className="activity-row" key={entryKey(entry)}>
        <div className="activity-time"><time dateTime={occurredAt || undefined}>{occurredAt ? new Date(occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</time><small>{timeLabel}</small></div>
        <article className={`activity-card ${state.read ? 'is-read' : ''}`}>
          <div className="activity-card-top"><span>{repo ? 'GitHub · 仓库' : item!.skill ? 'GitHub · 独立 Skill' : item!.source}</span><span className="activity-status">{label}</span><button className={`icon-button ${state.favorite ? 'active' : ''}`} aria-label={`${state.favorite ? '取消收藏' : '收藏'} ${original}`} aria-pressed={state.favorite} disabled={busy} onClick={() => onPatch(entry, { favorite: !state.favorite })}><Bookmark size={14} fill={state.favorite ? 'currentColor' : 'none'} /></button></div>
          <h3><button onClick={() => onOpen(entry)}>{title}</button></h3><span className="original-title">{original}</span>
          <p className="activity-summary">{report?.overview || repo?.description || '已收录，尚无有效中文分析；查看原文了解具体内容。'}</p>
          <footer><span className="activity-module">{moduleNames[entry.module]}</span>{repo && <span>{repo.stars.toLocaleString()} 仓库 Star</span>}<div><button className="text-button" onClick={() => onOpen(entry)}>详情</button><a aria-label={`打开原文 ${original}`} href={state.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />原文</a><button className="icon-button" disabled={busy} aria-label={`${state.read ? '标为未读' : '标为已读'} ${original}`} onClick={() => onPatch(entry, { read: !state.read })}><Check size={14} /></button><button className="icon-button" disabled={busy} aria-label={`忽略 ${original}`} onClick={() => onPatch(entry, { ignored: true })}><EyeOff size={14} /></button></div></footer>
        </article>
      </li>;
    })}</ol>
  </section>)}</div>;
}

export default function ActivityFeed({ data, action, busy, onOpen }: { data: Dashboard; action: ContentAction; busy: boolean; onOpen: (id: number) => void }) {
  const [module, setModule] = useState<ModuleId | 'all'>('all');
  const [search, setSearch] = useState(''); const [query, setQuery] = useState('');
  const [page, setPage] = useState(1); const [reload, setReload] = useState(0);
  const [feed, setFeed] = useState<ActivityData | null>(null); const [error, setError] = useState('');
  const [contentId, setContentId] = useState<string | null>(null);
  const cache = useRef<{ key: string; etag: string; value: ActivityData } | null>(null);
  const revision = `${data.status.lastSuccessAt}:${data.analysisJob.finishedAt}:${data.content?.job.finishedAt}:${JSON.stringify(data.settings)}`;
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController(); let loading = false;
    const params = new URLSearchParams({ page: String(page), query }); if (module !== 'all') params.set('module', module);
    const key = params.toString();
    if (cache.current?.key !== key) setFeed(null);
    const load = async () => {
      if (loading || document.hidden || controller.signal.aborted) return;
      loading = true;
      try {
        const response = await fetch(`/api/activity?${key}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), headers: cache.current?.key === key ? { 'If-None-Match': cache.current.etag } : {} });
        if (response.status !== 304) {
          if (!response.ok) throw new Error(response.status === 404 ? '全部动态接口尚未加载，请重启本机服务后重试。' : '动态读取失败，请重试');
          const value = await response.json() as ActivityData;
          if (!controller.signal.aborted) { cache.current = { key, etag: response.headers.get('etag') || '', value }; setFeed(value); }
        } else if (!controller.signal.aborted && cache.current?.key === key) setFeed(cache.current.value);
        if (!controller.signal.aborted) setError('');
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '动态读取失败'); }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 15000); const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [page, module, query, reload, revision]);
  const patch = (entry: RadarEntry, changes: Record<string, boolean>) => void action(async () => { await api(entry.type === 'repo' ? `/repos/${entry.repo.id}` : `/content/${entry.item.id}`, changes, 'PATCH'); setReload(value => value + 1); });
  const open = (entry: RadarEntry) => entry.type === 'repo' ? onOpen(entry.repo.id) : setContentId(entry.item.id);
  return <section className="activity-page">
    <header className="radar-heading"><div><h1>全部动态</h1><p>四个方向的已收录内容，含待分析与观察项；不受精选名额限制。</p></div><button className="text-button" onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />刷新</button></header>
    <div className="activity-toolbar"><ModuleTabs selected={module} onChange={value => { setModule(value); setPage(1); }} /><label className="radar-search"><Search size={14} /><input aria-label="搜索全部动态" placeholder="搜索标题、摘要…" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /></label></div>
    <p className="activity-note">按标注时间倒序：仓库按本机收录，文章按原文发布，Skill 变更按本机观测。每条展示当前资料，并非全网新闻或完整变更日志。{feed && ` 共 ${feed.total} 条匹配。`}</p>
    {error && <p className="notice error" role="alert">{error}<button onClick={() => setReload(value => value + 1)}>重试</button></p>}
    {!feed && !error && <div className="empty" role="status"><LoaderCircle className="spin" />正在读取动态…</div>}
    {feed && (feed.entries.length ? <ActivityTimeline feed={feed} busy={busy} onOpen={open} onPatch={patch} /> : <div className="empty"><h2>暂无匹配动态</h2><p>可切换模块、清空搜索或等待下一次同步。</p></div>)}
    {feed && <div className="radar-pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => { setPage(page - 1); window.scrollTo({ top: 0 }); }}>上一页</button><span>第 {page} 页 / 共 {Math.max(1, Math.ceil(feed.total / feed.pageSize))} 页</span><button className="secondary-button" disabled={page * feed.pageSize >= feed.total} onClick={() => { setPage(page + 1); window.scrollTo({ top: 0 }); }}>下一页</button></div>}
    {contentId && <ContentDetail id={contentId} close={() => setContentId(null)} action={action} busy={busy || data.status.running || data.analysisJob.running || !!data.content?.job.running} canAnalyze={data.settings.model.enabled} revision={revision} />}
  </section>;
}
