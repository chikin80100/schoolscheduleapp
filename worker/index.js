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

/** 同期コードに使う文字。0/1/I/L/O/U を除き、書き写しの取り違えを避ける。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10; // 30^10 ≒ 5.9e14（約 49 ビット）

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

/** 入力されたコードを正規化する。ハイフンや空白、小文字を許容する。 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  if ([...code].some((char) => !CODE_ALPHABET.includes(char))) return null;
  return code;
}

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

/**
 * 端末を登録し、必要なら時間割を書き込む。
 * code が無ければ新しい同期グループを作って返す。購読情報は通知を使う端末だけ送ってくる。
 */
async function handleSync(request, env) {
  const { deviceId, code: rawCode, subscription, schedule } = await request.json();
  if (!deviceId) return json({ error: 'deviceId が必要です' }, { status: 400 });

  const now = Date.now();
  let code = normalizeCode(rawCode);
  let group = code ? await env.DB.prepare('SELECT * FROM groups WHERE code = ?').bind(code).first() : null;

  if (!group) {
    // 未知のコードを渡された場合も、勝手に他人のグループに入れず新規作成する。
    code = generateCode();
    await env.DB.prepare('INSERT INTO groups (code, json, rev, updated_at) VALUES (?, ?, 1, ?)')
      .bind(code, JSON.stringify(normalizeState(schedule)), now)
      .run();
    group = { code, rev: 1 };
  } else if (schedule) {
    group = await writeGroup(env, code, schedule, now);
  }

  const keys = subscription?.keys;
  await env.DB.prepare(
    `INSERT INTO devices (id, code, endpoint, p256dh, auth, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         code = excluded.code, endpoint = excluded.endpoint,
         p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`,
  )
    .bind(deviceId, code, subscription?.endpoint ?? null, keys?.p256dh ?? null, keys?.auth ?? null, now)
    .run();

  return json({ ok: true, code, rev: group.rev });
}

/** グループの時間割を書き換え、rev を 1 つ進める。 */
async function writeGroup(env, code, schedule, now = Date.now()) {
  const row = await env.DB.prepare(
    `UPDATE groups SET json = ?, rev = rev + 1, updated_at = ? WHERE code = ? RETURNING code, rev`,
  )
    .bind(JSON.stringify(normalizeState(schedule)), now, code)
    .first();
  return row;
}

/** 同期コードで参加する。存在しないコードは 404 にして、勝手に作らない。 */
async function handleJoin(request, env) {
  const { deviceId, code: rawCode } = await request.json();
  const code = normalizeCode(rawCode);
  if (!deviceId || !code) return json({ error: '同期コードの形式が正しくありません' }, { status: 400 });

  const group = await env.DB.prepare('SELECT * FROM groups WHERE code = ?').bind(code).first();
  if (!group) return json({ error: 'この同期コードは見つかりませんでした' }, { status: 404 });

  await env.DB.prepare(
    `INSERT INTO devices (id, code, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code = excluded.code, updated_at = excluded.updated_at`,
  )
    .bind(deviceId, code, Date.now())
    .run();

  return json({ ok: true, code, rev: group.rev, schedule: JSON.parse(group.json) });
}

/** 最新の時間割を取り出す。since に手元の rev を渡すと、変化が無ければ本文を省く。 */
async function handleState(request, env, url) {
  const code = normalizeCode(url.searchParams.get('code'));
  if (!code) return json({ error: '同期コードの形式が正しくありません' }, { status: 400 });

  const group = await env.DB.prepare('SELECT rev, json, updated_at FROM groups WHERE code = ?')
    .bind(code)
    .first();
  if (!group) return json({ error: 'この同期コードは見つかりませんでした' }, { status: 404 });

  const since = Number(url.searchParams.get('since'));
  if (Number.isFinite(since) && since === group.rev) {
    return json({ rev: group.rev, changed: false });
  }
  return json({ rev: group.rev, changed: true, updatedAt: group.updated_at, schedule: JSON.parse(group.json) });
}

/** 時間割を書き込む。到着順の後勝ちで、端末の時計には依存しない。 */
async function handlePutState(request, env) {
  const { code: rawCode, schedule } = await request.json();
  const code = normalizeCode(rawCode);
  if (!code || !schedule) return json({ error: 'code と schedule が必要です' }, { status: 400 });

  const group = await writeGroup(env, code, schedule);
  if (!group) return json({ error: 'この同期コードは見つかりませんでした' }, { status: 404 });
  return json({ ok: true, rev: group.rev });
}

/** 端末の登録を消す。グループ自体は他の端末が使うので残す。 */
async function handleDelete(request, env) {
  const { deviceId } = await request.json();
  if (!deviceId) return json({ error: 'deviceId が必要です' }, { status: 400 });
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId).run();
  return json({ ok: true });
}

async function handleTest(request, env) {
  const { deviceId } = await request.json();
  const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND endpoint IS NOT NULL')
    .bind(deviceId)
    .first();
  if (!row) return json({ error: 'この端末はまだ通知を有効にしていません' }, { status: 404 });

  const result = await sendPush(
    { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
    { title: 'テスト通知', body: '通知は正しく設定されています。', tag: 'test', url: '/' },
    vapidFrom(env),
  );
  if (result.gone) await removeSubscription(env, deviceId);
  return json({ ok: result.ok, status: result.status }, { status: result.ok ? 200 : 502 });
}

/** 失効した購読を消す。通知だけ止め、同期の登録は残す。 */
async function removeSubscription(env, deviceId) {
  await env.DB.prepare(
    'UPDATE devices SET endpoint = NULL, p256dh = NULL, auth = NULL WHERE id = ?',
  )
    .bind(deviceId)
    .run();
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
    `SELECT d.id, d.endpoint, d.p256dh, d.auth, g.json
       FROM devices d JOIN groups g ON g.code = d.code
      WHERE d.endpoint IS NOT NULL`,
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
    if (result.gone) await removeSubscription(env, row.id);
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
        if (url.pathname === '/api/join' && request.method === 'POST') return handleJoin(request, env);
        if (url.pathname === '/api/state' && request.method === 'GET') return handleState(request, env, url);
        // POST も受けるのは、離脱時の送信に使う sendBeacon が POST しか送れないため。
        if (url.pathname === '/api/state' && (request.method === 'PUT' || request.method === 'POST')) {
          return handlePutState(request, env);
        }
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
