import test from 'node:test';
import assert from 'node:assert/strict';
import { growthDisplay } from '../src/growth-display.js';
import type { Growth } from '../shared/types.js';

const now = Date.parse('2026-10-08T12:00:00Z');
const growth: Growth = { from: '2026-10-03T00:00:00Z', to: '2026-10-08T12:00:00Z', days: 5.5, starsDelta: 1, fromStars: 3411, toStars: 3412 };

test('增长主文案显示整数净变化，日均小数只出现在说明中', () => {
  const display = growthDisplay({ growth }, now);
  assert.equal(display.label, '5.5 天 +1 ★');
  assert.equal(display.direction, 'up');
  assert.ok(display.description.includes('日均 +0.18 ★/天'));
  assert.ok(display.description.includes('3,411 → 3,412'));
  assert.ok(display.description.includes('不是今日新增'));
  assert.ok(display.description.includes('2026'));
  assert.equal(growthDisplay({ growth: { ...growth, starsDelta: 3 } }, now).label, '5.5 天 +3 ★');
});

test('下降、零变化、大数和整数天数准确显示，不把下降画为上升', () => {
  assert.equal(growthDisplay({ growth: { ...growth, starsDelta: -3 } }, now).label, '5.5 天 -3 ★');
  assert.equal(growthDisplay({ growth: { ...growth, starsDelta: -3 } }, now).direction, 'down');
  assert.equal(growthDisplay({ growth: { ...growth, starsDelta: 0 } }, now).label, '5.5 天 0 ★');
  assert.equal(growthDisplay({ growth: { ...growth, starsDelta: 0 } }, now).direction, 'flat');
  assert.equal(growthDisplay({ growth: { ...growth, from: '2026-10-07T12:00:00Z', starsDelta: 2345 } }, now).label, '1 天 +2,345 ★');
});

test('间隔使用真实时间戳，不使用四舍五入的 days 计算均值', () => {
  const display = growthDisplay({ growth: { ...growth, days: 1, from: '2026-10-02T15:37:11.542Z', to: '2026-10-08T03:22:14.287Z' } }, now);
  assert.equal(display.label, '5.5 天 +1 ★');
  assert.ok(display.description.includes('日均 +0.18 ★/天'));
});

test('缺样、过期、未来、短间隔和非法增长不伪装成零或有效实测值', () => {
  assert.equal(growthDisplay({}, now).label, '增速待采样');
  for (const patch of [
    { to: '2026-10-04T12:00:00Z' }, { from: '2026-10-08T06:00:00Z' },
    { to: '2026-10-09T12:00:00Z' }, { from: '2026-09-01T00:00:00Z' },
    { from: 'invalid' }, { starsDelta: NaN }, { starsDelta: 0.2 },
  ]) {
    const display = growthDisplay({ growth: { ...growth, ...patch } }, now);
    assert.equal(display.direction, 'unknown');
    assert.equal(display.label, '旧快照 · 待更新');
  }
});
