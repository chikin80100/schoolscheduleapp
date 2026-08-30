/**
 * Cloudflare Worker。
 *  - 静的アセット(public/)の配信
 *  - /api/*: 購読と時間割の保存
 *  - Cron Trigger: 授業開始の N 分前にプッシュ通知を送る
 */

import { sendPush } from './webpush.js';
import { DAY_NAMES, formatMinutes, getPeriod, periodStartingAfter } from '../public/js/schedule.js';
import { lessonAt, normalizeState } from '../public/js/timetable.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

function vapidFrom(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error('VAPID 鍵が設定されていません（README のセットアップ手順を参照）');
  }
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };
}

/** 日本時間の「その日の分」と曜日を返す。日本には夏時間が無いので固定オフセットでよい。 */
export function jstNow(date = new Date()) {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    day: jst.getUTCDay(),
    minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes(),
    dateKey: jst.toISOString().slice(0, 10),
  };
}

/** 通知の文面を組み立てる。持ち物が空なら、その行は出さない。 */
export function buildNotification(subject, period, dateKey, day) {
  const info = getPeriod(period);
  const lines = [];
  const place = [subject.room, subject.teacher].filter(Boolean).join(' / ');
  if (place) lines.push(place);
  if (subject.items.length) lines.push(`持ち物: ${subject.items.join('、')}`);
  else lines.push('持ち物の登録はありません');

  return {
    title: `次は ${subject.name}（${period}限 ${formatMinutes(info.startMinutes)}〜）`,
    body: lines.join('\n'),
    tag: `lesson-${dateKey}-${period}`,
    url: '/',
    day: DAY_NAMES[day],
  };
}

/* ---------------------------------------------------------------- API */

async function handleSync(request, env) {
  const { deviceId, subscription, schedule } = await request.json();
  if (!deviceId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ error: 'deviceId と subscription が必要です' }, { status: 400 });
  }

  const state = normalizeState(schedule);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices (id, endpoint, p256dh, auth, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, updated_at = excluded.updated_at`,
    ).bind(deviceId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now),
    env.DB.prepare(
      `INSERT INTO schedules (device_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).bind(deviceId, JSON.stringify(state), now),
  ]);

  return json({ ok: true });
}

async function handleDelete(request, env) {
  const { deviceId } = await request.json();
  if (!deviceId) return json({ error: 'deviceId が必要です' }, { status: 400 });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM schedules WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId),
  ]);
  return json({ ok: true });
}

async function handleTest(request, env) {
  const { deviceId } = await request.json();
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(deviceId).first();
  if (!row) return json({ error: 'この端末はまだ登録されていません' }, { status: 404 });

  const result = await sendPush(
    { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
    { title: 'テスト通知', body: '通知は正しく設定されています。', tag: 'test', url: '/' },
    vapidFrom(env),
  );
  if (result.gone) await removeDevice(env, deviceId);
  return json({ ok: result.ok, status: result.status }, { status: result.ok ? 200 : 502 });
}

async function removeDevice(env, deviceId) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM schedules WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId),
  ]);
}

/* -------------------------------------------------------------- 通知の送信 */

/**
 * 現在時刻に対して送るべき通知をすべて送る。
 * `now` を渡せる形にして、Cron 相当の動作をテストできるようにしてある。
 */
export async function dispatchNotifications(env, now = new Date()) {
  const { day, minutes, dateKey } = jstNow(now);
  const sent = [];
  if (day === 0 || day === 6) return sent;

  const { results } = await env.DB.prepare(
    `SELECT d.id, d.endpoint, d.p256dh, d.auth, s.json
       FROM devices d JOIN schedules s ON s.device_id = d.id`,
  ).all();

  const vapid = vapidFrom(env);

  for (const row of results ?? []) {
    let state;
    try {
      state = normalizeState(JSON.parse(row.json));
    } catch {
      continue;
    }
    if (!state.settings.notifyEnabled) continue;

    const period = periodStartingAfter(day, minutes, state.settings.leadMinutes);
    if (!period) continue;

    const lesson = lessonAt(state, day, period, dateKey);
    if (!lesson.subject) continue; // 未登録・休講は通知しない

    const payload = buildNotification(lesson.subject, period, dateKey, day);
    const result = await sendPush(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      payload,
      vapid,
    );
    if (result.gone) await removeDevice(env, row.id);
    sent.push({ deviceId: row.id, period, subject: lesson.subject.name, ok: result.ok });
  }

  return sent;
}

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname === '/api/vapid' && request.method === 'GET') {
          return json({ publicKey: vapidFrom(env).publicKey });
        }
        if (url.pathname === '/api/sync' && request.method === 'POST') return handleSync(request, env);
        if (url.pathname === '/api/sync' && request.method === 'DELETE') return handleDelete(request, env);
        if (url.pathname === '/api/test' && request.method === 'POST') return handleTest(request, env);

        // 開発用: 任意の時刻を指定して通知処理を試す。
        if (url.pathname === '/api/dry-run' && env.ALLOW_DRY_RUN === 'true') {
          const at = url.searchParams.get('at');
          const now = at ? new Date(at) : new Date();
          return json({ at: now.toISOString(), sent: await dispatchNotifications(env, now) });
        }
        return json({ error: 'not found' }, { status: 404 });
      } catch (error) {
        return json({ error: String(error.message ?? error) }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatchNotifications(env, new Date(event.scheduledTime)).catch((error) => {
        console.error('通知の送信に失敗しました', error);
      }),
    );
  },
};
