import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RadarDigest from '../src/RadarDigest.js';
import { radarBoard } from '../server/radar.js';
import { Store } from '../server/store.js';
import { radarFixture } from './radar-fixtures.js';

test('今日速览只用当前已入选内容，每方向一条，不制造跨模块热度', async () => {
  const store = new Store(':memory:');
  const services = radarFixture(store);
  try {
    const board = radarBoard(store.repos().map(repo => services.analyses.decorate(repo)), services.content.items(), store.settings(), 'home');
    const render = () => renderToStaticMarkup(createElement(RadarDigest, { board, onOpen: () => {} }));
    const markup = render();
    assert.match(markup, /今日速览/);
    assert.match(markup, /非跨模块热度排行/);
    assert.equal((markup.match(/<li>/g) || []).length, 4);
    assert.equal((markup.match(/<button/g) || []).length, 4);
    assert.doesNotMatch(markup, /热度指数|参与者|净增/);
    board.groups = board.groups.filter(group => group.id === 'papers');
    assert.equal((render().match(/<li>/g) || []).length, 1);
    board.groups[0].entries = [];
    assert.equal(render(), '');
    assert.equal(services.calls(), 0);
  } finally { await services.app.close(); store.close(); }
});
