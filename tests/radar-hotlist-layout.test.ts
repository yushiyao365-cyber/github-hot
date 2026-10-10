import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RadarHotlist from '../src/RadarHotlist.js';
import { Samples } from '../src/StarTrend.js';
import { Store } from '../server/store.js';
import { radarBoard } from '../server/radar.js';
import { radarFixture } from './radar-fixtures.js';

test('热点榜渲染紧凑排名列表而非精选卡片，论文不出现虚构曲线', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  try {
    const board = radarBoard(store.repos().map(repo => services.analyses.decorate(repo)), services.content.items(), store.settings(), 'hotlist');
    for (const group of board.groups) for (const entry of group.entries) if (entry.type === 'repo') entry.samples = store.starSamples(entry.repo.id);
    const markup = renderToStaticMarkup(createElement(RadarHotlist, { board, sort: 'growth', busy: false, onOpen: () => {}, onPatch: () => {} }));
    assert.equal((markup.match(/class="ranked-module"/g) || []).length, 4);
    assert.equal((markup.match(/class="ranked-list"/g) || []).length, 4);
    assert.equal((markup.match(/class="hot-row ranked-row/g) || []).length, 7);
    assert.equal((markup.match(/aria-label="第 1 名"/g) || []).length, 4);
    assert.equal((markup.match(/<polyline/g) || []).length, 3);
    assert.doesNotMatch(markup, /radar-story|radar-groups/);
    assert.match(markup, /data-count="2"/);
    assert.match(markup, /data-count="1"/);
    assert.equal((markup.match(/class="ranked-highlight"/g) || []).length, 4);
    assert.match(markup, /采样明细/); assert.match(markup, /区间日均/);
    assert.match(markup, /https:\/\/github.com\/test-only\/skills\/blob\/HEAD\/skills\/test\/SKILL.md/);
    assert.match(markup, /收藏 test-only\/skills/); assert.match(markup, /打开原文 test-only\/skills/);
    const papers = { ...board, groups: board.groups.filter(group => group.id === 'papers') };
    const paperMarkup = renderToStaticMarkup(createElement(RadarHotlist, { board: papers, sort: 'growth', busy: false, onOpen: () => {}, onPatch: () => {} }));
    assert.doesNotMatch(paperMarkup, /<polyline|hot-trend|净增 Star/);
    assert.match(paperMarkup, /阅读量 \/ 引用量未采集/); assert.match(paperMarkup, /原文发布/);
    assert.equal(services.calls(), 0);
  } finally { await services.app.close(); store.close(); }
});

test('高星和新兴榜保留趋势入口，缺样本不补点；明细显示真实时间和数值', async () => {
  const store = new Store(':memory:'); const services = radarFixture(store);
  try {
    const board = radarBoard(store.repos().map(repo => services.analyses.decorate(repo)), [], store.settings(), 'hotlist', { sort: 'stars' });
    board.groups = board.groups.filter(group => group.id === 'skills');
    const entry = board.groups[0].entries[0];
    assert.ok(entry.type === 'repo');
    entry.samples = store.starSamples(entry.repo.id);
    const props = { board, busy: false, onOpen: () => {}, onPatch: () => {} };
    const stars = renderToStaticMarkup(createElement(RadarHotlist, { ...props, sort: 'stars' }));
    assert.match(stars, /仓库总 Star/); assert.match(stars, /<polyline/); assert.match(stars, /不是 Skill 安装量/);
    const emerging = renderToStaticMarkup(createElement(RadarHotlist, { ...props, sort: 'new' }));
    assert.match(emerging, /仓库创建时间/); assert.match(emerging, /<polyline/);
    const detail = renderToStaticMarkup(createElement(Samples, { entry: { repo: entry.repo, growth: entry.repo.growth, samples: entry.samples }, close: () => {} }));
    assert.match(detail, /1,500/); assert.match(detail, /1,700/); assert.match(detail, /不是今日新增/);
    assert.equal((detail.match(/<td>/g) || []).length, 4);
    entry.samples = [];
    const missing = renderToStaticMarkup(createElement(RadarHotlist, { ...props, sort: 'stars' }));
    assert.match(missing, /趋势样本不足/); assert.doesNotMatch(missing, /<polyline/);
    assert.equal(services.calls(), 0);
  } finally { await services.app.close(); store.close(); }
});
