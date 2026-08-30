/** アプリ本体。ビュー切り替え、カードパレット、ドラッグ操作、設定をまとめる。 */

import { MAJORS, SPECIALIZED_MAJORS, GENERAL_MAJOR, presetsForMajor, resolveSubject } from './subjects.js';
import { getState, update, subscribe, exportJSON, replaceState } from './store.js';
import { renderWeek, weekLabel, mondayOf, escapeHtml } from './view-week.js';
import { renderMonth, monthLabel } from './view-month.js';
import { enableDrag } from './dnd.js';
import {
  openCellMenu,
  openDaySheet,
  openSubjectEditor,
  setTemplate,
  closeSheet,
} from './editor.js';
import {
  enablePush,
  disablePush,
  isStandalone,
  pushStatus,
  registerServiceWorker,
  sendTestPush,
} from './push.js';
import { toDateKey } from './schedule.js';

const view = document.getElementById('view');
const viewLabel = document.getElementById('view-label');
const palette = document.getElementById('palette');
const paletteTabs = document.getElementById('palette-tabs');
const trash = document.getElementById('trash');
const sheetBody = document.getElementById('sheet-body');
const dialog = document.getElementById('sheet');

let mode = getState().settings.defaultView;
let anchor = new Date();
let activeMajor = GENERAL_MAJOR;
let selectedSubjectId = null; // タップで選択 → コマをタップして配置

/* ------------------------------------------------------------------ 描画 */

function render() {
  const state = getState();
  document.body.dataset.mode = mode;
  if (mode === 'week') {
    renderWeek(view, state, anchor);
    viewLabel.textContent = weekLabel(anchor);
  } else {
    renderMonth(view, state, anchor);
    viewLabel.textContent = monthLabel(anchor);
  }
  document.querySelectorAll('.segment-button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  renderPalette();
}

function renderPalette() {
  const state = getState();
  const majors = [GENERAL_MAJOR, ...state.majors.filter((m) => m !== GENERAL_MAJOR)];
  const available = majors.length > 1 ? majors : MAJORS;
  if (!available.includes(activeMajor)) activeMajor = available[0];

  paletteTabs.innerHTML = available
    .map(
      (major) => `<button type="button" class="tab${major === activeMajor ? ' is-active' : ''}"
        data-major="${escapeHtml(major)}">${escapeHtml(major.replace('専攻', ''))}</button>`,
    )
    .join('');

  palette.innerHTML = presetsForMajor(activeMajor)
    .map((preset) => {
      const subject = resolveSubject(preset.id, state.subjects);
      const isSelected = selectedSubjectId === preset.id;
      return `<button type="button" class="subject-card${isSelected ? ' is-selected' : ''}"
        style="--subject-color:${subject.color}" data-drag="preset" data-id="${escapeHtml(preset.id)}">
        <span class="subject-name">${escapeHtml(subject.name)}</span>
        ${subject.items.length ? `<span class="subject-items">${escapeHtml(subject.items.join('・'))}</span>` : ''}
      </button>`;
    })
    .join('');
}

subscribe(render);

/* -------------------------------------------------------------- ナビゲーション */

function shift(direction) {
  const next = new Date(anchor);
  if (mode === 'week') next.setDate(next.getDate() + 7 * direction);
  else next.setMonth(next.getMonth() + direction);
  anchor = next;
  render();
}

document.getElementById('prev').addEventListener('click', () => shift(-1));
document.getElementById('next').addEventListener('click', () => shift(1));
document.getElementById('today').addEventListener('click', () => {
  anchor = new Date();
  render();
});

document.querySelectorAll('.segment-button').forEach((button) => {
  button.addEventListener('click', () => {
    mode = button.dataset.mode;
    update((state) => {
      state.settings.defaultView = mode;
    });
    render();
  });
});

paletteTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  activeMajor = tab.dataset.major;
  renderPalette();
});

/* ------------------------------------------------------------ ドラッグ&ドロップ */

function payloadFor(element) {
  if (element.dataset.drag === 'preset') return { type: 'preset', id: element.dataset.id };
  if (element.dataset.drag === 'cell') {
    const day = Number(element.dataset.day);
    const period = Number(element.dataset.period);
    const state = getState();
    const id = state.template?.[String(day)]?.[String(period)];
    if (!id) return null; // 空のコマはドラッグできない
    return { type: 'cell', id, day, period };
  }
  return null;
}

function handleDrop(payload, target) {
  if (target.id === 'trash') {
    if (payload.type === 'cell') setTemplate(payload.day, payload.period, null);
    return;
  }
  const day = Number(target.dataset.day);
  const period = Number(target.dataset.period);
  if (!day || !period) return;
  if (payload.type === 'cell' && payload.day === day && payload.period === period) return;

  if (payload.type === 'cell') {
    // 入れ替え: 移動先の科目を元の位置に移す。
    const state = getState();
    const replaced = state.template?.[String(day)]?.[String(period)] ?? null;
    setTemplate(payload.day, payload.period, replaced);
  }
  setTemplate(day, period, payload.id);
}

enableDrag(document.getElementById('app'), {
  itemSelector: '[data-drag]',
  dropSelector: '[data-drop]',
  getPayload: payloadFor,
  onDrop: handleDrop,
  onDragStart: () => trash.classList.add('is-visible'),
  onDragEnd: () => trash.classList.remove('is-visible'),
  onTap: (element) => {
    if (element.dataset.drag === 'preset') {
      selectedSubjectId = selectedSubjectId === element.dataset.id ? null : element.dataset.id;
      renderPalette();
      return;
    }
    if (element.dataset.drag === 'cell') {
      const day = Number(element.dataset.day);
      const period = Number(element.dataset.period);
      if (selectedSubjectId) {
        setTemplate(day, period, selectedSubjectId);
        selectedSubjectId = null;
        return;
      }
      openCellMenu(day, period, element.dataset.date);
    }
  },
});

