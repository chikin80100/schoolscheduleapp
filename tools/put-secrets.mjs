/**
 * VAPID 鍵を生成して、そのまま Cloudflare に登録する。
 *
 *   npm run secrets
 *
 * `wrangler secret put` は標準入力が端末でなければ stdin から値を読むので、
 * 生成した値を直接流し込める。手で貼り付ける必要がなく、
 * 公開鍵と秘密鍵が別々の生成回のものになる事故も起きない。
 */

import { spawn } from 'node:child_process';
import { generateVapidKeys } from './generate-vapid-keys.mjs';

/** wrangler に 1 つのシークレットを登録する。値は stdin から渡す。 */
function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
      // stdin だけ掴み、wrangler の出力とエラーはそのまま画面に出す。
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32', // Windows では npx が .cmd なのでシェル経由で起動する
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret put ${name} が終了コード ${code} で失敗しました。`));
    });
    child.stdin.end(value);
  });
}

console.log('VAPID 鍵を新しく作って、Cloudflare に登録します。');
console.log('※ すでに登録済みの鍵は置き換わります。通知を有効にしている端末がある場合は、');
console.log('   その端末で通知を有効にし直してください。\n');

const { publicKey, privateKey } = await generateVapidKeys();

try {
  console.log('1/2 VAPID_PUBLIC_KEY を登録しています…');
  await putSecret('VAPID_PUBLIC_KEY', publicKey);
  console.log('\n2/2 VAPID_PRIVATE_KEY を登録しています…');
  await putSecret('VAPID_PRIVATE_KEY', privateKey);
} catch (error) {
  console.error(`\n❌ ${error.message}`);
  console.error('   npx wrangler login でログインしているか、wrangler.toml の設定を確認してください。');
  process.exit(1);
}

console.log('\n✅ 登録しました。シークレットを入れると新しいバージョンが自動で配信されるので、');
console.log('   再デプロイは不要です。\n');
console.log('ローカル開発でも通知を試す場合は、リポジトリ直下に .dev.vars を作って次の 2 行を書いてください。');
console.log('（.dev.vars は Git 管理外です）\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
