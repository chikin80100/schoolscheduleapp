/**
 * iCalendar の読み取りを検証する。
 *
 *   node tools/test-ical.mjs
 */

import assert from 'node:assert/strict';
import { parseICalendar } from '../public/js/ical.js';

const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//JP\r\n${body}\r\nEND:VCALENDAR\r\n`;
const brief = (events) => events.map((e) => `${e.dateKey} ${e.time || '終日'} ${e.title}`);

/* -------------------------------------------------------------- 基本の形 */

// 終日の予定。DTEND は「終わりの翌日」を指すので、9/10 の 1 日だけになる。
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:a1',
          'SUMMARY:体育祭',
          'DTSTART;VALUE=DATE:20260910',
          'DTEND;VALUE=DATE:20260911',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-09-10 終日 体育祭'],
);

// 時刻つき（タイムゾーン指定つき）は、書かれたままの時刻で入る
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:a2',
          'SUMMARY:三者面談',
          'DTSTART;TZID=Asia/Tokyo:20260915T143000',
          'DTEND;TZID=Asia/Tokyo:20260915T151000',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-09-15 14:30 三者面談'],
);

// 末尾 Z の UTC は日本時間に直す（00:00Z → 09:00 JST）
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(['BEGIN:VEVENT', 'UID:a3', 'SUMMARY:全校集会', 'DTSTART:20260916T000000Z', 'END:VEVENT'].join('\r\n')),
    ),
  ),
  ['2026-09-16 09:00 全校集会'],
);

// 日付をまたぐ UTC（15:00Z → 翌日 00:00 JST）
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(['BEGIN:VEVENT', 'UID:a4', 'SUMMARY:夜間実習', 'DTSTART:20260916T150000Z', 'END:VEVENT'].join('\r\n')),
    ),
  ),
  ['2026-09-17 00:00 夜間実習'],
);

/* ---------------------------------------------------------- 複数日・折り返し */

// 3 日間の終日予定は、日ごとに分けて登録する
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:b1',
          'SUMMARY:修学旅行',
          'DTSTART;VALUE=DATE:20261005',
          'DTEND;VALUE=DATE:20261008',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-10-05 終日 修学旅行', '2026-10-06 終日 修学旅行', '2026-10-07 終日 修学旅行'],
);

// 折り返された長い行を戻し、エスケープを解く
const folded = parseICalendar(
  wrap(
    [
      'BEGIN:VEVENT',
      'UID:b2',
      'SUMMARY:文化祭\\, 準備日',
      ' （体育館）',
      'DTSTART;VALUE=DATE:20261020',
      'END:VEVENT',
    ].join('\r\n'),
  ),
);
assert.equal(folded[0].title, '文化祭, 準備日（体育館）');

/* ---------------------------------------------------------------- 繰り返し */

// 毎週月・水、4 回で終わり
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:c1',
          'SUMMARY:部活',
          'DTSTART;TZID=Asia/Tokyo:20260907T160000',
          'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  [
    '2026-09-07 16:00 部活', // 月
    '2026-09-09 16:00 部活', // 水
    '2026-09-14 16:00 部活',
    '2026-09-16 16:00 部活',
  ],
);

// UNTIL で止まる（毎日、9/13 まで）
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:c2',
          'SUMMARY:朝練',
          'DTSTART;VALUE=DATE:20260910',
          'RRULE:FREQ=DAILY;UNTIL=20260913',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-09-10 終日 朝練', '2026-09-11 終日 朝練', '2026-09-12 終日 朝練', '2026-09-13 終日 朝練'],
);

// EXDATE で除いた日は入らない
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:c3',
          'SUMMARY:委員会',
          'DTSTART;VALUE=DATE:20260910',
          'RRULE:FREQ=DAILY;COUNT=3',
          'EXDATE;VALUE=DATE:20260911',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-09-10 終日 委員会', '2026-09-12 終日 委員会'],
);

// 隔週。INTERVAL が効く
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:c4',
          'SUMMARY:大掃除',
          'DTSTART;VALUE=DATE:20260910',
          'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-09-10 終日 大掃除', '2026-09-24 終日 大掃除', '2026-10-08 終日 大掃除'],
);

// 毎月。31 日が無い月は飛ばす
assert.deepEqual(
  brief(
    parseICalendar(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:c5',
          'SUMMARY:月末点検',
          'DTSTART;VALUE=DATE:20260131',
          'RRULE:FREQ=MONTHLY;COUNT=3',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    ),
  ),
  ['2026-01-31 終日 月末点検', '2026-03-31 終日 月末点検', '2026-05-31 終日 月末点検'],
);

// 終わりの無い繰り返しでも、際限なく増やさない
const endless = parseICalendar(
  wrap(
    ['BEGIN:VEVENT', 'UID:c6', 'SUMMARY:日直', 'DTSTART;VALUE=DATE:20260401', 'RRULE:FREQ=DAILY', 'END:VEVENT'].join(
      '\r\n',
    ),
  ),
);
assert.ok(endless.length > 0 && endless.length <= 400, `件数が上限を超えています: ${endless.length}`);

/* ------------------------------------------------------------ 壊れた入力 */

// 予定が 1 件も無いファイルは、空で返す（エラーにはしない）
assert.deepEqual(parseICalendar(wrap('BEGIN:VTODO\r\nSUMMARY:宿題\r\nEND:VTODO')), []);

// 題名や開始日が無い VEVENT は捨てる
assert.deepEqual(parseICalendar(wrap('BEGIN:VEVENT\r\nUID:d1\r\nDTSTART;VALUE=DATE:20260910\r\nEND:VEVENT')), []);
assert.deepEqual(parseICalendar(wrap('BEGIN:VEVENT\r\nUID:d2\r\nSUMMARY:題名だけ\r\nEND:VEVENT')), []);

// iCalendar でないものは、はっきり断る
assert.throws(() => parseICalendar('これはただのテキストです'), /iCalendar/);
assert.throws(() => parseICalendar(''), /iCalendar/);

/* ---------------------------------------------------------- 並び順と UID */

const mixed = parseICalendar(
  wrap(
    [
      'BEGIN:VEVENT',
      'UID:e2',
      'SUMMARY:午後の部',
      'DTSTART;TZID=Asia/Tokyo:20260910T130000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:e1',
      'SUMMARY:午前の部',
      'DTSTART;TZID=Asia/Tokyo:20260910T090000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:e0',
      'SUMMARY:前日準備',
      'DTSTART;VALUE=DATE:20260909',
      'END:VEVENT',
    ].join('\r\n'),
  ),
);
assert.deepEqual(brief(mixed), [
  '2026-09-09 終日 前日準備',
  '2026-09-10 終日 午前の部'.replace('終日', '09:00'),
  '2026-09-10 13:00 午後の部',
]);
assert.deepEqual(
  mixed.map((e) => e.uid),
  ['e0', 'e1', 'e2'],
  'UID が引き継がれていません（再取り込みの重複防止に使う）',
);

console.log('iCalendar のテストに合格しました');
