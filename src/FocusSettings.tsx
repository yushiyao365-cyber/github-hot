import type { FocusTopic, Settings } from '../shared/types.js';
import { suggestedFocus } from '../shared/focus.js';
import './focus.css';

export default function FocusSettings({ settings, onChange }: { settings: Settings; onChange: (value: Settings) => void }) {
  const focus = settings.focus ?? { enabled: false, topics: [] };
  const update = (id: string, patch: Partial<FocusTopic>) => onChange({ ...settings, focus: { ...focus, topics: focus.topics.map(topic => topic.id === id ? { ...topic, ...patch } : topic) } });
  return <section className="settings-section focus-settings">
    <div className="section-heading"><div><h2>模块发现目标</h2><p>先判断与你的工作是否直接相关，再看热度。这些目标用于发现与审核候选；首页数量由四模块配额决定。</p></div></div>
    {!settings.radar && <label className="checkbox"><input type="checkbox" checked={focus.enabled} onChange={event => onChange({ ...settings, focus: { ...focus, enabled: event.target.checked } })} />启用专题精选</label>}
    <p className="muted">目标与排除要求会随公开资料发送给所选模型，请勿填写个人秘密。改动保存后生效，旧报告需要按新目标重新审核。</p>
    {!settings.radar && <div className="focus-settings-actions"><button type="button" className="secondary-button" onClick={() => onChange({ ...settings, focus: structuredClone(suggestedFocus) })}>填入三个起始专题</button><button type="button" className="secondary-button" disabled={focus.topics.length >= 10} onClick={() => onChange({ ...settings, focus: { ...focus, topics: [...focus.topics, { id: `focus-${crypto.randomUUID()}`, name: '新专题', enabled: true, weight: 1, goal: '', terms: [], exclusions: [] }] } })}>新增专题</button></div>}
    {focus.topics.map(topic => <fieldset className="focus-editor" key={topic.id}><legend>{topic.name || '未命名专题'}</legend>
      {!settings.radar && <div className="focus-settings-actions"><label className="checkbox"><input type="checkbox" checked={topic.enabled} onChange={event => update(topic.id, { enabled: event.target.checked })} />启用 {topic.name}</label><button type="button" className="text-button" onClick={() => onChange({ ...settings, focus: { ...focus, topics: focus.topics.filter(item => item.id !== topic.id) } })}>移除此专题</button></div>}
      <div className="form-grid"><div className="field"><label htmlFor={`${topic.id}-name`}>专题名称</label><input id={`${topic.id}-name`} required maxLength={80} value={topic.name} onChange={event => update(topic.id, { name: event.target.value })} /></div><div className="field"><label htmlFor={`${topic.id}-weight`}>候选分析优先级</label><input id={`${topic.id}-weight`} type="number" min="1" max="100" required value={Number.isNaN(topic.weight) ? '' : topic.weight} onChange={event => update(topic.id, { weight: event.target.valueAsNumber })} /></div>
      <div className="field wide"><label htmlFor={`${topic.id}-goal`}>我具体想了解什么</label><textarea id={`${topic.id}-goal`} rows={4} required maxLength={1200} value={topic.goal} onChange={event => update(topic.id, { goal: event.target.value })} /></div>
      <div className="field"><label htmlFor={`${topic.id}-terms`}>检索条件（每行一个）</label><textarea id={`${topic.id}-terms`} rows={5} required value={topic.terms.join('\n')} onChange={event => update(topic.id, { terms: event.target.value.split('\n') })} /><small>例如 dataset + deduplication 表示同时包含两部分；每行是一个备选条件，不要只填 database 或 agent 等泛词。</small></div>
      <div className="field"><label htmlFor={`${topic.id}-exclusions`}>不要推荐什么（每行一项）</label><textarea id={`${topic.id}-exclusions`} rows={5} value={topic.exclusions.join('\n')} onChange={event => update(topic.id, { exclusions: event.target.value.split('\n') })} /><small>作为模型审核要求，不是简单地看到某个词就排除。</small></div></div>
    </fieldset>)}
  </section>;
}
