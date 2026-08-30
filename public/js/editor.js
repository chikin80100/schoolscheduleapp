/** 科目カードの編集と、日付ごとの上書き（休講・変更）を扱うシート。 */

import { formatMinutes, getPeriod, DAY_NAMES, fromDateKey } from './schedule.js';
import { MAJORS, PRESETS, presetsForMajor, resolveSubject } from './subjects.js';
import { lessonAt } from './timetable.js';
import { getState, update } from './store.js';
import { escapeHtml } from './view-week.js';
import { lessonsOfDate } from './view-month.js';

const dialog = document.getElementById('sheet');
const sheetBody = document.getElementById('sheet-body');

function openSheet(title, html, wire) {
  sheetBody.innerHTML = `
    <header class="sheet-head">
      <h2>${escapeHtml(title)}</h2>
      <button type="button" class="icon-button" data-close aria-label="閉じる">✕</button>
    </header>
    <div class="sheet-content">${html}</div>`;
  sheetBody.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  wire?.(sheetBody);
  if (!dialog.open) dialog.showModal();
}

export function closeSheet() {
  if (dialog.open) dialog.close();
}

dialog.addEventListener('click', (event) => {
  // 背景（dialog 自身）のタップで閉じる。
  if (event.target === dialog) dialog.close();
});

/* ---------------------------------------------------------------- 科目カード編集 */

const COLOR_CHOICES = [
  'hsl(0 62% 50%)',
  'hsl(24 62% 48%)',
  'hsl(45 68% 44%)',
  'hsl(140 42% 40%)',
  'hsl(188 52% 42%)',
  'hsl(212 58% 50%)',
  'hsl(275 48% 52%)',
  'hsl(320 45% 50%)',
  'hsl(210 12% 45%)',
];

export function openSubjectEditor(id) {
  const subject = resolveSubject(id, getState().subjects);
  if (!subject) return;

  const swatches = COLOR_CHOICES.map(
    (color) => `<button type="button" class="swatch${color === subject.color ? ' is-active' : ''}"
      style="background:${color}" data-color="${color}" aria-label="色 ${color}"></button>`,
  ).join('');

  openSheet(
    `${subject.name}`,
    `
    <p class="sheet-sub">${escapeHtml(subject.major)}</p>
    <label class="field">
      <span class="field-label">持ち物<small>（カンマ区切り・空でも可）</small></span>
      <input id="edit-items" type="text" inputmode="text" placeholder="例: 教科書, ノート, 関数電卓"
        value="${escapeHtml(subject.items.join(', '))}">
    </label>
    <label class="field">
      <span class="field-label">教室・場所</span>
      <input id="edit-room" type="text" placeholder="例: 実習棟A" value="${escapeHtml(subject.room)}">
    </label>
    <label class="field">
      <span class="field-label">先生</span>
      <input id="edit-teacher" type="text" placeholder="例: 山田先生" value="${escapeHtml(subject.teacher)}">
    </label>
    <div class="field">
      <span class="field-label">色</span>
      <div class="swatches">${swatches}<button type="button" class="swatch is-reset" data-color="">既定</button></div>
    </div>
    <div class="sheet-actions">
      <button type="button" class="button is-primary" id="edit-save">保存</button>
    </div>`,
    (root) => {
      let color = subject.color;
      root.querySelectorAll('.swatch').forEach((swatch) => {
        swatch.addEventListener('click', () => {
          color = swatch.dataset.color || PRESETS.get(id)?.color || subject.color;
          root.querySelectorAll('.swatch').forEach((s) => s.classList.remove('is-active'));
          swatch.classList.add('is-active');
        });
      });
      root.querySelector('#edit-save').addEventListener('click', () => {
        const items = root
          .querySelector('#edit-items')
          .value.split(/[,、]/)
          .map((item) => item.trim())
          .filter(Boolean);
        update((state) => {
          state.subjects[id] = {
            items,
            room: root.querySelector('#edit-room').value.trim(),
            teacher: root.querySelector('#edit-teacher').value.trim(),
            color: color === PRESETS.get(id)?.color ? null : color,
          };
        });
        dialog.close();
      });
    },
  );
}

/* ------------------------------------------------------------------- コマ操作 */

