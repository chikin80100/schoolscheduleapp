/**
 * 状態の永続化。localStorage を正とし、変更を Worker（通知用）へ非同期に同期する。
 */

import { emptyState, normalizeState } from './timetable.js';

const STATE_KEY = 'timetable.v1';
const DEVICE_KEY = 'timetable.deviceId';
const SYNC_DEBOUNCE_MS = 1200;

const listeners = new Set();
let state = load();
let syncTimer = null;
let pushSubscriptionProvider = null;

function load() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : emptyState();
  } catch (error) {
    console.warn('保存データを読み込めませんでした', error);
    return emptyState();
  }
}

function persist() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('保存に失敗しました', error);
  }
}

/** この端末の識別子。Worker 側で購読と時間割を紐づけるのに使う。 */
export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getState() {
  return state;
}

/** 状態変更を購読する。解除用の関数を返す。 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 状態を更新する。`recipe` は state を受け取り、新しい state を返すか直接書き換える。
 * 保存・再描画・Worker 同期をまとめて行う。
 */
export function update(recipe, { sync = true } = {}) {
  const next = recipe(state);
  if (next) state = next;
  persist();
  for (const listener of listeners) listener(state);
  if (sync) scheduleSync();
}

/** 通知購読を取得する関数を登録する（push.js から呼ばれる）。 */
export function setPushSubscriptionProvider(provider) {
  pushSubscriptionProvider = provider;
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncNow().catch((error) => console.warn('同期に失敗しました', error));
  }, SYNC_DEBOUNCE_MS);
}

/**
 * 時間割と購読情報を Worker に送る。通知はここで送ったデータを元に組み立てられる。
 * 未購読なら何もしない（通知を使わないユーザーはサーバに何も残さない）。
 */
export async function syncNow() {
  const subscription = pushSubscriptionProvider ? await pushSubscriptionProvider() : null;
  if (!subscription) return false;

  const response = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: deviceId(),
      subscription: subscription.toJSON ? subscription.toJSON() : subscription,
      schedule: state,
    }),
  });
  if (!response.ok) throw new Error(`同期に失敗: ${response.status}`);
  return true;
}

/** 購読解除時に、サーバ側のデータも消す。 */
export async function deleteRemote() {
  await fetch('/api/sync', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId() }),
  });
}

/** 設定 JSON をまるごと差し替える（インポート用）。 */
export function replaceState(raw) {
  update(() => normalizeState(raw));
}

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}
