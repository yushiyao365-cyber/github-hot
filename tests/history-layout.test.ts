import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, editionSections } from '../src/history-layout.js';
import { fixtureRepo } from './fixtures.js';
import type { FeaturedHistoryEntry } from '../shared/types.js';

test('日报日历以星期一开头，闰年、跨年和没有记录的日期不捏造条目', () => {
  const september = calendarDays('2026-09-30');
  assert.deepEqual(september.slice(0, 3), [null, '2026-09-01', '2026-09-02']);
  assert.equal(september.at(-1), '2026-09-30');
  assert.equal(calendarDays('2024-02-29').filter(Boolean).length, 29);
  assert.equal(calendarDays('2025-02-28').filter(Boolean).length, 28);
  assert.equal(calendarDays('2027-01-01').filter(Boolean)[0], '2027-01-01');
  assert.equal(calendarDays('2026-02-01')[6], '2026-02-01');
});

test('日报按历史专题编排，兼容旧频道并保留完整快照与存档顺序', () => {
  const entries: FeaturedHistoryEntry[] = [
    { capturedAt: '2026-09-30', topic: { id: 'data', name: '旧数据专题' }, repo: fixtureRepo(1) },
    { capturedAt: '2026-09-30', topic: null, repo: fixtureRepo(4) },
    { capturedAt: '2026-09-30', topic: { id: 'data', name: '旧数据专题' }, repo: fixtureRepo(2) },
  ];
  const sections = editionSections(entries);
  assert.deepEqual(sections.map(section => [section.id, section.name, section.entries.map(entry => entry.repo.id)]), [
    ['topic:data', '旧数据专题', [1, 2]], ['channel:data', '大数据', [4]],
  ]);
  assert.equal(sections[0].entries[0], entries[0]);
  assert.deepEqual(entries.map(entry => entry.repo.id), [1, 4, 2]);
  assert.deepEqual(editionSections([]), []);
});
