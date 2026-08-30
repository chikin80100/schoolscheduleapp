/**
 * デプロイ前に wrangler.toml の置き換え忘れを見つける。
 *
 *   node tools/check-config.mjs
 *
 * これらは Cloudflare にアップロードして初めて弾かれ、英語のエラーコードで返ってくる。
 * 手元で、実行前に、何をどう直せばよいかまで出す。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let config;
try {
  config = readFileSync(CONFIG_PATH, 'utf8');
} catch {
  console.error(`wrangler.toml が見つかりません（${CONFIG_PATH}）。`);
  console.error('リポジトリのフォルダでコマンドを実行しているか確認してください。');
  process.exit(1);
}

/** TOML パーサを入れずに、必要な値だけ取り出す。 */
function readValue(key) {
  const match = config.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

const problems = [];
const warnings = [];

const databaseId = readValue('database_id');
if (!databaseId || !UUID_PATTERN.test(databaseId)) {
  problems.push(
    [
      'wrangler.toml の database_id が設定されていません。',
      databaseId ? `  いまの値: "${databaseId}"` : '  database_id の行が見つかりません。',
      '',
      '  直し方:',
      '    1) npx wrangler d1 list          … timetable の uuid を控える',
      '       （一覧に無ければ npx wrangler d1 create timetable で作る）',
      '    2) wrangler.toml の次の行を、その uuid に書き換える',
      '',
      '       database_id = "8f2c1a4b-9e3d-4f7a-b1c2-3d4e5f6a7b8c"',
      '',
      '  ※ [[d1_databases]] のブロックは 1 つだけです。貼り足して 2 つになっていないか確認してください。',
    ].join('\n'),
  );
}

// [[d1_databases]] が複数あると、古い方の値で弾かれる。
const databaseBlocks = config.match(/^\s*\[\[d1_databases\]\]/gm) ?? [];
if (databaseBlocks.length > 1) {
  problems.push(
    `wrangler.toml に [[d1_databases]] が ${databaseBlocks.length} 個あります。1 つだけ残してください。`,
  );
}

const subject = readValue('VAPID_SUBJECT');
if (!subject || subject.includes('you@example.com')) {
  warnings.push(
    [
      'wrangler.toml の VAPID_SUBJECT が既定のままです。',
      '  自分の連絡先（mailto: か https:）に書き換えることをおすすめします。',
      '  Web Push の送信元として配信サービスに伝えられる値です。',
    ].join('\n'),
  );
}

for (const warning of warnings) console.warn(`⚠️  ${warning}\n`);

if (problems.length) {
  console.error('❌ wrangler.toml の設定が足りません。\n');
  for (const problem of problems) console.error(`${problem}\n`);
  process.exit(1);
}

console.log('✅ wrangler.toml の設定を確認しました。');
