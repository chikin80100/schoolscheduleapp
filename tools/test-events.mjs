/**
 * 予定の優先度・「済み」の正規化と、並び順を検証する。
 *
 *   node tools/test-events.mjs
 */

import assert from 'node:assert/strict';
import { eventsOn, normalizeState } from '../public/js/timetable.js';

const day = '2026-10-01';

// 古い保存データ（優先度も済みも無い）でも読める
const [plain] = normalizeState({ events: { [day]: [{ id: 'a', title: '体育祭' }] } }).events[day];
assert.equal(plain.priority, '');
assert.equal(plain.done, false);

// 想定外の値は捨てる
const [odd] = normalizeState({
  events: { [day]: [{ id: 'b', title: '面談', priority: 'urgent', done: 'yes' }] },
}).events[day];
assert.equal(odd.priority, '');
assert.equal(odd.done, false);

// 正しい値はそのまま残る
const [kept] = normalizeState({
  events: { [day]: [{ id: 'c', title: '提出', priority: 'high', done: true }] },
}).events[day];
assert.equal(kept.priority, 'high');
assert.equal(kept.done, true);

// 済んだものは後ろ、終日が先、同じ時刻なら優先度の高い順
const state = normalizeState({
  events: {
    [day]: [
      { id: 'done-high', title: '済', time: '', priority: 'high', done: true },
      { id: 'late', title: '部活', time: '16:00' },
      { id: 'allday-low', title: '持ち物', time: '', priority: 'low' },
      { id: 'allday-high', title: '課題', time: '', priority: 'high' },
      { id: 'allday-none', title: 'メモ', time: '' },
      { id: 'early-medium', title: '朝', time: '08:00', priority: 'medium' },
      { id: 'early-high', title: '朝2', time: '08:00', priority: 'high' },
    ],
  },
});
assert.deepEqual(
  eventsOn(state, day).map((event) => event.id),
  ['allday-high', 'allday-low', 'allday-none', 'early-high', 'early-medium', 'late', 'done-high'],
);

console.log('予定の優先度・チェックのテストに合格しました');
