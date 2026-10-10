import { contentTitle } from '../shared/titles.js';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Bookmark, CheckCheck, ExternalLink, EyeOff, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { contentNames, type ContentItem, type ContentKind, type ContentSnapshot, type ContentJob } from '../shared/content.js';
import type { Dashboard } from '../shared/types.js';
import { api } from './api.js';
import './content.css';
import { contentModule } from '../shared/radar.js';

export type ContentAction = (work: () => Promise<unknown>, success?: string) => Promise<void>;
export const coverageLabel = (item: ContentItem) => item.coverage === 'abstract' ? '仅摘要 · 未核实全文' : item.coverage === 'feed' ? '订阅摘要' : '公开正文摘录';
const verdicts = { recommend: '值得阅读', watch: '继续观察', skip: '不推荐' };
const statusLabel = (item: ContentItem) => item.analysisStatus === 'done' && item.report ? verdicts[item.report.verdict] : ({ pending: '待分析', stale: '资料或偏好已变，待重审', failed: '分析失败', done: '已分析' }[item.analysisStatus]);

export function ContentCard({ item, onOpen, onPatch, busy = false, snapshot = false }: { item: ContentItem; onOpen: () => void; onPatch?: (patch: Record<string, boolean>) => void; busy?: boolean; snapshot?: boolean }) {
  const report = item.analysisStatus === 'done' ? item.report : null;
  const highlight = item.kind === 'paper' ? report?.contribution[0] : report?.workflow[0];
  return <article className="content-card" data-kind={item.kind}>
    <div className="content-meta"><span className={`content-kind ${item.kind}`}>{item.skill ? "Skill" : contentNames[item.kind]}</span><span>{item.source}</span><span>{item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('zh-CN') : '发布时间未知'}</span><span className="content-verdict">{statusLabel(item)}</span></div>
    <h3><button onClick={onOpen}>{contentTitle(item)}</button></h3><span className="original-title">{item.title}</span>
    <p className="content-overview">{report?.overview || (item.analysisStatus === 'stale' ? '原分析已过期，重新审核后再展示亮点。' : '已收录原始资料，尚未通过模型审核；不会直接进入精选。')}</p>
    {highlight && <p className="content-highlight"><strong>{item.kind === 'paper' ? '贡献' : '做法'}</strong>{highlight.text}</p>}
    {report?.takeaway[0] && <p className="content-takeaway"><strong>启发</strong>{report.takeaway[0].text}</p>}
    <div className="content-card-footer"><small>{coverageLabel(item)}</small><button className="text-button" onClick={onOpen}>{snapshot ? '查看快照' : '阅读与证据'} →</button>{onPatch && <><button className={`icon-button ${item.favorite ? 'active' : ''}`} aria-label={`${item.favorite ? '取消收藏' : '收藏'} ${item.title}`} aria-pressed={item.favorite} disabled={busy} onClick={() => onPatch({ favorite: !item.favorite })}><Bookmark size={14} /></button><button className="icon-button" aria-label={`${item.read ? '标为未读' : '标为已读'} ${item.title}`} disabled={busy} onClick={() => onPatch({ read: !item.read })}><CheckCheck size={15} /></button><button className="icon-button" aria-label={`${item.ignored ? '恢复' : '不感兴趣'} ${item.title}`} disabled={busy} onClick={() => onPatch({ ignored: !item.ignored })}><EyeOff size={14} /></button></>}</div>
  </article>;
}

