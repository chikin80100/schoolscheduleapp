/**
 * Web Push の送信。WebCrypto だけで完結させ、外部パッケージに依存しない。
 *
 *  - VAPID: ES256 で署名した JWT を Authorization ヘッダに載せる (RFC 8292)
 *  - 本文: aes128gcm による暗号化 (RFC 8291 / RFC 8188)
 */

const encoder = new TextEncoder();

/* ------------------------------------------------------------ base64url */

export function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/* ------------------------------------------------------------ VAPID JWT */

/**
 * VAPID 鍵ペアを WebCrypto の JWK 形式に変換する。
 * 公開鍵は非圧縮 P-256 点(65バイト)、秘密鍵はスカラー(32バイト)を base64url にしたもの。
 */
function vapidJwk(publicKey, privateKey) {
  const pub = base64UrlToBytes(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY は非圧縮形式(65バイト)の base64url である必要があります');
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(pub.slice(1, 33)),
    y: bytesToBase64Url(pub.slice(33, 65)),
    d: bytesToBase64Url(base64UrlToBytes(privateKey)),
    ext: true,
  };
}

async function signJwt(audience, subject, vapid) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };
  const unsigned = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  )}`;

  const key = await crypto.subtle.importKey(
    'jwk',
    vapidJwk(vapid.publicKey, vapid.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/* ------------------------------------------------------------ 本文の暗号化 */

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptPayload(payload, p256dh, auth) {
  const clientPublic = base64UrlToBytes(p256dh);
  const authSecret = base64UrlToBytes(auth);

  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, ephemeral.privateKey, 256),
  );

  // RFC 8291 §3.4: 共有秘密と auth secret から入力鍵材料を作る。
  const keyInfo = concat(encoder.encode('WebPush: info\0'), clientPublic, serverPublic);
  const ikm = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  // レコード終端を表す 0x02 を付けてから暗号化する。
  const plaintext = concat(encoder.encode(payload), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

/* ---------------------------------------------------------------- 送信本体 */

/**
 * 1 件の購読に通知を送る。
 * @returns {{ok: boolean, status: number, gone: boolean}} gone=true なら購読は無効（削除してよい）
 */
export async function sendPush(subscription, payload, vapid, { ttl = 600 } = {}) {
  const endpoint = new URL(subscription.endpoint);
  const jwt = await signJwt(endpoint.origin, vapid.subject, vapid);
  const body = await encryptPayload(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    subscription.keys.p256dh,
    subscription.keys.auth,
  );

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
    },
    body,
  });

  return {
    ok: response.ok,
    status: response.status,
    // 404/410 は購読が失効した合図。
    gone: response.status === 404 || response.status === 410,
  };
}
