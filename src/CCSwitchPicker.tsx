import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CCSwitchCatalog, CCSwitchModel, Settings } from '../shared/types.js';
import './cc-switch.css';

export default function CCSwitchPicker({ model, onChoose }: { model: Settings['model']; onChoose: (option: CCSwitchModel | null) => void }) {
  const [catalog, setCatalog] = useState<CCSwitchCatalog>({ models: [], message: '' });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetch('/api/cc-switch/models', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('读取失败，请刷新重试或手动配置。');
      const data = await response.json() as CCSwitchCatalog;
      if (!controller.signal.aborted) setCatalog(data);
    }).catch(() => {
      if (!controller.signal.aborted) setError('无法读取 CC Switch 配置，请刷新重试或手动配置。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const legacy = Boolean(model.ccSwitch && model.ccSwitch.mode !== 'direct');
  const selectedId = model.ccSwitch ? JSON.stringify([model.ccSwitch.appType || 'codex', model.ccSwitch.providerId, model.name, ...(legacy ? ['proxy'] : [])]) : '';
  const selected = catalog.models.find(option => option.id === selectedId);
  const stale = Boolean(model.ccSwitch && !legacy && (!selected?.selectable || selected.fingerprint !== model.ccSwitch.fingerprint || selected.endpoint !== model.endpoint));
  const appNames: Record<string, string> = { claude: 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex', gemini: 'Gemini', grokbuild: 'Grok Build', openclaw: 'OpenClaw', opencode: 'OpenCode' };
  return <div className="field wide cc-switch-picker">
    <label htmlFor="ccSwitchModel">CC Switch 模型（全部应用）</label>
    <div className="cc-switch-controls">
      <select id="ccSwitchModel" value={selectedId} onChange={event => {
        if (!event.target.value) onChoose(null);
        else {
          const option = catalog.models.find(item => item.id === event.target.value);
          if (option?.selectable) onChoose(option);
        }
      }}>
        <option value="">手动填写接口和模型</option>
        {selectedId && !selected && <option value={selectedId} disabled>{legacy ? `原有本机代理 · ${model.name}（继续保留）` : '已保存的 CC Switch 模型（请刷新或重新选择）'}</option>}
        {[...new Set(catalog.models.map(option => option.appType || '未知应用'))].map(appType => <optgroup key={appType} label={appNames[appType] || appType}>
          {catalog.models.filter(option => (option.appType || '未知应用') === appType).map(option => <option key={option.id} value={option.id} disabled={!option.selectable}>
            {option.providerName}{option.model ? ` · ${option.model}` : ''}{option.reason ? ` — ${option.reason}` : ''}
          </option>)}
        </optgroup>)}
      </select>
      <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label="刷新 CC Switch 模型列表"><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button>
    </div>
    <small role="status">{loading ? '正在读取本机 CC Switch 配置…' : error || catalog.message}</small>
    {model.ccSwitch && !loading && !error && stale && <small role="alert">{selected?.reason || '已保存的配置发生变化，请重新选择并保存。'}本次不会自动切换到其他模型。</small>}
    <small>选择后按该配置独立调用上游，无需在 CC Switch 切换当前模型。凭据仅由后端即时读取，不返回浏览器、不另存；不会修改 CC Switch。缺少模型或凭据的配置会显示原因。</small>
  </div>;
}
