import { Bell, Bookmark, CheckCheck, EyeOff, Minus, Star, TrendingDown, TrendingUp } from 'lucide-react';
import { channelNames, type Dashboard, type Repo } from '../shared/types.js';
import { growthDisplay } from './growth-display.js';
import { AnalysisBadge } from './AnalysisPanel.js';
import FocusStatus from './FocusStatus.js';
import { featuredDays, featuredTime } from './featured-layout.js';
import './featured.css';

function Growth({ repo }: { repo: Repo }) {
  const display = growthDisplay(repo);
  const Icon = display.direction === 'up' ? TrendingUp : display.direction === 'down' ? TrendingDown : Minus;
  return <span className={`featured-growth ${display.direction === 'up' ? 'rising' : display.direction === 'down' ? 'falling' : ''}`} title={display.description} aria-label={`${display.label}。${display.description}`} tabIndex={0}>
    {display.direction !== 'unknown' && <Icon size={12} />}{display.label}
  </span>;
}

export function FeaturedCard({ repo, data, busy, onOpen, onPatch }: { repo: Repo; data: Dashboard; busy: boolean; onOpen: () => void; onPatch: (patch: Record<string, unknown>) => void }) {
  const report = repo.analysis?.status === 'done' ? repo.analysis.report : null;
  const topic = data.settings.focus?.enabled ? data.settings.focus.topics.find(item => item.id === report?.focusReview?.topicId)?.name : null;
  const benefit = report?.focusReview?.benefit[0] || report?.capabilities[0];
  const why = report?.why[0] || report?.focusReview?.relationship[0];
  const highlight = benefit?.text || why?.text;
  const reason = why?.text !== highlight ? why?.text : undefined;
  const time = featuredTime(repo);
  return <li className="featured-timeline-item" data-focus={report?.focusReview?.topicId}>
    <div className="featured-time"><time dateTime={time.value || undefined} title={time.value ? `${new Date(time.value).toLocaleString('zh-CN')} · ${time.label}时间，不是项目发布时间` : '时间未知'}>{time.value ? new Date(time.value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}</time><small>{time.label}</small></div>
    <article className="repo-card featured-card" data-pool={repo.pool}>
      <div className="featured-card-top"><div className="featured-source"><span>GitHub</span><span className="featured-source-dot">·</span><span>{topic || channelNames[repo.channel]}</span>{repo.pool && <span className="featured-pool">{repo.pool === 'highStars' ? '高星' : '潜力'}</span>}</div><div className="featured-card-badges"><AnalysisBadge repo={repo} /><button className={`icon-button ${repo.favorite ? 'active' : ''}`} aria-label={`${repo.favorite ? '取消收藏' : '收藏'} ${repo.fullName}`} aria-pressed={repo.favorite} disabled={busy} onClick={() => onPatch({ favorite: !repo.favorite })}><Bookmark size={15} fill={repo.favorite ? 'currentColor' : 'none'} /></button></div></div>
      <h3 id={`featured-project-${repo.id}`} tabIndex={-1}><button className="repo-title" onClick={onOpen}>{repo.fullName}</button></h3>
      <p className="featured-overview">{report?.overview || repo.summary || repo.description || '仓库未提供描述，可打开项目查看公开资料。'}</p>
      {highlight && <p className="featured-highlight"><strong>亮点</strong>{highlight}</p>}
      <div className="featured-card-bottom"><div className="featured-reason">{report ? <><strong>{reason ? '推荐理由' : '判断依据'}</strong><span>{reason || (report.sources.length ? `基于 ${report.sources.length} 项公开资料评审，引用与试用方式可在详情查看。` : '报告未记录来源，需结合仓库原文核实。')}</span>{report.evidenceNote && <span className="featured-cache-note">基于缓存资料</span>}</> : <span>规则候选，尚未生成模型亮点，不代表质量已验证。</span>}</div>
        <div className="featured-card-footer"><div className="featured-metrics"><span title="最近采集的 GitHub Star 数"><Star size={12} />{repo.stars.toLocaleString()}</span>{repo.language && <span>{repo.language}</span>}<Growth repo={repo} /></div><div className="featured-actions"><button className="text-button" onClick={onOpen}>试用与证据 →</button><button className={`icon-button ${repo.followed ? 'active' : ''}`} aria-label={`${repo.followed ? '取消关注' : '关注'} ${repo.fullName}`} aria-pressed={repo.followed} disabled={busy} onClick={() => onPatch({ followed: !repo.followed })}><Bell size={14} /></button><button className="icon-button" aria-label={`标为已读 ${repo.fullName}`} disabled={busy} onClick={() => onPatch({ read: true })}><CheckCheck size={15} /></button><button className="icon-button" aria-label={`不感兴趣 ${repo.fullName}`} disabled={busy} onClick={() => onPatch({ ignored: true })}><EyeOff size={14} /></button></div></div>
      </div>
    </article>
  </li>;
}

export default function FeaturedFeed({ data, repos, onOpen, onPatch, onAnalyze, onSync, onSettings, onDiscover, onHistory, busy }: { data: Dashboard; repos: Repo[]; onOpen: (id: number) => void; onPatch: (id: number, patch: Record<string, unknown>) => void; onAnalyze: () => void; onSync: () => void; onSettings: () => void; onDiscover: () => void; onHistory: () => void; busy: boolean }) {
  const groups = featuredDays(repos);
  const jump = (id: number) => {
    const heading = document.getElementById(`featured-project-${id}`);
    heading?.scrollIntoView({ block: 'center' });
    heading?.focus({ preventScroll: true });
  };
  return <div className="featured-feed">
    {repos.length > 0 && <section className="featured-ranking" aria-label="当前精选速览"><div className="featured-ranking-head"><h3><span />当前精选</h3><small>推荐顺序 · 非热度排名</small><button className="text-button" onClick={() => jump(repos[0].id)}>查看全部 {repos.length} 个 ↓</button></div><ol>{repos.slice(0, 5).map((repo, index) => <li key={repo.id}><span className="featured-rank">{index + 1}</span><button className="featured-ranking-title" onClick={() => jump(repo.id)} title={repo.analysis?.report?.overview || repo.description}>{repo.fullName}<span>{repo.analysis?.status === 'done' ? repo.analysis.report?.overview : repo.description}</span></button><span className="featured-ranking-stars"><Star size={12} />{repo.stars.toLocaleString()}</span><Growth repo={repo} /></li>)}</ol></section>}
    {!data.settings.model.enabled && <div className="featured-model-notice"><span>{data.settings.focus?.enabled ? '模型尚未接入 · 专题精选等待审核' : '模型尚未接入 · 当前展示规则候选'}</span><button className="text-button" onClick={onSettings}>配置模型 →</button></div>}
    {groups.length ? groups.map(group => <section className="featured-day" key={group.day}><div className="featured-day-heading"><h2>{group.day === 'unknown' ? '时间未知' : new Date(`${group.day}T12:00:00`).toLocaleDateString('zh-CN', { ...(group.day.slice(0, 4) !== data.today.slice(0, 4) ? { year: 'numeric' } : {}), month: 'long', day: 'numeric' })}</h2><span>{group.day === 'unknown' ? '' : `${new Date(`${group.day}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'long' })} · `}{group.repos.length} 个 · 分析 / 采集日期</span><button className="text-button" onClick={onHistory}>往期日报 →</button></div><ol className="featured-timeline">{group.repos.map(repo => <FeaturedCard key={repo.id} repo={repo} data={data} busy={busy} onOpen={() => onOpen(repo.id)} onPatch={patch => onPatch(repo.id, patch)} />)}</ol></section>) : <div className="featured-empty"><h3>{data.analysisJob.running ? '正在审核，合格项目将自动出现' : '当前没有符合条件的精选'}</h3><p>{data.featuredIds.length ? '试试其他专题或搜索词，不用无关项目填满页面。' : '候选不足、已读或尚未通过审核都可能影响结果，不凑数。'}</p><button className="text-button" onClick={onDiscover}>查看候选 →</button></div>}
    <FocusStatus data={data} busy={busy} onAnalyze={onAnalyze} onSync={onSync} onSettings={onSettings} />
  </div>;
}
