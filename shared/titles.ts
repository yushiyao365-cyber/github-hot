import type { Repo } from './types.js';
import type { ContentItem } from './content.js';

export const chineseTitlePrompt = '\n增加 titleZh 字段：用 12–32 字中文描述核心任务、方法或用途，最多 48 字。不要直接复制英文原题或仓库名，不要营销词或未经证实的效果；允许必要的产品名和技术缩写。标题必须依据提供的资料，资料不足写“资料不足，待了解具体用途”。';

export function validChineseTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  return title.length <= 48 && (title.match(/\p{Script=Han}/gu)?.length || 0) >= 4 ? title : undefined;
}

export function chineseDescription(values: (string | undefined | null)[], fallback = '中文介绍待生成') {
  for (const value of values) {
    if (!value) continue;
    const sentence = value.replace(/\s+/g, ' ').trim().split(/[。！？\n]/u).find(part => (part.match(/\p{Script=Han}/gu)?.length || 0) >= 4);
    if (!sentence) continue;
    const description = sentence.replace(/^[^\p{Script=Han}]*?(?:是一款|是一个|是一种|是面向|用于)/u, '').trim();
    const text = description || sentence;
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
  return fallback;
}

export function repoTitle(repo: Repo) {
  const report = repo.analysis?.status === 'done' ? repo.analysis.report : null;
  return validChineseTitle(report?.titleZh) || chineseDescription([report?.overview, repo.summary, repo.description], '项目中文介绍待生成');
}

export function contentTitle(item: ContentItem) {
  const report = item.analysisStatus === 'done' ? item.report : null;
  return validChineseTitle(report?.titleZh) || chineseDescription([item.title, report?.overview], item.skill ? '技能中文介绍待生成' : item.kind === 'paper' ? '论文中文介绍待生成' : '实践中文介绍待生成');
}
