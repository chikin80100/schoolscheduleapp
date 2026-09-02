/** アプリ本体。ビュー切り替え、カードパレット、ドラッグ操作、設定をまとめる。 */

import { MAJORS, SPECIALIZED_MAJORS, GENERAL_MAJOR, presetsForMajor, resolveSubject } from './subjects.js';
import {
  getState,
  update,
  subscribe,
  subscribeStatus,
  exportJSON,
  replaceState,
  formatCode,
  getSyncStatus,
  initSync,
  joinSync,
  leaveSync,
  pullState,
  startSync,
  syncCode,
} from './store.js';
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
import {
  MAX_PERIODS,
  buildPeriods,
  formatMinutes,
  fromDateKey,
  inferTimetableParams,
  parseTime,
  toDateKey,
  toPeriods,
  toTimeValue,
} from './schedule.js';
import { DEFAULT_SHORT_PERIODS, detectedDayPlanCount } from './timetable.js';
import { parseICalendar } from './ical.js';

/** 取り込んだ予定の色。手で作った予定と見分けられるようにそろえる。 */
const IMPORTED_EVENT_COLOR = 'hsl(140 42% 40%)';

const view = document.getElementById('view');
const viewLabel = document.getElementById('view-label');
const palette = document.getElementById('palette');
const paletteTabs = document.getElementById('palette-tabs');
const trash = document.getElementById('trash');
const drawerToggle = document.getElementById('drawer-toggle');
const drawerLabel = document.getElementById('drawer-label');
const sheetBody = document.getElementById('sheet-body');
const dialog = document.getElementById('sheet');

let mode = getState().settings.defaultView;
let anchor = new Date();
let activeMajor = GENERAL_MAJOR;
let selectedSubjectId = null; // タップで選択 → コマをタップして配置

/* --------------------------------------------------------- カードパレットの開閉 */

const DRAWER_KEY = 'timetable.drawerOpen';
const NARROW = '(max-width: 560px)';

// 狭い画面ではパレットが場所を取りすぎるので、既定で畳んでおく。
// 一度でも開閉したら、その選択を端末に覚えさせる（同期はしない。端末ごとの都合のため）。
let drawerOpen = (() => {
  const saved = localStorage.getItem(DRAWER_KEY);
  if (saved !== null) return saved === '1';
  return !window.matchMedia(NARROW).matches;
})();

function renderDrawer() {
  document.body.dataset.drawer = drawerOpen ? 'open' : 'closed';
  drawerToggle.setAttribute('aria-expanded', String(drawerOpen));

  const picked = selectedSubjectId ? resolveSubject(selectedSubjectId, getState().subjects) : null;
  // 畳んでいても、選んだカードが分かるようにバーへ出す。
  drawerLabel.innerHTML = picked
    ? `教科カード <span class="is-picked">選択中: ${escapeHtml(picked.name)}</span>`
    : '教科カード';
}

