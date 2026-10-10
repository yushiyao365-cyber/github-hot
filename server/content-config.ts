import { defaultContent, type ContentPreferences } from '../shared/content.js';
import { AppError, record } from './config.js';
import { publicUrl } from './public-reader.js';

export function validateContent(input: unknown): ContentPreferences {
  const value = record(input ?? structuredClone(defaultContent));
  const boolean = (input: unknown) => { if (typeof input !== 'boolean') throw new AppError('论文与实践开关格式不正确'); return input; };
  const integer = (input: unknown, min: number, max: number) => { if (!Number.isSafeInteger(input) || Number(input) < min || Number(input) > max) throw new AppError(`内容数量需为 ${min}–${max} 的整数`); return Number(input); };
  const category = (input: unknown) => {
    const item = record(input);
    if (typeof item.goal !== 'string' || !item.goal.trim() || item.goal.length > 2000 || !Array.isArray(item.terms) || !item.terms.length || item.terms.length > 30 || item.terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 100 || !/^[\p{L}\p{N}\s._-]+$/u.test(term))) throw new AppError('请填写独立关注目标和 1–30 个普通关键词（不支持搜索操作符）');
    return { enabled: boolean(item.enabled), limit: integer(item.limit, 0, 30), goal: item.goal.trim(), terms: [...new Set(item.terms.map(term => String(term).trim()))] };
  };
  const practice = record(value.practice);
  if (!Array.isArray(practice.feeds) || practice.feeds.length > 12) throw new AppError('最多配置 12 个实践 RSS/Atom 来源');
  const feeds = practice.feeds.map(input => { const feed = record(input); if (typeof feed.name !== 'string' || !feed.name.trim() || feed.name.length > 100 || typeof feed.url !== 'string') throw new AppError('请填写订阅名称和链接'); return { name: feed.name.trim(), url: publicUrl(feed.url).toString(), enabled: boolean(feed.enabled) }; });
  if (new Set(feeds.map(feed => feed.url)).size !== feeds.length) throw new AppError('订阅来源地址不能重复');
  return { enabled: boolean(value.enabled), autoSync: boolean(value.autoSync), autoAnalyze: boolean(value.autoAnalyze), batchSize: integer(value.batchSize, 1, 12), windowDays: integer(value.windowDays, 1, 180), paper: category(value.paper), practice: { ...category(practice), feeds } };
}
