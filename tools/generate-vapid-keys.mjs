/**
 * VAPID 鍵ペアを生成する（依存パッケージなし）。
 *
 *   node tools/generate-vapid-keys.mjs
 *
 * 公開鍵は wrangler.toml の [vars] か `wrangler secret put` で、
 * 秘密鍵は必ず `wrangler secret put VAPID_PRIVATE_KEY` で設定する。
 */

import { webcrypto as crypto } from 'node:crypto';

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicKey = toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log('VAPID_PUBLIC_KEY  =', publicKey);
console.log('VAPID_PRIVATE_KEY =', jwk.d);
console.log();
console.log('設定例:');
console.log(`  npx wrangler secret put VAPID_PUBLIC_KEY   # ${publicKey}`);
console.log('  npx wrangler secret put VAPID_PRIVATE_KEY  # 上の秘密鍵');
console.log('  ローカル開発では .dev.vars に同じ 2 つを書く');
