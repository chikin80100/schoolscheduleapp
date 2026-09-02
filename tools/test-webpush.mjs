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
import { DEFAULT_PERIODS, buildPeriods, formatMinutes, periodsFrom } from '../public/js/schedule.js';
import { eventsOn, normalizeState } from '../public/js/timetable.js';
import { PRESETS, SPECIALIZED_MAJORS } from '../public/js/subjects.js';

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

// 壊れた購読が 1 件あっても、後続の端末への通知は止まらない
const brokenRow = { ...deviceRow('broken', JSON.stringify(state)), p256dh: 'BROKEN' };
const realError = console.error;
console.error = () => {}; // 想定どおりの失敗なので、ログは伏せる
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([brokenRow, deviceRow('healthy', JSON.stringify(state))]) },
  thursdayMorning,
);
console.error = realError;
assert.equal(sent.length, 2, '壊れた購読で処理が止まっています');
assert.equal(sent[0].ok, false);
assert.equal(sent[1].ok, true, '後続の端末に通知が届いていません');

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

const defaultPeriods = periodsFrom({});
const withItems = buildNotification(
  defaultPeriods,
  { name: '物理', room: '第1実験室', teacher: '山田', items: ['教科書', 'ノート'], color: '' },
  3,
  '2026-09-03',
  4,
);
assert.equal(withItems.title, '次は 物理（3限 10:50〜）');
assert.equal(withItems.body, '第1実験室 / 山田\n持ち物: 教科書、ノート');

const withoutItems = buildNotification(defaultPeriods, { name: 'LHR', room: '', teacher: '', items: [], color: '' }, 1, '2026-09-03', 4);
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

/* ------------------------------------------------------------ 任意の予定 */

const withEvents = normalizeState({
  events: {
    '2026-09-10': [
      { title: ' 体育祭 ', time: '09:00', color: 'hsl(0 62% 50%)' },
      { title: '短縮授業' },
      { title: '   ' }, // 題名が空なので捨てる
      'ごみ', // オブジェクトですらないので捨てる
      { title: '面談', time: '25:99' }, // 時刻が不正なら終日にする
    ],
    'bad-key': [{ title: 'x' }], // 日付キーの形式が違うので捨てる
    '2026-09-11': [], // 空の日はキーごと持たない
  },
});

const day = withEvents.events['2026-09-10'];
assert.equal(day.length, 3);
assert.equal(day[0].title, '体育祭', '前後の空白が落ちていません');
assert.equal(day[2].time, '', '不正な時刻が終日になっていません');
assert.ok(day.every((event) => typeof event.id === 'string' && event.id), 'id が振られていません');
assert.equal(withEvents.events['bad-key'], undefined);
assert.equal(withEvents.events['2026-09-11'], undefined);

// 終日を先に、時刻のあるものはその順に並べる
assert.deepEqual(
  eventsOn(withEvents, '2026-09-10').map((event) => `${event.time}|${event.title}`),
  ['|短縮授業', '|面談', '09:00|体育祭'],
);

// 予定を入れても通知の判定には影響しない（通知は授業だけ）
const stateWithEvent = { ...state, events: { '2026-09-03': [{ id: 'e1', title: '体育祭', time: '', color: '' }] } };
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('device-1', JSON.stringify(stateWithEvent))]) },
  thursdayMorning,
);
assert.equal(sent.length, 1);
assert.equal(sent[0].subject, '電子回路');

/* ------------------------------------------------- 日課の変更と通知の連動 */

// 「40分授業」の木曜。1限は 8:50 開始のままなので通知は 8:40（＝前日 23:40 UTC）
const shortDay = {
  ...state,
  events: { '2026-09-03': [{ id: 's1', title: '40分授業', time: '', color: '' }] },
  overrides: {},
};
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('short', JSON.stringify(shortDay))]) },
  new Date('2026-09-02T23:40:00Z'),
);
assert.equal(sent.length, 1);
assert.equal(sent[0].period, 1);

// 2限は 9:40 開始になるので、通知は 9:30（＝00:30 UTC）。既定の 9:40 では鳴らない
const withSecond = {
  ...shortDay,
  template: { 4: { 1: '電子情報専攻:電子回路', 2: '普通科目:物理' } },
};
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('short', JSON.stringify(withSecond))]) },
  new Date('2026-09-03T00:30:00Z'),
);
assert.equal(sent.length, 1, '短縮の日の 2 限が通知されていません');
assert.equal(sent[0].subject, '物理');
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('short', JSON.stringify(withSecond))]) },
  new Date('2026-09-03T00:40:00Z'),
);
assert.equal(sent.length, 0, '短縮の日に通常の時刻で通知が出ています');

// 「月曜日課」の木曜は、月曜の時間割で通知する
const swapped = {
  ...state,
  events: { '2026-09-03': [{ id: 's2', title: '月曜振替授業', time: '', color: '' }] },
  overrides: {},
  template: { 1: { 1: '普通科目:数学Ⅲ' }, 4: { 1: '電子情報専攻:電子回路' } },
};
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('swap', JSON.stringify(swapped))]) },
  thursdayMorning,
);
assert.equal(sent.length, 1);
assert.equal(sent[0].subject, '数学Ⅲ', '振替先の曜日の教科になっていません');

