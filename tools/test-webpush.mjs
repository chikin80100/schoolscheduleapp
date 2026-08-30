/**
 * Worker の通知まわりを、実際の送信先なしで検証するテスト。
 *
 *   node tools/test-webpush.mjs
 *
 *  1. VAPID JWT が公開鍵で検証できること
 *  2. 暗号化した本文を、購読者側の鍵で復号できること（RFC 8291 の往復）
 *  3. 時程どおりの時刻に、正しい教科の通知が組み立てられること
 */

import assert from 'node:assert/strict';
import { sendPush, base64UrlToBytes, bytesToBase64Url } from '../worker/webpush.js';
import { dispatchNotifications, jstNow, buildNotification, normalizeCode } from '../worker/index.js';
import { PERIODS, formatMinutes } from '../public/js/schedule.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ------------------------------------------------------- 購読者側の鍵を作る */

const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
  'deriveBits',
]);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const subscription = {
  endpoint: 'https://push.example.com/send/abc123',
  keys: { p256dh: bytesToBase64Url(uaPublic), auth: bytesToBase64Url(authSecret) },
};

const vapid = {
  publicKey: 'BHtU7lB7-UWdejN-tyHSdk-UpR5k-II6JPGYz_gl3WsD_aQhSS8EQMU9473400irY9Z6Xjk7O1BkX2U-GAGGeWY',
  privateKey: 'UxEZGM-jYsNtlOu3yEvK4KU4g68NHMEzQBYgi1IAyiM',
  subject: 'mailto:test@example.com',
};

/* ------------------------------------------------------------ fetch を差し替え */

let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url, init };
  return new Response(null, { status: 201 });
};

/* --------------------------------------------------------- 1) 送信して検証 */

const payload = { title: '次は 物理（3限 10:50〜）', body: '実習棟A\n持ち物: 教科書、ノート' };
const result = await sendPush(subscription, payload, vapid);
assert.equal(result.ok, true);
assert.equal(captured.url, subscription.endpoint);
assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');

// --- VAPID JWT の検証
const authHeader = captured.init.headers.Authorization;
const [, token] = authHeader.match(/t=([^,]+)/);
const [, sentKey] = authHeader.match(/k=(.+)$/);
assert.equal(sentKey, vapid.publicKey);

const [headerB64, payloadB64, signatureB64] = token.split('.');
const jwtPayload = JSON.parse(decoder.decode(base64UrlToBytes(payloadB64)));
assert.equal(jwtPayload.aud, 'https://push.example.com');
assert.equal(jwtPayload.sub, vapid.subject);
assert.ok(jwtPayload.exp > Math.floor(Date.now() / 1000));

const verifyKey = await crypto.subtle.importKey(
  'raw',
  base64UrlToBytes(vapid.publicKey),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['verify'],
);
const signatureValid = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' },
  verifyKey,
  base64UrlToBytes(signatureB64),
  encoder.encode(`${headerB64}.${payloadB64}`),
);
assert.ok(signatureValid, 'VAPID の署名が検証できませんでした');

/* ------------------------------------------ 2) 購読者側として本文を復号する */

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

function concat(...chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const body = new Uint8Array(captured.init.body);
const salt = body.slice(0, 16);
const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
const idLength = body[20];
const serverPublic = body.slice(21, 21 + idLength);
const ciphertext = body.slice(21 + idLength);

assert.equal(recordSize, 4096);
assert.equal(idLength, 65);

const serverKey = await crypto.subtle.importKey(
  'raw',
  serverPublic,
  { name: 'ECDH', namedCurve: 'P-256' },
  false,
  [],
);
const shared = new Uint8Array(
  await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, uaKeys.privateKey, 256),
);
const ikm = await hkdf(shared, authSecret, concat(encoder.encode('WebPush: info\0'), uaPublic, serverPublic), 32);
const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);

const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
const plaintext = new Uint8Array(
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
);
assert.equal(plaintext[plaintext.length - 1], 0x02, 'レコード終端の 0x02 がありません');
assert.deepEqual(JSON.parse(decoder.decode(plaintext.slice(0, -1))), payload);

/* ------------------------------------------------- 3) 通知タイミングと文面 */

// 日本時間 2026-09-03（木）8:40 = UTC 2026-09-02 23:40
const thursdayMorning = new Date('2026-09-02T23:40:00Z');
const at = jstNow(thursdayMorning);
assert.equal(at.day, 4, '木曜として扱われていません');
assert.equal(at.minutes, 8 * 60 + 40);
assert.equal(at.dateKey, '2026-09-03');

const state = {
  version: 1,
  majors: ['電子情報専攻'],
  subjects: { '電子情報専攻:電子回路': { items: ['教科書', 'レポート用紙'], room: '第2実習室', teacher: '', color: null } },
  template: {
    4: { 1: '電子情報専攻:電子回路', 7: '普通科目:体育' },
    1: { 1: '普通科目:数学Ⅲ' },
  },
  overrides: { '2026-09-10': { 1: { type: 'cancelled' } } },
  settings: { leadMinutes: 10, notifyEnabled: true, defaultView: 'week' },
};

