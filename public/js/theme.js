/**
 * ライト／ダークの切り替え。
 * 'system' のときは OS の設定に追従し、'light' / 'dark' のときはそれに固定する。
 * 選択は端末ごとの見やすさの都合なので、同期はせず localStorage に置く。
 */

const THEME_KEY = 'timetable.theme';
const DARK_QUERY = window.matchMedia('(prefers-color-scheme: dark)');

/** アドレスバーやステータスバーの色。ヘッダーの背景に合わせる。 */
const THEME_COLORS = { dark: '#101418', light: '#ffffff' };

const listeners = new Set();

export function getThemePreference() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ストレージが使えない環境では OS の設定に任せる。
  }
  return 'system';
}

/** 実際に表示しているテーマ（'light' か 'dark'）。 */
export function effectiveTheme() {
  const preference = getThemePreference();
  if (preference !== 'system') return preference;
  return DARK_QUERY.matches ? 'dark' : 'light';
}

export function setThemePreference(preference) {
  try {
    if (preference === 'light' || preference === 'dark') localStorage.setItem(THEME_KEY, preference);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // 保存できなくても、この画面の間は切り替えを効かせる。
  }
  applyTheme(preference);
}

/** 今の見た目と逆のテーマに固定する。ヘッダーのボタン用。 */
export function toggleTheme() {
  setThemePreference(effectiveTheme() === 'dark' ? 'light' : 'dark');
}

export function onThemeChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyTheme(preference = getThemePreference()) {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;

  const theme = preference === 'system' ? (DARK_QUERY.matches ? 'dark' : 'light') : preference;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  listeners.forEach((listener) => listener(theme, preference));
}

// 「自動」のときは、OS 側でライト／ダークが切り替わったら追従する。
DARK_QUERY.addEventListener('change', () => {
  if (getThemePreference() === 'system') applyTheme('system');
});

applyTheme();
