import { repoTitle, contentTitle } from '../shared/titles.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bookmark, Check, ExternalLink, EyeOff, LoaderCircle, RefreshCw, Search, Settings2, Star } from 'lucide-react';
import { entryKey, moduleIds, moduleNames, type ModuleId, type RadarBoard, type RadarEntry } from '../shared/radar.js';
import type { Dashboard } from '../shared/types.js';
import { growthRate } from '../shared/signals.js';
import { skillLabel } from '../shared/content.js';
import { ContentDetail, type ContentAction } from './ContentViews.js';
import { api } from './api.js';
import './radar.css';
import RadarHotlist from './RadarHotlist.js';
import RadarDigest from './RadarDigest.js';
import './hotlist.css';
import './radar-hotlist.css';

export function ModuleTabs({ selected, onChange }: { selected: string; onChange: (module: ModuleId | 'all') => void }) {
  return <div className="module-tabs" role="group" aria-label="内容模块">{(['all', ...moduleIds] as const).map(id => <button key={id} className={selected === id ? 'selected' : ''} aria-pressed={selected === id} onClick={() => onChange(id)}>{id === 'all' ? '全部模块' : moduleNames[id]}</button>)}</div>;
}

export default function RadarView({ view, data, action, busy, onOpen, onSettings }: { view: 'home' | 'hotlist' | 'library'; data: Dashboard; action: ContentAction; busy: boolean; onOpen: (id: number) => void; onSettings: () => void }) {
  const [module, setModule] = useState<ModuleId | 'all'>('all');
  const [candidates, setCandidates] = useState(false);
  const [sort, setSort] = useState('growth');
  const [library, setLibrary] = useState('saved');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [board, setBoard] = useState<RadarBoard | null>(null);
  const [error, setError] = useState('');
  const [contentId, setContentId] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importModule, setImportModule] = useState<ModuleId>('workflows');
  const cache = useRef<{ key: string; etag: string; board: RadarBoard } | null>(null);
  const running = busy || data.status.running || data.analysisJob.running || !!data.content?.job.running;
  const taskErrors = [...data.status.errors, ...data.analysisJob.errors, ...(data.content?.job.errors || [])];
  const mode = view === 'home' && candidates ? 'candidates' : view;
  const revision = `${data.analysisJob.generated}:${data.analysisJob.finishedAt}:${data.status.lastSuccessAt}:${data.content?.job.generated}:${data.content?.job.finishedAt}:${JSON.stringify(data.settings)}`;
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setPage(1); }, [view, module, candidates, sort, library]);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ view: mode, sort, library, query, page: String(page) });
    if (module !== 'all') params.set('module', module);
    const key = params.toString();
    if (cache.current?.key !== key) setBoard(null);
    let active = false;
    const load = async () => {
      if (active || document.hidden || controller.signal.aborted) return;
      active = true;
      try {
        const response = await fetch(`/api/radar?${key}`, { signal: controller.signal, headers: cache.current?.key === key ? { 'If-None-Match': cache.current.etag } : {} });
        if (response.status !== 304) {
          if (!response.ok) throw new Error('模块内容读取失败，请重试');
          const next = await response.json() as RadarBoard;
          if (!controller.signal.aborted) { cache.current = { key, etag: response.headers.get('etag') || '', board: next }; setBoard(next); }
        } else if (cache.current?.key === key) setBoard(cache.current.board);
        if (!controller.signal.aborted) setError('');
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取失败'); }
      finally { active = false; }
    };
    void load(); const timer = setInterval(() => void load(), running ? 5000 : 15000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [mode, module, sort, library, query, page, reload, revision, running]);
  const patch = (entry: RadarEntry, changes: Record<string, boolean>) => void action(async () => { await api(entry.type === 'repo' ? `/repos/${entry.repo.id}` : `/content/${entry.item.id}`, changes, 'PATCH'); setReload(value => value + 1); });
  const analyze = (entry: RadarEntry) => void action(() => entry.type === 'repo' ? api('/analyses', { repoId: entry.repo.id }) : api('/content/analyses', { id: entry.item.id }), '分析已开始，完成后自动更新');
  const open = (entry: RadarEntry) => entry.type === 'repo' ? onOpen(entry.repo.id) : setContentId(entry.item.id);
  const card = (entry: RadarEntry, index: number) => {
    const repo = entry.type === 'repo' ? entry.repo : null;
    const item = entry.type === 'content' ? entry.item : null;
    const state = repo || item!;
    const report = repo?.analysis?.status === 'done' ? repo.analysis.report : item?.analysisStatus === 'done' ? item.report : null;
    const title = repo?.fullName || item!.title;
    const highlight = repo ? repo.analysis?.status === 'done' ? repo.analysis.report?.focusReview?.benefit[0]?.text || repo.analysis.report?.capabilities[0]?.text : '' : item?.analysisStatus === 'done' ? item.report?.takeaway[0]?.text : '';
    const rate = repo ? growthRate(repo) : null;
    const fresh = repo && Date.now() - Date.parse(repo.createdAt) <= (data.settings.recommendations.newProjectDays ?? 30) * 86400000;
    return <article className={`radar-story ${state.read ? 'is-read' : ''}`} key={entryKey(entry)}>
      <div className="radar-story-top"><span>{view === 'hotlist' ? `${String(index + 1).padStart(2, '0')} · ` : ''}{repo ? entry.module === 'skills' ? repo.skillPaths?.length ? `Skill 仓库 · 已发现 ${repo.skillPaths.length} 个文件（最多索引 1000）` : 'Skill 仓库候选 · 文件待核实' : 'GitHub 项目' : item?.skill ? `独立 Skill · ${skillLabel(item, data.settings.recommendations.newProjectDays ?? 30)}` : item!.source}</span><button className={`icon-button ${state.favorite ? 'active' : ''}`} aria-label={`${state.favorite ? '取消收藏' : '收藏'} ${title}`} disabled={busy} onClick={() => patch(entry, { favorite: !state.favorite })}><Bookmark size={16} fill={state.favorite ? 'currentColor' : 'none'} /></button></div>
      <h3><button onClick={() => open(entry)}>{repo ? repoTitle(repo) : contentTitle(item!)}</button></h3><span className="original-title">{title}</span>
      <p className="radar-overview">{report?.overview || repo?.description || '尚未完成分析；不会用标题猜测亮点。'}</p>
      {highlight && <p className="radar-highlight"><strong>{entry.module === 'papers' ? '阅读价值' : entry.module === 'paimon' ? '值得关注' : '可借鉴'}</strong>{highlight}</p>}
      <div className="radar-meta">{repo ? <><span><Star size={12} />{repo.stars.toLocaleString()} 仓库 Star</span>{rate !== null ? <span>区间日均 {rate > 0 ? '+' : ''}{rate.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}</span> : <span>增速暂无有效样本</span>}{fresh && <span>近 {data.settings.recommendations.newProjectDays ?? 30} 天新建</span>}</> : item?.skill ? <><span>{item.skill.repository}</span><span>{item.skill.stars?.toLocaleString() ?? "—"} 来源仓库 Star</span><span>独立审核 · 未安装或运行</span></> : <span>{item!.publishedAt ? new Date(item!.publishedAt).toLocaleDateString('zh-CN') : '发布日期未知'} · {item!.coverage === 'abstract' ? '摘要' : '正文摘录'}</span>}<span>{report ? report.verdict === 'recommend' ? '已分析 · 值得了解' : report.verdict === 'watch' ? '已分析 · 观察' : '已分析 · 不推荐' : '待分析 / 待更新'}</span></div>
      {!!repo?.skillPaths?.length && <details className="skill-paths"><summary>查看具体 Skill 入口</summary>{repo.skillPaths.slice(0, 8).map(path => <a key={path} href={`${repo.url}/blob/HEAD/${path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer">{path}<ExternalLink size={11} /></a>)}<small>仅阅读文件，未安装或执行。抽样分析不代表逐个验证。</small></details>}
      <div className="radar-actions"><button className="text-button" onClick={() => open(entry)}>查看分析</button><a href={state.url} target="_blank" rel="noreferrer">原文 <ExternalLink size={12} /></a>{!report && <button className="text-button" disabled={running || !data.settings.model.enabled} onClick={() => analyze(entry)}>分析这条</button>}<button className="icon-button" aria-label={`${state.read ? '标为未读' : '标为已读'} ${title}`} disabled={busy} onClick={() => patch(entry, { read: !state.read })}><Check size={15} /></button><button className="icon-button" aria-label={`${state.ignored ? '恢复' : '忽略'} ${title}`} disabled={busy} onClick={() => patch(entry, { ignored: !state.ignored })}><EyeOff size={15} /></button></div>
    </article>;
  };
  const importItem = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => {
      if (/^(?:https:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/?$/.test(importUrl.trim())) await api('/follows', { repository: importUrl.trim() });
      else if (importModule === 'skills') throw new Error('Skill 请填写 GitHub 仓库地址或 owner/repo');
      else await api('/content/import', { url: importUrl.trim(), kind: importModule === 'papers' ? 'paper' : 'practice', module: importModule });
      setImportUrl(''); setReload(value => value + 1);
    }, '已提交收录；资料读取和分析完成后自动显示');
  };
  return <section className="radar-view">
    <header className="radar-heading"><div><span className="eyebrow">PERSONAL TECH RADAR</span><h1>{view === 'home' ? '今日精选' : view === 'hotlist' ? '热点榜' : '我的清单'}</h1><p>{view === 'home' ? `四个方向，少而精。每日首页最多 ${data.settings.dailyLimit} 条，未通过分析的内容不凑数。` : view === 'hotlist' ? 'Skill 看仓库热度，其余模块看近期优选；不同指标不混算。' : '项目与文章统一收藏、关注和回看，个人状态仅保存在本机。'}</p></div><button className="secondary-button" onClick={onSettings}><Settings2 size={15} />模块设置</button></header>
    <ModuleTabs selected={module} onChange={setModule} />
    <div className="radar-toolbar">
      {view === 'home' && <div className="module-tabs sub-tabs"><button className={!candidates ? 'selected' : ''} onClick={() => setCandidates(false)}>精选</button><button className={candidates ? 'selected' : ''} onClick={() => setCandidates(true)}>发现候选</button></div>}
      {view === 'hotlist' && (module === 'all' || module === 'skills') && <label>Skill 排序 <select aria-label="Skill 排序" value={sort} onChange={event => setSort(event.target.value)}><option value="growth">增速榜 · 实测增长</option><option value="stars">高星榜 · 总 Star</option><option value="new">新兴榜 · 近期新增 / 变更</option></select></label>}
      {view === 'library' && <select aria-label="清单筛选" value={library} onChange={event => setLibrary(event.target.value)}><option value="saved">收藏与关注</option><option value="followed">关注项目</option><option value="read">已读</option><option value="ignored">已忽略</option></select>}
      <label className="radar-search"><Search size={14} /><input aria-label="搜索模块内容" placeholder="搜索标题、用途…" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /></label>
      <button className="text-button" onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />刷新</button>
    </div>
    {error && <div className="notice error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
    {!board && !error && <div className="empty"><LoaderCircle className="spin" />正在读取本机内容…</div>}
    {view === 'home' && !candidates && board && <RadarDigest board={board} onOpen={open} />}
    {view === 'hotlist' ? board && <RadarHotlist board={board} sort={sort} busy={busy} onOpen={open} onPatch={patch} /> : <div className={`radar-groups ${module === 'all' ? 'overview' : ''}`}>{board?.groups.map(group => <section className="radar-group" key={group.id} aria-label={group.name}><header><div><h2>{group.name}</h2><p>{group.description}</p></div><span>{group.entries.length} 条</span></header>{group.entries.length ? group.entries.map(card) : <div className="radar-empty"><p>{!group.enabled && view !== 'library' ? '此模块已暂停' : view === 'library' ? '这里还没有内容' : '暂无符合条件的内容'}</p><small>{view === 'home' && !candidates ? `已收录 ${group.candidates} 条相关资料。可查看发现候选；未分析、观察或过期内容不补位。` : '同步、分析或加入具体链接后，这里会自动更新。'}</small></div>}<footer>{view === 'library' || candidates ? `${group.total} 条匹配 · 每页 24 条` : `展示上限 ${group.limit} 条，可在模块设置调整`}</footer></section>)}</div>}
    {(view === 'library' || candidates) && board && <div className="radar-pagination"><button className="secondary-button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page} 页</span><button className="secondary-button" disabled={!board.groups.some(group => group.total > page * 24) && (board.unclassifiedTotal || 0) <= page * 24} onClick={() => setPage(page + 1)}>下一页</button></div>}
    {!!board?.unclassified?.length && <details className="radar-import"><summary>旧清单 · 尚未归入四个模块（保留原收藏）</summary>{board.unclassified.map(repo => <p key={repo.id}><button className="text-button" onClick={() => onOpen(repo.id)}>{repo.fullName}</button></p>)}</details>}
    {taskErrors.length > 0 && <details className="radar-import"><summary>最近任务提示 · {taskErrors.length} 条</summary>{taskErrors.slice(-6).map((message, index) => <p key={index}>{message}</p>)}<button className="text-button" onClick={onSettings}>检查来源、GitHub Token 与模型设置</button></details>}
    <details className="radar-import"><summary>收录链接与同步</summary><form onSubmit={importItem}><select aria-label="收录模块" value={importModule} onChange={event => setImportModule(event.target.value as ModuleId)}>{moduleIds.map(id => <option value={id} key={id}>{moduleNames[id]}</option>)}</select><input aria-label="收录链接" required type="text" placeholder="GitHub 仓库、文章、arXiv 或白皮书 URL" value={importUrl} onChange={event => setImportUrl(event.target.value)} /><button className="primary-button" disabled={running}>收录</button></form><p>GitHub 仓库加入关注；文章和报告异步读取后分析。PDF 最多 2 MB / 前 30 页文字，需本机 pdftotext；不会安装 Skill 或运行项目代码。</p><div className="radar-actions"><button className="secondary-button" disabled={running} onClick={() => void action(() => api('/sync', { mode: 'all' }), 'GitHub 同步已开始')}>同步 GitHub</button><button className="secondary-button" disabled={running} onClick={() => void action(() => api('/content/sync', {}), '论文与文章同步已开始')}>同步论文与文章</button><button className="secondary-button" disabled={running || !data.settings.model.enabled} onClick={() => void action(() => api('/analyses', {}), '项目候选分析已开始')}>分析项目候选</button><button className="secondary-button" disabled={running || !data.settings.model.enabled} onClick={() => void action(() => api('/content/analyses', {}), 'Skill 与文章候选分析已开始')}>分析 Skill / 文章候选</button></div></details>
    {running && <p className="radar-job" role="status"><LoaderCircle size={14} className="spin" />{data.analysisJob.running ? data.analysisJob.current : data.content?.job.running ? data.content.job.current : data.status.phase || '正在处理…'}</p>}
    {contentId && <ContentDetail id={contentId} close={() => setContentId(null)} action={action} canAnalyze={data.settings.model.enabled} busy={running} revision={revision} />}
  </section>;
}
