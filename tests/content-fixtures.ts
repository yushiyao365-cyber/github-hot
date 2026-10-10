import { defaultSettings } from '../server/config.js';
import { defaultContent } from '../shared/content.js';
import { contentRecord } from '../server/content-reader.js';
import type { ContentItem, ContentKind } from '../shared/content.js';

export const articleText = 'This is a test-only AI workflow fixture, not a real recommendation. First, use Claude to draft a migration script for a sample project. Next, review the diff and run isolated tests to check every generated change. The author reports saving time but has not independently benchmarked the result. The example explains when human review is still necessary.';
export const paperText = 'This is a test-only large language model paper fixture, not a real publication. We study reasoning under limited inference budgets. Our method selects shorter reasoning traces and compares them on a small benchmark. The authors report a gain but external validation and complete experimental details are not available in this abstract.';
export const contentSettings = () => ({ ...structuredClone(defaultSettings), content: { ...structuredClone(defaultContent), enabled: true, practice: { ...structuredClone(defaultContent.practice), feeds: [{ name: 'Test-only blog', url: 'https://example.org/feed', enabled: true }] } }, model: { ...defaultSettings.model, enabled: true, name: 'test-only-model', dailyBudget: 0 } });
export function fixtureContent(kind: ContentKind = 'paper', index = 1) {
  return contentRecord(kind, kind === 'paper' ? `https://arxiv.org/abs/2610.${String(index).padStart(5, '0')}` : `https://example.org/article-${index}`, `Test-only ${kind} ${index}`, kind === 'paper' ? paperText : articleText, 'Test-only source', kind === 'paper' ? 'abstract' : 'excerpt', { publishedAt: new Date().toISOString() });
}
export function contentReply(item: ContentItem) {
  const finding = { text: '自动化测试依据，不是真实论文或实践结论。', quote: item.text.slice(0, 80) };
  return { verdict: 'recommend', confidence: 'medium', relevance: 'direct', overview: '自动化测试报告：用 AI 辅助任务，再通过人工检查与测试验证。', problem: [finding], contribution: item.kind === 'paper' ? [finding] : [], evidence: [], workflow: item.kind === 'practice' ? [finding, { ...finding, quote: item.text.slice(80, 160) }] : [], tools: item.kind === 'practice' ? [finding] : [], outcomes: [], caveats: [], takeaway: [finding], unknowns: ['此处为测试数据，未验证外部结果。'] };
}
export function paperFeed() { return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2610.00001v2</id><title>Test-only large language model study</title><summary>${paperText}</summary><author><name>Test Author</name></author><published>${new Date().toISOString()}</published><updated>${new Date().toISOString()}</updated><link rel="alternate" href="http://arxiv.org/abs/2610.00001v2" /></entry></feed>`; }
export function practiceFeed() { return `<rss version="2.0"><channel><item><title>AI workflow test</title><link>https://example.org/article-1</link><pubDate>${new Date().toUTCString()}</pubDate><description><![CDATA[<p>${articleText}</p>]]></description></item></channel></rss>`; }
export const articleHtml = `<html><head><title>AI workflow test</title><meta name="author" content="Test Author" /></head><body><nav>Not article text</nav><article><p>${articleText}</p><script>doNotExecute()</script></article></body></html>`;
