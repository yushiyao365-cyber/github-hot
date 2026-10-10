import type { Analysis, Finding } from '../shared/types.js';
import './focus.css';

export default function FocusReview({ report }: { report: Analysis }) {
  const review = report.focusReview;
  if (!review) return null;
  const rows: { label: string; items: Finding[] }[] = [{ label: '与你的关系', items: review.relationship }, { label: '能减少什么工作', items: review.benefit }, { label: '如何试用 / 前提', items: review.trial }, { label: '本次关注理由', items: review.timeliness }];
  return <div className="focus-review"><span className="focus-topic-label">{review.topicName} · {review.relevance === 'direct' ? '直接相关' : review.relevance === 'adjacent' ? '仅沾边' : '不相关'}</span>
    {rows.map(row => row.items[0] && <p className="focus-review-row" key={row.label}><strong>{row.label}</strong>{row.items[0].text}</p>)}
    <details className="focus-evidence"><summary>查看专题判断的原文依据</summary>{rows.flatMap(row => row.items.slice(0, 1).map(finding => <div key={row.label}><strong>{row.label}</strong>{finding.evidence.map((reference, index) => <blockquote key={index}>{reference.quote}</blockquote>)}</div>))}</details>
    <small>依据公开资料评审 · 尚未实际运行或验证效果</small>
  </div>;
}
