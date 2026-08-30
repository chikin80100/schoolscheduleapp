/**
 * Web Push の購読管理。
 * 実際の通知送信は Cloudflare Worker の Cron Trigger 側で行う。
 *
 * iOS/iPadOS では 16.4 以降、かつ「ホーム画面に追加」した状態でのみ Web Push が使える。
 */

import { deviceId, registerDevice, setPushSubscriptionProvider } from './store.js';

let registration = null;

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  setPushSubscriptionProvider(getSubscription);
  return registration;
}

async function ready() {
  if (registration) return registration;
  registration = await navigator.serviceWorker.ready;
  return registration;
}

export async function getSubscription() {
  if (!isPushSupported()) return null;
  const reg = await ready();
  return reg.pushManager.getSubscription();
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

/** 通知を有効にする。必ずユーザー操作（ボタンタップ）から呼ぶこと。 */
export async function enablePush() {
  if (!isPushSupported()) {
    throw new Error('この環境ではプッシュ通知を使えません。');
  }
  if (isIOS() && !isStandalone()) {
    throw new Error('iPad では「ホーム画面に追加」したアプリから通知を有効にしてください。');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('通知が許可されませんでした。設定アプリから許可してください。');
  }

  const reg = await ready();
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    const response = await fetch('/api/vapid');
    if (!response.ok) throw new Error('サーバの公開鍵を取得できませんでした。');
    const { publicKey } = await response.json();
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  // 購読情報と時間割をサーバに登録する。未参加ならここで同期コードが発行される。
  await registerDevice({ withSubscription: true });
  return subscription;
}

export async function disablePush() {
  const subscription = await getSubscription();
  if (subscription) await subscription.unsubscribe();
  // 購読だけ消す。同期の登録は残すので、他の端末との共有は続く。
  await registerDevice().catch(() => {});
}

/** 動作確認用の即時通知をサーバから送らせる。 */
export async function sendTestPush() {
  const response = await fetch('/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId() }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`テスト通知に失敗しました: ${text || response.status}`);
  }
}

/** 設定画面に出す現在の状態。 */
export async function pushStatus() {
  if (!isPushSupported()) return { state: 'unsupported', message: 'この端末/ブラウザは通知に対応していません。' };
  if (isIOS() && !isStandalone()) {
    return { state: 'needs-install', message: 'ホーム画面に追加したアプリから開くと通知を有効にできます。' };
  }
  if (Notification.permission === 'denied') {
    return { state: 'denied', message: '通知がブロックされています。端末の設定から許可してください。' };
  }
  const subscription = await getSubscription();
  if (subscription) return { state: 'subscribed', message: '通知は有効です（授業の10分前にお知らせします）。' };
  return { state: 'idle', message: '通知はまだ有効になっていません。' };
}
