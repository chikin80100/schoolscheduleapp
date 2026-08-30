/**
 * 時程定義。フロントエンドと Cloudflare Worker の両方から読み込まれる唯一の情報源。
 *
 *   1限 8:50 開始 / 授業 50 分 / 休憩 10 分
 *   4限と5限の間は 40 分の昼休み
 *   月・水・金は 6 時限、火・木は 7 時限
 */

export const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** 授業のある曜日（1=月 … 5=金）。 */
export const SCHOOL_DAYS = [1, 2, 3, 4, 5];

/** 7 時限まである曜日（火・木）。 */
const SEVEN_PERIOD_DAYS = new Set([2, 4]);

/** 4限のあとに挟まる昼休み（分）。 */
export const LUNCH_MINUTES = 40;

const CLASS_MINUTES = 50;
const BREAK_MINUTES = 10;
const FIRST_PERIOD_START = 8 * 60 + 50;
const MAX_PERIODS = 7;

function buildPeriods() {
  const periods = [];
  let start = FIRST_PERIOD_START;
  for (let period = 1; period <= MAX_PERIODS; period += 1) {
    const end = start + CLASS_MINUTES;
    periods.push({ period, startMinutes: start, endMinutes: end });
    // 4限のあとだけ昼休み、それ以外は 10 分休憩。
    start = end + (period === 4 ? LUNCH_MINUTES : BREAK_MINUTES);
  }
  return periods;
}

/** 全 7 時限の開始・終了時刻（分単位、0:00 起点）。 */
export const PERIODS = buildPeriods();

/** 昼休みの時間帯（4限終了 〜 5限開始）。 */
export const LUNCH = {
  startMinutes: PERIODS[3].endMinutes,
  endMinutes: PERIODS[4].startMinutes,
};

/** その曜日の時限数を返す（授業のない曜日は 0）。 */
export function periodCountForDay(day) {
  if (!SCHOOL_DAYS.includes(day)) return 0;
  return SEVEN_PERIOD_DAYS.has(day) ? MAX_PERIODS : 6;
}

/** 指定の曜日・時限に授業枠が存在するか。 */
export function hasPeriod(day, period) {
  return period >= 1 && period <= periodCountForDay(day);
}

/** 分を "8:50" 形式に整形する。 */
export function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** 時限の情報を取得する（1 始まり）。 */
export function getPeriod(period) {
  return PERIODS[period - 1] ?? null;
}

/**
 * その曜日で、指定時刻の `leadMinutes` 分後に始まる時限を返す。
 * 通知タイミングの判定に使う（例: 8:40 + 10 分 → 1限）。
 */
export function periodStartingAfter(day, minutesOfDay, leadMinutes) {
  const target = minutesOfDay + leadMinutes;
  const count = periodCountForDay(day);
  for (let period = 1; period <= count; period += 1) {
    if (PERIODS[period - 1].startMinutes === target) return period;
  }
  return null;
}

/** 現在進行中の時限（授業中でなければ null）。 */
export function currentPeriod(day, minutesOfDay) {
  const count = periodCountForDay(day);
  for (let period = 1; period <= count; period += 1) {
    const { startMinutes, endMinutes } = PERIODS[period - 1];
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
