/**
 * 月表示。日付だけのカレンダーを描く。
 * 授業の中身は日をタップして開く詳細シート（editor.js の openDaySheet）で見る。
 */

import { SCHOOL_DAYS, periodCountForDay, toDateKey } from './schedule.js';
import { lessonAt } from './timetable.js';

const WEEK_HEADS = ['月', '火', '水', '木', '金', '土', '日'];

/** その月のカレンダーに並べる日付（月曜始まり、前後の月ではみ出す分を含む）。 */
function calendarDates(anchorDate) {
  const first = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));

  const last = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0);
  const end = new Date(last);
  end.setDate(last.getDate() + (7 - ((last.getDay() + 6) % 7) - 1));

  const dates = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    dates.push(new Date(cursor));
  }
  return dates;
}

/** 指定日の授業一覧（時限順、休講も含む）。日詳細シートからも使う。 */
export function lessonsOfDate(state, date) {
  const day = date.getDay();
  if (!SCHOOL_DAYS.includes(day)) return [];
  const key = toDateKey(date);
  const lessons = [];
  for (let period = 1; period <= periodCountForDay(day); period += 1) {
    lessons.push({ period, ...lessonAt(state, day, period, key) });
  }
  return lessons;
}

export function renderMonth(container, state, anchorDate) {
  const today = toDateKey(new Date());
  const month = anchorDate.getMonth();

  const cells = calendarDates(anchorDate).map((date) => {
    const key = toDateKey(date);
    const classes = [
      'month-day',
      date.getMonth() === month ? '' : 'is-outside',
      SCHOOL_DAYS.includes(date.getDay()) ? '' : 'is-weekend',
      key === today ? 'is-today' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return `<button type="button" class="${classes}" data-date="${key}">
      <span class="month-date">${date.getDate()}</span>
    </button>`;
  });

  container.innerHTML = `
    <div class="month-grid">
      ${WEEK_HEADS.map((name) => `<div class="month-head">${name}</div>`).join('')}
      ${cells.join('')}
    </div>`;
}

export function monthLabel(anchorDate) {
  return `${anchorDate.getFullYear()}年${anchorDate.getMonth() + 1}月`;
}
