import type { ContentItem } from './content.js';
import type { FocusTopic, Repo, Settings } from './types.js';

export const moduleIds = ['paimon', 'skills', 'papers', 'workflows'] as const;
export type ModuleId = typeof moduleIds[number];
export const moduleNames: Record<ModuleId, string> = { paimon: 'Paimon 生态', skills: 'Skills', papers: '大模型论文 / 白皮书', workflows: 'AI 工作流实践' };
export const moduleDescriptions: Record<ModuleId, string> = {
  paimon: '能力迭代、直接集成与落地场景，不泛化为全部大数据项目。',
  skills: '可复用的 Agent Skills：看具体任务、使用前提和新兴亮点。热度来自仓库 Star，不是安装量。',
  papers: '大模型研究与技术报告：研究贡献、阅读启发与未验证的边界。',
  workflows: '研发、数据、短视频、文案、运营等工作的 AI 流程；文章与项目一起看。',
};
export interface RadarPreferences { version: 1; review?: { batchSize: number; intervalMinutes: number }; modules: Record<ModuleId, { enabled: boolean; featuredLimit: number; hotLimit: number }> }
export const defaultReview = { batchSize: 24, intervalMinutes: 30 };
export const defaultRadar: RadarPreferences = { version: 1, modules: {
  paimon: { enabled: true, featuredLimit: 3, hotLimit: 10 }, skills: { enabled: true, featuredLimit: 3, hotLimit: 10 },
  papers: { enabled: true, featuredLimit: 3, hotLimit: 10 }, workflows: { enabled: true, featuredLimit: 3, hotLimit: 10 },
} };
export const radarFocus: FocusTopic[] = [
  { id: 'paimon', name: 'Paimon 生态', enabled: true, weight: 1, terms: ['apache paimon', 'paimon + flink', 'paimon + cdc', 'paimon + integration'], goal: '跟踪 Apache Paimon 能力迭代、接入集成、查询、数据更新、运维性能与真实落地场景。Paimon 本体的新能力和正式发布值得关注，但不把发布说明当成升级建议。周边项目必须有直接使用或集成 Paimon 的证据。', exclusions: ['只在支持列表提及 Paimon', '同名游戏项目', '通用数据库汇总和面试资料'] },
  { id: 'skills', name: 'Agent Skills', enabled: true, weight: 1, terms: ['agent skills', 'SKILL.md', 'claude + skills', 'codex + skills'], goal: '寻找实际可复用的 Agent Skills，包括单个 skill 和有实质内容的 skill 包。核实 SKILL.md、具体能力、适用宿主、输入输出、权限和使用前提；说明能替代哪段工作。有多个 skill 的仓库按集合评价，不把仓库 Star 说成单个 skill 热度。不收仅列链接的 awesome 清单、课程、职业技能或只有 skills 标签的项目。新兴项目不要求高星，但需实质流程和使用证据。', exclusions: ['仅链接目录', '职业技能或游戏技能', '仅含 skills 标签，无可用内容'] },
  { id: 'workflows', name: 'AI 工作流实践', enabled: true, weight: 1, terms: ['AI + workflow', 'AI + video', 'AI + content creation', 'agent + automation', 'AI + data analysis', 'AI + production'], goal: '了解不同岗位如何应用 AI 完成工作，覆盖研发、数据、AI办公、短视频制作、文案、运营和设计。GitHub 实现或实践文章均可，重点提炼具体任务、输入、步骤、工具、人机分工、输出、权限成本和限制。有可复用工作流与明确亮点即可值得了解，不强求有规模化生产部署；明确区分作者实战、教程、模板和演示，不能把模板称为已验证生产成果。不收单纯模型发布、通用工具清单和仅提到 AI 的项目。', exclusions: ['纯新闻或工具目录', '没有任务和流程的套壳', '只有宣传没有操作依据'] },
];

export function repoModule(repo: Repo): ModuleId | null {
  const report = repo.analysis?.report;
  const topic = report?.focusReview?.topicId;
  const text = `${repo.fullName} ${repo.description} ${repo.topics.join(' ')} ${repo.readme}`;
  if (repo.fullName.toLowerCase() === 'apache/paimon' || topic === 'paimon' && report?.focusReview?.relevance === 'direct') return 'paimon';
  if (report?.focusReview?.relevance === 'direct' && topic === 'skills') return 'skills';
  if (report?.focusReview?.relevance === 'direct' && ['workflows', 'work-tools', 'training-data'].includes(topic || '')) return 'workflows';
  if (/\bpaimon\b/i.test(text) && !/genshin|原神/i.test(`${repo.fullName} ${repo.description}`)) return 'paimon';
  if (repo.skillPaths?.length || /\bSKILL\.md\b|\bagent[- ]skills?\b|\b(?:claude|codex)[- ]skills?\b/i.test(text)) return 'skills';
  if (/\b(?:AI|LLM|agent|Claude|GPT|Codex)\b|大模型|人工智能/i.test(text) && /workflow|automat|video|copywriting|coding|review|analysis|工作流|视频|文案|自动化|办公|分析/i.test(text)) return 'workflows';
  return null;
}
export function contentModule(item: ContentItem): ModuleId {
  if (item.module) return item.module;
  if (item.kind === 'paper') return 'papers';
  return /\bpaimon\b/i.test(`${item.title} ${item.text}`) ? 'paimon' : 'workflows';
}
export function modulePreferences(settings: Settings) { return settings.radar || defaultRadar; }
export type RadarEntry = { type: 'repo'; module: ModuleId; repo: Repo; samples?: import('./types.js').StarSample[] } | { type: 'content'; module: ModuleId; item: ContentItem; sourceRepo?: Repo; samples?: import('./types.js').StarSample[] };
export interface RadarBoard {
  generatedAt: string; view: 'home' | 'hotlist' | 'library' | 'candidates'; total: number; unclassified?: Repo[]; unclassifiedTotal?: number;
  groups: { id: ModuleId; name: string; description: string; enabled: boolean; candidates: number; qualified: number; limit: number; entries: RadarEntry[]; total: number }[];
}

export function entryKey(entry: RadarEntry) { return entry.type === 'repo' ? `repo:${entry.repo.id}` : `content:${entry.item.id}`; }
