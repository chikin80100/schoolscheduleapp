/**
 * iCalendar (.ics / RFC 5545) を読み、このアプリの「予定」に変換する。
 *
 * 学校が配る行事予定や、Google カレンダーから書き出したファイルを取り込むために使う。
 * 依存パッケージは増やさず、必要な範囲だけを自前で解釈する。
 *
 * 対応するもの:
 *   VEVENT / SUMMARY / DTSTART / DTEND / UID / EXDATE
 *   終日と時刻つきの両方、複数日にまたがる予定（日ごとに分けて登録する）
 *   RRULE のうち FREQ, INTERVAL, COUNT, UNTIL, BYDAY(週ごと)
 *
 * 対応しないもの:
 *   Asia/Tokyo 以外のタイムゾーン変換（末尾 Z の UTC だけは日本時間に直す。
 *   TZID つきの時刻は書かれたままの時刻として扱う）
 *   RDATE、BYMONTHDAY などの細かい繰り返し指定、VTODO などの他の種類
 */

const MAX_OCCURRENCES = 400; // 繰り返しを展開する上限
const MAX_YEARS = 3; // 繰り返しを追いかける年数
const MAX_SPAN_DAYS = 60; // 1 件が何日にまたがるかの上限
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/* ------------------------------------------------------------ 低レベルの解釈 */

/** 折り返された行（次の行が空白で始まる）を 1 行に戻す。 */
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

/**
 * "DTSTART;TZID=Asia/Tokyo:20260910T090000" のような 1 行を分解する。
 * 値の中にも ':' が出るため、引用符の外にある最初の ':' で切る。
 */
function parseLine(line) {
  let index = 0;
  let quoted = false;
  for (; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) break;
  }
  if (index >= line.length) return null;

  const [name, ...rawParams] = line.slice(0, index).split(';');
  const params = {};
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '').toUpperCase();
  }
  return { name: name.toUpperCase(), params, value: line.slice(index + 1) };
}

/** TEXT 型のエスケープ（\, \; \n \\）を戻す。 */
function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, char) => (char === 'n' || char === 'N' ? '\n' : char));
}

const pad = (value) => String(value).padStart(2, '0');

/** 日付を "YYYY-MM-DD" に。 */
function toDateKey({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 日付を「1970-01-01 からの日数」に直す。日をまたぐ計算をこれで行う。 */
function toDayNumber({ year, month, day }) {
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

function fromDayNumber(days) {
  const date = new Date(days * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** その日の曜日（0=日）。 */
function weekdayOf(days) {
  return new Date(days * 86_400_000).getUTCDay();
}

/**
 * DTSTART/DTEND などの日時を読む。
 * 末尾が Z の UTC は日本時間に直す。TZID つきは書かれたままの時刻として扱う。
 */
function parseDateValue(value, params = {}) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return null;

  const [, y, mo, d, hh, mi, , zulu] = match;
  const isAllDay = params.VALUE === 'DATE' || hh === undefined;
  if (isAllDay) {
    return { year: Number(y), month: Number(mo), day: Number(d), allDay: true, minutes: 0 };
  }

  if (zulu) {
    const jst = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi)) + JST_OFFSET_MS);
    return {
      year: jst.getUTCFullYear(),
      month: jst.getUTCMonth() + 1,
      day: jst.getUTCDate(),
      allDay: false,
      minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes(),
    };
  }
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    allDay: false,
    minutes: Number(hh) * 60 + Number(mi),
  };
}

/* ---------------------------------------------------------------- 繰り返し */

function parseRRule(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return rule;
}

/**
 * 繰り返しを展開して、開始日（日数）の一覧を返す。
 * 上限を超える場合はそこで打ち切る（無限に続く指定を安全に扱うため）。
 */
