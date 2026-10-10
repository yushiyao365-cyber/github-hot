import { ArrowUpRight, CircleHelp, FileText, LoaderCircle, Sparkles } from 'lucide-react';
import type { Analysis, Finding, Repo } from '../shared/types.js';
import FocusReview from './FocusReview.js';

const verdictNames = { recommend: '值得关注', watch: '继续观察', skip: '暂不推荐' };
const confidenceNames = { low: '低', medium: '中', high: '高' };

export function AnalysisBadge({ repo }: { repo: Repo }) {
  const analysis = repo.analysis;
  if (!analysis || analysis.status === 'pending') return <span className="analysis-badge pending">规则候选 · 待分析</span>;
  if (analysis.status === 'running') return <span className="analysis-badge pending"><LoaderCircle size={11} className="spin" />正在分析</span>;
  if (analysis.status === 'waiting') return <span className="analysis-badge pending">等待 GitHub 资料 · 可用缓存优先</span>;
  if (analysis.status === 'stale') return <span className="analysis-badge stale">资料或设置已变 · 待重分析</span>;
  if (analysis.status === 'failed') return <span className="analysis-badge failed">分析失败 · 可重试</span>;
  return <span className={`analysis-badge ${analysis.report?.verdict}`}><Sparkles size={11} />AI 判断 · {analysis.report ? verdictNames[analysis.report.verdict] : '未知'}</span>;
}

function FindingList({ title, findings, report }: { title: string; findings: Finding[]; report: Analysis }) {
  return <section className="finding-section"><h4>{title}</h4>{findings.length ? findings.map((finding, index) => <div key={index} className="finding"><p>{finding.text}</p><details><summary>查看原文依据 · {finding.evidence.length} 处</summary>{finding.evidence.map((reference, citationIndex) => {
    const source = report.sources.find(item => item.id === reference.sourceId);
    return <div key={citationIndex} className="evidence-quote"><a href={source?.url} target="_blank" rel="noreferrer">{source?.title || reference.sourceId}<ArrowUpRight size={12} /></a><blockquote>{reference.quote}</blockquote></div>;
  })}</details></div>) : <p className="muted">现有资料不足，尚无有依据的结论。</p>}</section>;
}

export default function AnalysisPanel({ repo, enabled, running, onAnalyze, onSettings, readOnly = false }: { repo: Repo; enabled: boolean; running: boolean; onAnalyze: () => void; onSettings: () => void; readOnly?: boolean }) {
  const state = repo.analysis;
  const report = state?.report;
  return <section className="analysis-panel"><div className="section-title"><h3><Sparkles size={18} />项目分析</h3><AnalysisBadge repo={repo} /></div>
    {state?.error && <p className="analysis-warning">{state.error}</p>}
    {report?.focusReview && <FocusReview report={report} />}
    {state?.status === 'stale' && <p className="analysis-warning">以下是历史报告：输入资料或模型配置已经变化，不参与当前 AI 推荐排序。</p>}
    {!enabled && !readOnly && <div className="model-disabled"><CircleHelp size={17} /><span>分析模型尚未启用。规则候选不等于 AI 精选，也不代表技术质量已获认可。</span><button className="text-button" onClick={onSettings}>配置模型 →</button></div>}
    {report ? <><div className="analysis-meta"><span>模型：{report.model}</span><span>来源：{report.provider}</span><span>{new Date(report.analyzedAt).toLocaleString('zh-CN')}</span><span>置信度：{confidenceNames[report.confidence]}（模型自评）</span></div><p className="analysis-overview">{report.overview}</p>{report.evidenceNote && <p className="card-cache-note">{report.evidenceNote}</p>}<div className="findings-grid"><FindingList title="为什么值得看 / 结论依据" findings={report.why} report={report} /><FindingList title="能力与技术特点" findings={report.capabilities} report={report} /><FindingList title="适用场景" findings={report.useCases} report={report} /><FindingList title="风险与限制" findings={report.risks} report={report} /></div><section className="finding-section unknowns"><h4>尚未验证与不确定性</h4><ul>{report.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></section><details className="analysis-sources"><summary><FileText size={14} />本次使用的资料 · {report.sources.length} 项</summary>{report.sources.map(source => <div key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}<ArrowUpRight size={13} /></a><small>采集：{new Date(source.fetchedAt).toLocaleString('zh-CN')}</small><pre>{source.text}</pre></div>)}</details><p className="analysis-disclaimer">以上是模型基于公开资料作出的判断，不是代码审计、性能验证或未来热度保证。系统校验引用存在，但不能保证模型推论正确。</p></> : <p className="analysis-placeholder">分析将读取公开的仓库信息、README、近期版本说明与已有 Star 快照，输出判断及可追溯的原文证据。不会执行仓库代码。</p>}
    {enabled && repo.pool && !readOnly && <button className="secondary-button" disabled={running} onClick={onAnalyze}>{running ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{running ? '正在处理分析任务' : report ? '重新检查并分析' : '分析这个项目'}</button>}
  </section>;
}