/** 週表示のコマをタップしたときのメニュー。 */
export function openCellMenu(day, period, dateKey) {
  const state = getState();
  const lesson = lessonAt(state, day, period, dateKey);
  const info = getPeriod(period);
  const date = fromDateKey(dateKey);
  const title = `${date.getMonth() + 1}/${date.getDate()}（${DAY_NAMES[day]}） ${period}限 ${formatMinutes(info.startMinutes)}`;

  if (!lesson.subject && lesson.status !== 'cancelled') {
    openSubjectPicker(title, (id) => setTemplate(day, period, id));
    return;
  }

  const isCancelled = lesson.status === 'cancelled';
  openSheet(
    title,
    `
    <p class="sheet-sub">${lesson.subject ? escapeHtml(lesson.subject.name) : '休講'}</p>
    <div class="menu">
      ${lesson.subject ? '<button type="button" class="menu-item" data-action="edit">この教科を編集（持ち物・教室・先生・色）</button>' : ''}
      <button type="button" class="menu-item" data-action="swap">別の教科に置き換える（毎週）</button>
      <button type="button" class="menu-item" data-action="${isCancelled ? 'uncancel' : 'cancel'}">
        ${isCancelled ? 'この日の休講を取り消す' : 'この日だけ休講にする'}</button>
      <button type="button" class="menu-item is-danger" data-action="clear">この曜日・時限を空にする（毎週）</button>
    </div>`,
    (root) => {
      root.querySelectorAll('.menu-item').forEach((button) => {
        button.addEventListener('click', () => {
          const { action } = button.dataset;
          if (action === 'edit') {
            openSubjectEditor(lesson.subject.id);
            return;
          }
          if (action === 'swap') {
            openSubjectPicker(title, (id) => setTemplate(day, period, id));
            return;
          }
          if (action === 'cancel') setOverride(dateKey, period, { type: 'cancelled' });
          if (action === 'uncancel') setOverride(dateKey, period, null);
          if (action === 'clear') {
            setTemplate(day, period, null);
            setOverride(dateKey, period, null);
          }
          dialog.close();
        });
      });
    },
  );
}

/** 教科を一覧から選ぶ（ドラッグが使えない場面のフォールバック）。 */
export function openSubjectPicker(title, onPick) {
  const state = getState();
  const majors = state.majors.length ? ['普通科目', ...state.majors] : MAJORS;
  const groups = [...new Set(majors)]
    .map((major) => {
      const cards = presetsForMajor(major)
        .map((preset) => {
          const subject = resolveSubject(preset.id, state.subjects);
          return `<button type="button" class="pick-card" style="--subject-color:${subject.color}"
            data-id="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</button>`;
        })
        .join('');
      return `<section class="pick-group"><h3>${escapeHtml(major)}</h3><div class="pick-grid">${cards}</div></section>`;
    })
    .join('');

  openSheet(title, groups, (root) => {
    root.querySelectorAll('.pick-card').forEach((card) => {
      card.addEventListener('click', () => {
        onPick(card.dataset.id);
        dialog.close();
      });
    });
  });
}

/** 月表示で日をタップしたときの、その日の一覧シート。 */
export function openDaySheet(dateKey) {
  const date = fromDateKey(dateKey);
  const state = getState();
  const lessons = lessonsOfDate(state, date);
  const title = `${date.getMonth() + 1}月${date.getDate()}日（${DAY_NAMES[date.getDay()]}）`;

  if (!lessons.length) {
    openSheet(title, '<p class="sheet-sub">この日は授業がありません。</p>');
    return;
  }

  const rows = lessons
    .map((lesson) => {
      const info = getPeriod(lesson.period);
      const label =
        lesson.status === 'cancelled'
          ? '<span class="day-row-name is-cancelled">休講</span>'
          : lesson.subject
            ? `<span class="day-row-name" style="--subject-color:${lesson.subject.color}">
                 ${escapeHtml(lesson.subject.name)}
                 ${lesson.subject.room ? `<small>${escapeHtml(lesson.subject.room)}</small>` : ''}
               </span>`
            : '<span class="day-row-name is-empty">未登録</span>';
      return `<div class="day-row">
        <span class="day-row-time"><b>${lesson.period}</b>${formatMinutes(info.startMinutes)}</span>
        ${label}
        <button type="button" class="button is-small" data-toggle="${lesson.period}">
          ${lesson.status === 'cancelled' ? '戻す' : '休講'}</button>
      </div>`;
    })
    .join('');

  openSheet(title, `<div class="day-list">${rows}</div>`, (root) => {
    root.querySelectorAll('[data-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const period = Number(button.dataset.toggle);
        const current = getState().overrides?.[dateKey]?.[String(period)];
        setOverride(dateKey, period, current?.type === 'cancelled' ? null : { type: 'cancelled' });
        openDaySheet(dateKey); // 再描画
      });
    });
  });
}

/* ------------------------------------------------------------------- 更新関数 */

/** 週テンプレートの 1 コマを設定する（null で削除）。 */
export function setTemplate(day, period, subjectId) {
  update((state) => {
    const dayKey = String(day);
    const periods = state.template[dayKey] ?? (state.template[dayKey] = {});
    if (subjectId) periods[String(period)] = subjectId;
    else delete periods[String(period)];
  });
}

/** 日付ごとの上書きを設定する（null で解除）。 */
export function setOverride(dateKey, period, value) {
  update((state) => {
    if (!value) {
      if (state.overrides[dateKey]) {
        delete state.overrides[dateKey][String(period)];
        if (!Object.keys(state.overrides[dateKey]).length) delete state.overrides[dateKey];
      }
      return;
    }
    const periods = state.overrides[dateKey] ?? (state.overrides[dateKey] = {});
    periods[String(period)] = value;
  });
}
