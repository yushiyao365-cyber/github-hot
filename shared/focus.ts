import type { FocusConfig, FocusTopic, Repo, Settings } from './types.js';

export const suggestedFocus: FocusConfig = {
  enabled: true,
  topics: [
    { id: 'paimon', name: 'Paimon 及其周边', enabled: true, weight: 1, goal: '了解 Paimon 的重要能力变化及直接相关的接入、读写集成、查询、运维和性能诊断工具。必须有直接集成或实际使用证据；仅列出 Paimon 名称或同属大数据领域不算相关。', terms: ['apache paimon', 'paimon + flink', 'paimon + cdc', 'paimon + lakehouse'], exclusions: ['仅在支持清单或资料列表中提及 Paimon', '与 Apache Paimon 无关的同名游戏或聊天项目', '泛数据库推荐', '教程合集和面试题'] },
    { id: 'training-data', name: '训练数据工程落地', enabled: true, weight: 1, goal: '了解大数据技术在模型训练中的具体落地：训练数据清洗、去重、质量检查、样本构建、版本追溯、数据加载与供给。必须连接到实际训练数据工作流，并有实现、使用示例或可复现实践，而不是一般 ETL 或模型介绍。', terms: ['training data', 'data curation', 'dataset + deduplication', 'training + dataloader', '训练数据'], exclusions: ['仅有模型权重或模型排行榜', '纯论文列表', '没有训练数据应用证据的通用 ETL'] },
    { id: 'work-tools', name: '研发工作提效', enabled: true, weight: 1, goal: '发现能用于编码、测试、排障、SQL 数据开发、代码审查、文档处理或重复操作自动化的 AI、Agent 和开发工具。说明减少了什么具体操作、使用前提及限制；优先新兴且值得试用或高星成熟的工具，不能把项目方自述当成已验证好用。', terms: ['coding agent', 'code review', 'test generation', 'sql + assistant', 'browser automation', 'developer tool + automation', '编程助手'], exclusions: ['单纯聊天界面套壳', '玩具演示和游戏', '资料合集和课程', '只有 Agent 或 MCP 标签，没有具体工作流'] },
  ],
};

export function activeFocus(settings: Settings): FocusTopic[] {
  return settings.focus?.enabled ? settings.focus.topics.filter(topic => topic.enabled && topic.weight > 0 && !(settings.radar && ['paimon', 'skills', 'workflows'].includes(topic.id) && !settings.radar.modules[topic.id as 'paimon' | 'skills' | 'workflows'].enabled)) : [];
}

export function focusSignature(topic: FocusTopic): string {
  return JSON.stringify([topic.id, topic.goal, topic.terms, topic.exclusions]);
}

export function focusTerms(clause: string): string[] {
  return clause.split('+').map(term => term.trim().toLowerCase()).filter(Boolean);
}

export function candidateFocusIds(repo: Repo, settings: Settings): string[] {
  const text = `${repo.fullName} ${repo.description} ${repo.topics.join(' ')} ${repo.readme.slice(0, 14000)}`.toLowerCase().replace(/[-_/]/g, ' ');
  return activeFocus(settings).filter(topic => topic.id === 'skills' && Boolean(repo.skillPaths?.length) || repo.focusIds?.includes(topic.id) || topic.terms.some(clause => focusTerms(clause).every(term => {
    const normalized = term.replace(/[-_/]/g, ' ');
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /[a-z0-9]/i.test(normalized) ? new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text) : text.includes(normalized);
  }))).map(topic => topic.id);
}
