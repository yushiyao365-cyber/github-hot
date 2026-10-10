import { channelIds, type Settings } from '../shared/types.js';
import { validateContent } from './content-config.js';
import { AppError } from './errors.js';
import { defaultContent } from '../shared/content.js';
import { validateRadar } from './radar-config.js';
export { AppError } from './errors.js';

export const defaultSettings: Settings = {
  content: structuredClone(defaultContent),
  focus: { enabled: false, topics: [] },
  dailyLimit: 12,
  recommendations: { highStarMin: 1000, potentialMaxAgeDays: 365, potentialShare: 50, newProjectDays: 30, growthMinStarsPerDay: 10 },
  channels: {
    ai: { weight: 1, keywords: ['llm', 'machine learning', 'inference', '人工智能'], topics: ['artificial-intelligence', 'machine-learning', 'llm', 'deep-learning'] },
    agent: { weight: 1, keywords: ['agent', 'mcp', 'multi-agent'], topics: ['ai-agents', 'agent', 'agents', 'mcp', 'agent-framework'] },
    devtools: { weight: 1, keywords: ['developer tool', 'cli', 'code editor', 'debugger'], topics: ['developer-tools', 'cli', 'devtools', 'code-editor'] },
    data: { weight: 1, keywords: ['data lake', 'lakehouse', 'olap', 'stream processing', 'database', '大数据'], topics: ['big-data', 'database', 'data-engineering', 'stream-processing', 'lakehouse'] },
  },
  excludeKeywords: [],
  model: { enabled: false, endpoint: 'http://127.0.0.1:11434/v1/chat/completions', name: '', dailyBudget: 12, autoAnalyze: false },
};

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('请求格式不正确');
  return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string, lowercase = true): string[] {
  if (!Array.isArray(value) || value.length > 60 || value.some(item => typeof item !== 'string' || item.length > 100)) {
    throw new AppError(`${label}需为最多 60 个短词组成的列表`);
  }
  return [...new Set(value.map(item => lowercase ? item.trim().toLowerCase() : item.trim()).filter(Boolean))];
}