// 月表示の日タップ（ドラッグ対象ではないので個別に拾う）。
view.addEventListener('click', (event) => {
  const day = event.target.closest('.month-day');
  if (day) openDaySheet(day.dataset.date);
});

// パレットのカードを長押しせずに編集したいとき用。
palette.addEventListener('dblclick', (event) => {
  const card = event.target.closest('.subject-card');
  if (card) openSubjectEditor(card.dataset.id);
});

/* ------------------------------------------------------------------- 設定 */

function openSettings() {
  const state = getState();
  const majorChecks = SPECIALIZED_MAJORS.map(
    (major) => `<label class="check">
      <input type="checkbox" value="${escapeHtml(major)}" ${state.majors.includes(major) ? 'checked' : ''}>
      <span>${escapeHtml(major)}</span>
    </label>`,
  ).join('');

  sheetBody.innerHTML = `
    <header class="sheet-head">
      <h2>設定</h2>
      <button type="button" class="icon-button" data-close aria-label="閉じる">✕</button>
    </header>
    <div class="sheet-content">
      <section class="settings-block">
        <h3>専攻</h3>
        <p class="sheet-sub">選んだ専攻の教科がパレットに並びます。</p>
        <div class="checks" id="major-checks">${majorChecks}</div>
      </section>

      <section class="settings-block">
        <h3>通知</h3>
        <p class="sheet-sub" id="push-status">確認中…</p>
        <label class="field">
          <span class="field-label">何分前に通知するか</span>
          <input id="lead-minutes" type="number" min="1" max="60" step="1" value="${state.settings.leadMinutes}">
        </label>
        <div class="sheet-actions">
          <button type="button" class="button is-primary" id="push-enable">通知を有効にする</button>
          <button type="button" class="button" id="push-test">テスト通知</button>
          <button type="button" class="button is-danger" id="push-disable">通知を止める</button>
        </div>
        ${isStandalone() ? '' : '<p class="hint">iPad では 共有 → 「ホーム画面に追加」 してから開くと通知が使えます。</p>'}
      </section>

      <section class="settings-block">
        <h3>データ</h3>
        <div class="sheet-actions">
          <button type="button" class="button" id="data-export">エクスポート</button>
          <label class="button" for="data-import">インポート</label>
          <input id="data-import" type="file" accept="application/json" hidden>
        </div>
      </section>
    </div>`;

  sheetBody.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  sheetBody.querySelector('#major-checks').addEventListener('change', (event) => {
    const checked = [...sheetBody.querySelectorAll('#major-checks input:checked')].map((i) => i.value);
    update((state) => {
      state.majors = checked;
    });
    if (event) activeMajor = checked.includes(activeMajor) ? activeMajor : GENERAL_MAJOR;
    renderPalette();
  });

  sheetBody.querySelector('#lead-minutes').addEventListener('change', (event) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value < 1 || value > 60) return;
    update((state) => {
      state.settings.leadMinutes = Math.round(value);
    });
  });

  const statusLine = sheetBody.querySelector('#push-status');
  const refreshStatus = async () => {
    const status = await pushStatus();
    statusLine.textContent = status.message;
    statusLine.dataset.state = status.state;
  };
  refreshStatus();

  sheetBody.querySelector('#push-enable').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await enablePush();
      update((state) => {
        state.settings.notifyEnabled = true;
      });
    } catch (error) {
      statusLine.textContent = error.message;
    } finally {
      button.disabled = false;
      refreshStatus();
    }
  });

  sheetBody.querySelector('#push-disable').addEventListener('click', async () => {
    await disablePush();
    update((state) => {
      state.settings.notifyEnabled = false;
    });
    refreshStatus();
  });

  sheetBody.querySelector('#push-test').addEventListener('click', async () => {
    try {
      await sendTestPush();
      statusLine.textContent = 'テスト通知を送信しました。';
    } catch (error) {
      statusLine.textContent = error.message;
    }
  });

  sheetBody.querySelector('#data-export').addEventListener('click', () => {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `timetable-${toDateKey(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  sheetBody.querySelector('#data-import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      replaceState(JSON.parse(await file.text()));
      dialog.close();
    } catch (error) {
      statusLine.textContent = '読み込めませんでした。';
    }
  });

  if (!dialog.open) dialog.showModal();
}

document.getElementById('settings').addEventListener('click', openSettings);

/* ------------------------------------------------------------------- 起動 */

// 初回起動時は専攻の選択を促す。
if (!getState().majors.length && !localStorage.getItem('timetable.onboarded')) {
  localStorage.setItem('timetable.onboarded', '1');
  setTimeout(openSettings, 400);
}

// 土日に開いたときは、過ぎた週ではなく次の週を出す。
const startOfToday = new Date();
if (mode === 'week' && (startOfToday.getDay() === 0 || startOfToday.getDay() === 6)) {
  startOfToday.setDate(startOfToday.getDate() + (startOfToday.getDay() === 6 ? 2 : 1));
}
anchor = mode === 'week' ? mondayOf(startOfToday) : new Date();
render();
registerServiceWorker().catch((error) => console.warn('Service Worker の登録に失敗', error));

// 日付が変わったら「今日」の強調を更新する。
let lastDateKey = toDateKey(new Date());
setInterval(() => {
  const key = toDateKey(new Date());
  if (key !== lastDateKey) {
    lastDateKey = key;
    render();
  }
}, 60_000);

export { closeSheet };
