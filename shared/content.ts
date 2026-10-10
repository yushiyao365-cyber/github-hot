export type ContentKind = 'paper' | 'practice';
export const contentNames = { paper: '论文', practice: '实践' };
export interface ContentPreferences {
  enabled: boolean;
  autoSync: boolean;
  autoAnalyze: boolean;
  batchSize: number;
  windowDays: number;
  paper: { enabled: boolean; limit: number; goal: string; terms: string[] };
  practice: { enabled: boolean; limit: number; goal: string; terms: string[]; feeds: { name: string; url: string; enabled: boolean }[] };
}
export const defaultContent: ContentPreferences = {
  enabled: false, autoSync: true, autoAnalyze: true, batchSize: 6, windowDays: 30,
  paper: { enabled: true, limit: 3, goal: '关注大模型推理、多模态、长上下文、训练与后训练、Agent 工具调用/记忆/评测、RAG、可靠性和推理效率。解释研究问题、贡献、实验依据、局限与应用启发。不因会议名气或引用数忽略新研究。', terms: ['large language model', 'language models', 'reasoning', 'agent', 'retrieval augmented', 'multimodal', 'post-training'] },
  practice: { enabled: true, limit: 3, goal: '了解不同项目和岗位里，人们具体如何使用 AI 工具：任务、工具、步骤、人机分工、结果检查、提示词/配置/代码、效果和踩坑。跨领域但必须有具体过程，不收纯新闻、发布公告、泛宣传和只有结果截图的文章。作者声称的收益不能当成独立验证。', terms: ['AI', 'agent', 'LLM', 'Claude', 'Codex', 'Copilot', 'ChatGPT', 'prompt', '大模型', '人工智能'], feeds: [{ name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', enabled: true }, { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', enabled: true }] },
};
export interface ContentFinding { text: string; quote: string }
export interface ContentReport {
  titleZh?: string;
  key: string; model: string; analyzedAt: string;
  verdict: 'recommend' | 'watch' | 'skip'; confidence: 'low' | 'medium' | 'high';
  overview: string; relevance: 'direct' | 'adjacent' | 'unrelated';
  problem: ContentFinding[]; contribution: ContentFinding[]; evidence: ContentFinding[];
  workflow: ContentFinding[]; tools: ContentFinding[]; outcomes: ContentFinding[]; caveats: ContentFinding[];
  takeaway: ContentFinding[]; unknowns: string[];
}
export interface ContentItem {
  skill?: { repoId: number; repository: string; path: string; sha: string; active: boolean; firstObservedAt: string; change: 'baseline' | 'added' | 'changed'; observedAt: string; stars?: number; starsPerDay?: number | null };
  module?: import('./radar.js').ModuleId;
  id: string; kind: ContentKind; url: string; title: string; authors: string[];
  source: string; publishedAt: string | null; updatedAt: string | null; fetchedAt: string; firstSeenAt: string;
  text: string; coverage: 'abstract' | 'feed' | 'excerpt'; version: string; publication: string; feedFingerprint?: string;
  favorite: boolean; read: boolean; ignored: boolean;
  report: ContentReport | null; analysisStatus: 'pending' | 'done' | 'stale' | 'failed'; error: string;
}
export interface ContentJob { running: boolean; mode: string; current: string; completed: number; total: number; generated: number; errors: string[]; startedAt: string | null; finishedAt: string | null }
export const emptyContentJob: ContentJob = { running: false, mode: '', current: '', completed: 0, total: 0, generated: 0, errors: [], startedAt: null, finishedAt: null };
export interface ContentSnapshot { capturedAt: string; item: ContentItem }
export function skillLabel(item: ContentItem, days = 30, now = Date.now()) {
  const skill = item.skill;
  if (!skill) return '';
  if (!skill.active) return '文件不可用';
  const age = now - Date.parse(skill.observedAt);
  if (skill.change === 'baseline' || age < 0 || age > days * 86400000) return '存量 Skill';
  return skill.change === 'added' ? '近期观测新增' : '近期文件变更';
}
export interface ContentDashboard { featured: ContentItem[]; job: ContentJob; count: number }
export interface ContentHotlist {
  generatedAt: string;
  enabled: boolean;
  windowDays: number;
  limit: number;
  groups: Record<ContentKind, { enabled: boolean; eligible: number; reviewed: number; qualified: number; entries: ContentItem[] }>;
}

export function readingSelection(repoIds: number[], articles: ContentItem[], total: number, preferences: ContentPreferences) {
  const queues: (number | ContentItem)[][] = [repoIds, articles.filter(item => item.kind === 'paper').slice(0, preferences.paper.limit), articles.filter(item => item.kind === 'practice').slice(0, preferences.practice.limit)];
  const selectedRepos: number[] = [];
  const selectedContent: ContentItem[] = [];
  let round = 0;
  while (selectedRepos.length + selectedContent.length < total && queues.some(queue => round < queue.length)) {
    for (const queue of queues) {
      if (selectedRepos.length + selectedContent.length >= total) break;
      const item = queue[round];
      if (typeof item === 'number') selectedRepos.push(item); else if (item) selectedContent.push(item);
    }
    round++;
  }
  return { repoIds: selectedRepos, articles: selectedContent };
}
