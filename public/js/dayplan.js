/**
 * 予定の名前から、その日の日課の変更を読み取る。
 *
 *   「40分授業」「45分授業」 → その長さの授業に組み替える
 *   「短縮授業」（長さの指定なし）→ 設定した短縮時程を使う
 *   「月曜日課」「火曜振替授業」 → その曜日の時間割を使う
 *
 * フロントエンドと Worker の両方から使うので、DOM にも保存データにも触らない純粋な関数にする。
 */

const WEEKDAY_NUMBERS = { 月: 1, 火: 2, 水: 3, 木: 4, 金: 5 };

/** 「40分授業」のように長さが書かれている場合。数字をそのまま授業の長さに使う。 */
const CLASS_MINUTES_PATTERN = /(\d{1,3})\s*分(?:授業|短縮|日課)/;

/** 長さの指定はないが短縮だと分かる場合。 */
const SHORT_PATTERN = /短縮/;

/**
 * 「◯曜日課」「◯曜振替授業」の形。
 * 長い言い方から先に試す。「月曜授業参観」のような別の言葉を拾わないよう、
 * 直後が文末か区切り文字のときだけ認める。
 */
const FOLLOW_PATTERN =
  /([月火水木金])曜日?(?:振替授業|振り替え授業|振替日課|振り替え日課|日課|日程|時間割|振替|振り替え|授業|課)(?=$|[\s　（(）)・/／、,.。])/;

/** 授業の長さとして受け付ける範囲。桁の読み違いで極端な値にならないようにする。 */
const MIN_CLASS_MINUTES = 5;
const MAX_CLASS_MINUTES = 120;

/**
 * 予定の名前から、その日の日課を判定する。
 *
 * @param {string[]} titles その日の予定の名前
 * @returns {{schedule: 'normal'|'short', classMinutes: number|null, followDay: number|null, labels: string[]}}
 *   schedule='short' かつ classMinutes=null なら、設定した短縮時程をそのまま使う。
 *   classMinutes に数字が入っていれば、その長さで組み直す。
 */
export function detectDayPlan(titles) {
  let schedule = 'normal';
  let classMinutes = null;
  let followDay = null;
  const labels = [];

  for (const raw of titles) {
    const title = typeof raw === 'string' ? raw : '';
    if (!title) continue;

    if (classMinutes === null) {
      const minutes = Number(CLASS_MINUTES_PATTERN.exec(title)?.[1]);
      if (minutes >= MIN_CLASS_MINUTES && minutes <= MAX_CLASS_MINUTES) {
        schedule = 'short';
        classMinutes = minutes;
        labels.push(`${minutes}分授業`);
      }
    }
    if (schedule === 'normal' && SHORT_PATTERN.test(title)) {
      schedule = 'short';
      labels.push('短縮時程');
    }

    if (followDay === null) {
      const match = FOLLOW_PATTERN.exec(title);
      if (match) {
        followDay = WEEKDAY_NUMBERS[match[1]];
        labels.push(`${match[1]}曜日課`);
      }
    }
  }

  return { schedule, classMinutes, followDay, labels };
}

/** 判定結果が「いつもどおり」かどうか。 */
export function isPlainDay(plan) {
  return plan.schedule === 'normal' && plan.followDay === null;
}
