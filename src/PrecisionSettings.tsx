import type { Settings } from '../shared/types.js';

export default function PrecisionSettings({ settings, onChange }: { settings: Settings; onChange: (value: Settings) => void }) {
  const update = (key: 'newProjectDays' | 'growthMinStarsPerDay', value: number) => onChange({ ...settings, recommendations: { ...settings.recommendations, [key]: value } });
  return <section className="settings-section">
    <div className="section-heading"><div><h2>新技术与实测增长</h2><p>候选可以多，首页只保留有具体用途和原文依据的推荐，不用无关项目凑数。</p></div></div>
    <div className="form-grid">
      <div className="field"><label htmlFor="newProjectDays">新项目发现窗口（天）</label><input id="newProjectDays" type="number" min="1" max="365" required value={settings.recommendations.newProjectDays ?? 30} onChange={event => update('newProjectDays', event.target.valueAsNumber)} /><small>依据 GitHub 的创建时间，不把首次入库当作新建。</small></div>
      <div className="field"><label htmlFor="growthMinStarsPerDay">快速增长门槛（日均新增 Star）</label><input id="growthMinStarsPerDay" type="number" min="1" max="1000000" required value={settings.recommendations.growthMinStarsPerDay ?? 10} onChange={event => update('growthMinStarsPerDay', event.target.valueAsNumber)} /><small>至少两个相隔 24 小时的实测快照；日均值不是精确的过去 24 小时涨幅。</small></div>
    </div>
  </section>;
}
