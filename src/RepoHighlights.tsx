import type { Repo } from '../shared/types.js';
import { growthDisplay } from './growth-display.js';
import './precision.css';
import FocusReview from './FocusReview.js';

export function growthLabel(repo: Repo): string {
  return growthDisplay(repo).label;
}

export default function RepoHighlights({ repo, compact = false, onOpen }: { repo: Repo; compact?: boolean; onOpen?: () => void }) {
  const report = repo.analysis?.status === 'done' ? repo.analysis.report : null;
  if (!report) return <p className="card-highlight-pending">{repo.analysis?.status === 'waiting' ? '等待资料补齐 · 不生成无依据的亮点' : repo.analysis?.status === 'running' ? '正在自动提炼亮点…' : '规则候选 · 尚未完成亮点评审'}</p>;
  const highlights = report.capabilities.length ? report.capabilities : report.why;
  if (compact) {
    const highlight = report.focusReview?.benefit[0] || highlights[0];
    return <div className="compact-highlights">{highlight && <p><strong>亮点</strong>{highlight.text}</p>}<div>{report.evidenceNote && <span className="card-cache-note">基于缓存资料</span>}<button className="text-button" onClick={onOpen}>试用方式与证据 →</button></div></div>;
  }
  return <div className="card-highlights">
    <span className="card-highlight-label">AI 提炼亮点 · 有原文依据</span>
    {report.focusReview && <FocusReview report={report} />}
    {!report.focusReview && <ul>{highlights.slice(0, 2).map((finding, index) => <li key={index} title={finding.evidence.map(item => item.quote).join('\n')}>{finding.text}</li>)}</ul>}
    {!report.focusReview && report.useCases[0] && <p className="card-use-case"><strong>适合：</strong>{report.useCases[0].text}</p>}
    {report.evidenceNote && <p className="card-cache-note" title={report.evidenceNote}>基于缓存资料 · 最新变化待刷新</p>}
    <small>来源采集：{report.sources.map(source => source.fetchedAt).filter(Boolean).sort()[0]?.slice(0, 10) || '时间未知'}</small>
  </div>;
}
