/**
 * 予定の一覧の描画。日のシートと、週表示の下の「その日の予定」で同じ見た目を使う。
 * チェックボックスで済んだ予定に印を付けられ、優先度はバッジで出す。
 */

import { DAY_NAMES, fromDateKey } from './schedule.js';
import { PRIORITY_LABELS, eventsOn } from './timetable.js';
import { DEFAULT_EVENT_COLOR } from './view-month.js';
import { escapeHtml } from './html.js';

/** 優先度のバッジ（なしなら空文字）。 */
export function priorityBadge(priority) {
  const label = PRIORITY_LABELS[priority];
  return label ? `<span class="priority-badge is-${priority}" title="優先度: ${label}">${label}</span>` : '';
}

/** 予定 1 行。deletable なら右端に削除ボタンを付ける。 */
export function eventRow(event, { deletable = false } = {}) {
  const id = escapeHtml(event.id);
  const title = escapeHtml(event.title);
  return `<div class="event-row${event.done ? ' is-done' : ''}"
      style="--event-color:${escapeHtml(event.color || DEFAULT_EVENT_COLOR)}">
    <label class="event-check">
      <input type="checkbox" data-done-event="${id}" ${event.done ? 'checked' : ''}
        aria-label="${title} を${event.done ? '未完了に戻す' : '済みにする'}">
    </label>
    <button type="button" class="event-main" data-edit-event="${id}">
      <span class="event-time">${escapeHtml(event.time || '終日')}</span>
      <span class="event-title">${title}</span>
      ${priorityBadge(event.priority)}
    </button>
    ${
      deletable
        ? `<button type="button" class="icon-button is-quiet" data-delete-event="${id}"
            aria-label="${title} を削除">✕</button>`
        : ''
    }
  </div>`;
}

/** 週表示の下に出す、選んだ日の予定。 */
export function agendaHtml(state, dateKey) {
  const date = fromDateKey(dateKey);
  const events = eventsOn(state, dateKey);
  const remaining = events.filter((event) => !event.done).length;
  const summary = events.length ? `<span class="agenda-count">残り ${remaining} / ${events.length}</span>` : '';
  return `<section class="week-agenda" data-date="${dateKey}" aria-label="その日の予定">
    <div class="agenda-head">
      <h2>${date.getMonth() + 1}月${date.getDate()}日（${DAY_NAMES[date.getDay()]}）の予定</h2>
      ${summary}
      <button type="button" class="button is-small" data-agenda-add>＋ 追加</button>
    </div>
    ${
      events.length
        ? `<div class="event-list">${events.map((event) => eventRow(event)).join('')}</div>`
        : '<p class="agenda-empty">予定はありません。</p>'
    }
  </section>`;
}
