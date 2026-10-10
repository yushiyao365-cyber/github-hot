import test from 'node:test';
import assert from 'node:assert/strict';
import { chineseDescription, contentTitle, repoTitle, validChineseTitle } from '../shared/titles.js';
import { parseContentReport, contentAnalysisKey } from '../server/content-analysis.js';
import { fixtureContent, contentReply, contentSettings } from './content-fixtures.js';
import { fixtureRepo } from './fixtures.js';

test('中文标题优先使用模型短标题，旧报告回退中文概述且不改原题或缓存键', () => {
  const item = fixtureContent(); const settings = contentSettings();
  const key = contentAnalysisKey(item, settings);
  const report = parseContentReport(JSON.stringify({ ...contentReply(item), titleZh: '减少大模型推理成本的新方法' }), item, settings);
  item.report = report; item.analysisStatus = 'done';
  assert.equal(contentTitle(item), '减少大模型推理成本的新方法');
  assert.equal(contentAnalysisKey(item, settings), key);
  assert.match(item.title, /Test-only/);
  delete report.titleZh;
  assert.match(contentTitle(item), /测试报告/);
  item.analysisStatus = 'stale';
  assert.equal(contentTitle(item), '论文中文介绍待生成');
  const repo = fixtureRepo(1, { description: 'English description', summary: '帮助开发者检查代码变更与运行测试。更多介绍。' });
  assert.equal(repoTitle(repo), '帮助开发者检查代码变更与运行测试');
});

test('不拿英文原题冒充中文描述，允许专有名词且限制长度', () => {
  assert.equal(validChineseTitle('English only'), undefined);
  assert.equal(validChineseTitle('中文' + 'a'.repeat(70)), undefined);
  assert.equal(validChineseTitle('用 Paimon 管理流式数据'), '用 Paimon 管理流式数据');
  assert.equal(chineseDescription(['English only']), '中文介绍待生成');
  assert.equal(chineseDescription(['Apache Paimon 是面向实时湖仓的流式存储格式。支持更新。']), '实时湖仓的流式存储格式');
  assert.ok(chineseDescription(['这是中文介绍'.repeat(20)]).length <= 48);
});
