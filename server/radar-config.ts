import { defaultRadar, defaultReview, moduleIds, radarFocus, type RadarPreferences } from '../shared/radar.js';
import { defaultContent } from '../shared/content.js';
import { AppError } from './errors.js';
import type { Store } from './store.js';

export function validateRadar(input: unknown): RadarPreferences {
  if (!input || typeof input !== 'object') throw new AppError('模块配置不正确');
  const value = input as RadarPreferences;
  if (value.version !== 1 || !value.modules) throw new AppError('模块配置版本不正确');
  const review = value.review || defaultReview;
  if (!Number.isSafeInteger(review.batchSize) || review.batchSize < 1 || review.batchSize > 100 || !Number.isSafeInteger(review.intervalMinutes) || review.intervalMinutes < 5 || review.intervalMinutes > 360) throw new AppError('每轮审核量需为 1–100，审核间隔需为 5–360 分钟');
  for (const id of moduleIds) {
    const config = value.modules[id];
    if (!config || typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.featuredLimit) || config.featuredLimit < 0 || config.featuredLimit > 30 || !Number.isSafeInteger(config.hotLimit) || config.hotLimit < 1 || config.hotLimit > 50) throw new AppError('模块精选数量需为 0–30，榜单数量需为 1–50 的整数');
  }
  return { version: 1, ...(value.review ? { review: { ...review } } : {}), modules: Object.fromEntries(moduleIds.map(id => [id, { enabled: value.modules[id].enabled, featuredLimit: value.modules[id].featuredLimit, hotLimit: value.modules[id].hotLimit }])) as RadarPreferences['modules'] };
}

export function installRadar(store: Store) {
  const settings = store.settings();
  if (settings.radar) return false;
  store.set('settingsBeforeRadarV1', settings);
  const content = structuredClone(settings.content || defaultContent);
  content.enabled = true;
  content.paper.goal += ' 同样关注大模型技术报告、系统白皮书和工程设计，区分作者论述与实验结论。';
  content.practice.goal = radarFocus.find(topic => topic.id === 'workflows')!.goal;
  content.practice.terms = [...new Set([...content.practice.terms, 'paimon', 'workflow', '视频', '文案'])].slice(0, 30);
  if (content.practice.feeds.length < 12 && !content.practice.feeds.some(feed => feed.url === 'https://sspai.com/feed')) content.practice.feeds.push({ name: '少数派 · 工作流初筛', url: 'https://sspai.com/feed', enabled: true });
  const topics = radarFocus.map(topic => {
    const previous = settings.focus?.topics.find(item => item.id === topic.id);
    return { ...structuredClone(topic), terms: [...new Set([...(previous?.terms || []), ...topic.terms].map(term => term.toLowerCase()))].slice(0, 20), weight: previous?.weight || topic.weight };
  });
  store.set('settings', { ...settings, radar: structuredClone(defaultRadar), focus: { enabled: true, topics }, content });
  store.set('sync', { ...store.status(), lastDiscoveryAt: null, lastAttemptAt: null });
  return true;
}
