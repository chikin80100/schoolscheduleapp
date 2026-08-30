/**
 * 専攻ごとの教科プリセット。
 * 持ち物は初期状態では空で、ユーザーがカード編集で追加する。
 */

export const GENERAL_MAJOR = '普通科目';

/**
 * 専攻ごとの基準色。専門科目は専攻ごとに色相をそろえ、明度だけをずらす。
 * 普通科目は 17 科目あり同系色では見分けられないため、色相そのものを散らす。
 */
const MAJOR_STYLE = {
  普通科目: { spread: true, sat: 44, light: 46 },
  機械加工専攻: { hue: 24, sat: 62 },
  ロボット専攻: { hue: 275, sat: 48 },
  電気専攻: { hue: 45, sat: 68 },
  電子情報専攻: { hue: 188, sat: 52 },
};

const PRESET_NAMES = {
  普通科目: [
    '数学Ⅲ',
    '数学C',
    '英語コミュニケーション',
    '英語演習',
    '地学基礎',
    '生物基礎',
    '物理',
    '論理国語',
    '国語表現',
    '歴史総合',
    '政治・経済',
    'フードデザイン',
    '体育',
    '美術表現',
    'プロゼミ２',
    'LHR',
    '実習',
  ],
  機械加工専攻: ['機械設計', '技術者入門', '原動機', '機械工作', '製図', '生産技術'],
  ロボット専攻: ['電子機械', '技術者入門', 'ハードウェア技術', '機械工作', 'ロボット工学', '機械設計'],
  電気専攻: [
    '電力技術',
    '電気回路',
    '電気実習',
    '電力技術Ｂ',
    '電子技術',
    '電気製図',
    '電気機器',
    '電気回路Ｂ',
  ],
  電子情報専攻: [
    '電気回路',
    '電子回路',
    'ハードウェア技術',
    '通信応用',
    '通信技術',
    'プログラミング技術',
  ],
};

/** 専攻名の一覧（普通科目が先頭）。 */
export const MAJORS = Object.keys(PRESET_NAMES);

/** 専攻を除いた専門科目の専攻名。設定画面の選択肢に使う。 */
export const SPECIALIZED_MAJORS = MAJORS.filter((major) => major !== GENERAL_MAJOR);

/** 同名の科目が複数専攻に存在するため、ID は "専攻:科目名" で一意にする。 */
export function subjectId(major, name) {
  return `${major}:${name}`;
}

function colorFor(major, index, total) {
  const style = MAJOR_STYLE[major] ?? { hue: 210, sat: 20 };
  if (style.spread) {
    // 黄金角(137.5°)ずつ回すと、隣り合う科目の色相が最も離れる。
    const hue = Math.round((index * 137.5) % 360);
    return `hsl(${hue} ${style.sat}% ${style.light}%)`;
  }
  // 同じ専攻の中で明度を 36%〜62% の範囲に分散させる。
  const light = total <= 1 ? 48 : 36 + Math.round((index / (total - 1)) * 26);
  return `hsl(${style.hue} ${style.sat}% ${light}%)`;
}

function buildPresets() {
  const presets = new Map();
  for (const major of MAJORS) {
    const names = PRESET_NAMES[major];
    names.forEach((name, index) => {
      const id = subjectId(major, name);
      presets.set(id, {
        id,
        name,
        major,
        color: colorFor(major, index, names.length),
        items: [], // 持ち物の初期値は空
        room: '',
        teacher: '',
      });
    });
  }
  return presets;
}

/** id -> プリセット定義。 */
export const PRESETS = buildPresets();

/** 指定した専攻のプリセット一覧。 */
export function presetsForMajor(major) {
  return [...PRESETS.values()].filter((subject) => subject.major === major);
}

/**
 * プリセットにユーザーの編集内容を重ねた、表示・通知用の科目データを返す。
 * 未知の ID（プリセットから消えた科目）でも壊れないようフォールバックする。
 */
export function resolveSubject(id, overrides) {
  if (!id) return null;
  const preset = PRESETS.get(id);
  const custom = overrides?.[id] ?? {};
  const [major, ...rest] = id.split(':');
  const base = preset ?? {
    id,
    name: rest.join(':') || id,
    major,
    color: 'hsl(210 16% 48%)',
    items: [],
    room: '',
    teacher: '',
  };
  return {
    ...base,
    color: custom.color || base.color,
    items: Array.isArray(custom.items) ? custom.items : base.items,
    room: custom.room ?? base.room,
    teacher: custom.teacher ?? base.teacher,
  };
}
