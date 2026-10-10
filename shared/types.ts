export const channelIds = ['ai', 'agent', 'devtools', 'data'] as const;
export type ChannelId = typeof channelIds[number];
export const channelNames: Record<ChannelId, string> = {
  ai: '人工智能', agent: 'Agent', devtools: '开发者工具', data: '大数据',
};
export interface ChannelConfig {
  weight: number;
  keywords: string[];
  topics: string[];
}
export interface FocusTopic {
  id: string;
  name: string;
  enabled: boolean;
  weight: number;
  goal: string;
  terms: string[];
  exclusions: string[];
}
export interface FocusConfig { enabled: boolean; topics: FocusTopic[] }
export interface FeaturedHistoryDay { day: string; count: number; updatedAt: string; leadTitle?: string; leadSummary?: string }
export interface FeaturedHistoryEntry {
  capturedAt: string;
  topic: { id: string; name: string } | null;
  repo: Repo;
}
export interface Settings {
  radar?: import('./radar.js').RadarPreferences;
  content?: import('./content.js').ContentPreferences;
  focus?: FocusConfig;
  dailyLimit: number;
  recommendations: { highStarMin: number; potentialMaxAgeDays: number; potentialShare: number; newProjectDays?: number; growthMinStarsPerDay?: number };
  channels: Record<ChannelId, ChannelConfig>;
  excludeKeywords: string[];
  model: { enabled: boolean; endpoint: string; name: string; dailyBudget: number; autoAnalyze: boolean; ccSwitch?: { providerId: string; fingerprint: string; appType?: string; mode?: 'direct' } };
}
export type ModelProtocol = 'responses' | 'chat' | 'anthropic' | 'gemini';
export interface CCSwitchModel {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  endpoint: string;
  fingerprint: string;
  selectable: boolean;
  reason: string;
  appType?: string;
  protocol?: ModelProtocol;
}
export interface CCSwitchCatalog { models: CCSwitchModel[]; message: string }
export type Pool = 'highStars' | 'potential';
export interface Growth {
  from: string;
  to: string;
  days: number;
  starsDelta: number;
  fromStars?: number;
  toStars?: number;
}
export interface StarSample { observedAt: string; stars: number }
export interface HotlistEntry {
  rank: number;
  repo: Pick<Repo, 'id' | 'fullName' | 'url' | 'description' | 'stars' | 'language' | 'favorite' | 'read' | 'channel' | 'pool'>;
  topic: { id: string; name: string } | null;
  overview: string;
  highlight: string;
  analyzedAt: string | null;
  reviewed: boolean;
  growth: Growth;
  starsPerDay: number;
  samples: StarSample[];
}
export interface Hotlist {
  generatedAt: string;
  latestSampleAt: string | null;
  reviewRequired: boolean;
  relevantCount: number;
  measuredCount: number;
  growingCount: number;
  entries: HotlistEntry[];
}
export interface EvidenceSource { id: string; title: string; url: string; text: string; fetchedAt: string }
export interface Finding { text: string; evidence: { sourceId: string; quote: string }[] }
export interface Analysis {
  titleZh?: string;
  focusReview?: { topicId: string; topicName: string; relevance: 'direct' | 'adjacent' | 'unrelated'; task: string; relationship: Finding[]; benefit: Finding[]; trial: Finding[]; timeliness: Finding[] };
  repoId: number;
  key: string;
  pool: Pool;
  model: string;
  provider: string;
  analyzedAt: string;
  verdict: 'recommend' | 'watch' | 'skip';
  confidence: 'low' | 'medium' | 'high';
  overview: string;
  why: Finding[];
  capabilities: Finding[];
  useCases: Finding[];
  risks: Finding[];
  unknowns: string[];
  sources: EvidenceSource[];
  evidenceNote?: string;
}
export interface AnalysisState {
  status: 'pending' | 'waiting' | 'running' | 'done' | 'stale' | 'failed';
  error?: string;
  report: Analysis | null;
}
export interface AnalysisJob {
  running: boolean;
  total: number;
  completed: number;
  generated: number;
  cached: number;
  current: string;
  startedAt: string | null;
  finishedAt: string | null;
  errors: string[];
  message: string;
}
export interface Repo {
  skillPaths?: string[];
  focusIds?: string[];
  id: number;
  fullName: string;
  description: string;
  url: string;
  language: string;
  stars: number;
  forks: number;
  topics: string[];
  channel: ChannelId;
  createdAt: string;
  pushedAt: string;
  firstSeenAt: string;
  fetchedAt: string;
  archived: boolean;
  fork: boolean;
  readme: string;
  license: string;
  favorite: boolean;
  followed: boolean;
  ignored: boolean;
  read: boolean;
  notes: string;
  baseline: boolean;
  releaseBaselineAt: string | null;
  summary: string;
  score: number;
  reasons: string[];
  pool?: Pool | null;
  growth?: Growth | null;
  analysis?: AnalysisState;
}
export interface Release {
  id: number;
  repoId: number;
  fullName: string;
  tag: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string;
  firstSeenAt: string;
  prerelease: boolean;
  baseline: boolean;
  read: boolean;
  hidden: boolean;
  summary: string;
}
export interface SyncStatus {
  running: boolean;
  phase: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastDiscoveryAt: string | null;
  lastReleasesAt: string | null;
  errors: string[];
  incomplete: boolean;
  requestCount: number;
  retryAt: string | null;
}
export interface GithubRate { resource: string; remaining: number; limit: number; resetAt: number; observedAt: number }
export interface Dashboard {
  content?: import('./content.js').ContentDashboard;
  focusSections?: { topicId: string; name: string; goal: string; repoIds: number[]; candidates: number; reviewed: number }[];
  repos: Repo[];
  featuredIds: number[];
  initialIds: number[];
  releases: Release[];
  settings: Settings;
  status: SyncStatus;
  hasGithubToken: boolean;
  hasModelKey: boolean;
  modelUsage: number;
  today: string;
  githubRate?: GithubRate[];
  highStarIds: number[];
  potentialIds: number[];
  poolCounts: Record<Pool, { candidates: number; analyzed: number }>;
  analysisJob: AnalysisJob;
}
