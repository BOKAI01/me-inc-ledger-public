/* 加密與簽章：權杖以 AES-GCM 加密保存；OAuth state 以 HMAC 簽章防偽造 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (str) => {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

function masterKey(env) {
  const raw = env.TOKEN_ENC_KEY;
  if (!raw) throw new Error('尚未設定 TOKEN_ENC_KEY');
  const bytes = unb64u(raw.replace(/=+$/, ''));
  if (bytes.length < 32) throw new Error('TOKEN_ENC_KEY 長度不足（需 32 bytes）');
  return bytes;
}

async function derive(env, purpose, usage) {
  const mk = masterKey(env);
  const h = await crypto.subtle.digest('SHA-256', new Uint8Array([...mk, ...enc.encode('|' + purpose)]));
  return usage === 'hmac'
    ? crypto.subtle.importKey('raw', h, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    : crypto.subtle.importKey('raw', h, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(env, plain) {
  const key = await derive(env, 'token-v1', 'aes');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return 'v1.' + b64u(iv) + '.' + b64u(ct);
}

export async function decryptText(env, blob) {
  const [v, iv, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('不支援的密文格式');
  const key = await derive(env, 'token-v1', 'aes');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(ct));
  return dec.decode(pt);
}

/** 簽章後的短期資料（OAuth state 用） */
export async function signState(env, obj, ttlSec = 1800) {
  const body = b64u(enc.encode(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  const key = await derive(env, 'state-v1', 'hmac');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return body + '.' + b64u(sig);
}

export async function verifyState(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const key = await derive(env, 'state-v1', 'hmac');
  const ok = await crypto.subtle.verify('HMAC', key, unb64u(sig), enc.encode(body));
  if (!ok) return null;
  const obj = JSON.parse(dec.decode(unb64u(body)));
  return obj.exp >= Math.floor(Date.now() / 1000) ? obj : null;
}

export const randomKey = (bytes = 24) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
