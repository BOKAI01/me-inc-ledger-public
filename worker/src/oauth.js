/**
 * 「用 Google 登入」：在使用者自己的雲端硬碟建立帳本（drive.file 範圍，只能碰機器人建立的檔案）
 *   GET /auth/start?s=<state>     → 轉到 Google 授權頁
 *   GET /auth/callback            → 換權杖、建立帳本、完成綁定
 *   GET /privacy                  → 隱私權說明
 * 權杖：refresh token 以 AES-GCM 加密存在 KV（tok:...）；access token 只放記憶體
 */
import { getAccessToken, GoogleAuthError } from './google.js';
import { encryptText, decryptText, signState, verifyState, randomKey } from './crypto.js';
import { HEADER_ZH, HEADER_EN, SET_HEADER_ZH, TAB_TXN, TAB_SET } from './zh.js';
import { formatRequests } from './google.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const LEDGER_TITLE = 'Me, Inc. 記帳本';

export class AuthRevokedError extends GoogleAuthError {}

/* ---------- 頻道與綁定鍵 ---------- */
export const bindKey = (ch, uid) => (ch ? `bind:${ch}:${uid}` : `bind:${uid}`);
export const tokKey = (ch, uid) => (ch ? `tok:${ch}:${uid}` : `tok:${uid}`);
export const obKey = (ch, uid) => (ch ? `ob:${ch}:${uid}` : `ob:${uid}`);

/* ---------- 依帳本取得 Google access token ---------- */
const accessCache = new Map();   // tok 鍵 → { token, exp }

/** 這個錯誤是否代表使用者要重新連結 Google（順便清掉失效的快取） */
export function needsRelink(err, ledger) {
  if (!ledger || ledger.auth !== 'oauth') return false;
  if (err instanceof AuthRevokedError || err?.status === 401) { accessCache.delete(ledger.tok); return true; }
  return false;
}

export async function tokenFor(env, ledger, fetchImpl = fetch) {
  if (!ledger || ledger.auth !== 'oauth') return getAccessToken(env.GOOGLE_SA_JSON, fetchImpl);
  const now = Math.floor(Date.now() / 1000);
  const c = accessCache.get(ledger.tok);
  if (c && c.exp - 60 > now) return c.token;
  const blob = await env.KV.get(ledger.tok);
  if (!blob) throw new AuthRevokedError('找不到 Google 授權，請重新連結');
  const refresh = await decryptText(env, blob);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh, grant_type: 'refresh_token',
    }),
  });
  if (res.status === 400 || res.status === 401) {
    const j = await res.json().catch(() => ({}));
    if (j.error === 'invalid_grant') throw new AuthRevokedError('Google 授權已取消或過期，請重新連結');
    throw new GoogleAuthError(`Google 授權失敗（${j.error || res.status}）`);
  }
  if (!res.ok) throw new GoogleAuthError(`Google 授權失敗（HTTP ${res.status}）`);
  const j = await res.json();
  accessCache.set(ledger.tok, { token: j.access_token, exp: now + Number(j.expires_in || 3600) });
  return j.access_token;
}

/* ---------- 開始授權：由 LINE 卡片的按鈕開啟 ---------- */
export async function authLink(env, base, ch, uid) {
  const s = await signState(env, { ch, uid, n: randomKey(6) }, 1800);
  // Google 禁止在 LINE 內建瀏覽器登入，openExternalBrowser=1 讓 LINE 改用手機預設瀏覽器開啟
  return `${base}/auth/start?s=${encodeURIComponent(s)}&openExternalBrowser=1`;
}

export async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const st = await verifyState(env, url.searchParams.get('s'));
  if (!st) return page('連結已失效', '<p>這個連結已過期或無效。請回到 LINE，輸入「開始」重新取得連結。</p>', 400);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state: url.searchParams.get('s'),
  });
  return Response.redirect(`${AUTH_URL}?${q}`, 302);
}

