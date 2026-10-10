import { repoTitle, contentTitle } from '../shared/titles.js';
import { useState } from 'react';
import { Bookmark, Check, ExternalLink, EyeOff, Flame, Star } from 'lucide-react';
import { entryKey, type RadarBoard, type RadarEntry } from '../shared/radar.js';
import { growthRate } from '../shared/signals.js';
import { growthDisplay } from './growth-display.js';
import { Samples, Trend, type StarTrendEntry } from './StarTrend.js';
import { skillLabel } from '../shared/content.js';

const dateLabel = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN') : '日期未知';
const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

function RankingMetric({ entry, sort }: { entry: RadarEntry; sort: string }) {
  if (entry.type === 'content' && entry.item.skill) {
    const skill = entry.item.skill;
    return <div className="hot-metric article-metric"><strong>{sort === 'new' ? dateLabel(skill.observedAt) : sort === 'stars' ? skill.stars?.toLocaleString('zh-CN') ?? '—' : skill.starsPerDay == null ? '—' : signed(skill.starsPerDay)}</strong><span>{sort === 'new' ? '本机观测时间' : sort === 'stars' ? '来源仓库 Star' : '来源仓库日均增星'}</span><small>{sort === 'new' ? '非发布时间 / 能力提升结论' : '非此 Skill 的安装或使用量'}</small></div>;
  }
  if (entry.type === 'content') return <div className="hot-metric article-metric"><strong>{dateLabel(entry.item.publishedAt)}</strong><span>{entry.item.publishedAt ? '原文发布' : `收录于 ${dateLabel(entry.item.firstSeenAt)}`}</span><small>阅读量 / 引用量未采集</small></div>;
  const repo = entry.repo;
  if (sort === 'stars') return <div className="hot-metric"><strong>{repo.stars.toLocaleString('zh-CN')}</strong><span>仓库总 Star</span><small>{entry.module === 'skills' ? '不是 Skill 安装量' : '不代表已验证好用'}</small></div>;
  if (sort === 'new') return <div className="hot-metric article-metric"><strong>{dateLabel(repo.createdAt)}</strong><span>仓库创建时间</span><small>{repo.stars.toLocaleString('zh-CN')} 仓库 Star</small></div>;
  const rate = growthRate(repo);
  const display = growthDisplay(repo);
  if (rate === null || !repo.growth) return <div className="hot-metric unknown-metric" title={display.description}><strong>—</strong><span>{display.label}</span><small>不将未知增长记作零</small></div>;
  const days = ((Date.parse(repo.growth.to) - Date.parse(repo.growth.from)) / 86400000).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  return <div className="hot-metric" title={display.description}><strong>{signed(repo.growth.starsDelta)}</strong><span>{days} 天净增 Star</span><small>区间日均 {signed(rate)}</small></div>;
}

