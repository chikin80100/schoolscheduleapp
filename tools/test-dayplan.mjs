/**
 * 予定の名前から日課の変更を読み取る部分を検証する。
 *
 *   node tools/test-dayplan.mjs
 */

import assert from 'node:assert/strict';
import { detectDayPlan, isPlainDay } from '../public/js/dayplan.js';
import { dayPlanFor, effectiveDay, lessonAt, normalizeState, periodsFor } from '../public/js/timetable.js';
import { formatMinutes } from '../public/js/schedule.js';

const plan = (...titles) => detectDayPlan(titles);

/* ------------------------------------------------------------ 短縮の判定 */

// 長さが書かれていれば、その数字を使う
assert.deepEqual(plan('40分授業').classMinutes, 40);
assert.deepEqual(plan('45分授業').classMinutes, 45);
assert.deepEqual(plan('本日は 50 分授業').classMinutes, 50);
assert.equal(plan('40分授業').schedule, 'short');
assert.deepEqual(plan('40分授業').labels, ['40分授業']);

// 長さの指定が無い短縮は、設定した短縮時程を使う合図
assert.deepEqual(plan('短縮授業'), { schedule: 'short', classMinutes: null, followDay: null, labels: ['短縮時程'] });
assert.equal(plan('午後は短縮日課').schedule, 'short');

// 数字が極端なものは信じない
assert.equal(plan('300分授業').classMinutes, null);
assert.equal(plan('1分授業').classMinutes, null);

// 関係のない予定では変わらない
for (const title of ['体育祭', '三者面談', '中間考査', '避難訓練']) {
  assert.ok(isPlainDay(plan(title)), `${title} で日課が変わっています`);
}

/* ------------------------------------------------------- ◯曜日課の判定 */

assert.equal(plan('月曜日課').followDay, 1);
assert.equal(plan('火曜授業').followDay, 2);
assert.equal(plan('水曜時間割').followDay, 3);
assert.equal(plan('木曜振替').followDay, 4);
assert.equal(plan('金曜振替授業').followDay, 5);
assert.equal(plan('月曜振り替え授業').followDay, 1);
assert.equal(plan('火曜日程（3年生）').followDay, 2);
assert.deepEqual(plan('月曜日課').labels, ['月曜日課']);

// 似ているが日課の話ではないものは拾わない
for (const title of ['月曜授業参観', '金曜ロードショー', '水曜日は委員会', '木曜会議']) {
  assert.equal(plan(title).followDay, null, `${title} を日課として拾っています`);
}

/* ------------------------------------------------------------ 組み合わせ */

const both = plan('短縮授業', '月曜日課');
assert.equal(both.schedule, 'short');
assert.equal(both.followDay, 1);
assert.deepEqual(both.labels, ['短縮時程', '月曜日課']);

// 1 つの予定名に両方入っていても読める
const oneLine = plan('40分授業・火曜日課');
assert.equal(oneLine.classMinutes, 40);
assert.equal(oneLine.followDay, 2);

/* -------------------------------------------------- 保存データからの解決 */

const base = normalizeState({
  majors: ['電気専攻'],
  template: {
    1: { 1: '普通科目:数学Ⅲ', 2: '普通科目:物理' }, // 月
    3: { 1: '普通科目:体育' }, // 水
    2: { 7: '普通科目:LHR' }, // 火（7限まである曜日）
  },
  events: {
    '2026-09-16': [{ id: 'e1', title: '40分授業', time: '', color: '' }], // 水
    '2026-09-17': [{ id: 'e2', title: '月曜日課', time: '', color: '' }], // 木
    '2026-09-18': [{ id: 'e3', title: '短縮授業', time: '', color: '' }], // 金
    '2026-09-24': [{ id: 'e4', title: '体育祭', time: '', color: '' }], // 水（変化なし）
  },
});

const ranges = (dateKey) =>
  periodsFor(base, dateKey)
    .slice(0, 2)
    .map((p) => `${formatMinutes(p.startMinutes)}-${formatMinutes(p.endMinutes)}`);

// 通常の日は既定の時程のまま
assert.deepEqual(ranges('2026-09-24'), ['8:50-9:40', '9:50-10:40']);

// 「40分授業」の日は 40 分で組み直す（開始時刻と休憩はそのまま）
assert.deepEqual(ranges('2026-09-16'), ['8:50-9:30', '9:40-10:20']);

// 長さの指定が無い短縮は、設定した短縮時程（既定は 45 分）
assert.deepEqual(ranges('2026-09-18'), ['8:50-9:35', '9:45-10:30']);

// 「月曜日課」の木曜は、月曜の時間割を引く
assert.equal(effectiveDay(base, 4, '2026-09-17'), 1);
assert.equal(lessonAt(base, 4, 1, '2026-09-17').subject.name, '数学Ⅲ');
assert.equal(lessonAt(base, 4, 2, '2026-09-17').subject.name, '物理');
// 日課を変えていない木曜は、木曜のまま（登録が無いので空）
assert.equal(lessonAt(base, 4, 1, '2026-09-10').subject, null);

// 水曜は 6 限までだが、火曜日課なら 7 限が出る
const tuesdayOnWednesday = normalizeState({
  ...base,
  events: { '2026-09-16': [{ id: 'e5', title: '火曜振替授業', time: '', color: '' }] },
});
assert.equal(effectiveDay(tuesdayOnWednesday, 3, '2026-09-16'), 2);
assert.equal(lessonAt(tuesdayOnWednesday, 3, 7, '2026-09-16').subject.name, 'LHR');
// 通常の水曜なら 7 限は存在しない
assert.equal(lessonAt(tuesdayOnWednesday, 3, 7, '2026-09-23').subject, null);

/* ------------------------------------------------------ 自動判定を止める */

const off = normalizeState({ ...base, dayPlanOff: { '2026-09-17': true } });
assert.equal(effectiveDay(off, 4, '2026-09-17'), 4, '自動判定を止めた日で曜日が変わっています');
assert.deepEqual(dayPlanFor(off, '2026-09-17').labels, []);
assert.equal(dayPlanFor(off, '2026-09-17').off, true);

// 予定を消せば判定も消える（判定結果は保存していない）
const removed = normalizeState({ ...base, events: {} });
assert.equal(effectiveDay(removed, 4, '2026-09-17'), 4);
assert.deepEqual(
  periodsFor(removed, '2026-09-16').slice(0, 1).map((p) => formatMinutes(p.endMinutes)),
  ['9:40'],
);

/* ---------------------------------------------------------- 短縮時程の保存 */

// 短縮時程を変えれば、指定なしの短縮の日はそれに従う
const custom = normalizeState({
  ...base,
  shortPeriods: [
    { start: '09:00', end: '09:35' },
    { start: '09:45', end: '10:20' },
    { start: '10:30', end: '11:05' },
    { start: '11:15', end: '11:50' },
    { start: '12:30', end: '13:05' },
    { start: '13:15', end: '13:50' },
    { start: '14:00', end: '14:35' },
  ],
});
assert.deepEqual(
  periodsFor(custom, '2026-09-18').slice(0, 2).map((p) => `${formatMinutes(p.startMinutes)}-${formatMinutes(p.endMinutes)}`),
  ['9:00-9:35', '9:45-10:20'],
);
// 壊れた短縮時程は既定に戻す
const brokenShort = normalizeState({ ...base, shortPeriods: [{ start: '09:00', end: '08:00' }] });
assert.equal(brokenShort.shortPeriods.length, 7);
assert.equal(brokenShort.shortPeriods[0].start, '08:50');

console.log('日課の判定のテストに合格しました');
