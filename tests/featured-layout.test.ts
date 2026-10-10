import test from 'node:test';
import assert from 'node:assert/strict';
import { featuredDays, featuredRepos, featuredTime } from '../src/featured-layout.js';
import { fixtureRepo } from './fixtures.js';
import { defaultSettings } from '../server/config.js';
import type { Analysis } from '../shared/types.js';

test('精选信息流只使用后端入选 ID，保留推荐顺序，过滤与顶部速览共用同一集合', () => {
  const data = { settings: defaultSettings, repos: [fixtureRepo(1), fixtureRepo(2), fixtureRepo(3)], featuredIds: [2, 1, 2, 999] };
  assert.deepEqual(featuredRepos(data, () => true).map(repo => repo.id), [2, 1]);
  assert.deepEqual(featuredRepos(data, repo => repo.id === 1).map(repo => repo.id), [1]);
  assert.deepEqual(featuredRepos({ ...data, featuredIds: [] }, () => true), []);
});

test('专题筛选以已审核的入选专题为准，不拿候选标签匹配冒充其他专题入选', () => {
  const data = {
    settings: { ...defaultSettings, focus: { enabled: true, topics: [] } }, repos: [fixtureRepo(1, { focusIds: ['first', 'second'] }), fixtureRepo(2)], featuredIds: [2, 1],
    focusSections: [{ topicId: 'first', name: 'First', goal: '', candidates: 1, reviewed: 1, repoIds: [1] }, { topicId: 'second', name: 'Second', goal: '', candidates: 1, reviewed: 1, repoIds: [2] }],
  };
  assert.deepEqual(featuredRepos(data, () => true, 'first').map(repo => repo.id), [1]);
  assert.deepEqual(featuredRepos(data, () => true, 'second').map(repo => repo.id), [2]);
  assert.deepEqual(featuredRepos(data, () => true, 'missing'), []);
});

test('时间线按真实分析/采集日期分组，不把旧项目标成今日发布，日期未知单独显示', () => {
  const analyzedAt = '2026-09-30T10:00:00';
  const report = { analyzedAt } as Analysis;
  const older = fixtureRepo(1, { fetchedAt: '2026-10-08T15:00:00', analysis: { status: 'done', report } });
  const current = fixtureRepo(2, { fetchedAt: '2026-10-08T14:00:00' });
  const earlier = fixtureRepo(3, { fetchedAt: '2026-10-08T09:00:00' });
  const unknown = fixtureRepo(4, { fetchedAt: 'invalid' });
  assert.equal(featuredTime(older).label, '分析');
  assert.equal(featuredTime(older).day, '2026-09-30');
  assert.equal(featuredTime({ ...older, analysis: { status: 'stale', report } }).label, '采集');
  assert.equal(featuredTime(unknown).day, 'unknown');
  const repos = [unknown, older, earlier, current];
  assert.deepEqual(featuredDays(repos).map(group => [group.day, group.repos.map(repo => repo.id)]), [['2026-10-08', [2, 3]], ['2026-09-30', [1]], ['unknown', [4]]]);
  assert.deepEqual(repos.map(repo => repo.id), [4, 1, 3, 2]);
  assert.deepEqual(featuredDays([]), []);
});
