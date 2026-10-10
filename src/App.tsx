import { repoTitle } from '../shared/titles.js';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowDownUp, ArrowRight, ArrowUpRight, Bell, CalendarDays, BookOpen, Bookmark, Bot, Check, CheckCheck, ChevronDown, CircleHelp, Code2, Database, ExternalLink, EyeOff, Flame, Github, Layers3, LoaderCircle, Menu, Plus, Radar, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Star, Terminal, X, Zap } from 'lucide-react';
import { channelIds, channelNames, type ChannelId, type Dashboard, type Release, type Repo, type Settings } from '../shared/types.js';
import { api } from './api.js';
import AnalysisPanel, { AnalysisBadge } from './AnalysisPanel.js';
import RecommendationSettings from './RecommendationSettings.js';
import CCSwitchPicker from './CCSwitchPicker.js';
import RepoHighlights, { growthLabel } from './RepoHighlights.js';
import { growthDisplay } from './growth-display.js';
import GithubQuotaHint from './GithubQuotaHint.js';
import PrecisionSettings from './PrecisionSettings.js';
import ReadingFeed from './ReadingFeed.js';
import ContentBoard from './ContentViews.js';
import ContentSettings from './ContentSettings.js';
import TechHotlist from './TechHotlist.js';
import { featuredRepos } from './featured-layout.js';
import FeaturedHistory from './FeaturedHistory.js';
import FocusSettings from './FocusSettings.js';
import FocusTabs from './FocusTabs.js';
import SidebarFocus from './SidebarFocus.js';
import { createDashboardClient } from './dashboard-client.js';
import { growthRate, isNewProject } from '../shared/signals.js';
import RadarView from './RadarView.js';
import RadarSettings from './RadarSettings.js';