export async function handleAuthCallback(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const url = new URL(request.url);
  const st = await verifyState(env, url.searchParams.get('state'));
  const back = lineBack(env, st?.ch, '完成連結');
  if (!st) return page('連結已失效', '<p>請回到 LINE，輸入「開始」重新取得連結。</p>', 400);
  if (url.searchParams.get('error')) {
    return page('尚未完成授權', `<p>你取消了 Google 授權，所以我還沒辦法建立帳本。</p>
      <p>授權只會讓機器人存取「它自己建立的那一份帳本」，看不到你的其他檔案。想再試一次，請回到 LINE 按「用 Google 登入」。</p>
      ${back ? `<a class="btn" href="${lineBack(env, st.ch, '開始')}">回到 LINE</a>` : ''}`);
  }

  // 1. 換取權杖
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`, grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); console.error('token exchange failed', res.status, e.error, e.error_description); return page('授權失敗', `<p>Google 沒有回傳授權，請回到 LINE 再試一次。</p><p class="mute">錯誤代碼：${String(e.error || res.status).replace(/[<>&"]/g, '')}</p>`, 400); }
  const tok = await res.json();
  const granted = String(tok.scope || '').split(' ');
  if (!granted.includes(SCOPE)) {
    return page('需要雲端硬碟權限', '<p>請在 Google 授權頁勾選「建立及編輯檔案」的權限，機器人才能建立你的帳本。</p>', 400);
  }
  if (!tok.refresh_token) return page('授權不完整', '<p>請回到 LINE 再按一次「用 Google 登入」。</p>', 400);

  // 2. 保存加密後的 refresh token
  const tk = tokKey(st.ch, st.uid);
  await env.KV.put(tk, await encryptText(env, tok.refresh_token));
  accessCache.set(tk, { token: tok.access_token, exp: Math.floor(Date.now() / 1000) + Number(tok.expires_in || 3600) });

  // 3. 已有帳本就沿用（重新連結），否則建立新帳本
  const bk = bindKey(st.ch, st.uid);
  let bind = await env.KV.get(bk, 'json');
  if (!bind || bind.auth !== 'oauth') {
    const sheetId = await createLedgerSheet(tok.access_token, fetchImpl);
    const apiKey = randomKey(24);
    bind = { sheetId, ledgerName: '我的帳本', auth: 'oauth', tok: tk, apiKey };
    await env.KV.put(`api:${apiKey}`, JSON.stringify({ sheetId, auth: 'oauth', tok: tk }));
    await env.KV.put(bk, JSON.stringify(bind));
    await env.KV.put(obKey(st.ch, st.uid), JSON.stringify({ step: 'opening' }));
  }
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${bind.sheetId}/edit`;
  return page('帳本已建立 ✅', `
    <p>你的帳本已經建立在<b>你自己的 Google 雲端硬碟</b>，檔名是「${LEDGER_TITLE}」。</p>
    <p class="mute">機器人只能存取這一份帳本。不想用時，可以到 Google 帳戶的「第三方應用程式」移除授權，帳本仍會完整留在你的雲端硬碟。</p>
    ${back ? `<a class="btn" href="${back}">回到 LINE 繼續設定</a>` : '<p>請回到 LINE，輸入「完成連結」繼續。</p>'}
    <p><a href="${sheetUrl}" target="_blank" rel="noopener">查看我的帳本</a></p>`);
}

/* ---------- 在使用者雲端硬碟建立帳本 ---------- */
export async function createLedgerSheet(accessToken, fetchImpl = fetch) {
  const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const res = await fetchImpl('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      properties: { title: LEDGER_TITLE, locale: 'zh_TW', timeZone: 'Asia/Taipei' },
      sheets: [
        { properties: { title: TAB_TXN, gridProperties: { frozenRowCount: 1 } } },
        { properties: { title: TAB_SET, gridProperties: { frozenRowCount: 1 } } },
      ],
    }),
  });
  if (!res.ok) throw new GoogleAuthError(`建立帳本失敗（HTTP ${res.status}）`);
  const j = await res.json();
  const id = j.spreadsheetId;
  const w = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        { range: `'${TAB_TXN}'!A1`, values: [HEADER_ZH] },
        { range: `'${TAB_SET}'!A1`, values: [SET_HEADER_ZH, ['期初存款', 0, '開通時的存款，計算餘額的起點'], ['結算日', 1, '每月幾號開始新的一期（1–28）'], ['緊急備用金目標', 50000, '緊急備用金的目標金額']] },
      ],
    }),
  });
  if (!w.ok) throw new GoogleAuthError(`初始化帳本失敗（HTTP ${w.status}）`);
  // 凍結標題列、隱藏系統欄位、金額千分位（失敗不影響使用）
  try {
    const gid = (t) => (j.sheets || []).find(x => x.properties?.title === t)?.properties?.sheetId;
    const reqs = formatRequests(gid(TAB_TXN), gid(TAB_SET), HEADER_EN);
    if (reqs.length) {
      await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { method: 'POST', headers: h, body: JSON.stringify({ requests: reqs }) });
    }
  } catch (err) { console.error('format failed', err); }
  return id;
}

/* ---------- 頁面 ---------- */
export function lineBack(env, ch, msg) {
  const id = ch === 'pub' ? env.LINE_PUB_BASIC_ID : env.LINE_BASIC_ID;
  return id ? `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(msg)}` : '';
}

export function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
body{margin:0;font-family:-apple-system,"Noto Sans TC","PingFang TC",sans-serif;background:#F6F1E7;color:#1F2A24}
main{max-width:520px;margin:0 auto;padding:40px 20px;line-height:1.7}
h1{font-size:22px;color:#1F3A2E;margin:0 0 16px}
.btn{display:block;text-align:center;background:#1F3A2E;color:#fff;text-decoration:none;padding:14px;border-radius:10px;margin:24px 0 12px;font-weight:600}
.mute{color:#6B6B6B;font-size:14px} a{color:#1F3A2E}
h2{font-size:17px;margin:24px 0 6px;color:#1F3A2E} li{margin:4px 0}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function privacyPage(env) {
  return page('隱私權說明', `
<p class="mute">最後更新：2026 年 10 月</p>
<h2>我們存了什麼</h2>
<ul>
<li><b>你的帳本資料</b>：存在<b>你自己的 Google 雲端硬碟</b>，擁有者是你，我們的伺服器不保留副本。</li>
<li><b>Google 授權權杖</b>：加密後保存在伺服器，只用來讀寫機器人為你建立的那一份帳本。</li>
<li><b>LINE 使用者 ID</b>：用來辨識你的帳本，以及暫存尚未確認的記帳卡片（最多保留 7 天）。</li>
<li><b>你改過的分類</b>：例如「咖啡豆」改成「娛樂」，下次會自動套用。</li>
<li><b>群組分帳資料</b>：分帳區的成員名稱、項目與金額存在我們的伺服器，只有該分帳區成員看得到。分帳結束後依建立者選擇保留 90 天或 7 天後自動刪除。</li>
<li><b>分帳收款帳號</b>：只在分帳進行中加密保存，群組卡片只顯示末 4 碼，<b>分帳結束時立即刪除</b>。若你勾選「記住我的收款帳號」，會存在你自己的 Google 試算表。</li>
</ul>
<h2>權限範圍</h2>
<p>只申請 Google 的「drive.file」權限：機器人只能存取<b>它自己建立的檔案</b>，看不到你雲端硬碟的其他檔案、信件或聯絡人。</p>
<h2>我們不會做的事</h2>
<ul><li>不販售、不分享你的資料給任何第三方</li><li>不用你的資料投放廣告</li><li>不主動推播行銷訊息</li></ul>
<h2>如何停用與刪除</h2>
<ul>
<li>到 <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener">Google 帳戶 → 第三方應用程式</a> 移除授權，機器人立即失去存取權。</li>
<li>帳本檔案仍留在你的雲端硬碟，可自行保留或刪除。</li>
<li>在 LINE 輸入「刪除我的資料」，會清除伺服器上的授權權杖、綁定與分類記憶。</li>
</ul>
${env.CONTACT_EMAIL ? `<h2>聯絡我們</h2><p>${env.CONTACT_EMAIL}</p>` : ''}`);
}
