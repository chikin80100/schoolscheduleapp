/**
 * 週テンプレートと日付ごとの上書きを解決する純粋関数群。
 * フロントエンドの表示と Worker の通知判定で同じロジックを使う。
 */

import { DEFAULT_PERIODS, MAX_PERIODS, hasPeriod, parseTime } from './schedule.js';
import { resolveSubject } from './subjects.js';

/** 空の保存データ。localStorage と D1 の両方で同じ形を使う。 */
export function emptyState() {
  return {
    version: 1,
    majors: [],
    subjects: {},
    template: {},
    overrides: {},
    events: {},
    periods: DEFAULT_PERIODS.map((entry) => ({ ...entry })),
    settings: { leadMinutes: 10, notifyEnabled: false, defaultView: 'week' },
  };
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 「実習」は普通科目から各専攻へ移した。すでに登録済みの古い ID を読み替える。
 * どの専攻に寄せるかは、専攻がちょうど 1 つ選ばれているときだけ決められる。
 * 0 個または複数のときは触らない（resolveSubject のフォールバックで表示自体は保たれる）。
 */
const LEGACY_SUBJECT_ID = '普通科目:実習';

function subjectRemapper(majors) {
  const specialized = majors.filter((major) => major !== '普通科目');
  if (specialized.length !== 1) return (id) => id;
  const replacement = `${specialized[0]}:実習`;
  return (id) => (id === LEGACY_SUBJECT_ID ? replacement : id);
}

/**
 * 時程を安全な形に整える。
 * 7 時限ぶんそろっていて、各時限が「開始 < 終了」かつ前の時限より後ろにある場合だけ採用する。
 * ひとつでも崩れていたら、部分的に壊れた時程で通知が出ないよう、まるごと既定値に戻す。
 */
function normalizePeriods(raw) {
  if (!Array.isArray(raw) || raw.length !== MAX_PERIODS) return null;

  const periods = [];
  let previousEnd = -1;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const start = parseTime(entry.start);
    const end = parseTime(entry.end);
    if (start === null || end === null || end <= start || start < previousEnd) return null;
    periods.push({ start: entry.start, end: entry.end });
    previousEnd = end;
  }
  return periods;
}

/** 予定 1 件を安全な形に整える。題名が無いものは捨てる。 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    title: title.slice(0, 80),
    time: typeof raw.time === 'string' && TIME_PATTERN.test(raw.time) ? raw.time : '',
    color: typeof raw.color === 'string' && raw.color ? raw.color : '',
  };
}

/**
 * その日の予定を並べ替えて返す。
 * 時刻の無いもの（終日）を先に、時刻のあるものはその順に並べる。
 */
export function eventsOn(state, dateKey) {
  const list = state.events?.[dateKey] ?? [];
  return [...list].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return -1;
    if (!b.time) return 1;
    return a.time.localeCompare(b.time);
  });
}

/**
 * 欠けたキーを補い、想定外の値を捨てて安全な形に正規化する。
 * 古い保存データや Worker が受け取った任意の JSON にも使う。
 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;

  const majors = Array.isArray(raw.majors) ? raw.majors.filter((m) => typeof m === 'string') : [];
  const remap = subjectRemapper(majors);

  const template = {};
  for (const [day, periods] of Object.entries(raw.template ?? {})) {
    if (!periods || typeof periods !== 'object') continue;
    const entries = {};
    for (const [period, id] of Object.entries(periods)) {
      if (typeof id === 'string' && id) entries[period] = remap(id);
    }
    template[day] = entries;
  }

  const overrides = {};
  for (const [dateKey, periods] of Object.entries(raw.overrides ?? {})) {
    if (!DATE_KEY_PATTERN.test(dateKey) || !periods || typeof periods !== 'object') continue;
    const entries = {};
    for (const [period, value] of Object.entries(periods)) {
      if (!value || typeof value !== 'object') continue;
      if (value.type === 'cancelled') entries[period] = { type: 'cancelled' };
      else if (value.type === 'replace' && typeof value.subjectId === 'string') {
        entries[period] = { type: 'replace', subjectId: remap(value.subjectId) };
      }
    }
    if (Object.keys(entries).length) overrides[dateKey] = entries;
  }

  const events = {};
  for (const [dateKey, list] of Object.entries(raw.events ?? {})) {
    if (!DATE_KEY_PATTERN.test(dateKey) || !Array.isArray(list)) continue;
    const items = list.map(normalizeEvent).filter(Boolean).slice(0, 50);
    if (items.length) events[dateKey] = items;
  }

  const subjects = {};
  for (const [id, value] of Object.entries(raw.subjects ?? {})) {
    if (!value || typeof value !== 'object') continue;
    subjects[remap(id)] = {
      items: Array.isArray(value.items) ? value.items.filter((i) => typeof i === 'string') : [],
      room: typeof value.room === 'string' ? value.room : '',
      teacher: typeof value.teacher === 'string' ? value.teacher : '',
      color: typeof value.color === 'string' && value.color ? value.color : null,
    };
  }

  const settings = raw.settings ?? {};
  const lead = Number(settings.leadMinutes);

  return {
    version: 1,
    majors,
    subjects,
    template,
    overrides,
    events,
    periods: normalizePeriods(raw.periods) ?? DEFAULT_PERIODS.map((entry) => ({ ...entry })),
    settings: {
      leadMinutes: Number.isFinite(lead) && lead > 0 && lead <= 60 ? Math.round(lead) : 10,
      notifyEnabled: settings.notifyEnabled === true,
      defaultView: settings.defaultView === 'month' ? 'month' : 'week',
    },
  };
}

/** テンプレートに登録された科目 ID（上書きは見ない）。 */
export function templateSubjectId(state, day, period) {
  return state.template?.[String(day)]?.[String(period)] ?? null;
}

/**
 * 指定の日付・時限に実際に行われる授業を解決する。
 * dateKey を省略すると週テンプレートのみを見る。
 *
 * @returns {{status: 'none'|'normal'|'replaced'|'cancelled', subject: object|null}}
 */
export function lessonAt(state, day, period, dateKey = null) {
  if (!hasPeriod(day, period)) return { status: 'none', subject: null };

  const override = dateKey ? state.overrides?.[dateKey]?.[String(period)] : null;
  if (override?.type === 'cancelled') return { status: 'cancelled', subject: null };

  const id = override?.type === 'replace' ? override.subjectId : templateSubjectId(state, day, period);
  if (!id) return { status: 'none', subject: null };

  return {
    status: override?.type === 'replace' ? 'replaced' : 'normal',
    subject: resolveSubject(id, state.subjects),
  };
}
