import type { EvidenceSource } from '../shared/types.js';

export const testReadme = '# Fixture project\nA test-only stream processing framework with documented SQL examples. It supports local development and an experimental streaming pipeline. These statements are fixture data, not a real project recommendation.';

export function analysisReply(sources: EvidenceSource[], verdict = 'recommend') {
  const source = sources.find(item => item.id === 'readme') || sources[0];
  const finding = { text: '测试报告：资料描述了明确的使用方向，实际能力仍需验证。', evidence: [{ sourceId: source.id, quote: source.text.split('\n').find(line => line.length >= 4)!.slice(0, 120) }] };
  return { verdict, confidence: 'medium', overview: '这是自动化测试模型返回的结构化分析，不是真实项目评估。', why: [finding], capabilities: [finding], useCases: [], risks: [], unknowns: ['未执行代码，性能和实际可用性尚未验证。'] };
}