export function ContentDetail({ id, day, close, action, revision = '', canAnalyze = false, busy = false }: { id: string; day?: string; close: () => void; action?: ContentAction; revision?: string; canAnalyze?: boolean; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [item, setItem] = useState<ContentItem | null>(null);
  const [capturedAt, setCapturedAt] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void fetch(day ? `/api/history/${day}/content/${id}` : `/api/content/${id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }).then(async response => {
      if (!response.ok) throw new Error('内容详情读取失败');
      const result = await response.json() as ContentSnapshot;
      if (!controller.signal.aborted) { setItem(result.item); setCapturedAt(result.capturedAt || ''); }
    }).catch(() => { if (!controller.signal.aborted) setError('内容详情读取失败，请重试'); });
    return () => controller.abort();
  }, [id, day, revision, retry]);
  const sections = item?.skill ? [["problem", "解决什么任务"], ["tools", "适用工具 / 宿主"], ["workflow", "具体使用步骤"], ["takeaway", "提效亮点"], ["caveats", "权限、依赖与限制"]] as const : item && contentModule(item) === 'paimon' ? [['problem', '场景与问题'], ['contribution', '能力变化'], ['evidence', '原文依据'], ['takeaway', '落地启发'], ['caveats', '边界与限制']] as const : item?.kind === 'paper' ? [['problem', '研究问题'], ['contribution', '关键贡献'], ['evidence', '作者报告的依据'], ['takeaway', '应用启发'], ['caveats', '局限']] as const : [['problem', '实际任务'], ['tools', '使用工具'], ['workflow', '操作步骤与人机分工'], ['outcomes', '作者报告的结果'], ['takeaway', '可以借鉴什么'], ['caveats', '前提与踩坑']] as const;
  return <dialog ref={dialog} className="detail-modal content-detail" aria-label={day ? '历史内容快照' : '内容详情'} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-head"><span><BookOpen size={18} />{day ? `${day} · 入选快照` : '阅读与原文依据'}</span><button className="icon-button" aria-label="关闭内容详情" onClick={close}><X size={21} /></button></div>
    <div className="modal-body">{error ? <p role="alert">{error}<button className="text-button" onClick={() => setRetry(retry + 1)}>重试</button></p> : item ? <>
      <div className="content-meta"><span>{item.skill ? "Skill" : contentNames[item.kind]}</span><span>{item.source}</span><span>{coverageLabel(item)}</span></div><h2>{contentTitle(item)}</h2><span className="original-title">{item.title}</span>{item.skill && <p className="history-note">独立文件：{item.skill.path} · 仅阅读 SKILL.md，未安装或执行；未读取引用脚本。{item.skill.change === "baseline" ? "首次收录为存量基线，不代表近期发布。" : `本机于 ${new Date(item.skill.observedAt).toLocaleDateString("zh-CN")} 观测到${item.skill.change === "added" ? "新增文件" : "文件变化"}，不等于作者发布时间或已验证的能力提升。`}</p>}
      {item.authors.length > 0 && <p className="muted">{item.authors.join('、')}</p>}
      {item.kind === 'paper' && <p className="history-note">论文推荐表示值得阅读与了解，不代表实验已验证或可直接用于生产；置信度针对阅读价值与摘要解读。</p>}
      <p className="muted">{item.publishedAt ? `发表于 ${new Date(item.publishedAt).toLocaleDateString('zh-CN')}` : '原文发布时间未知'}{item.version && ` · ${item.version}`} {item.publication}</p>
      {day && <p className="history-note">保存于 {new Date(capturedAt).toLocaleString('zh-CN')}；以下为当时判断，不使用当前资料替换。</p>}
      <div className="content-detail-actions"><a className="secondary-button" href={item.url} target="_blank" rel="noreferrer">阅读原文 <ExternalLink size={14} /></a>{!day && action && <button className="secondary-button" disabled={!canAnalyze || busy || item.analysisStatus === 'done'} onClick={() => void action(() => api('/content/analyses', { id }), '已开始分析这篇内容')}>{item.analysisStatus === 'done' ? '已分析，使用缓存' : '分析这篇内容'}</button>}</div>
      {item.analysisStatus !== 'done' && <p className="history-note">{statusLabel(item)}。{item.error || '仅通过审核后进入精选，不凑数。'}</p>}
      {item.report && <div className={item.analysisStatus === 'done' ? '' : 'content-stale'}><p className="content-detail-overview">{item.report.overview}</p><p className="muted">{item.analysisStatus !== 'done' && '旧报告，仅供对照 · '}{verdicts[item.report.verdict]} · {item.report.model} · {new Date(item.report.analyzedAt).toLocaleString('zh-CN')}</p>
        {sections.map(([key, name]) => item.report![key].length > 0 && <section className="content-report-section" key={key}><h3>{name}</h3>{item.report![key].map((finding, index) => <div key={index}><p>{finding.text}</p><details><summary>原文依据</summary><blockquote>{finding.quote}</blockquote></details></div>)}</section>)}
        <section className="content-report-section"><h3>仍需核实</h3><ul>{item.report.unknowns.map((text, index) => <li key={index}>{text}</li>)}</ul></section>
      </div>}
      <details className="history-readme"><summary>本次实际读取的{item.coverage === 'abstract' ? '摘要' : '纯文本摘录'}（非完整论文/网页）</summary><pre className="readme">{item.text}</pre></details>
    </> : <div className="empty" role="status"><LoaderCircle className="spin" />正在读取…</div>}</div>
  </dialog>;
}

export function ContentStatus({ job }: { job?: ContentJob }) {
  if (!job) return null;
  return <div className="content-status" role="status">{job.running ? <span><LoaderCircle size={14} className="spin" />{job.mode === 'sync' ? '采集 / 审核' : '内容审核'} {job.completed}/{job.total} · {job.current || '准备中'}</span> : <span>{job.finishedAt ? `最近任务：${new Date(job.finishedAt).toLocaleString('zh-CN')} · 分析 ${job.generated} 篇` : '尚未采集；启用后定时采集，也可手动同步。'}</span>}{job.errors.length > 0 && <details><summary>{job.errors.length} 项未完成</summary>{job.errors.map((error, index) => <p key={index}>{error}</p>)}</details>}</div>;
}

export default function ContentBoard({ kind, data, action, busy, onSettings, library = false }: { kind?: ContentKind; data: Dashboard; action: ContentAction; busy: boolean; onSettings: () => void; library?: boolean }) {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [view, setView] = useState('candidates');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const job = data.content?.job;
  const revision = `${job?.completed}:${job?.finishedAt}:${job?.generated}:${data.content?.count}:${retry}`;
  const blocked = busy || !!job?.running || data.status.running || data.analysisJob.running;
  const enabled = Boolean(data.settings.content?.enabled && (!kind || data.settings.content[kind].enabled));
  useEffect(() => {
    const controller = new AbortController(); setError(''); setLoading(true);
    void fetch(`/api/content?${new URLSearchParams({ ...(kind ? { kind } : {}), view: library ? 'library' : view, page: String(page) })}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }).then(async response => {
      if (!response.ok) throw new Error('内容列表读取失败');
      const result = await response.json(); if (!controller.signal.aborted) { setItems(result.items); setTotal(result.total); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setError('内容列表读取失败，请重试'); setLoading(false); } });
    return () => controller.abort();
  }, [kind, library, view, page, revision]);
  const patch = (id: string, values: Record<string, boolean>) => void action(async () => { await api(`/content/${id}`, values, 'PATCH'); setRetry(value => value + 1); });
  const shown = items.filter(item => `${item.title} ${item.source} ${item.report?.overview || ''}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="content-board">
    <div className="section-heading"><BookOpen size={21} /><div><h2>{library ? '收藏的论文与实践' : kind === 'paper' ? '大模型论文' : 'AI 工具实践'}</h2><p>{library ? '独立保存的阅读清单。' : kind === 'paper' ? '从 arXiv 摘要发现研究问题、贡献与应用启发；不冒充全文精读。' : '看人们怎样把 AI 用进具体项目：任务、工具、步骤、检查和踩坑。'}</p></div></div>
    {!library && <><div className="content-toolbar"><button className="secondary-button" disabled={blocked || !enabled} onClick={() => void action(() => api('/content/sync', {}), '已启动论文与实践采集')}><RefreshCw size={14} />同步内容</button><button className="secondary-button" disabled={blocked || !enabled || !data.settings.model.enabled} onClick={() => void action(() => api('/content/analyses', {}), '已开始分批分析论文与实践')}>审核候选</button><button className="text-button" onClick={onSettings}>来源与阅读偏好 →</button><small>共同同步两类内容 · 自动审核后再入选</small></div>
      {!enabled && <p className="history-note">此类型尚未启用，前往偏好设置开启；已有资料保留。</p>}
      <ContentStatus job={job} />
      <details className="content-import"><summary><Plus size={14} />添加{kind === 'paper' ? 'arXiv 论文' : '公开实践文章'}链接</summary><form onSubmit={event => { event.preventDefault(); void action(async () => { await api('/content/import', { kind, url }); setUrl(''); }, '已开始读取链接，结果会自动刷新'); }}><input type="url" aria-label="内容原文链接" required value={url} placeholder={kind === 'paper' ? 'https://arxiv.org/abs/…' : 'https://…'} onChange={event => setUrl(event.target.value)} /><button className="secondary-button" disabled={blocked || !enabled}>收录</button></form><small>仅公开 HTTPS。论文不下载 PDF；网页不执行脚本，不绕过登录、付费或反爬限制。</small></details>
    </>}
    <div className="content-toolbar">{!library && <select aria-label="内容显示范围" value={view} onChange={event => { setView(event.target.value); setPage(1); }}><option value="candidates">阅读目标内候选</option><option value="all">所有已收录（含忽略 / 过期）</option></select>}<input aria-label="筛选本页内容" placeholder="筛选本页标题、介绍或来源…" value={search} onChange={event => setSearch(event.target.value)} /><small>共 {total} 篇 · 每页 24 篇</small></div>
    {error ? <p role="alert">{error}<button className="text-button" onClick={() => setRetry(retry + 1)}>重试</button></p> : loading && !items.length ? <div className="empty"><LoaderCircle className="spin" />正在读取…</div> : shown.length ? <div className="content-list">{shown.map(item => <ContentCard key={item.id} item={item} onOpen={() => setSelected(item.id)} busy={busy} onPatch={values => patch(item.id, values)} />)}</div> : <div className="empty"><BookOpen size={26} /><h3>{library ? '尚未收藏阅读内容' : '还没有匹配的内容'}</h3><p>{search ? '试试其他筛选词。' : '真实采集并审核后展示，不填充模拟文章。'}</p></div>}
    {total > 24 && <div className="content-pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {Math.ceil(total / 24)}</span><button className="secondary-button" disabled={page * 24 >= total} onClick={() => setPage(page + 1)}>下一页</button></div>}
    {selected && <ContentDetail id={selected} close={() => setSelected(null)} action={action} revision={revision} canAnalyze={enabled && data.settings.model.enabled} busy={blocked} />}
  </section>;
}