const sentPushes = [];
globalThis.fetch = async (url, init) => {
  sentPushes.push({ url, init });
  return new Response(null, { status: 201 });
};

function fakeDB(rows) {
  return {
    prepare(sql) {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: sql.includes('JOIN') ? rows : [] }),
        first: async () => rows[0] ?? null,
        run: async () => ({}),
      };
      return statement;
    },
    batch: async () => [],
  };
}

/** 通知の対象は「グループの時間割 × 購読済みの端末」なので、その形の行を作る。 */
function deviceRow(id, json) {
  return {
    id,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    json,
  };
}

const env = {
  DB: fakeDB([deviceRow('device-1', JSON.stringify(state))]),
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: vapid.subject,
};

// 木曜 8:40 → 1限の電子回路が通知される
let sent = await dispatchNotifications(env, thursdayMorning);
assert.equal(sent.length, 1);
assert.equal(sent[0].period, 1);
assert.equal(sent[0].subject, '電子回路');

// 木曜 15:10 → 7限（火・木のみ）の体育
sent = await dispatchNotifications(env, new Date('2026-09-03T06:10:00Z'));
assert.equal(sent.length, 1, '木曜の7限が通知されていません');
assert.equal(sent[0].subject, '体育');

// 月曜 15:10 → 月曜に7限は無いので通知なし
sent = await dispatchNotifications(env, new Date('2026-08-31T06:10:00Z'));
assert.equal(sent.length, 0, '月曜に7限の通知が出ています');

// 授業の 10 分前ちょうどでなければ何も送らない
sent = await dispatchNotifications(env, new Date('2026-09-02T23:41:00Z'));
assert.equal(sent.length, 0);

// 休講にした日は通知しない（2026-09-10 は木曜）
sent = await dispatchNotifications(env, new Date('2026-09-09T23:40:00Z'));
assert.equal(sent.length, 0, '休講の日に通知が出ています');

// 土曜は対象外
sent = await dispatchNotifications(env, new Date('2026-09-04T23:40:00Z'));
assert.equal(sent.length, 0);

// 通知を無効にしている端末には送らない
const disabled = { ...state, settings: { ...state.settings, notifyEnabled: false } };
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('d', JSON.stringify(disabled))]) },
  thursdayMorning,
);
assert.equal(sent.length, 0);

// 同じグループに属する 2 台には、それぞれ通知が届く
sent = await dispatchNotifications(
  {
    ...env,
    DB: fakeDB([deviceRow('ipad', JSON.stringify(state)), deviceRow('iphone', JSON.stringify(state))]),
  },
  thursdayMorning,
);
assert.equal(sent.length, 2, '同期グループの全端末に通知されていません');
assert.deepEqual(sent.map((s) => s.deviceId), ['ipad', 'iphone']);

/* --------------------------------------------------------------- 文面確認 */

const withItems = buildNotification(
  { name: '物理', room: '第1実験室', teacher: '山田', items: ['教科書', 'ノート'], color: '' },
  3,
  '2026-09-03',
  4,
);
assert.equal(withItems.title, '次は 物理（3限 10:50〜）');
assert.equal(withItems.body, '第1実験室 / 山田\n持ち物: 教科書、ノート');

const withoutItems = buildNotification({ name: 'LHR', room: '', teacher: '', items: [], color: '' }, 1, '2026-09-03', 4);
assert.equal(withoutItems.body, '持ち物の登録はありません');

/* ---------------------------------------------------------- 同期コード */

// ハイフン・小文字・空白を含む入力を受け付ける
assert.equal(normalizeCode('abcde-fghjk'), 'ABCDEFGHJK');
assert.equal(normalizeCode('ABCDE FGHJK'), 'ABCDEFGHJK');
assert.equal(normalizeCode('ABCDEFGHJK'), 'ABCDEFGHJK');
// 桁数違い・紛らわしい文字(0/1/I/L/O/U)・空は弾く
assert.equal(normalizeCode('ABCDE-FGHJ'), null);
assert.equal(normalizeCode('ABCDEFGHJKL'), null);
assert.equal(normalizeCode('ABCDEFGHI0'), null);
assert.equal(normalizeCode(''), null);
assert.equal(normalizeCode(undefined), null);

/* ------------------------------------------------------------ 時程の確認 */

const expected = ['8:50-9:40', '9:50-10:40', '10:50-11:40', '11:50-12:40', '13:20-14:10', '14:20-15:10', '15:20-16:10'];
assert.deepEqual(
  PERIODS.map((p) => `${formatMinutes(p.startMinutes)}-${formatMinutes(p.endMinutes)}`),
  expected,
);

console.log('すべてのテストに合格しました');