function expandRecurrence(startDay, rule) {
  const freq = rule.FREQ;
  if (!freq) return [startDay];

  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || Infinity;
  const untilValue = rule.UNTIL ? parseDateValue(rule.UNTIL) : null;
  const untilDay = untilValue ? toDayNumber(untilValue) : Infinity;
  const limitDay = startDay + MAX_YEARS * 366;

  const byWeekdays = (rule.BYDAY ?? '')
    .split(',')
    .map((code) => WEEKDAY_CODES.indexOf(code.replace(/^[-+]?\d+/, '')))
    .filter((index) => index >= 0);

  const days = [];
  const push = (day) => {
    if (day < startDay || day > untilDay || day > limitDay) return false;
    days.push(day);
    return days.length < count && days.length < MAX_OCCURRENCES;
  };

  if (freq === 'WEEKLY' && byWeekdays.length) {
    // DTSTART を含む週の日曜からたどり、指定された曜日だけを拾う。
    const weekStart = startDay - weekdayOf(startDay);
    for (let block = 0; ; block += 1) {
      const base = weekStart + block * 7 * interval;
      if (base > untilDay || base > limitDay) break;
      let room = true;
      for (const weekday of [...byWeekdays].sort((a, b) => a - b)) {
        room = push(base + weekday);
        if (!room) break;
      }
      if (!room) break;
    }
    return days;
  }

  const step = { DAILY: 1, WEEKLY: 7 }[freq];
  if (step) {
    for (let k = 0; ; k += 1) {
      if (!push(startDay + k * step * interval)) break;
    }
    return days;
  }

  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const origin = fromDayNumber(startDay);
    for (let k = 0; ; k += 1) {
      const monthsAhead = (freq === 'MONTHLY' ? 1 : 12) * interval * k;
      const month0 = origin.month - 1 + monthsAhead;
      const year = origin.year + Math.floor(month0 / 12);
      const month = (month0 % 12) + 1;
      // 31 日が無い月などは飛ばす。
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (origin.day > daysInMonth) {
        if (toDayNumber({ year, month, day: 1 }) > Math.min(untilDay, limitDay)) break;
        continue;
      }
      if (!push(toDayNumber({ year, month, day: origin.day }))) break;
    }
    return days;
  }

  return [startDay]; // 知らない FREQ は 1 回きりとして扱う
}

/* ------------------------------------------------------------------ 本体 */

/**
 * .ics の中身を、日付ごとの予定に変換する。
 *
 * @param {string} text .ics ファイルの中身
 * @returns {{dateKey: string, title: string, time: string, uid: string}[]} 日付順
 */
export function parseICalendar(text) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('iCalendar 形式のファイルではないようです。');
  }

  const results = [];
  let event = null;

  for (const rawLine of unfold(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^BEGIN:VEVENT$/i.test(line)) {
      event = { exdates: new Set() };
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (event) results.push(...toOccurrences(event));
      event = null;
      continue;
    }
    if (!event) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    if (name === 'SUMMARY') event.title = unescapeText(value).replace(/\s+/g, ' ').trim();
    else if (name === 'UID') event.uid = value.trim();
    else if (name === 'DTSTART') event.start = parseDateValue(value, params);
    else if (name === 'DTEND') event.end = parseDateValue(value, params);
    else if (name === 'RRULE') event.rrule = parseRRule(value);
    else if (name === 'EXDATE') {
      for (const one of value.split(',')) {
        const excluded = parseDateValue(one, params);
        if (excluded) event.exdates.add(toDateKey(excluded));
      }
    }
  }

  results.sort((a, b) => (a.dateKey === b.dateKey ? a.time.localeCompare(b.time) : a.dateKey.localeCompare(b.dateKey)));
  return results;
}

/** 1 つの VEVENT を、日付ごとの予定に展開する。 */
function toOccurrences(event) {
  if (!event.start || !event.title) return [];

  const startDay = toDayNumber(event.start);
  const time = event.start.allDay ? '' : `${pad(Math.floor(event.start.minutes / 60))}:${pad(event.start.minutes % 60)}`;

  // 何日にまたがるか。終日の DTEND は「終わりの翌日」を指すので 1 日引く。
  let span = 1;
  if (event.end) {
    const diff = toDayNumber(event.end) - startDay;
    if (event.start.allDay) span = Math.max(1, diff);
    else span = Math.max(1, event.end.minutes === 0 && diff > 0 ? diff : diff + 1);
  }
  span = Math.min(span, MAX_SPAN_DAYS);

  const occurrences = [];
  for (const day of expandRecurrence(startDay, event.rrule ?? {})) {
    if (event.exdates.has(toDateKey(fromDayNumber(day)))) continue;
    for (let offset = 0; offset < span; offset += 1) {
      const dateKey = toDateKey(fromDayNumber(day + offset));
      occurrences.push({
        dateKey,
        title: event.title,
        // 複数日にまたがる場合、時刻は初日にだけ付ける。
        time: offset === 0 ? time : '',
        uid: event.uid ?? `${event.title}-${startDay}`,
      });
    }
  }
  return occurrences;
}