type Page = 'papers' | 'practices' | 'history' | 'hotlist' | 'home' | 'discover' | 'updates' | 'library' | 'settings';
type Action = (work: () => Promise<unknown>, success?: string) => Promise<void>;
const channelIcons = { ai: Sparkles, agent: Bot, devtools: Terminal, data: Database };
const pageNames: Record<Page, string> = { papers: '大模型论文', practices: 'AI 工具实践', hotlist: '热点榜', history: '精选历史', home: '今日精选', discover: '项目发现', updates: '版本动态', library: '我的清单', settings: '偏好设置' };
const compact = (value: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const dateLabel = (value: string) => value ? new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '未知';
const fullDate = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';

function Empty({ icon, title, description, children }: { icon?: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon || <Radar size={30} />}</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

function RepoCard({ repo, settings, onOpen, onPatch, initial = false }: { repo: Repo; settings: Settings; onOpen: () => void; onPatch: (patch: Record<string, unknown>) => void; initial?: boolean }) {
  const Icon = channelIcons[repo.channel];
  const [owner, name] = repo.fullName.split('/');
  const isNew = isNewProject(repo, settings);
  const topicName = settings.focus?.enabled ? settings.focus.topics.find(topic => topic.enabled && (repo.analysis?.status === 'done' ? topic.id === repo.analysis.report?.focusReview?.topicId : repo.focusIds?.includes(topic.id)))?.name : undefined;
  const compactCard = settings.focus?.enabled === true;
  return <article className={`repo-card ${compactCard ? 'compact-card' : ''} ${repo.read ? 'is-read' : ''}`}>
    <div className="card-top"><span className={`channel-badge ${repo.channel}`}><Icon size={13} />{topicName || channelNames[repo.channel]}</span><div className="card-top-right">{initial ? <span className="subtle-label">初始推荐</span> : isNew ? <span className="new-label">新项目</span> : null}<button className={`icon-button ${repo.favorite ? 'active' : ''}`} aria-label={repo.favorite ? `取消收藏 ${repo.fullName}` : `收藏 ${repo.fullName}`} aria-pressed={repo.favorite} onClick={() => onPatch({ favorite: !repo.favorite })}><Bookmark size={17} fill={repo.favorite ? 'currentColor' : 'none'} /></button></div></div>
    <button className="repo-title" onClick={onOpen}><span className="repo-avatar">{name.slice(0, 1).toUpperCase()}</span><span><span className="repo-owner">{owner} /</span><strong>{name}</strong></span><ArrowUpRight size={18} /></button>
    <p className="repo-description">{(repo.analysis?.status === 'done' ? repo.analysis.report?.overview : '') || repo.summary || repo.description || '项目尚未提供描述，可查看仓库原文了解详情。'}</p>
    <RepoHighlights repo={repo} compact={compactCard} onOpen={onOpen} />
    {!compactCard && repo.summary && <span className="ai-note"><Sparkles size={11} />AI 摘要 · 请结合原文判断</span>}
    {!compactCard && <div className="topics">{repo.topics.slice(0, 3).map(topic => <span key={topic}>{topic}</span>)}</div>}
    <div className="card-analysis"><AnalysisBadge repo={repo} />{(!compactCard || growthRate(repo) !== null) && <span className="growth-label" title={growthDisplay(repo).description} aria-label={growthDisplay(repo).description} tabIndex={0}>{growthLabel(repo)}</span>}</div>
    {!compactCard && <div className="card-reason"><span className="reason-dot" />{repo.reasons[0] || '匹配你的关注方向'}{repo.reasons[1] && <><span className="separator">·</span>{repo.reasons[1]}</>}</div>}
    <div className="card-footer"><div className="repo-metrics"><span><Star size={14} />{compact(repo.stars)}</span>{repo.language && <span><i className={`language-dot ${repo.language.toLowerCase()}`} />{repo.language}</span>}</div><span className="date-hint" title={`创建：${fullDate(repo.createdAt)}\n首次发现：${fullDate(repo.firstSeenAt)}`}>{dateLabel(repo.firstSeenAt)} 发现</span></div>
    <div className="card-actions"><button className={repo.followed ? 'selected' : ''} onClick={() => onPatch({ followed: !repo.followed })}>{repo.followed ? <Check size={13} /> : <Plus size={13} />}{repo.followed ? '已关注更新' : '关注更新'}</button><button onClick={() => onPatch({ read: !repo.read })}><CheckCheck size={13} />{repo.read ? '标为未读' : '已读'}</button><button title="不再推荐此项目；不会取消关注" onClick={() => onPatch({ ignored: !repo.ignored })}><EyeOff size={13} />{repo.ignored ? '恢复推荐' : '不感兴趣'}</button></div>
  </article>;
}

function ReleaseCard({ release, onPatch }: { release: Release; onPatch: (patch: Record<string, unknown>) => void }) {
  const [expanded, setExpanded] = useState(false);
  return <article className={`release-card ${release.read ? 'is-read' : ''}`}><div className="release-symbol"><Layers3 size={21} /></div><div className="release-content"><div className="release-heading"><span className="repo-owner">{release.fullName}</span><span>{dateLabel(release.publishedAt)}</span></div><h3><a href={release.url || `https://github.com/${release.fullName}/releases`} target="_blank" rel="noreferrer">{release.name}<ArrowUpRight size={16} /></a>{release.prerelease ? <span className="pre-badge">预发布</span> : <span className="stable-badge">Release</span>}{release.baseline && <span className="subtle-label">历史版本</span>}</h3><p className={expanded ? 'release-body expanded' : 'release-body'}>{release.summary || release.body || '该发布未提供说明，请查看 GitHub 原文。'}</p><div className="release-actions"><button onClick={() => setExpanded(!expanded)}>{expanded ? '收起内容' : '展开内容'}<ChevronDown size={13} /></button><span>来源：GitHub 发布记录</span><button onClick={() => onPatch({ read: !release.read })}><CheckCheck size={14} />{release.read ? '标为未读' : '标为已读'}</button><button onClick={() => onPatch({ hidden: true })}>隐藏</button></div></div></article>;
}

function SettingsPage({ data, action }: { data: Dashboard; action: Action }) {
  const [settings, setSettings] = useState<Settings>(() => structuredClone(data.settings));
  const [token, setToken] = useState('');
  const [key, setKey] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState(data.settings.model.enabled);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    await action(async () => {
      if (settings.model.enabled && !consent) throw new Error('请先确认模型的数据发送范围');
      await api('/settings', { settings, ...(token || clearToken ? { githubToken: clearToken ? '' : token } : {}), ...(key || clearKey ? { modelKey: clearKey ? '' : key } : {}) }, 'PUT');
      setToken(''); setKey(''); setClearToken(false); setClearKey(false);
    }, '设置已保存，首页精选数量立即生效');
    setSaving(false);
  }
  return <form className="settings-form" onSubmit={save}>
    <RadarSettings settings={settings} onChange={setSettings} />
    <section className="settings-section"><div className="section-heading"><SlidersHorizontal size={20} /><div><h2>你的阅读节奏</h2><p>少一点噪音，多一点真正想看的内容。</p></div></div><div className="setting-line"><div><label htmlFor="dailyLimit">每日精选上限</label><p>四个模块共用此总上限，按模块轮流分配；各模块还有独立上限，不足时不凑数。</p></div><input id="dailyLimit" type="number" min="1" step="1" required value={Number.isNaN(settings.dailyLimit) ? '' : settings.dailyLimit} onChange={event => setSettings({ ...settings, dailyLimit: event.target.valueAsNumber })} /></div><div className="field"><label htmlFor="exclude">排除关键词</label><input id="exclude" value={settings.excludeKeywords.join(', ')} placeholder="例如：awesome-list, interview" onChange={event => setSettings({ ...settings, excludeKeywords: event.target.value.split(/[,，]/) })} /><small>以逗号分隔，只影响项目发现，不会取消已有关注。</small></div></section>
    <FocusSettings settings={settings} onChange={setSettings} />
    <ContentSettings settings={settings} onChange={setSettings} />
    {settings.focus?.enabled && <p className="muted">专题模式按专题权重分配首页名额；以下高星与增长参数仅作为辅助信号，旧频道权重与双池占比不控制专题入选。</p>}
    <details className="settings-section"><summary>项目筛选的高级参数</summary><RecommendationSettings settings={settings} onChange={setSettings} /></details>
    <PrecisionSettings settings={settings} onChange={setSettings} />
    <GithubQuotaHint data={data} />
    <section className="settings-section"><div className="section-heading"><Layers3 size={20} /><div><h2>关注方向</h2><p>权重设为 0 可暂停该频道的自动发现；至少保留一个方向。</p></div></div><div className="channel-settings">{channelIds.map(channel => { const Icon = channelIcons[channel]; return <div className="channel-setting" key={channel}><div className="channel-setting-title"><span className={`channel-badge ${channel}`}><Icon size={15} />{channelNames[channel]}</span><label>权重 <input aria-label={`${channelNames[channel]}权重`} type="number" min="0" max="100" step="0.1" required value={settings.channels[channel].weight} onChange={event => setSettings({ ...settings, channels: { ...settings.channels, [channel]: { ...settings.channels[channel], weight: event.target.valueAsNumber } } })} /></label></div><label>关键词<input value={settings.channels[channel].keywords.join(', ')} onChange={event => setSettings({ ...settings, channels: { ...settings.channels, [channel]: { ...settings.channels[channel], keywords: event.target.value.split(/[,，]/) } } })} /></label><label>GitHub Topics<input value={settings.channels[channel].topics.join(', ')} onChange={event => setSettings({ ...settings, channels: { ...settings.channels, [channel]: { ...settings.channels[channel], topics: event.target.value.split(/[,，]/) } } })} /></label></div>; })}</div></section>
    <section className="settings-section"><div className="section-heading"><Github size={21} /><div><h2>GitHub 连接</h2><p>无需写权限，只读取公开仓库。不配置也可有限使用。</p></div><span className={data.hasGithubToken ? 'stable-badge' : 'subtle-label'}>{data.hasGithubToken ? '已配置 Token' : '有限模式'}</span></div><div className="field"><label htmlFor="githubToken">Personal access token</label><input id="githubToken" type="password" autoComplete="new-password" placeholder={data.hasGithubToken ? '已保存，留空保持不变' : '可选 · 输入你的 GitHub Token'} value={token} onChange={event => setToken(event.target.value)} /><small>凭据仅存放在本机权限受限文件，不会返回浏览器或发送给模型。</small></div>{data.hasGithubToken && <label className="checkbox"><input type="checkbox" checked={clearToken} onChange={event => setClearToken(event.target.checked)} />移除已保存的 GitHub Token</label>}</section>
    <section className="settings-section"><div className="section-heading"><Sparkles size={21} /><div><h2>分析模型与中文摘要</h2><p>项目分析使用结构化 JSON 输出。未接入模型时只展示规则候选，不声称已有 AI 精选。</p></div><label className="switch"><input aria-label="启用项目分析与摘要模型" type="checkbox" checked={settings.model.enabled} onChange={event => setSettings({ ...settings, model: { ...settings.model, enabled: event.target.checked } })} /><span /></label></div><div className="form-grid"><CCSwitchPicker model={settings.model} onChoose={option => { const { ccSwitch: _binding, ...manual } = settings.model; setConsent(false); setSettings({ ...settings, model: option ? { ...manual, endpoint: option.endpoint, name: option.model, ccSwitch: { providerId: option.providerId, fingerprint: option.fingerprint, appType: option.appType, mode: 'direct' } } : manual }); if (option) { setKey(''); setClearKey(true); } }} /><div className="field wide"><label htmlFor="endpoint">模型接口完整地址（自动识别协议）</label><input id="endpoint" type="url" required value={settings.model.endpoint} onChange={event => { setConsent(false); setSettings({ ...settings, model: { ...settings.model, endpoint: event.target.value, ccSwitch: undefined } }); }} /><small>支持本机代理和 HTTPS 云端接口；支持 Responses、Chat Completions、Anthropic Messages 和 Gemini generateContent；更换服务域名时，未重新填写的旧模型 Key 将被清除，避免发送给不同服务。</small></div><div className="field"><label htmlFor="modelName">模型名称</label><input id="modelName" required={settings.model.enabled} placeholder="服务中实际可用的模型名称" value={settings.model.name} onChange={event => setSettings({ ...settings, model: { ...settings.model, name: event.target.value, ccSwitch: undefined } })} /></div><div className="field"><label htmlFor="modelBudget">每日调用上限（0 表示不限制）</label><input id="modelBudget" type="number" min="0" max="500" step="1" required value={settings.model.dailyBudget} onChange={event => setSettings({ ...settings, model: { ...settings.model, dailyBudget: event.target.valueAsNumber } })} /></div><div className="field wide"><label htmlFor="modelKey">模型 API Key（选择 CC Switch 配置后无需填写）</label><input id="modelKey" type="password" disabled={Boolean(settings.model.ccSwitch)} autoComplete="new-password" placeholder={data.hasModelKey ? '已保存，留空保持不变' : '手动配置时填写；CC Switch 凭据由后端读取'} value={key} onChange={event => setKey(event.target.value)} /></div></div>{data.hasModelKey && <label className="checkbox"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />移除已保存的模型 Key</label>}<label className="checkbox consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我了解：生成分析或摘要时，公开项目描述、README、版本原文、论文摘要、实践正文摘录、阅读目标、所选技术关键词和实测 Star 快照将发送至上述接口；选择 CC Switch 配置时，仅向其配置的上游发送必要认证凭据；不会发送个人备注、GitHub Token 或其他本地文件。</label><p className="muted">今日已使用 {data.modelUsage} 次调用。{settings.model.dailyBudget === 0 ? '当前不限制每日调用次数，实际用量可能产生模型费用。' : `每日最多 ${settings.model.dailyBudget} 次，项目 / 论文 / 实践分析与摘要共享。`}有效缓存会复用，不重复调用模型。</p></section>
    <div className="settings-bottom"><span><ShieldCheck size={16} />所有偏好仅保存在本机</span><button className="primary-button" disabled={saving} type="submit">{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存设置</button></div>
  </form>;
}

function RepoModal({ id, action, close, patch, enabled, running, revision, onSettings }: { id: number; action: Action; close: () => void; patch: (id: number, value: Record<string, unknown>) => void; enabled: boolean; running: boolean; revision: string; onSettings: () => void }) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [notes, setNotes] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    api<{ repo: Repo }>(`/repos/${id}`).then(data => { setRepo(data.repo); setNotes(data.repo.notes); }).catch(() => close());
  }, [id]);
  useEffect(() => { if (revision) void api<{ repo: Repo }>(`/repos/${id}`).then(data => setRepo(data.repo)).catch(() => {}); }, [id, revision]);
  return <dialog ref={dialog} className="detail-modal" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="modal-head"><span><Github size={18} />项目详情</span><button className="icon-button" aria-label="关闭项目详情" onClick={close}><X size={21} /></button></div>{repo ? <div className="modal-body"><span className={`channel-badge ${repo.channel}`}>{channelNames[repo.channel]}</span><h2>{repoTitle(repo)}</h2><span className="original-title">{repo.fullName}</span><p className="detail-description">{repo.summary || repo.description || '该项目未提供描述'}</p><div className="detail-metrics"><span><Star size={16} />{repo.stars.toLocaleString()} Stars</span><span>{repo.language || '未标注语言'}</span><span>{repo.license || '未识别许可证'}</span></div><div className="detail-dates"><span>创建时间 <b>{fullDate(repo.createdAt)}</b></span><span>首次发现 <b>{fullDate(repo.firstSeenAt)}</b></span><span>最近采集 <b>{fullDate(repo.fetchedAt)}</b></span></div><div className="detail-buttons"><a className="primary-button" href={repo.url} target="_blank" rel="noreferrer">打开 GitHub <ExternalLink size={14} /></a><button className="secondary-button" onClick={() => { patch(id, { followed: !repo.followed }); setRepo({ ...repo, followed: !repo.followed }); }}>{repo.followed ? '取消关注更新' : '关注更新'}</button><button className="secondary-button" onClick={() => { patch(id, { read: !repo.read }); setRepo({ ...repo, read: !repo.read }); }}>{repo.read ? '标为未读' : '标为已读'}</button></div><AnalysisPanel repo={repo} enabled={enabled} running={running} onSettings={onSettings} onAnalyze={() => void action(() => api("/analyses", { repoId: id }), "项目分析已开始，完成后自动显示报告")} /><div className="detail-section"><h3>README 摘录 <span>纯文本 · 不执行代码或加载远程图片</span></h3>{repo.readme ? <pre className="readme">{repo.readme}</pre> : <div className="readme-empty"><BookOpen size={23} /><p>尚未缓存 README，可按需从 GitHub 获取。</p><button className="secondary-button" onClick={() => void action(async () => { await api(`/repos/${id}/readme`, {}); const result = await api<{ repo: Repo }>(`/repos/${id}`); setRepo(result.repo); }, 'README 已缓存')}>获取 README</button></div>}</div><div className="field"><label htmlFor="notes">我的备注 <span className="muted">仅本地保存，不发送给模型</span></label><textarea id="notes" rows={3} maxLength={10000} value={notes} placeholder="记下你想尝试的场景…" onChange={event => setNotes(event.target.value)} /><button className="secondary-button" onClick={() => patch(id, { notes })}>保存备注</button></div></div> : <div className="empty"><LoaderCircle className="spin" /></div>}</dialog>;
}