export default function RadarHotlist({ board, sort, busy, onOpen, onPatch }: { board: RadarBoard; sort: string; busy: boolean; onOpen: (entry: RadarEntry) => void; onPatch: (entry: RadarEntry, patch: Record<string, boolean>) => void }) {
  const [sampleEntry, setSampleEntry] = useState<StarTrendEntry | null>(null);
  const rule = (id: string) => id === 'skills'
    ? sort === 'stars' ? '存量与新兴优选 · 按来源仓库 Star；同仓库最多 2 条' : sort === 'new' ? '近期观测新增 / 文件变更 · 初次收录不算新发布；同仓库最多 2 条' : '按来源仓库实测日均增星 · 非单个 Skill 热度；同仓库最多 2 条'
    : id === 'papers' ? '按原文发布时间 · 近期优选，非引用量排行' : `项目按${sort === 'stars' ? '总 Star' : sort === 'new' ? '创建时间' : '实测日均增星'}，文章按发布时间 · 分别排序、交替展示`;
  return <div className="radar-hotlist">
    <p className="ranked-intro">各模块独立编号，不跨模块比较热度。点击曲线查看近 30 天的真实 Star 采样；没有样本就不画趋势。</p>
    {board.groups.map(group => <section key={group.id} className="ranked-module" aria-label={group.name}>
      <header className="ranked-module-heading"><div><h2><Flame size={16} />{group.name}</h2><p>{rule(group.id)}</p></div><span>{group.entries.length} / {group.limit} 条</span></header>
      {group.entries.length ? <ol className="ranked-list" data-count={Math.min(group.entries.length, 3)} aria-label={`${group.name}排名列表`}>{group.entries.map((entry, index) => {
        const repo = entry.type === 'repo' ? entry.repo : null;
        const item = entry.type === 'content' ? entry.item : null;
        const state = repo || item!;
        const title = repo?.fullName || item!.title;
        const overview = repo?.analysis?.report?.overview || item?.report?.overview || repo?.description || '';
        const sourceRepo = repo || (entry.type === 'content' ? entry.sourceRepo : null);
        const sample = sourceRepo ? { repo: sourceRepo, samples: entry.samples || [], growth: sourceRepo.growth } : null;
        const highlight = repo?.analysis?.report?.focusReview?.benefit[0]?.text || item?.report?.takeaway[0]?.text;
        return <li className={`hot-row ranked-row ${index < 3 ? 'ranked-leading' : ''} ${state.read ? 'is-read' : ''}`} key={entryKey(entry)}>
          <span className="hot-row-rank" aria-label={`第 ${index + 1} 名`}>{String(index + 1).padStart(2, '0')}</span>
          <div className="hot-row-copy"><button className="hot-title" onClick={() => onOpen(entry)}>{repo ? repoTitle(repo) : contentTitle(item!)}</button><span className="original-title">{title}</span><p title={overview}>{overview}</p>
            {index === 0 && highlight && <div className="ranked-highlight"><strong>值得关注</strong>{highlight}</div>}
            <div className="ranked-meta"><span>{repo ? group.id === 'skills' ? 'Skill 仓库' : 'GitHub 项目' : item?.skill ? `独立 Skill · ${skillLabel(item)}` : item!.source}</span>{repo && <span><Star size={11} />{repo.stars.toLocaleString('zh-CN')}</span>}<button className="text-button" title={highlight || '查看亮点与原文依据'} onClick={() => onOpen(entry)}>亮点与证据 →</button></div>
            {repo && group.id === 'skills' && !!repo.skillPaths?.length && <details className="ranked-skill-paths"><summary>Skill 文件入口</summary>{repo.skillPaths.slice(0, 8).map(path => <a key={path} href={`${repo.url}/blob/HEAD/${path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer">{path}<ExternalLink size={11} /></a>)}<small>只读抽样，不代表逐个验证；未安装或运行。</small></details>}
          </div>
          {sample ? <Trend entry={sample} onClick={() => setSampleEntry(sample)} /> : <span className="ranked-source-kind">{entry.module === 'papers' ? '论文 / 技术报告' : entry.module === 'paimon' ? '更新 / 落地资料' : item?.skill ? 'SKILL.md · 逐条审核' : '工作流文章'}</span>}
          <RankingMetric entry={entry} sort={sort} />
          <div className="ranked-actions"><button className={`icon-button ${state.favorite ? 'active' : ''}`} disabled={busy} aria-label={`${state.favorite ? '取消收藏' : '收藏'} ${title}`} aria-pressed={state.favorite} onClick={() => onPatch(entry, { favorite: !state.favorite })}><Bookmark size={16} fill={state.favorite ? 'currentColor' : 'none'} /></button><a className="icon-button" href={state.url} target="_blank" rel="noreferrer" aria-label={`打开原文 ${title}`} title="打开原文"><ExternalLink size={15} /></a><button className="icon-button" disabled={busy} aria-label={`${state.read ? '标为未读' : '标为已读'} ${title}`} onClick={() => onPatch(entry, { read: !state.read })}><Check size={15} /></button><button className="icon-button" disabled={busy} aria-label={`忽略 ${title}`} onClick={() => onPatch(entry, { ignored: true })}><EyeOff size={15} /></button></div>
        </li>;
      })}</ol> : <div className="ranked-empty"><p>{!group.enabled ? '此模块已暂停' : group.id === 'skills' && sort === 'growth' ? '暂无通过审核且有有效增星样本的 Skill' : '暂无符合条件的内容'}</p><small>审核、同步和采样完成后自动更新，数量不足不凑榜。</small></div>}
      <p className="ranked-footer">最多展示 {group.limit} 条 · 可在模块设置调整{group.id === 'skills' ? ' · 仓库 Star 不等于单个 Skill 的使用量' : ' · 编号是模块内阅读顺序，不是跨来源热度分数'}</p>
    </section>)}
    {sampleEntry && <Samples entry={sampleEntry} close={() => setSampleEntry(null)} />}
  </div>;
}
