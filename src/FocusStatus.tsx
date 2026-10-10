import type { Dashboard } from '../shared/types.js';
import GithubQuotaHint from './GithubQuotaHint.js';
import './focus.css';

export default function FocusStatus({ data, busy, onAnalyze, onSync, onSettings }: { data: Dashboard; busy: boolean; onAnalyze: () => void; onSync: () => void; onSettings: () => void }) {
  const job = data.analysisJob;
  const running = job.running || data.status.running;
  const errors = job.errors.length + data.status.errors.length;
  return <details className="focus-status"><summary><span className={`status-dot ${running ? 'working' : ''}`} />{job.running ? `自动审核中 ${job.completed}/${job.total}` : data.status.running ? '正在同步项目' : '后台采集与审核'}{errors > 0 && <span className="focus-status-warning">{errors} 项未完成</span>}<span className="focus-status-more">状态与操作</span></summary>
    <div className="focus-status-body"><p>模型：{data.settings.model.enabled ? data.settings.model.name : '未启用'} · 今日调用 {data.modelUsage} / {data.settings.model.dailyBudget || '不限'} · 精选上限 {data.settings.dailyLimit}</p><p>{job.message}</p>{data.status.phase && <p>{data.status.phase}</p>}
      {[...data.status.errors, ...job.errors].map((error, index) => <p className="focus-status-warning" key={index}>{error}</p>)}
      <div className="focus-settings-actions"><button className="secondary-button" disabled={busy || running} onClick={onSync}>同步数据</button><button className="secondary-button" disabled={busy || running || !data.settings.model.enabled} onClick={onAnalyze}>{data.settings.focus?.enabled ? '审核专题候选' : '分析双池候选'}</button><button className="text-button" onClick={onSettings}>设置模型与专题 →</button></div>
      <GithubQuotaHint data={data} />
    </div>
  </details>;
}