export default function App() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [page, setPage] = useState<'home' | 'hotlist' | 'history' | 'library' | 'settings'>('home');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalId, setModalId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const dashboardClient = useRef<ReturnType<typeof createDashboardClient> | null>(null);
  if (!dashboardClient.current) dashboardClient.current = createDashboardClient();
  const refresh = async (afterMutation = false) => { const value = await dashboardClient.current!.refresh(afterMutation); setData(value); setConnectionError(''); };
  useEffect(() => {
    let stopped = false; let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (polling || stopped) return;
      polling = true; clearTimeout(timer); let delay = 15000;
      try {
        if (!document.hidden) {
          const value = await dashboardClient.current!.refresh();
          if (!stopped) { setData(value); setConnectionError(''); }
          if (value?.analysisJob.running || value?.status.running || value?.content?.job.running) delay = 4000;
        }
      } catch (error) { if (!stopped) setConnectionError(error instanceof Error ? error.message : '暂时无法连接本地服务'); }
      polling = false; if (!stopped) timer = setTimeout(poll, delay);
    };
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    void poll(); document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 12000 : 5000); return () => clearTimeout(timer); }, [toast]);
  const action: Action = async (work, success) => {
    setBusy(true);
    try { await work(); await refresh(true); if (success) setToast({ text: success, error: false }); }
    catch (error) { setToast({ text: error instanceof Error ? error.message : '操作未完成', error: true }); }
    finally { setBusy(false); }
  };
  const navigate = (next: typeof page) => { setPage(next); setMenuOpen(false); window.scrollTo({ top: 0 }); };
  const patchRepo = (id: number, patch: Record<string, unknown>) => { void action(() => api(`/repos/${id}`, patch, 'PATCH'), patch.notes !== undefined ? '备注已保存' : undefined); };
  if (!data) return <div className="boot"><Radar size={45} /><h1>个人技术雷达</h1><p>{connectionError || '正在读取本机数据…'}</p>{connectionError ? <button className="primary-button" onClick={() => void refresh().catch(error => setConnectionError(error.message))}>重新连接</button> : <LoaderCircle className="spin" />}</div>;
  return <div className="app-shell">
    {menuOpen && <button className="sidebar-overlay" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}><button className="brand" onClick={() => navigate('home')}><span className="brand-icon"><Radar size={27} /></span><span>Tech Radar<small>个人技术雷达</small></span></button><span className="nav-label">WORKSPACE</span><nav aria-label="主导航">{([{ id: 'home', icon: Radar }, { id: 'hotlist', icon: Flame }, { id: 'history', icon: CalendarDays }, { id: 'library', icon: Bookmark }] as const).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{pageNames[item.id]}</span></button>)}</nav><div className="sidebar-bottom"><div className="local-card"><span><span className="online-dot" />LOCAL FIRST</span><p>关注四个方向。<br />让信息服务实际工作。</p><ShieldCheck size={35} /></div><div className="sidebar-footer"><span>本机运行 · 数据本地保存</span></div></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setMenuOpen(true)}><Menu size={21} /></button><span>我的工作台</span><span>/</span><strong>{pageNames[page]}</strong></div><div className="topbar-right"><span className="local-status"><span className="online-dot" />本地服务</span><button className="icon-button" aria-label="偏好设置" onClick={() => navigate('settings')}><Settings2 size={19} /></button></div></header>
    <main className={`main ${page === 'settings' ? 'settings-main' : page === 'history' ? 'history-main' : ''}`}>
      {connectionError && <div className="notice error" role="alert">{connectionError}</div>}
      {page === 'settings' ? <SettingsPage data={data} action={action} /> : page === 'history' ? <FeaturedHistory today={data.today} onToday={() => navigate('home')} revision={`${data.analysisJob.finishedAt}:${data.content?.job.finishedAt}:${data.featuredIds.join(',')}:${data.content?.featured.map(item => item.id).join(',')}`} /> : <RadarView key={page} view={page} data={data} action={action} busy={busy} onOpen={setModalId} onSettings={() => navigate('settings')} />}
      <footer className="page-footer"><span><ShieldCheck size={14} />本地存储 · 不运行仓库代码 · 不伪造热度</span></footer>
    </main></div>
    {toast && <div role={toast.error ? 'alert' : 'status'} className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <CircleHelp size={19} /> : <Check size={19} />}<span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {modalId !== null && <RepoModal key={modalId} id={modalId} action={action} close={() => setModalId(null)} patch={patchRepo} enabled={data.settings.model.enabled} running={busy || data.analysisJob.running || data.status.running || !!data.content?.job.running} revision={`${data.analysisJob.finishedAt}:${data.analysisJob.generated}`} onSettings={() => { setModalId(null); navigate('settings'); }} />}
  </div>;
}
