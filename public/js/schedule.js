/**
 * 時程。フロントエンドと Cloudflare Worker の両方から読み込まれる。
 *
 * 各時限の開始・終了時刻はユーザーが設定できる（設定画面の「時程」）。
 * 保存データには "HH:MM" の文字列で持ち、ここで扱いやすい分単位に直す。
 * 設定していない場合は下の既定値を使う。
 *
 *   既定: 1限 8:50 開始 / 授業 50 分 / 休憩 10 分 / 4限のあと 40 分の昼休み
 *   月・水・金は 6 時限、火・木は 7 時限
 */

export const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** 授業のある曜日（1=月 … 5=金）。 */
export const SCHOOL_DAYS = [1, 2, 3, 4, 5];

/** 7 時限まである曜日（火・木）。 */
const SEVEN_PERIOD_DAYS = new Set([2, 4]);

/** 用意する時限の数。曜日ごとに何限まで使うかは periodCountForDay で決める。 */
export const MAX_PERIODS = 7;

/** 一括生成の既定値。設定画面の「まとめて作り直す」もこの形を使う。 */
export const DEFAULT_TIMETABLE = {
  firstStart: '08:50',
  classMinutes: 50,
  breakMinutes: 10,
  lunchMinutes: 40,
  lunchAfter: 4, // 何限のあとに昼休みを入れるか
};

/** 週表示で休み時間の行を出す下限。10 分休憩まで行にすると細かすぎる。 */
const BREAK_ROW_THRESHOLD = 15;

/** "08:50" → 530。読めない値は null。 */
export function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 分を "8:50" 形式に整形する（表示用）。 */
export function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** 分を "08:50" 形式に整形する（<input type="time"> 用）。 */
export function toTimeValue(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * 開始時刻・授業・休憩・昼休みから、各時限の時刻を組み立てる。
 * @returns {{start: string, end: string}[]} "HH:MM" の配列（保存データの形）
 */
export function buildPeriods(options = {}) {
  const { firstStart, classMinutes, breakMinutes, lunchMinutes, lunchAfter } = {
    ...DEFAULT_TIMETABLE,
    ...options,
  };
  const periods = [];
  let start = parseTime(firstStart) ?? parseTime(DEFAULT_TIMETABLE.firstStart);
  for (let period = 1; period <= MAX_PERIODS; period += 1) {
    const end = start + classMinutes;
    periods.push({ start: toTimeValue(start), end: toTimeValue(end) });
    start = end + (period === lunchAfter ? lunchMinutes : breakMinutes);
  }
  return periods;
}

/** 既定の時程（"HH:MM" の配列）。 */
export const DEFAULT_PERIODS = buildPeriods();

/**
 * 保存データから、分単位に直した時程を取り出す。
 * 設定が無ければ既定値を返すので、呼び出し側は state の中身を気にしなくてよい。
 *
 * @returns {{period: number, startMinutes: number, endMinutes: number}[]}
 */
export function periodsFrom(state) {
  const source = state?.periods?.length === MAX_PERIODS ? state.periods : DEFAULT_PERIODS;
  return source.map((entry, index) => ({
    period: index + 1,
    startMinutes: parseTime(entry.start) ?? 0,
    endMinutes: parseTime(entry.end) ?? 0,
  }));
}

/** その曜日の時限数を返す（授業のない曜日は 0）。 */
export function periodCountForDay(day) {
  if (!SCHOOL_DAYS.includes(day)) return 0;
  return SEVEN_PERIOD_DAYS.has(day) ? MAX_PERIODS : 6;
}

/** 指定の曜日・時限に授業枠が存在するか。 */
export function hasPeriod(day, period) {
  return period >= 1 && period <= periodCountForDay(day);
}

/** 時限の情報を取得する（1 始まり）。 */
export function getPeriod(periods, period) {
  return periods[period - 1] ?? null;
}

/**
 * 時限のあとに続く休み時間。昼休みのようにまとまった休みだけを対象にする
 * （10 分休憩まで行にすると週表示が細切れになるため）。
 *
 * @returns {number|null} 休みの長さ（分）。行にするほどでなければ null
 */
export function longBreakAfter(periods, period) {
  const current = periods[period - 1];
  const next = periods[period];
  if (!current || !next) return null;
  const gap = next.startMinutes - current.endMinutes;
  return gap >= BREAK_ROW_THRESHOLD ? gap : null;
}

/**
 * その曜日で、指定時刻の `leadMinutes` 分後に始まる時限を返す。
 * 通知タイミングの判定に使う（例: 8:40 + 10 分 → 1限）。
 */
export function periodStartingAfter(periods, day, minutesOfDay, leadMinutes) {
  const target = minutesOfDay + leadMinutes;
  const count = periodCountForDay(day);
  for (let period = 1; period <= count; period += 1) {
    if (periods[period - 1].startMinutes === target) return period;
  }
  return null;
}

/** 現在進行中の時限（授業中でなければ null）。 */
export function currentPeriod(periods, day, minutesOfDay) {
  const count = periodCountForDay(day);
  for (let period = 1; period <= count; period += 1) {
    const { startMinutes, endMinutes } = periods[period - 1];
    if (minutesOfDay >= startMinutes && minutesOfDay < endMinutes) return period;
  }
  return null;
}

/** ローカル日付を "YYYY-MM-DD" に整形する（UTC 変換を挟まない）。 */
export function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** "YYYY-MM-DD" をローカル時刻の Date に戻す。 */
export function fromDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}