drawerToggle.addEventListener('click', () => {
  drawerOpen = !drawerOpen;
  localStorage.setItem(DRAWER_KEY, drawerOpen ? '1' : '0');
  renderDrawer();
});

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

  renderDrawer();

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
  if (mode === 'week') {
    next.setDate(next.getDate() + 7 * direction);
  } else {
    // 31 日のまま月を動かすと、30 日までの月を飛び越してしまう（8/31 → 10/1）。
    // 月表示は年と月しか見ないので、1 日に寄せてから動かす。
    next.setDate(1);
    next.setMonth(next.getMonth() + direction);
  }
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
        <h3>時程</h3>
        <div id="periods-panel"></div>
      </section>

      <section class="settings-block">
        <h3>複数端末で同期</h3>
        <div id="sync-panel"></div>
      </section>

      <section class="settings-block">
        <h3>カレンダーの読み込み</h3>
        <p class="sheet-sub">
          学校の行事予定やカレンダーアプリから書き出した .ics ファイルを、予定として取り込めます。
        </p>
        <div class="sheet-actions">
          <label class="button is-primary" for="ics-import">.ics ファイルを選ぶ</label>
          <input id="ics-import" type="file" accept=".ics,text/calendar" hidden>
        </div>
        <div id="ics-panel"></div>
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
  renderSyncPanel();
  renderPeriodsPanel();

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

  sheetBody.querySelector('#ics-import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // 同じファイルを選び直せるようにする
    if (file) await previewCalendar(file);
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

/* -------------------------------------------------------- カレンダーの読み込み */

/**
 * .ics を読んで、取り込む前に中身を見せる。
 * 件数と期間を確かめてから入れられるようにし、いきなり大量の予定が増えないようにする。
 */
async function previewCalendar(file) {
  const panel = sheetBody.querySelector('#ics-panel');
  if (!panel) return;
  panel.innerHTML = '<p class="hint">読み込んでいます…</p>';

  let occurrences;
  try {
    occurrences = parseICalendar(await file.text());
  } catch (error) {
    panel.innerHTML = `<p class="hint is-note">${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!occurrences.length) {
    panel.innerHTML = '<p class="hint is-note">取り込める予定が見つかりませんでした。</p>';
    return;
  }

  const first = fromDateKey(occurrences[0].dateKey);
  const last = fromDateKey(occurrences[occurrences.length - 1].dateKey);
  const range = `${first.getFullYear()}/${first.getMonth() + 1}/${first.getDate()} 〜 ${last.getFullYear()}/${last.getMonth() + 1}/${last.getDate()}`;
  const samples = occurrences
    .slice(0, 5)
    .map((item) => {
      const date = fromDateKey(item.dateKey);
      return `<li>${date.getMonth() + 1}/${date.getDate()} ${escapeHtml(item.time || '終日')} ${escapeHtml(item.title)}</li>`;
    })
    .join('');

  const planDays = detectedDayPlanCount(occurrences);

  panel.innerHTML = `
    <div class="ics-preview">
      <p><b>${occurrences.length}件</b>の予定が見つかりました（${escapeHtml(range)}）。</p>
      ${
        planDays
          ? `<p class="ics-plans">うち <b>${planDays}日</b>は短縮授業・◯曜日課として読み取れました。
             その日の時程と時間割を自動で切り替えます。</p>`
          : ''
      }
      <ul class="ics-samples">${samples}</ul>
      ${occurrences.length > 5 ? `<p class="hint">ほか ${occurrences.length - 5} 件</p>` : ''}
      <div class="sheet-actions">
        <button type="button" class="button is-primary" id="ics-apply">この内容を取り込む</button>
        <button type="button" class="button" id="ics-cancel">やめる</button>
      </div>
      <p class="hint">すでにある予定は消えません。同じファイルを読み直しても重複しません。</p>
    </div>`;

  panel.querySelector('#ics-cancel').addEventListener('click', () => {
    panel.innerHTML = '';
  });

  panel.querySelector('#ics-apply').addEventListener('click', () => {
    const added = importCalendar(occurrences);
    render();
    panel.innerHTML = `<p class="hint is-note">${added}件の予定を取り込みました。</p>`;
  });
}

/**
 * 読み取った予定を保存データに入れる。
 * id に .ics の UID を使うので、同じファイルを読み直しても増えず、上書きになる。
 * 手で作った予定（別の id）はそのまま残る。
 *
 * @returns {number} 取り込んだ件数
 */
function importCalendar(occurrences) {
  update((state) => {
    for (const item of occurrences) {
      const list = state.events[item.dateKey] ?? (state.events[item.dateKey] = []);
      const event = {
        id: `ics:${item.uid}:${item.dateKey}`,
        title: item.title,
        time: item.time,
        color: IMPORTED_EVENT_COLOR,
      };
      const index = list.findIndex((existing) => existing.id === event.id);
      if (index >= 0) list[index] = event;
      else list.push(event);
    }
  });
  return occurrences.length;
}

/* ------------------------------------------------------------------ 時程 */

/**
 * 時程の設定。
 * 上のまとめ入力で一気に組み立てられるほか、時限ごとに開始・終了を直接直せる。
 * どちらの結果も state.periods（"HH:MM" の配列）に入り、そのまま同期と通知に効く。
 */
/** 時程パネルでいまどちらを編集しているか。 */
let editingSchedule = 'normal';

function renderPeriodsPanel(message = '') {
  const panel = sheetBody.querySelector('#periods-panel');
  if (!panel) return;

  const state = getState();
  const isShort = editingSchedule === 'short';
  const periods = toPeriods(isShort ? state.shortPeriods : state.periods);
  const params = inferTimetableParams(periods);
  const rows = periods
    .map(
      (info) => `<div class="period-row">
        <span class="period-no">${info.period}</span>
        <input type="time" data-period-start="${info.period}" value="${toTimeValue(info.startMinutes)}">
        <span class="period-sep">〜</span>
        <input type="time" data-period-end="${info.period}" value="${toTimeValue(info.endMinutes)}">
        <span class="period-length">${info.endMinutes - info.startMinutes}分</span>
      </div>`,
    )
    .join('');

  panel.innerHTML = `
    <div class="tabs" id="tt-tabs">
      <button type="button" class="tab${isShort ? '' : ' is-active'}" data-schedule="normal">通常</button>
      <button type="button" class="tab${isShort ? ' is-active' : ''}" data-schedule="short">短縮</button>
    </div>
    <p class="sheet-sub">
      ${
        isShort
          ? '「短縮授業」の予定がある日に使う時程です。「40分授業」のように長さが書かれている日は、その数字が優先されます。'
          : '授業と休み時間の長さを変えられます。変更は通知の時刻にも反映されます。'
      }
    </p>

    <div class="period-form">
      <label class="field is-inline">
        <span class="field-label">1限の開始</span>
        <input id="tt-first" type="time" value="${params.firstStart}">
      </label>
      <label class="field is-inline">
        <span class="field-label">授業</span>
        <input id="tt-class" type="number" min="1" max="180" value="${params.classMinutes}">
      </label>
      <label class="field is-inline">
        <span class="field-label">休憩</span>
        <input id="tt-break" type="number" min="0" max="120" value="${params.breakMinutes}">
      </label>
      <label class="field is-inline">
        <span class="field-label">昼休み</span>
        <input id="tt-lunch" type="number" min="0" max="180" value="${params.lunchMinutes}">
      </label>
      <label class="field is-inline is-wide">
        <span class="field-label">昼休みの位置</span>
        <select id="tt-lunch-after">
          ${Array.from({ length: MAX_PERIODS - 1 }, (_, i) => i + 1)
            .map((n) => `<option value="${n}"${n === params.lunchAfter ? ' selected' : ''}>${n}限のあと</option>`)
            .join('')}
        </select>
      </label>
    </div>
    <div class="sheet-actions">
      <button type="button" class="button is-primary" id="tt-apply">この内容で作り直す</button>
      <button type="button" class="button" id="tt-reset">既定に戻す</button>
    </div>

    <p class="field-label">時限ごとの時刻</p>
    <div class="period-list">${rows}</div>
    ${message ? `<p class="hint is-note">${escapeHtml(message)}</p>` : ''}`;

  const savePeriods = (list, note) => {
    update((current) => {
      if (isShort) current.shortPeriods = list;
      else current.periods = list;
    });
    render();
    renderPeriodsPanel(note);
  };

  panel.querySelector('#tt-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    editingSchedule = tab.dataset.schedule;
    renderPeriodsPanel();
  });

  panel.querySelector('#tt-apply').addEventListener('click', () => {
    const classMinutes = Number(panel.querySelector('#tt-class').value);
    const breakMinutes = Number(panel.querySelector('#tt-break').value);
    const lunchMinutes = Number(panel.querySelector('#tt-lunch').value);
    const firstStart = panel.querySelector('#tt-first').value;
    if (!Number.isFinite(classMinutes) || classMinutes < 1 || parseTime(firstStart) === null) {
      renderPeriodsPanel('開始時刻と授業の長さを確認してください。');
      return;
    }
    savePeriods(
      buildPeriods({
        firstStart,
        classMinutes,
        breakMinutes: Number.isFinite(breakMinutes) ? breakMinutes : 0,
        lunchMinutes: Number.isFinite(lunchMinutes) ? lunchMinutes : 0,
        lunchAfter: Number(panel.querySelector('#tt-lunch-after').value),
      }),
      '時程を作り直しました。',
    );
  });

  panel.querySelector('#tt-reset').addEventListener('click', () => {
    savePeriods(
      isShort ? DEFAULT_SHORT_PERIODS.map((entry) => ({ ...entry })) : buildPeriods(),
      '既定の時程に戻しました。',
    );
  });

  // 時限ごとの直接編集。1 つ直すたびに保存し、おかしい値はその場で知らせる。
  panel.querySelectorAll('[data-period-start], [data-period-end]').forEach((input) => {
    input.addEventListener('change', () => {
      const next = periods.map((info) => ({
        start: toTimeValue(info.startMinutes),
        end: toTimeValue(info.endMinutes),
      }));
      const index = Number(input.dataset.periodStart ?? input.dataset.periodEnd) - 1;
      const key = input.dataset.periodStart ? 'start' : 'end';
      if (parseTime(input.value) === null) {
        renderPeriodsPanel('時刻の形式が正しくありません。');
        return;
      }
      if (parseTime(next[index][key]) === parseTime(input.value)) return; // 変わっていない
      next[index][key] = input.value;

      // 開始 < 終了、かつ前の時限より後ろ。崩れていたら保存せずに知らせる。
      let previousEnd = -1;
      for (const entry of next) {
        const start = parseTime(entry.start);
        const end = parseTime(entry.end);
        if (end <= start || start < previousEnd) {
          renderPeriodsPanel(
            `${index + 1}限の時刻が前後しています。開始より終了をあとにし、前の時限と重ならないようにしてください。`,
          );
          return;
        }
        previousEnd = end;
      }
      savePeriods(next, `${index + 1}限を ${formatMinutes(parseTime(next[index].start))} 〜 ${formatMinutes(parseTime(next[index].end))} にしました。`);
    });
  });
}

/** 設定シート内の同期セクションを描き直す。 */
function renderSyncPanel(message = '') {
  const panel = sheetBody.querySelector('#sync-panel');
  if (!panel) return;

  const { code, lastSyncedAt, syncing, error } = getSyncStatus();
  const note = message || error || '';
  const lastLine = lastSyncedAt
    ? `最終同期 ${new Date(lastSyncedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
    : '';

  panel.innerHTML = code
    ? `
      <p class="sheet-sub">他の端末でこのコードを入力すると、同じ時間割になります。</p>
      <div class="sync-code" id="sync-code" role="group" aria-label="同期コード">
        <code>${escapeHtml(formatCode(code))}</code>
        <button type="button" class="button is-small" id="sync-copy">コピー</button>
      </div>
      <p class="hint">${escapeHtml(lastLine)}${syncing ? ' / 同期中…' : ''}</p>
      <div class="sheet-actions">
        <button type="button" class="button" id="sync-pull">今すぐ取り込む</button>
        <button type="button" class="button is-danger" id="sync-leave">この端末の同期をやめる</button>
      </div>
      ${note ? `<p class="hint is-note">${escapeHtml(note)}</p>` : ''}`
    : `
      <p class="sheet-sub">同期を始めるとコードが発行されます。別の端末ではそのコードを入力してください。</p>
      <div class="sheet-actions">
        <button type="button" class="button is-primary" id="sync-start">同期を始める</button>
      </div>
      <label class="field">
        <span class="field-label">別の端末のコードで参加</span>
        <input id="sync-input" type="text" inputmode="latin" autocapitalize="characters"
          autocomplete="off" spellcheck="false" placeholder="ABCDE-FGHIJ" maxlength="13">
      </label>
      <div class="sheet-actions">
        <button type="button" class="button" id="sync-join">参加する</button>
      </div>
      <p class="hint">参加すると、この端末の時間割は参加先の内容に置き換わります。</p>
      ${note ? `<p class="hint is-note">${escapeHtml(note)}</p>` : ''}`;

  wireSyncPanel(panel);
}

function wireSyncPanel(panel) {
  const run = async (button, action, successMessage) => {
    button.disabled = true;
    try {
      await action();
      renderSyncPanel(successMessage);
    } catch (error) {
      renderSyncPanel(error.message);
    }
  };

  panel.querySelector('#sync-start')?.addEventListener('click', (event) =>
    run(event.currentTarget, startSync, '同期を始めました。'),
  );

  panel.querySelector('#sync-join')?.addEventListener('click', (event) => {
    const value = panel.querySelector('#sync-input').value.trim();
    if (!value) {
      renderSyncPanel('同期コードを入力してください。');
      return;
    }
    run(event.currentTarget, () => joinSync(value), '参加しました。');
  });

  panel.querySelector('#sync-pull')?.addEventListener('click', (event) =>
    run(event.currentTarget, pullState, '最新の内容を取り込みました。'),
  );

  panel.querySelector('#sync-leave')?.addEventListener('click', (event) =>
    run(event.currentTarget, leaveSync, 'この端末の同期をやめました。'),
  );

  panel.querySelector('#sync-copy')?.addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(formatCode(syncCode()));
      event.currentTarget.textContent = 'コピー済み';
    } catch {
      // クリップボードが使えない環境では、選択できるようにするだけにする。
      const range = document.createRange();
      range.selectNodeContents(panel.querySelector('#sync-code code'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
}

// 同期の進行状況が変わったら、設定シートが開いていれば表示を更新する。
subscribeStatus(() => {
  if (!dialog.open || !sheetBody.querySelector('#sync-panel')) return;
  // コード入力中に描き直すと入力が消えるので、そのときは触らない。
  const input = sheetBody.querySelector('#sync-input');
  if (input && (input.value || document.activeElement === input)) return;
  renderSyncPanel();
});

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
initSync();
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
