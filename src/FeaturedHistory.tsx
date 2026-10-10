import { repoTitle, chineseDescription } from '../shared/titles.js';
import { ModuleTabs } from './RadarView.js';
import { contentModule, repoModule, type ModuleId } from '../shared/radar.js';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, ExternalLink, LoaderCircle, Star, X } from 'lucide-react';
import { channelNames, type FeaturedHistoryDay, type FeaturedHistoryEntry } from '../shared/types.js';
import AnalysisPanel, { AnalysisBadge } from './AnalysisPanel.js';
import { calendarDays, editionSections, editionPreview } from './history-layout.js';
import './history.css';
import type { ContentSnapshot } from '../shared/content.js';
import { contentNames } from '../shared/content.js';
import { ContentCard, ContentDetail } from './ContentViews.js';
import './tech-hotlist.css';

async function load<Type>(path: string, signal: AbortSignal): Promise<Type> {
  const response = await fetch(`/api/history${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if (!response.ok) throw new Error('历史记录读取失败，请重试');
  return response.json() as Promise<Type>;
}

function SnapshotDetail({ day, id, close }: { day: string; id: number; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [entry, setEntry] = useState<FeaturedHistoryEntry | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void load<FeaturedHistoryEntry>(`/${day}/repos/${id}`, controller.signal).then(setEntry).catch(() => {
      if (!controller.signal.aborted) setError('快照读取失败，请重试');
    });
    return () => controller.abort();
  }, [day, id, retry]);
  return <dialog ref={dialog} className="detail-modal" aria-label="历史精选快照" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-head"><span><CalendarDays size={18} />{day} · 入选快照</span><button className="icon-button" aria-label="关闭历史详情" onClick={close}><X size={21} /></button></div>
    <div className="modal-body">{error ? <div role="alert">{error}<button className="text-button" onClick={() => setRetry(retry + 1)}>重试</button></div> : entry ? <>
      <h2>{repoTitle(entry.repo)}</h2><span className="original-title">{entry.repo.fullName}</span><p className="history-note">保存于 {new Date(entry.capturedAt).toLocaleString('zh-CN')}，以下为当时的资料与判断，不代表最新状态。</p>
      <div className="detail-metrics"><span><Star size={16} />{entry.repo.stars.toLocaleString()} Stars</span><span>{entry.topic?.name || channelNames[entry.repo.channel]}</span></div>
      <p className="detail-description">{entry.repo.description}</p>
      <a className="secondary-button" href={entry.repo.url} target="_blank" rel="noreferrer">打开 GitHub <ExternalLink size={14} /></a>
      {entry.repo.analysis?.report ? <AnalysisPanel repo={entry.repo} enabled={false} running={false} readOnly onAnalyze={() => {}} onSettings={() => {}} /> : <p className="history-note">入选时仅有规则筛选结果，未生成模型分析。</p>}
      {entry.repo.readme && <details className="history-readme"><summary>当时的 README 摘录</summary><pre className="readme">{entry.repo.readme}</pre></details>}
    </> : <div className="empty" role="status"><LoaderCircle className="spin" />正在读取快照…</div>}</div>
  </dialog>;
}

function dateText(day: string, options: Intl.DateTimeFormatOptions) {
  return new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', options);
}

function EditionProject({ entry, number, lead, onOpen }: { entry: FeaturedHistoryEntry; number: number; lead: boolean; onOpen: () => void }) {
  const repo = entry.repo;
  const report = repo.analysis?.status === 'done' ? repo.analysis.report : null;
  const benefit = report?.focusReview?.benefit[0] || report?.capabilities[0] || report?.why[0];
  return <article className={`edition-project ${lead ? 'edition-lead' : ''}`}>
    <div className="edition-project-top"><span className="edition-number">{String(number).padStart(2, '0')}</span><span>{entry.topic?.name || channelNames[repo.channel]}</span>{lead && <span className="edition-lead-label">本期首条</span>}</div>
    <h3><button onClick={onOpen}>{repoTitle(repo)}</button></h3><span className="original-title">{repo.fullName}</span>
    <p className="edition-overview">{report?.overview || repo.summary || repo.description || '仓库未提供项目描述。'}</p>
    {benefit && <p className="edition-benefit"><strong>亮点</strong>{benefit.text}</p>}
    <div className="edition-project-footer"><span><Star size={13} />{repo.stars.toLocaleString()}</span>{repo.language && <span>{repo.language}</span>}<AnalysisBadge repo={repo} /><button className="text-button" onClick={onOpen}>查看快照 →</button></div>
  </article>;
}

export default function FeaturedHistory({ today, onToday, revision = '' }: { today: string; onToday: () => void; revision?: string }) {
  const [days, setDays] = useState<FeaturedHistoryDay[]>([]);
  const [day, setDay] = useState('');
  const [entries, setEntries] = useState<FeaturedHistoryEntry[]>([]);
  const [content, setContent] = useState<ContentSnapshot[]>([]);
  const [contentId, setContentId] = useState<string | null>(null);
  const [module, setModule] = useState<ModuleId | 'all'>('all');
  const [topic, setTopic] = useState('all');
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [entryError, setEntryError] = useState('');
  const [retry, setRetry] = useState(0);
  const paper = useRef<HTMLElement>(null);
  const chooseDay = (next: string) => {
    if (next === day) return;
    setDay(next); setEntries([]); setContent([]); setContentId(null); setLoading(true); setEntryError(''); setTopic('all'); setSelected(null);
  };
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError('');
    void load<{ days: FeaturedHistoryDay[] }>('', controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setDays(result.days);
      setDay(current => current || result.days[0]?.day || today);
    }).catch(() => { if (!controller.signal.aborted) { setCatalogError('日期列表读取失败，请重试'); setLoading(false); } });
    return () => controller.abort();
  }, [today, retry, revision]);
  useEffect(() => {
    if (!day) return;
    const controller = new AbortController();
    setLoading(true); setEntryError(''); setEntries([]); setContent([]); setContentId(null); setTopic('all'); setSelected(null);
    void load<{ entries: FeaturedHistoryEntry[]; content?: ContentSnapshot[] }>(`/${day}`, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setEntries(result.entries); setContent(result.content || []); setLoading(false);
    }).catch(() => { if (!controller.signal.aborted) { setEntryError('当天记录读取失败，请重试'); setLoading(false); } });
    return () => controller.abort();
  }, [day, retry, today, revision]);
  useEffect(() => {
    if (day && paper.current && window.scrollY > paper.current.offsetTop) {
      window.scrollTo({ top: paper.current.offsetTop, behavior: 'instant' });
    }
  }, [day]);
  const position = days.findIndex(item => item.day === day);
  const currentDay = day || today;
  const moduleEntries = entries.filter(entry => module === 'all' || repoModule(entry.repo) === module);
  const moduleContent = content.filter(entry => module === 'all' || contentModule(entry.item) === module);
  const sections = editionSections(moduleEntries);
  const contentKinds = (['paper', 'practice'] as const).filter(kind => moduleContent.some(entry => entry.item.kind === kind));
  const visibleSections = sections.filter(section => (kind === 'all' || kind === 'project') && (topic === 'all' || section.id === topic));
  const visibleContentKinds = contentKinds.filter(value => (kind === 'all' || kind === value) && (topic === 'all' || topic === value));
  const preview = editionPreview(moduleEntries, moduleContent);
  const openPreview = (item: typeof preview[number]) => { if (item.kind === 'project') setSelected(Number(item.id)); else setContentId(String(item.id)); };
  const months = [...new Set(days.map(item => item.day.slice(0, 7)))];
  const availableDays = new Set(days.map(item => item.day));
  const firstId = visibleSections[0]?.entries[0]?.repo.id;
  const reviewed = entries.filter(entry => entry.repo.analysis?.status === 'done' && entry.repo.analysis.report).length;
  const error = catalogError || entryError;
  const jumpToSection = (id: string) => {
    setTopic('all'); setKind('all');
    requestAnimationFrame(() => document.getElementById(`edition-${id}`)?.scrollIntoView({ block: 'start' }));
  };
  return <section className="featured-history edition-layout">
    <aside className="edition-archive" aria-label="往期日报">
      <div className="edition-archive-heading"><span><CalendarDays size={15} />日报</span><small>{days.length} 期存档</small></div>
      <nav className="edition-months" aria-label="按月浏览往期">
        {months.map(month => <details key={month} open className="edition-month"><summary>{dateText(`${month}-01`, { year: 'numeric', month: 'long' })}<span>{days.filter(item => item.day.startsWith(month)).length} 期</span></summary>
          {days.filter(item => item.day.startsWith(month)).map(item => <button key={item.day} className={`edition-date ${item.day === day ? 'selected' : ''}`} aria-label={`查看 ${item.day} 日报`} aria-current={item.day === day ? 'date' : undefined} onClick={() => chooseDay(item.day)}>
            <span className="edition-date-number"><b>{item.day.slice(-2)}</b><small>{dateText(item.day, { weekday: 'short' })}</small></span>
            <span className="edition-date-copy"><strong>{chineseDescription([item.leadTitle, item.leadSummary], '技术阅读精选')}</strong><span>{item.leadSummary || '查看当天入选内容与分析快照'}</span><small>{item.count} 条内容{item.day === today ? ' · 今天' : ''}</small></span>
          </button>)}
        </details>)}
        {!days.length && <p className="history-note">{catalogError ? '暂时无法读取往期目录' : loading ? '正在读取往期…' : '有内容入选后自动留档'}</p>}
      </nav>
      <div className="edition-archive-footer">本机存档 · 仅记录实际入选日期</div>
    </aside>
    <article className="edition-paper" ref={paper} aria-label="开源日报正文">
      <div className="edition-kicker"><span>{dateText(currentDay, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</span><button className="text-button" onClick={onToday}>返回今日精选 →</button></div>
      <header className="edition-masthead"><div><span className="edition-eyebrow">GITHUB RADAR / DAILY</span><h1><span>精品</span>日报</h1><p>Paimon · Skills · 大模型研究 · AI 工作流</p></div>
        <div className="edition-calendar"><div className="edition-calendar-date"><small>{currentDay === today ? '今日存档' : '往期存档'}</small><strong>{currentDay.slice(-2)}</strong><span>{dateText(currentDay, { year: 'numeric', month: 'long' })}</span></div><div className="edition-calendar-month"><span>{dateText(currentDay, { month: 'long' })}</span><div className="edition-calendar-grid" aria-label="归档日历">
          {['一', '二', '三', '四', '五', '六', '日'].map(weekday => <small key={weekday}>{weekday}</small>)}
          {calendarDays(currentDay).map((value, index) => value ? <button key={value} aria-label={`日历 ${value}`} aria-pressed={value === day} disabled={!availableDays.has(value)} title={availableDays.has(value) ? `${value} · 查看存档` : `${value} · 无存档`} onClick={() => chooseDay(value)}>{Number(value.slice(-2))}</button> : <span key={`blank-${index}`} />)}
        </div></div></div>
      </header>
      <div className="edition-stats"><div><span><b>{loading ? '—' : entries.length + content.length}</b> 条内容</span><span><b>{loading ? '—' : sections.length + contentKinds.length}</b> 个专题</span><span><b>{loading ? '—' : reviewed + content.filter(entry => entry.item.report).length}</b> 份分析</span></div><span>入选时快照 · 非实时榜单</span></div>
      <ModuleTabs selected={module} onChange={value => { setModule(value); setKind('all'); setTopic('all'); }} />
      {!loading && !error && kind === 'all' && topic === 'all' && content.length > 0 && <section className="edition-reading-preview" aria-label="三类阅读导读">{preview.map(item => <button key={item.id} onClick={() => openPreview(item)}><small>{item.kind === 'project' ? '开源项目' : item.kind === 'paper' ? '大模型论文' : 'AI 工具实践'}</small><strong>{item.title}</strong><p>{item.summary}</p></button>)}</section>}
      <div className="edition-controls">
        <label className="edition-date-picker"><CalendarDays size={14} /><select aria-label="精选日期" value={day} disabled={!days.length} onChange={event => chooseDay(event.target.value)}>
          {!days.length && <option value={day}>{today} · 暂无记录</option>}{days.map(item => <option key={item.day} value={item.day}>{item.day} · {item.count} 个</option>)}
        </select></label>
        <div className="history-navigation"><button className="icon-button" aria-label="更早一期" disabled={position < 0 || position >= days.length - 1} onClick={() => chooseDay(days[position + 1].day)}><ArrowLeft size={16} /></button><button className="icon-button" aria-label="更新一期" disabled={position <= 0} onClick={() => chooseDay(days[position - 1].day)}><ArrowRight size={16} /></button></div>

      </div>
      {error ? <div className="notice error" role="alert">{error}<button className="text-button" onClick={() => setRetry(retry + 1)}>重试</button></div> : loading ? <div className="empty" role="status"><LoaderCircle className="spin" />正在读取历史…</div> : !entries.length && !content.length ? <div className="empty"><CalendarDays size={28} /><h3>这一天还没有精选记录</h3><p>从启用历史记录起保存实际入选结果，不补造过去的榜单；服务未运行的日期不会生成记录。</p></div> : <div className="edition-body">
        <div className="edition-stories">{!visibleSections.length && !visibleContentKinds.length && <div className="edition-type-empty"><h3>本期没有{kind === 'paper' ? '大模型论文' : kind === 'practice' ? 'AI 工具实践' : '此类内容'}入选</h3><p>日报只保存当天实际进入精选的内容；待审核或观察中的资料不会补入，也不会用今天的结果改写往期。</p></div>}{visibleSections.map(section => <section key={section.id} id={`edition-${section.id}`} className="edition-section"><h2 className="edition-section-heading">{section.name}<span>{section.entries.length} 个项目</span></h2>{section.entries.map(entry => <EditionProject key={entry.repo.id} entry={entry} number={entries.indexOf(entry) + 1} lead={entry.repo.id === firstId} onOpen={() => setSelected(entry.repo.id)} />)}</section>)}{visibleContentKinds.map(kind => <section key={kind} id={`edition-${kind}`} className="edition-section edition-content-section"><h2 className="edition-section-heading">{contentNames[kind]}<span>{moduleContent.filter(entry => entry.item.kind === kind).length} 篇</span></h2><div className="content-list">{moduleContent.filter(entry => entry.item.kind === kind).map(entry => <ContentCard key={entry.item.id} item={entry.item} snapshot onOpen={() => setContentId(entry.item.id)} />)}</div></section>)}</div>
        <aside className="edition-index" aria-label="本期导读"><section><h2 className="edition-section-heading">本期看点</h2><ol>{preview.map((item, index) => <li key={item.id}><button onClick={() => openPreview(item)}><b>{index + 1}</b><span><strong>{item.title}</strong><small>{item.summary}</small></span></button></li>)}</ol></section>
          <section><h2 className="edition-section-heading">本期版面</h2><nav aria-label="本期专题目录">{sections.map((section, index) => <button key={section.id} onClick={() => jumpToSection(section.id)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{section.name}</strong><small>{section.entries.length} 个</small></button>)}{contentKinds.map((kind, index) => <button key={kind} onClick={() => jumpToSection(kind)}><span>{String(sections.length + index + 1).padStart(2, '0')}</span><strong>{contentNames[kind]}</strong><small>{moduleContent.filter(entry => entry.item.kind === kind).length} 篇</small></button>)}</nav></section>
          <p className="edition-order-note">编号为存档阅读顺序，不代表热度排名。</p>
        </aside>
      </div>}
      <details className="edition-archive-note"><summary>关于这份日报</summary><p>当天入选过的项目、论文和实践去重留档，保留首次入选快照；已读不删除。日内补位后，存档总数可能超过首页上限。不补造过去榜单，也不代表项目在当天创建。</p></details>
    </article>
    {contentId && <ContentDetail key={`${day}:${contentId}`} day={day} id={contentId} close={() => setContentId(null)} />}
    {selected !== null && <SnapshotDetail key={`${day}:${selected}`} day={day} id={selected} close={() => setSelected(null)} />}
  </section>;
}
