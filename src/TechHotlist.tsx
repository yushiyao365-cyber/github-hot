import { useEffect, useState, type ComponentProps } from 'react';
import { BookOpen, Flame, RefreshCw } from 'lucide-react';
import type { Hotlist as ProjectHotlist } from '../shared/types.js';
import type { ContentHotlist, ContentKind } from '../shared/content.js';
import Hotlist from './Hotlist.js';
import { ContentCard, ContentDetail, type ContentAction } from './ContentViews.js';
import { api } from './api.js';
import './tech-hotlist.css';

const labels = { project: '开源项目', paper: '大模型论文', practice: 'AI 工具实践' };

export default function TechHotlist(props: ComponentProps<typeof Hotlist> & { action: ContentAction; onContent: (kind: ContentKind) => void }) {
  const [kind, setKind] = useState<'all' | 'project' | ContentKind>('all');
  const [articles, setArticles] = useState<ContentHotlist | null>(null);
  const [projects, setProjects] = useState<ProjectHotlist | null>(null);
  const [errors, setErrors] = useState({ articles: '', projects: '' });
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (kind === 'project') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let active = false;
    const etags = { articles: '', projects: '' };
    const load = async () => {
      if (active || controller.signal.aborted || document.hidden) return;
      active = true; setLoading(true);
      const read = async (type: 'articles' | 'projects', path: string) => {
        try {
          const response = await fetch(path, { headers: etags[type] ? { 'If-None-Match': etags[type] } : {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
          if (response.status !== 304) {
            if (!response.ok) throw new Error('读取失败');
            const result = await response.json();
            if (!controller.signal.aborted) { if (type === 'articles') setArticles(result); else setProjects(result); etags[type] = response.headers.get('etag') || ''; }
          }
          if (!controller.signal.aborted) setErrors(current => ({ ...current, [type]: '' }));
        } catch { if (!controller.signal.aborted) setErrors(current => ({ ...current, [type]: `${type === 'articles' ? '论文与实践' : '项目'}榜单读取失败；已有结果可能不是最新，请重试。` })); }
      };
      await Promise.all([read('articles', '/api/content/hotlist'), ...(kind === 'all' ? [read('projects', '/api/hotlist')] : [])]);
      active = false;
      if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void load(), 15000); }
    };
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void load(); } };
    void load(); document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [kind, reload, props.data]);
  const change = (value: typeof kind) => { setKind(value); setSelected(null); };
  const articleGroup = (type: ContentKind, compact = false) => {
    const group = articles?.groups[type];
    const entries = group?.entries || [];
    return <section className={`tech-hot-group ${compact ? 'compact' : ''}`} key={type} aria-label={`${labels[type]}榜单`}>
      <header><h2>{labels[type]}</h2><small>近期优选 · 非热度排行</small>{compact && <button className="text-button" onClick={() => change(type)}>查看全部 →</button>}</header>
      {entries.length ? compact ? <ol className="tech-hot-preview">{entries.slice(0, 3).map((item, index) => <li key={item.id}><span>{index + 1}</span><button onClick={() => setSelected(item.id)}><strong>{item.title}</strong><p>{item.report?.overview}</p><small>{item.source} · {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('zh-CN') : '发布日期未知 · 按收录时间'}</small></button></li>)}</ol> : <div className="content-list">{entries.map(item => <ContentCard key={item.id} item={item} busy={props.busy} onOpen={() => setSelected(item.id)} onPatch={patch => void props.action(async () => { await api(`/content/${item.id}`, patch, 'PATCH'); setReload(value => value + 1); })} />)}</div> : <div className="tech-hot-empty"><BookOpen size={20} /><p>{!articles ? errors.articles ? '榜单暂不可用' : '正在读取…' : !group?.enabled ? '尚未启用此类内容' : '暂无通过推荐审核的内容'}</p><small>观察、未分析或资料过期的内容不会凑数上榜。</small><button className="text-button" onClick={() => props.onContent(type)}>查看{labels[type]}候选 →</button></div>}
      {group && <footer>{group.eligible} 篇窗口内资料 · {group.reviewed} 篇已分析 · {group.qualified} 篇符合推荐要求{!compact && ` · 最多展示 ${articles!.limit} 篇`}</footer>}
    </section>;
  };
  return <div className="tech-hotlist">
    <header className="hotlist-header"><div><span className="hotlist-eyebrow"><Flame size={13} />项目 · 论文 · 实践</span><h1>技术热点榜</h1><p>项目看真实增长，论文看研究进展，实践看具体用法；三类分别排序，不混算热度。</p></div>{kind !== 'project' && <button className="text-button" disabled={loading} onClick={() => setReload(reload + 1)}><RefreshCw size={13} className={loading ? 'spin' : ''} />刷新榜单</button>}</header>
    <div className="reading-types tech-hot-types" role="group" aria-label="热点榜内容类型">{(['all', 'project', 'paper', 'practice'] as const).map(value => <button key={value} className={kind === value ? 'selected' : ''} aria-pressed={kind === value} onClick={() => change(value)}>{value === 'all' ? '全部' : labels[value]}</button>)}</div>
    {kind === 'project' ? <Hotlist {...props} /> : <>
      {(errors.articles || kind === 'all' && errors.projects) && <div className="notice error" role="alert">{errors.articles || errors.projects}<button className="text-button" onClick={() => setReload(reload + 1)}>重试</button></div>}
      <div className="tech-hot-note">论文和实践：仅采用有效、直接相关的推荐报告，按原文发布时间由新到旧（未知日期置后，按首次收录时间），各最多 10 篇。暂无引用量、阅读量或讨论增速数据，不称为全网热度榜。<button className="text-button" onClick={props.onSettings}>阅读偏好 →</button></div>
      {kind === 'all' ? <div className="tech-hot-overview"><section className="tech-hot-group compact" aria-label="开源项目榜单"><header><h2>开源项目</h2><small>按实测日均增星</small><button className="text-button" onClick={() => change('project')}>查看全部 →</button></header>{projects?.entries.length ? <ol className="tech-hot-preview">{projects.entries.slice(0, 3).map(entry => <li key={entry.repo.id}><span>{entry.rank}</span><button onClick={() => props.onOpen(entry.repo.id)}><strong>{entry.repo.fullName}</strong><p>{entry.overview}</p><small>区间日均 +{entry.starsPerDay.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} Star · 非今日新增</small></button></li>)}</ol> : <div className="tech-hot-empty"><p>{!projects ? errors.projects ? '榜单暂不可用' : '正在读取…' : '暂无符合条件的增长项目'}</p><button className="text-button" onClick={props.onDiscover}>查看项目候选 →</button></div>}{projects && <footer>{projects.growingCount} 个符合条件的增长项目 · 最多展示 10 个</footer>}</section>{articleGroup('paper', true)}{articleGroup('practice', true)}</div> : articleGroup(kind)}
      <p className="tech-hot-note">从全部已采集的合格资料中选择，不受首页名额限制；已读仍可上榜，忽略内容不上榜。榜单读取只访问本机缓存，不额外调用模型。</p>
    </>}
    {selected && <ContentDetail id={selected} close={() => setSelected(null)} action={props.action} canAnalyze={props.data.settings.model.enabled} busy={props.busy || props.data.analysisJob.running || props.data.status.running || !!props.data.content?.job.running} revision={articles?.generatedAt} />}
  </div>;
}
