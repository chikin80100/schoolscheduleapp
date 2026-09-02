/** 週表示。時限 × 曜日のグリッドを描画する。 */

import {
  DAY_NAMES,
  SCHOOL_DAYS,
  currentPeriod,
  formatMinutes,
  hasPeriod,
  longBreakAfter,
  periodCountForDay,
  periodsFrom,
  toDateKey,
} from './schedule.js';
import { dayPlanLabel, effectiveDay, lessonAt, periodsFor } from './timetable.js';

/** その週の月曜日を返す。 */
export function mondayOf(date) {
  const monday = new Date(date);
  const offset = (monday.getDay() + 6) % 7; // 月曜を 0 とする
  monday.setDate(monday.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** その週で最も多い時限数（火・木を含めば 7）。 */
function maxPeriods() {
  return Math.max(...SCHOOL_DAYS.map(periodCountForDay));
}

function cellContent(lesson) {
  if (lesson.status === 'cancelled') {
    return '<span class="cell-status">休講</span>';
  }
  if (!lesson.subject) return '';
  const { name, room, teacher, color, major } = lesson.subject;
  const meta = [room, teacher].filter(Boolean).join(' / ');
  return `
    <span class="cell-card" style="--subject-color:${color}" title="${escapeHtml(major)}">
      <span class="cell-name">${escapeHtml(name)}</span>
      ${meta ? `<span class="cell-meta">${escapeHtml(meta)}</span>` : ''}
      ${lesson.status === 'replaced' ? '<span class="cell-badge">変更</span>' : ''}
    </span>`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

export function renderWeek(container, state, anchorDate) {
  const monday = mondayOf(anchorDate);
  const today = toDateKey(new Date());
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const rows = maxPeriods();
  const periods = periodsFrom(state);

  const dates = SCHOOL_DAYS.map((day) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + day - 1);
    const key = toDateKey(date);
    // 日課が変わっている日は、引く曜日も時程もその日だけ別になる。
    return { day, date, key, source: effectiveDay(state, day, key), plan: dayPlanLabel(state, key) };
  });

  const head = dates
    .map(({ day, date, key, plan }) => {
      const isToday = key === today;
      return `<div class="week-head${isToday ? ' is-today' : ''}${plan ? ' is-changed' : ''}">
        <span class="week-head-day">${DAY_NAMES[day]}</span>
        <span class="week-head-date">${date.getMonth() + 1}/${date.getDate()}</span>
        ${plan ? `<span class="week-head-plan">${escapeHtml(plan)}</span>` : ''}
      </div>`;
    })
    .join('');

  const body = [];
  // 行の高さは、授業の行だけ画面に合わせて伸ばし、休み時間の行は内容ぶんにする。
  const rowSizes = ['auto']; // 曜日の見出し行
  for (let period = 1; period <= rows; period += 1) {
    const info = periods[period - 1];
    rowSizes.push('minmax(58px, 1fr)');
    body.push(`<div class="week-gutter">
      <span class="gutter-period">${period}</span>
      <span class="gutter-time">${formatMinutes(info.startMinutes)}<br>${formatMinutes(info.endMinutes)}</span>
    </div>`);

    for (const { day, key, source, plan } of dates) {
      if (!hasPeriod(source, period)) {
        body.push('<div class="week-cell is-disabled" data-drop="cell" data-drop-disabled="true"></div>');
        continue;
      }
      const lesson = lessonAt(state, day, period, key);
      // 今どの時限かは、その日の時程で見る（短縮の日は時刻がずれるため）。
      const isNow =
        key === today && currentPeriod(periodsFor(state, key), source, nowMinutes) === period;
      const classes = [
        'week-cell',
        lesson.subject ? 'is-filled' : 'is-empty',
        lesson.status === 'cancelled' ? 'is-cancelled' : '',
        plan ? 'is-changed' : '',
        isNow ? 'is-now' : '',
      ]
        .filter(Boolean)
        .join(' ');
      body.push(`<div class="${classes}" data-drop="cell" data-drag="cell"
        data-day="${day}" data-period="${period}" data-date="${key}">${cellContent(lesson)}</div>`);
    }

    // まとまった休み（昼休みなど）だけを行として挟む。10 分休憩は出さない。
    const breakMinutes = longBreakAfter(periods, period);
    if (breakMinutes !== null && period < rows) {
      const next = periods[period];
      rowSizes.push('auto');
      body.push(`<div class="week-gutter is-lunch">
        <span class="gutter-time">${formatMinutes(info.endMinutes)}<br>${formatMinutes(next.startMinutes)}</span>
      </div>`);
      body.push(`<div class="week-lunch" style="grid-column: span ${dates.length}">
        ${breakMinutes >= 30 ? '昼休み' : '休み'}（${breakMinutes}分）
      </div>`);
    }
  }

  container.innerHTML = `
    <div class="week-grid" style="--day-count:${dates.length}; grid-template-rows:${rowSizes.join(' ')}">
      <div class="week-head is-corner">時限</div>
      ${head}
      ${body.join('')}
    </div>`;
}

/** ヘッダーに出す週のラベル（例: 2026年9月 第1週）。 */
export function weekLabel(anchorDate) {
  const monday = mondayOf(anchorDate);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const sameMonth = monday.getMonth() === friday.getMonth();
  const right = sameMonth
    ? `${friday.getDate()}日`
    : `${friday.getMonth() + 1}月${friday.getDate()}日`;
  return `${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日 〜 ${right}`;
}