// 通知の本文に、いつもと違う日であることが入る
const changedBody = buildNotification(
  defaultPeriods,
  { name: '数学Ⅲ', room: '', teacher: '', items: [], color: '' },
  1,
  '2026-09-03',
  4,
  '月曜日課',
);
assert.ok(changedBody.body.includes('（本日は 月曜日課）'), changedBody.body);

/* -------------------------------------------------------------- 教科の構成 */

// 「実習」は普通科目から各専攻へ移した
assert.ok(PRESETS.has('普通科目:キャリア探求'), '普通科目にキャリア探求がありません');
assert.ok(!PRESETS.has('普通科目:実習'), '普通科目に実習が残っています');
for (const major of SPECIALIZED_MAJORS) {
  assert.ok(PRESETS.has(`${major}:実習`), `${major} に実習がありません`);
}

// 登録済みの古い ID は、専攻がちょうど 1 つのときだけ読み替える
const migrated = normalizeState({
  majors: ['電気専攻'],
  template: { 1: { 3: '普通科目:実習', 4: '普通科目:物理' } },
  overrides: { '2026-09-10': { 3: { type: 'replace', subjectId: '普通科目:実習' } } },
  subjects: { '普通科目:実習': { items: ['作業服'], room: '実習棟', teacher: '', color: null } },
});
assert.equal(migrated.template['1']['3'], '電気専攻:実習');
assert.equal(migrated.template['1']['4'], '普通科目:物理', '関係ない科目まで書き換えています');
assert.equal(migrated.overrides['2026-09-10']['3'].subjectId, '電気専攻:実習');
assert.deepEqual(migrated.subjects['電気専攻:実習'].items, ['作業服'], '持ち物が引き継がれていません');
assert.equal(migrated.subjects['普通科目:実習'], undefined);

// 専攻が 0 個または複数なら、寄せ先を決められないので触らない
for (const majors of [[], ['電気専攻', 'ロボット専攻']]) {
  const kept = normalizeState({ majors, template: { 1: { 3: '普通科目:実習' } } });
  assert.equal(kept.template['1']['3'], '普通科目:実習', `majors=${JSON.stringify(majors)} で書き換わっています`);
}

/* ------------------------------------------------------------ 時程の確認 */

const asRanges = (periods) =>
  periods.map((p) => `${formatMinutes(p.startMinutes)}-${formatMinutes(p.endMinutes)}`);

// 既定の時程
assert.deepEqual(asRanges(periodsFrom({})), [
  '8:50-9:40',
  '9:50-10:40',
  '10:50-11:40',
  '11:50-12:40',
  '13:20-14:10',
  '14:20-15:10',
  '15:20-16:10',
]);

// 設定を変えると、その時程になる（授業45分・休憩5分・昼休み50分・3限のあと・8:30開始）
const custom = buildPeriods({
  firstStart: '08:30',
  classMinutes: 45,
  breakMinutes: 5,
  lunchMinutes: 50,
  lunchAfter: 3,
});
assert.deepEqual(asRanges(periodsFrom({ periods: custom })), [
  '8:30-9:15',
  '9:20-10:05',
  '10:10-10:55',
  '11:45-12:30',
  '12:35-13:20',
  '13:25-14:10',
  '14:15-15:00',
]);

// 壊れた時程は保存させず、既定に戻す
for (const broken of [
  [], // 数が足りない
  [...DEFAULT_PERIODS.slice(0, 6), { start: '15:20', end: '15:00' }], // 終了が開始より前
  [...DEFAULT_PERIODS.slice(0, 6), { start: '09:00', end: '09:50' }], // 前の時限と重なる
  [...DEFAULT_PERIODS.slice(0, 6), { start: 'あ', end: 'い' }], // 時刻として読めない
]) {
  assert.deepEqual(
    normalizeState({ periods: broken }).periods,
    DEFAULT_PERIODS,
    '壊れた時程が既定に戻っていません',
  );
}
// まっとうな時程はそのまま保つ
assert.deepEqual(normalizeState({ periods: custom }).periods, custom);

// 時程を変えると、通知の時刻もそれに追従する
const customState = {
  ...state,
  periods: custom,
  template: { 4: { 1: '電子情報専攻:電子回路' } },
  overrides: {},
};
// 1限が 8:30 開始なので、10 分前は 8:20（JST）= 前日 23:20 UTC
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('d1', JSON.stringify(customState))]) },
  new Date('2026-09-02T23:20:00Z'),
);
assert.equal(sent.length, 1, '変更した時程で通知が出ていません');
assert.equal(sent[0].period, 1);
// 既定の 8:40 では、もう鳴らない
sent = await dispatchNotifications(
  { ...env, DB: fakeDB([deviceRow('d1', JSON.stringify(customState))]) },
  new Date('2026-09-02T23:40:00Z'),
);
assert.equal(sent.length, 0, '古い時程のまま通知が出ています');

console.log('すべてのテストに合格しました');
