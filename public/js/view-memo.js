/**
 * メモページ。一覧と編集の 2 画面を切り替える。
 * 1 行目をタイトルとして扱い、入力するそばから保存する（保存ボタンは置かない）。
 *
 * 状態が変わるたびに app.js の render() から呼ばれるので、入力中の欄や検索欄を
 * 作り直してカーソルが飛ばないよう、骨組みは使い回して中身だけを差し替える。
 */

import { MAX_NOTES, MAX_NOTE_LENGTH, sortedNotes } from './timetable.js';
import { update } from './store.js';
import { escapeHtml } from './view-week.js';

let openId = null; // 編集中のメモ。null なら一覧
let draftId = null; // 新規作成して、まだ 1 文字も書いていないメモ
let query = '';
let currentState = null; // イベントハンドラから最新の状態を引くため

/** 他の表示へ移るときに呼ぶ。次にメモを開いたときは一覧から始める。 */
export function resetMemo() {
  openId = null;
  draftId = null;
}

export function renderMemo(view, state) {
  currentState = state;
  const note = openId ? state.notes.find((entry) => entry.id === openId) : null;
  // 別の端末で消されたメモを開いていた場合は、一覧に戻す。
  if (openId && !note && openId !== draftId) openId = null;

  if (openId) renderEditor(view, note);
  else renderList(view, state);
}

/* ------------------------------------------------------------------ 一覧 */

function renderList(view, state) {
  let root = view.querySelector(':scope > .memo-page');
  if (!root) {
    view.innerHTML = `
      <div class="memo-page">
        <div class="memo-toolbar">
          <input type="search" class="memo-search" placeholder="メモを検索" aria-label="メモを検索">
          <button type="button" class="button is-primary" data-new>＋ 新しいメモ</button>
        </div>
        <div class="memo-list"></div>
      </div>`;
    root = view.firstElementChild;
    const search = root.querySelector('.memo-search');
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value;
      renderMemo(view, currentState);
    });
    root.querySelector('[data-new]').addEventListener('click', () => {
      if (currentState.notes.length >= MAX_NOTES) {
        alert(`メモは ${MAX_NOTES} 件までです。不要なメモを削除してください。`);
        return;
      }
      draftId = crypto.randomUUID();
      openId = draftId;
      renderMemo(view, currentState);
      view.querySelector('.memo-body')?.focus();
    });
    root.querySelector('.memo-list').addEventListener('click', (event) => {
      const card = event.target.closest('[data-id]');
      if (!card) return;
      openId = card.dataset.id;
      renderMemo(view, currentState);
    });
  }

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const notes = sortedNotes(state).filter((note) => {
    const body = note.body.toLowerCase();
    return words.every((word) => body.includes(word));
  });

  const list = root.querySelector('.memo-list');
  if (!state.notes.length) {
    list.innerHTML = `<p class="memo-empty">メモはまだありません。<br>「＋ 新しいメモ」から書き始められます。</p>`;
  } else if (!notes.length) {
    list.innerHTML = `<p class="memo-empty">「${escapeHtml(query.trim())}」を含むメモはありません。</p>`;
  } else {
    list.innerHTML = notes.map(noteCard).join('');
  }
}

function noteCard(note) {
  const { title, preview } = splitNote(note.body);
  return `<button type="button" class="memo-card" data-id="${escapeHtml(note.id)}">
    <span class="memo-card-head">
      <span class="memo-title">${escapeHtml(title || '（空のメモ）')}</span>
      <time class="memo-date">${escapeHtml(formatUpdated(note.updatedAt))}</time>
    </span>
    ${preview ? `<span class="memo-preview">${escapeHtml(preview)}</span>` : ''}
  </button>`;
}

/** 1 行目をタイトル、残りを抜粋にする。 */
function splitNote(body) {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  return { title: lines[0] ?? '', preview: lines.slice(1).join(' ').slice(0, 120) };
}

/** 今日なら時刻、今年なら月日、それより前なら年から出す。 */
function formatUpdated(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return time;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/* ------------------------------------------------------------------ 編集 */

function renderEditor(view, note) {
  let root = view.querySelector(':scope > .memo-editor');
  if (!root || root.dataset.id !== openId) {
    view.innerHTML = `
      <div class="memo-editor" data-id="${escapeHtml(openId)}">
        <div class="memo-editor-bar">
          <button type="button" class="button is-small" data-back>‹ 一覧</button>
          <span class="memo-status"></span>
          <button type="button" class="button is-small is-danger" data-delete>削除</button>
        </div>
        <textarea class="memo-body" maxlength="${MAX_NOTE_LENGTH}"
          placeholder="1 行目がタイトルになります" aria-label="メモ"></textarea>
      </div>`;
    root = view.firstElementChild;
    const textarea = root.querySelector('.memo-body');
    textarea.value = note?.body ?? '';
    textarea.addEventListener('input', () => saveBody(textarea.value));
    root.querySelector('[data-back]').addEventListener('click', () => closeEditor(view));
    root.querySelector('[data-delete]').addEventListener('click', () => {
      const id = openId;
      if (id !== draftId && !confirm('このメモを削除しますか？')) return;
      openId = null;
      draftId = null;
      update((state) => {
        state.notes = state.notes.filter((entry) => entry.id !== id);
      });
      renderMemo(view, currentState);
    });
  } else if (note) {
    // 別の端末での変更が届いたとき。書いている最中なら、手元の入力を優先する。
    const textarea = root.querySelector('.memo-body');
    if (document.activeElement !== textarea && textarea.value !== note.body) textarea.value = note.body;
  }

  root.querySelector('.memo-status').textContent = note ? `${formatUpdated(note.updatedAt)} に保存` : '';
}

function saveBody(body) {
  const id = openId;
  const now = Date.now();
  update((state) => {
    const note = state.notes.find((entry) => entry.id === id);
    if (note) {
      note.body = body;
      note.updatedAt = now;
    } else if (body.trim()) {
      state.notes.unshift({ id, body, createdAt: now, updatedAt: now });
      if (id === draftId) draftId = null;
    }
  });
}

/** 一覧に戻る。中身を全部消したメモは、そのまま消しておく。 */
function closeEditor(view) {
  const id = openId;
  openId = null;
  draftId = null;
  const note = currentState.notes.find((entry) => entry.id === id);
  if (note && !note.body.trim()) {
    update((state) => {
      state.notes = state.notes.filter((entry) => entry.id !== id);
    });
  }
  renderMemo(view, currentState);
}