export function validateSettings(input: unknown): Settings {
  const value = record(input);
  const focus = record(value.focus ?? { enabled: false, topics: [] });
  if (typeof focus.enabled !== 'boolean' || !Array.isArray(focus.topics) || focus.topics.length > 10) throw new AppError('专题配置不正确，最多支持 10 个专题');
  const focusIds = new Set<string>();
  const focusTopics = focus.topics.map(input => {
    const topic = record(input);
    if (typeof topic.id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(topic.id) || focusIds.has(topic.id)) throw new AppError('专题 ID 不正确或重复');
    focusIds.add(topic.id);
    if (typeof topic.name !== 'string' || !topic.name.trim() || topic.name.length > 80 || typeof topic.goal !== 'string' || !topic.goal.trim() || topic.goal.length > 1200 || typeof topic.enabled !== 'boolean' || typeof topic.weight !== 'number' || !Number.isFinite(topic.weight) || topic.weight < 1 || topic.weight > 100) throw new AppError('请填写专题名称、关注目标与 1–100 的权重');
    const terms = stringList(topic.terms, '专题检索条件');
    if (!terms.length || terms.length > 20 || terms.some(term => !/^[\p{L}\p{N}\s+._-]+$/u.test(term) || term.split('+').some(part => !part.trim()) || term.split('+').length > 4)) throw new AppError('专题需有 1–20 条检索条件；可用 + 组合最多 4 个词，不支持其他搜索操作符');
    return { id: topic.id, name: topic.name.trim(), goal: topic.goal.trim(), enabled: topic.enabled, weight: topic.weight, terms, exclusions: stringList(topic.exclusions, '专题排除要求', false) };
  });
  if (focus.enabled && !focusTopics.some(topic => topic.enabled)) throw new AppError('专题模式至少启用一个专题');
  if (!Number.isSafeInteger(value.dailyLimit) || Number(value.dailyLimit) < 1) throw new AppError('每日精选上限必须是正整数');
  const recommendations = record(value.recommendations ?? defaultSettings.recommendations);
  const newProjectDays = recommendations.newProjectDays ?? 30;
  const growthMinStarsPerDay = recommendations.growthMinStarsPerDay ?? 10;
  if (!Number.isSafeInteger(newProjectDays) || Number(newProjectDays) < 1 || Number(newProjectDays) > 365) throw new AppError('新项目发现窗口需为 1–365 天');
  if (!Number.isSafeInteger(growthMinStarsPerDay) || Number(growthMinStarsPerDay) < 1 || Number(growthMinStarsPerDay) > 1000000) throw new AppError('快速增长门槛需为日均 1–1000000 Star 的整数');
  for (const [key, maximum] of [['highStarMin', 10000000], ['potentialMaxAgeDays', 3650], ['potentialShare', 100]] as const) {
    const number = recommendations[key];
    if (!Number.isSafeInteger(number) || Number(number) < (key === 'potentialShare' ? 0 : 1) || Number(number) > maximum) throw new AppError('推荐参数不正确：Star 门槛和新项目天数需为正整数，潜力项目占比需为 0–100 的整数');
  }
  const channels = record(value.channels);
  const validated = {} as Settings['channels'];
  for (const channel of channelIds) {
    const config = record(channels[channel]);
    if (typeof config.weight !== 'number' || !Number.isFinite(config.weight) || config.weight < 0 || config.weight > 100) throw new AppError('频道权重必须在 0–100 之间');
    validated[channel] = { weight: config.weight, keywords: stringList(config.keywords, '关键词'), topics: stringList(config.topics, 'Topics') };
  }
  if (!channelIds.some(channel => validated[channel].weight > 0)) throw new AppError('至少保留一个频道的权重');
  const model = record(value.model);
  if (typeof model.enabled !== 'boolean' || typeof model.endpoint !== 'string' || typeof model.name !== 'string' || model.name.length > 150) throw new AppError('模型设置格式不正确');
  let endpoint: URL;
  try { endpoint = new URL(model.endpoint); } catch { throw new AppError('请输入完整的模型接口地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:'))) throw new AppError('模型接口需使用 HTTPS，本机地址可使用 HTTP；不要把密钥放进 URL');
  if (model.enabled && !model.name.trim()) throw new AppError('启用摘要前请填写模型名称');
  if (!Number.isSafeInteger(model.dailyBudget) || Number(model.dailyBudget) < 0 || Number(model.dailyBudget) > 500) throw new AppError('模型每日调用上限需为 0–500 的整数，0 表示不限制');
  if (model.autoAnalyze !== undefined && typeof model.autoAnalyze !== 'boolean') throw new AppError('自动分析设置不正确');
  let ccSwitch: Settings['model']['ccSwitch'];
  if (model.ccSwitch !== undefined) {
    const binding = record(model.ccSwitch);
    if (typeof binding.providerId !== 'string' || !binding.providerId || binding.providerId.length > 200 || typeof binding.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(binding.fingerprint)) throw new AppError('CC Switch 模型绑定格式不正确');
    if (binding.mode !== undefined && binding.mode !== 'direct') throw new AppError('CC Switch 调用模式不正确');
    if (binding.mode === 'direct' && (typeof binding.appType !== 'string' || !binding.appType || binding.appType.length > 100)) throw new AppError('CC Switch 应用类型不正确');
    ccSwitch = { providerId: binding.providerId, fingerprint: binding.fingerprint, ...(binding.mode === 'direct' ? { mode: 'direct', appType: String(binding.appType) } : {}) };
  }
  return {
    ...(value.radar !== undefined ? { radar: validateRadar(value.radar) } : {}),
    content: validateContent(value.content),
    focus: { enabled: focus.enabled, topics: focusTopics },
    dailyLimit: Number(value.dailyLimit), channels: validated,
    recommendations: { highStarMin: Number(recommendations.highStarMin), potentialMaxAgeDays: Number(recommendations.potentialMaxAgeDays), potentialShare: Number(recommendations.potentialShare), newProjectDays: Number(newProjectDays), growthMinStarsPerDay: Number(growthMinStarsPerDay) },
    excludeKeywords: stringList(value.excludeKeywords, '排除词'),
    model: { enabled: model.enabled, endpoint: endpoint.toString(), name: model.name.trim(), dailyBudget: Number(model.dailyBudget), autoAnalyze: model.autoAnalyze === true, ...(ccSwitch ? { ccSwitch } : {}) },
  };
}

export function parseRepo(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('请输入 GitHub 仓库地址或 owner/repo');
  let name = value.trim();
  if (/^https?:/i.test(name)) {
    let url: URL;
    try { url = new URL(name); } catch { throw new AppError('仓库地址不正确'); }
    if (url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) throw new AppError('只支持 github.com 的公开仓库链接');
    name = url.pathname.replace(/^\/+|\/+$/g, '');
  }
  name = name.replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(name) || name.endsWith('/..') || name.endsWith('/.')) throw new AppError('请使用 owner/repo 格式或完整仓库链接');
  return name;
}
