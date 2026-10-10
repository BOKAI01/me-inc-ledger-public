/**
 * 帳本網站的登入（用 LINE 身分，不再使用寫在連結裡的固定金鑰）
 *   POST /api/session  { idToken }       → 驗證 LINE ID Token，發一組登入憑證 { session, name }
 *   POST /api/logout   Authorization      → 登出這台裝置
 * 之後網站呼叫 /api 時帶 Authorization: Bearer <session>。
 *
 * 登入憑證：KV  sess:<token> → { ch, uid, sv, created, seen }
 *   ・14 天沒使用就失效；最長 90 天一定要重新登入
 *   ・綁定資料的 sv（登入版本）變了就全部失效 → 「登出所有裝置」、刪除資料都會讓舊登入失效
 */
import { verifyIdToken } from './split-web.js';
import { bindKey, obKey } from './oauth.js';
import { randomKey } from './crypto.js';

export const IDLE_SEC = 14 * 24 * 3600;
export const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const TOUCH_MS = 24 * 3600 * 1000;
/** 舊的「連結金鑰」過渡期：之後一律拒絕 */
export const LEGACY_KEY_UNTIL = '2026-10-18T00:00:00+08:00';

const chOf = (env) => env.SPLIT_CHANNEL || '';
const sessKey = (t) => `sess:${t}`;

export function bearer(request) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+([\w-]{20,100})$/);
  return m ? m[1] : '';
}

/** 依登入憑證找出使用者的帳本綁定 → { bind, sess }；失效回傳 null */
export async function bindFromSession(env, token, now = Date.now()) {
  if (!token) return null;
  const s = await env.KV.get(sessKey(token), 'json');
  if (!s) return null;
  if (now - s.created > MAX_AGE_MS) { await env.KV.delete(sessKey(token)); return null; }
  const bind = await env.KV.get(bindKey(s.ch, s.uid), 'json');
  if (!bind || !bind.sheetId || (bind.sv || 0) !== (s.sv || 0)) { await env.KV.delete(sessKey(token)); return null; }
  if (now - (s.seen || 0) > TOUCH_MS) {                  // 有在用就延長（最多寫一次／天）
    await env.KV.put(sessKey(token), JSON.stringify({ ...s, seen: now }), { expirationTtl: IDLE_SEC });
  }
  return { bind, sess: s };
}

export const legacyKeyAllowed = (env, now = Date.now()) => now < Date.parse(env.LEGACY_KEY_UNTIL || LEGACY_KEY_UNTIL);

/** POST /api/session */
export async function createSession(env, idToken, fetchImpl = fetch, now = Date.now()) {
  const who = await verifyIdToken(env, idToken, fetchImpl);
  if (!who) return { ok: false, error: 'auth', message: 'LINE 登入已過期，請重新登入' };
  const ch = chOf(env);
  const bind = await env.KV.get(bindKey(ch, who.uid), 'json');
  if (!bind || !bind.sheetId || await env.KV.get(obKey(ch, who.uid))) {
    return { ok: false, error: 'notBound', message: '你還沒開通記帳帳本。請先在 LINE 加入記帳機器人好友，完成開通後再打開網站。' };
  }
  const token = randomKey(32);
  await env.KV.put(sessKey(token), JSON.stringify({ ch, uid: who.uid, sv: bind.sv || 0, created: now, seen: now }), { expirationTtl: IDLE_SEC });
  return { ok: true, data: { session: token, name: who.name, owner: who.uid } };
}

export async function deleteSession(env, token) {
  if (token) await env.KV.delete(sessKey(token));
}

/** 登出所有裝置：提高登入版本，舊的登入憑證全部失效 */
export async function logoutAll(env, ch, uid) {
  const k = bindKey(ch, uid);
  const bind = await env.KV.get(k, 'json');
  if (!bind) return false;
  await env.KV.put(k, JSON.stringify({ ...bind, sv: (bind.sv || 0) + 1 }));
  return true;
}
