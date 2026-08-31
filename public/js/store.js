/**
 * 状態の永続化と、複数端末での同期。
 *
 * 端末内の localStorage を正としつつ、同期コードを持つ端末どうしで同じ時間割を共有する。
 * 新旧の判定はサーバが振る版番号 (rev) で行うため、端末の時計がずれていても壊れない。
 * 競合したときはサーバに後から届いた書き込みが残る（後勝ち）。
 */

import { emptyState, normalizeState } from './timetable.js';

const STATE_KEY = 'timetable.v1';
const DEVICE_KEY = 'timetable.deviceId';
const CODE_KEY = 'timetable.syncCode';
const REV_KEY = 'timetable.rev';

const PUSH_DEBOUNCE_MS = 1200;
const POLL_INTERVAL_MS = 60_000;

const listeners = new Set();
const statusListeners = new Set();

let state = load();
let pushTimer = null;
let pollTimer = null;
let pendingPush = false; // 未送信の変更があるか
let pushSubscriptionProvider = null;
let status = { syncing: false, lastSyncedAt: null, error: null };

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

/** この端末の識別子。購読と同期グループの紐づけに使う。 */
export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** 参加中の同期コード（未参加なら null）。 */
export function syncCode() {
  return localStorage.getItem(CODE_KEY);
}

/** 手元が把握している最後の版番号。 */
function localRev() {
  return Number(localStorage.getItem(REV_KEY)) || 0;
}

function rememberSync(code, rev) {
  if (code) localStorage.setItem(CODE_KEY, code);
  if (Number.isFinite(rev)) localStorage.setItem(REV_KEY, String(rev));
}

/** 表示用の同期コード（ABCDE-FGHIJ）。 */
export function formatCode(code) {
  if (!code) return '';
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function getState() {
  return state;
}

export function getSyncStatus() {
  return { ...status, code: syncCode(), rev: localRev() };
}

/** 状態変更を購読する。解除用の関数を返す。 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 同期の進行状況を購読する。 */
export function subscribeStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const listener of statusListeners) listener(getSyncStatus());
}

function notify() {
  for (const listener of listeners) listener(state);
}

/**
 * 状態を更新する。`recipe` は state を受け取り、新しい state を返すか直接書き換える。
 * 保存・再描画・サーバへの反映をまとめて行う。
 * sync: false は、サーバから受け取った内容を当てるときに使う（そのまま送り返さないため）。
 */
export function update(recipe, { sync = true } = {}) {
  const next = recipe(state);
  if (next) state = next;
  persist();
  notify();
  if (sync && syncCode()) schedulePush();
}

/** 通知購読を取得する関数を登録する（push.js から呼ばれる）。 */
export function setPushSubscriptionProvider(provider) {
  pushSubscriptionProvider = provider;
}

/* ------------------------------------------------------------------ 送信 */

function schedulePush() {
  pendingPush = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushState().catch((error) => setStatus({ error: error.message }));
  }, PUSH_DEBOUNCE_MS);
}

/**
 * 未送信の変更を、待たずに送り切る。
 * 編集した直後にアプリを閉じたりホーム画面に戻ったりすると、待ち時間のあいだに
 * ページが止められて変更が届かないことがある。そのままだと通知の内容が古くなる。
 *
 * この場面では通常の fetch は中断されるため、離脱中でも送信が保証される
 * sendBeacon を使う。sendBeacon は POST しか送れないので、
 * Worker 側は /api/state で PUT と POST の両方を受け付けている。
 */
function flushPendingPush() {
  const code = syncCode();
  if (!pendingPush || !code) return;
  clearTimeout(pushTimer);

  const body = JSON.stringify({ code, deviceId: deviceId(), schedule: state });
  if (navigator.sendBeacon?.('/api/state', new Blob([body], { type: 'application/json' }))) {
    pendingPush = false;
    return;
  }
  // sendBeacon が使えない環境向けの保険。keepalive で離脱後も送信を続けさせる。
  fetch('/api/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  })
    .then(() => {
      pendingPush = false;
    })
    .catch(() => {});
}

/** 手元の時間割をサーバに反映する。 */
export async function pushState() {
  const code = syncCode();
  if (!code) return false;
  setStatus({ syncing: true, error: null });
  try {
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceId: deviceId(), schedule: state }),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const { rev } = await response.json();
    rememberSync(code, rev);
    pendingPush = false;
    setStatus({ syncing: false, lastSyncedAt: Date.now() });
    return true;
  } catch (error) {
    setStatus({ syncing: false, error: error.message });
    throw error;
  }
}

