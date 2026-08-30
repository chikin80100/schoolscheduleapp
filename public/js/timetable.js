/**
 * 週テンプレートと日付ごとの上書きを解決する純粋関数群。
 * フロントエンドの表示と Worker の通知判定で同じロジックを使う。
 */

import { hasPeriod } from './schedule.js';
import { resolveSubject } from './subjects.js';

/** 空の保存データ。localStorage と D1 の両方で同じ形を使う。 */
export function emptyState() {
  return {
    version: 1,
    majors: [],
    subjects: {},
    template: {},
    overrides: {},
    settings: { leadMinutes: 10, notifyEnabled: false, defaultView: 'week' },
  };
}

/**
 * 欠けたキーを補い、想定外の値を捨てて安全な形に正規化する。
 * 古い保存データや Worker が受け取った任意の JSON にも使う。
 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;

  const template = {};
  for (const [day, periods] of Object.entries(raw.template ?? {})) {
    if (!periods || typeof periods !== 'object') continue;
    const entries = {};
    for (const [period, id] of Object.entries(periods)) {
      if (typeof id === 'string' && id) entries[period] = id;
    }
    template[day] = entries;
  }

  const overrides = {};
  for (const [dateKey, periods] of Object.entries(raw.overrides ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !periods || typeof periods !== 'object') continue;
    const entries = {};
    for (const [period, value] of Object.entries(periods)) {
      if (!value || typeof value !== 'object') continue;
      if (value.type === 'cancelled') entries[period] = { type: 'cancelled' };
      else if (value.type === 'replace' && typeof value.subjectId === 'string') {
        entries[period] = { type: 'replace', subjectId: value.subjectId };
      }
    }
    if (Object.keys(entries).length) overrides[dateKey] = entries;
  }

  const subjects = {};
  for (const [id, value] of Object.entries(raw.subjects ?? {})) {
    if (!value || typeof value !== 'object') continue;
    subjects[id] = {
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
    majors: Array.isArray(raw.majors) ? raw.majors.filter((m) => typeof m === 'string') : [],
    subjects,
    template,
    overrides,
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
