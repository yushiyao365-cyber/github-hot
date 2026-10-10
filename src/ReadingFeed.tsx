import { useState } from 'react';
import type { ComponentProps } from 'react';
import FeaturedFeed, { FeaturedCard } from './FeaturedFeed.js';
import FocusStatus from './FocusStatus.js';
import { ContentCard, ContentDetail, ContentStatus, type ContentAction } from './ContentViews.js';
import { contentNames } from '../shared/content.js';
import { api } from './api.js';

export default function ReadingFeed(props: ComponentProps<typeof FeaturedFeed> & { action: ContentAction }) {
  const { data, repos, action, busy } = props;
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  if (!data.settings.content?.enabled) return <FeaturedFeed {...props} />;
  const articles = (data.content?.featured || []).filter(item => kind === 'all' || item.kind === kind);
  const projects = kind === 'all' || kind === 'project' ? repos : [];
  const rows = Array.from({ length: Math.max(projects.length, articles.length) }, (_, index) => [projects[index] ? { type: 'project' as const, repo: projects[index] } : null, articles[index] ? { type: 'content' as const, item: articles[index] } : null]).flat().filter(row => row !== null);
  const job = data.content?.job;
  const jump = (id: string) => { document.getElementById(id)?.scrollIntoView({ block: 'center' }); document.getElementById(id)?.focus({ preventScroll: true }); };
  return <div className="featured-feed reading-feed">
    <div className="reading-types" role="group" aria-label="精选内容类型">{[['all', '全部'], ['project', '项目'], ['paper', '论文'], ['practice', '实践']].map(([value, label]) => <button key={value} className={kind === value ? 'selected' : ''} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}<small>合计最多 {data.settings.dailyLimit} 条 · 不凑数 · 上方专题 / 搜索仅筛项目</small></div>
    {rows.length > 0 && <section className="featured-ranking" aria-label="当前精选速览"><div className="featured-ranking-head"><h3><span />当前精选</h3><small>阅读顺序 · 非热度排名</small><span>{rows.length} 条</span></div><ol>{rows.slice(0, 5).map((row, index) => <li key={row.type === 'project' ? row.repo.id : row.item.id}><span className="featured-rank">{index + 1}</span><button className="featured-ranking-title" onClick={() => jump(row.type === 'project' ? `featured-project-${row.repo.id}` : `reading-${row.item.id}`)}>{row.type === 'project' ? row.repo.fullName : row.item.title}<span>{row.type === 'project' ? row.repo.analysis?.report?.overview || row.repo.description : row.item.report?.overview}</span></button><small>{row.type === 'project' ? '项目' : contentNames[row.item.kind]}</small></li>)}</ol></section>}
    <section className="featured-day"><div className="featured-day-heading"><h2>本次精选</h2><span>符合当前阅读目标</span><button className="text-button" onClick={props.onHistory}>往期日报 →</button></div>{rows.length ? <ol className="featured-timeline">{rows.map(row => row.type === 'project' ? <FeaturedCard key={row.repo.id} repo={row.repo} data={data} busy={busy} onOpen={() => props.onOpen(row.repo.id)} onPatch={patch => props.onPatch(row.repo.id, patch)} /> : <li className="featured-timeline-item" key={row.item.id}><div className="featured-time"><small>{contentNames[row.item.kind]}</small></div><div id={`reading-${row.item.id}`} tabIndex={-1}><ContentCard item={row.item} busy={busy} onOpen={() => setSelected(row.item.id)} onPatch={patch => void action(() => api(`/content/${row.item.id}`, patch, 'PATCH'))} /></div></li>)}</ol> : <div className="featured-empty"><h3>当前没有通过审核的内容</h3><p>待采集、待分析或不符合目标的内容不会填进精选。</p><button className="text-button" onClick={props.onSettings}>调整阅读目标 →</button></div>}</section>
    <details className="reading-status"><summary>采集与审核状态</summary><ContentStatus job={job} /><FocusStatus data={data} busy={busy} onAnalyze={props.onAnalyze} onSync={props.onSync} onSettings={props.onSettings} /></details>
    {selected && <ContentDetail id={selected} action={action} close={() => setSelected(null)} canAnalyze={data.settings.model.enabled} busy={busy || !!job?.running || data.analysisJob.running || data.status.running} revision={`${job?.finishedAt}:${job?.generated}`} />}
  </div>;
}
