/**
 * VAPID 鍵ペアを生成する（依存パッケージなし）。
 *
 *   node tools/generate-vapid-keys.mjs
 *
 * ここで表示した値は `.dev.vars`（ローカル開発用）に書くほか、手動で
 * `wrangler secret put` に貼り付けるときにも使う。
 * 本番へは `npm run secrets` が生成から登録までまとめて行うので、通常はそちらでよい。
 */

import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * VAPID の鍵ペアを 1 組作る。
 * 公開鍵は非圧縮 P-256 点(65バイト)、秘密鍵はスカラー(32バイト)を base64url にしたもの。
 *
 * 公開鍵と秘密鍵は必ず同じ組で使うこと。混ざると署名が検証できず、
 * エラーは出ないまま通知だけが届かなくなる。
 */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey));
  const { d: privateKey } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey, privateKey };
}

// 直接実行されたときだけ表示する（import しても副作用が出ないように）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { publicKey, privateKey } = await generateVapidKeys();
  console.log('VAPID_PUBLIC_KEY  =', publicKey);
  console.log('VAPID_PRIVATE_KEY =', privateKey);
  console.log();
  console.log('本番に登録するだけなら、貼り付け不要の `npm run secrets` が使えます。');
  console.log('ローカル開発では、リポジトリ直下の .dev.vars に上の 2 行を書いてください。');
}