/* ------------------------------------------------------------------ 受信 */

/**
 * サーバ側が新しければ取り込む。
 * @returns {boolean} 取り込んだら true
 */
export async function pullState() {
  const code = syncCode();
  if (!code) return false;
  setStatus({ syncing: true, error: null });
  try {
    const response = await fetch(`/api/state?code=${encodeURIComponent(code)}&since=${localRev()}`);
    if (!response.ok) throw new Error(await errorMessage(response));
    const data = await response.json();
    rememberSync(code, data.rev);
    setStatus({ syncing: false, lastSyncedAt: Date.now() });
    if (!data.changed) return false;

    state = normalizeState(data.schedule);
    persist();
    notify();
    return true;
  } catch (error) {
    setStatus({ syncing: false, error: error.message });
    throw error;
  }
}

async function errorMessage(response) {
  try {
    const data = await response.json();
    return data.error ?? `通信に失敗しました (${response.status})`;
  } catch {
    return `通信に失敗しました (${response.status})`;
  }
}

/* -------------------------------------------------------------- 同期の開始 */

/**
 * 端末をサーバに登録する。コードが無ければ新しく発行される。
 * 通知を有効にするときは購読情報も一緒に送る。
 */
export async function registerDevice({ withSubscription = false } = {}) {
  const subscription = withSubscription && pushSubscriptionProvider ? await pushSubscriptionProvider() : null;
  const response = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: deviceId(),
      code: syncCode(),
      schedule: state,
      subscription: subscription?.toJSON ? subscription.toJSON() : subscription,
    }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const { code, rev } = await response.json();
  rememberSync(code, rev);
  setStatus({ lastSyncedAt: Date.now(), error: null });
  startPolling();
  return code;
}

/** この端末で同期を始め、新しい同期コードを発行する。 */
export async function startSync() {
  if (syncCode()) return syncCode();
  return registerDevice();
}

/**
 * 別の端末の同期コードに参加する。
 * 参加先の時間割が、この端末の内容を置き換える。
 */
export async function joinSync(inputCode) {
  const response = await fetch('/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId(), code: inputCode }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));

  const { code, rev, schedule } = await response.json();
  rememberSync(code, rev);
  state = normalizeState(schedule);
  persist();
  notify();
  setStatus({ lastSyncedAt: Date.now(), error: null });
  startPolling();

  // 通知を使っている端末なら、購読も新しいグループに付け替える。
  const subscription = pushSubscriptionProvider ? await pushSubscriptionProvider() : null;
  if (subscription) await registerDevice({ withSubscription: true });
  return code;
}

/** この端末を同期から外す（サーバのデータは他の端末のために残す）。 */
export async function leaveSync() {
  await fetch('/api/sync', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId() }),
  }).catch(() => {});
  localStorage.removeItem(CODE_KEY);
  localStorage.removeItem(REV_KEY);
  stopPolling();
  setStatus({ lastSyncedAt: null, error: null });
}

/* ---------------------------------------------------------------- 定期取得 */

function startPolling() {
  if (pollTimer || !syncCode()) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      pullState().catch(() => {});
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/** 起動時に呼ぶ。参加中なら最新を取り込み、以降は定期的に確認する。 */
export function initSync() {
  // 同期を後から始める場合もあるので、監視は参加状況にかかわらず張っておく
  // （pullState と flushPendingPush は、未参加なら何もせず戻る）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullState().catch(() => {});
    // 画面から離れる前に、未送信の変更を送り切る。
    else flushPendingPush();
  });
  // iOS では閉じるときに visibilitychange が来ないことがあるため、こちらも見る。
  window.addEventListener('pagehide', flushPendingPush);

  if (!syncCode()) return;
  startPolling();
  pullState().catch(() => {});
}

/* -------------------------------------------------------- インポート/エクスポート */

/** 設定 JSON をまるごと差し替える（インポート用）。 */
export function replaceState(raw) {
  update(() => normalizeState(raw));
}

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}
