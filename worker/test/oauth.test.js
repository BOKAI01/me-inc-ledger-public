import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleEvent } from '../src/index.js';
import { encryptText, decryptText, signState, verifyState, b64u } from '../src/crypto.js';
import { HEADER } from './helpers.js';
import { fakeKV, fakeEntryNS, fakeSheetsApi } from './helpers.js';
import { HEADER_ZH } from '../src/zh.js';
import { resetSheetCaches } from '../src/google.js';

const KEY = b64u(new Uint8Array(32).fill(7));
const UID = 'Unewuser000000000000000000000001';

function world() {
  const w = { replies: [], sheets: {}, tokenCalls: [], revoked: false, createdBy: null };
  const sheets = fakeSheetsApi(w.sheets);
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(String(init.body));
      w.tokenCalls.push(p.get('grant_type'));
      if (p.get('grant_type') === 'authorization_code') {
        return Response.json({ access_token: 'AT1', refresh_token: 'RT-secret', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
      }
      if (w.revoked) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'AT2', expires_in: 3600 });
    }
    if (u === 'https://oauth2.googleapis.com/revoke') { w.revokeCalled = true; return new Response(''); }
    if (u.includes('/values:batchGet')) w.lastAuth = init.headers?.Authorization;
    if (u === 'https://sheets.googleapis.com/v4/spreadsheets' && init.method === 'POST') w.createdBy = init.headers.Authorization;
    const sr = await sheets(url, init);
    if (sr) return sr;
    if (u.startsWith('https://api.line.me/')) { w.replies.push(JSON.parse(init.body)); return Response.json({}); }
    throw new Error('unexpected ' + u);
  };
  w.last = () => w.replies.at(-1).messages;
  return w;
}

function env() {
  resetSheetCaches();
  return {
    TOKEN_ENC_KEY: KEY, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec',
    LINE_PUB_CHANNEL_SECRET: 's', LINE_PUB_CHANNEL_ACCESS_TOKEN: 't', LINE_PUB_BASIC_ID: '@pub',
    KV: fakeKV(), ENTRY: fakeEntryNS(),
  };
}

test('crypto: 加解密與 state 簽章', async () => {
  const e = { TOKEN_ENC_KEY: KEY };
  const c = await encryptText(e, 'hello');
  assert.notEqual(c, 'hello');
  assert.equal(await decryptText(e, c), 'hello');
  const s = await signState(e, { uid: 'U1', ch: 'pub' });
  assert.equal((await verifyState(e, s)).uid, 'U1');
  assert.equal(await verifyState(e, s.slice(0, -2) + 'xx'), null);
  assert.equal(await verifyState(e, await signState(e, { uid: 'U1' }, -5)), null);   // 過期
});

test('開通全流程：歡迎 → Google 登入 → 自動建帳本 → 存款 → 結算日 → 記帳 → 網站', async () => {
  const w = world(), E = env();
  const deps = { ch: 'pub', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: UID }, message: { type: 'text', text: t } }, E, deps);
  const tap = (d) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: UID }, postback: { data: d } }, E, deps);

  await handleEvent({ type: 'follow', replyToken: 'r', source: { userId: UID } }, E, deps);
  assert.match(w.last()[0].altText, /記帳機器人/);
  await tap('a=ob_start');
  const card = w.last()[0];
  const btn = card.contents.footer.contents[0].action;
  assert.equal(btn.label, '用 Google 登入');
  assert.match(btn.uri, /^https:\/\/bot\.test\/auth\/start\?s=.+&openExternalBrowser=1$/);
  assert.match(JSON.stringify(card), /為什麼需要這一步/);

  // 以手機瀏覽器開啟 → 轉到 Google
  const start = await worker.fetch(new Request(btn.uri), E, {});
  assert.equal(start.status, 302);
  const g = new URL(start.headers.get('location'));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(g.searchParams.get('access_type'), 'offline');
  assert.equal(g.searchParams.get('redirect_uri'), 'https://bot.test/auth/callback');

  // Google 回呼
  globalThis.fetch = w.fetch;
  const cb = await worker.fetch(new Request(`https://bot.test/auth/callback?code=C&state=${encodeURIComponent(g.searchParams.get('state'))}`), E, {});
  const html = await cb.text();
  assert.equal(cb.status, 200);
  assert.match(html, /帳本已建立/);
  assert.match(html, /line\.me\/R\/oaMessage\/%40pub\/\?%E5%AE%8C%E6%88%90%E9%80%A3%E7%B5%90/);
  assert.equal(w.createdBy, 'Bearer AT1');
  assert.deepEqual(w.sheets.NEW['記帳明細'][0], HEADER_ZH);
  assert.equal(w.sheets.NEW['設定'][0][0], '設定項目');
  const bind = JSON.parse(E.KV.m.get(`bind:pub:${UID}`));
  assert.equal(bind.sheetId, 'NEW'); assert.equal(bind.auth, 'oauth');
  const stored = E.KV.m.get(`tok:pub:${UID}`);
  assert.ok(stored.startsWith('v1.') && !stored.includes('RT-secret'));        // 權杖加密保存
  assert.ok(E.KV.m.get(`api:${bind.apiKey}`));

  // 回到 LINE
  await say('完成連結');
  assert.match(w.last()[0].text, /步驟 2／3/);
  await say('abc');
  assert.match(w.last()[0].text, /請直接輸入數字/);
  await say('52,000');
  assert.match(w.last()[0].text, /\$52,000 已記下[\s\S]*步驟 3／3/);
  await tap('a=obc&d=5');
  assert.match(w.last()[0].text, /開通完成/);
  const site = w.last()[1].contents.footer.contents[0].action.uri;
  assert.match(site, /openExternalBrowser=1#api=https%3A%2F%2Fbot\.test%2Fapi%3Fkey%3D/);
  const settings = Object.fromEntries(w.sheets.NEW['設定'].slice(1).map(r => [r[0], r[1]]));
  assert.equal(settings['期初存款'], 52000); assert.equal(settings['結算日'], 5);
  assert.equal(E.KV.m.has(`ob:pub:${UID}`), false);

  // 開始記帳：用使用者自己的權杖（refresh 取得的 AT2 或 AT1）
  await say('午餐 120');
  const pid = w.last()[0].contents.footer.contents[0].action.data.match(/p=(\w+)/)[1];
  await tap(`a=ok&p=${pid}`);
  assert.equal(w.sheets.NEW['記帳明細'].length, 2);
  assert.deepEqual(w.sheets.NEW['記帳明細'][1].slice(1, 3), ['支出', '食 · 餐飲部']);
  assert.match(w.last()[0].text, /已寫入/);
  assert.match(w.lastAuth, /^Bearer AT/);

  await say('餘額');
  assert.match(w.last()[0].text, /帳戶總額 \$51,880/);

  // 網站 API 也走使用者權杖
  const fd = new FormData(); fd.append('payload', JSON.stringify({ action: 'load' }));
  const r = await worker.fetch(new Request(`https://bot.test/api?key=${bind.apiKey}`, { method: 'POST', body: fd }), E, { waitUntil() {} });
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.data.transactions.length, 1); assert.equal(j.data.openingBalance, 52000);
});

test('授權被撤銷 → 引導重新連結；刪除我的資料', async () => {
  const UID2 = 'Urevoked00000000000000000000002';
  const w = world(), E = env();
  const deps = { ch: 'pub', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: UID2 }, message: { type: 'text', text: t } }, E, deps);
  const tap = (d) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: UID2 }, postback: { data: d } }, E, deps);
  w.sheets.S2 = { Transactions: [HEADER], Settings: [['key', 'value'], ['openingBalance', 0]] };
  E.KV.m.set(`tok:pub:${UID2}`, await encryptText(E, 'RT-old'));
  E.KV.m.set(`bind:pub:${UID2}`, JSON.stringify({ sheetId: 'S2', auth: 'oauth', tok: `tok:pub:${UID2}`, apiKey: 'k'.repeat(24) }));
  E.KV.m.set(`api:${'k'.repeat(24)}`, '{}');
  E.KV.m.set(`cat:${UID2}:咖啡`, '{}');
  w.revoked = true;
  await say('餘額');
  assert.match(w.last()[0].text, /重新連結/);
  await say('重新連結');
  assert.equal(w.last()[0].contents.footer.contents[0].action.label, '用 Google 登入');

  await say('刪除我的資料');
  assert.match(w.last()[0].text, /確定要刪除/);
  await tap('a=wipe');
  assert.match(w.last()[0].text, /已刪除/);
  assert.ok(w.revokeCalled);
  for (const k of [`tok:pub:${UID2}`, `bind:pub:${UID2}`, `api:${'k'.repeat(24)}`, `cat:${UID2}:咖啡`]) assert.equal(E.KV.m.has(k), false, k);
});

test('Google 頁面按取消 → 說明並可重試；隱私頁', async () => {
  const E = env();
  const s = await signState(E, { ch: 'pub', uid: UID });
  const r = await worker.fetch(new Request(`https://bot.test/auth/callback?error=access_denied&state=${encodeURIComponent(s)}`), E, {});
  assert.match(await r.text(), /你取消了 Google 授權/);
  const bad = await worker.fetch(new Request('https://bot.test/auth/start?s=forged.sig'), E, {});
  assert.equal(bad.status, 400);
  const p = await (await worker.fetch(new Request('https://bot.test/privacy'), E, {})).text();
  assert.match(p, /drive\.file/);
});

test('keygen 頁面：腳本語法正確，會產生 43 字元金鑰', async () => {
  const html = await (await worker.fetch(new Request('https://bot.test/keygen'), {}, {})).text();
  const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  const el = { textContent: '' };
  const fakeDoc = { getElementById: (id) => (id === 'k' ? el : {}), createRange: () => ({}) };
  new Function('document', 'window', 'navigator', js)(fakeDoc, {}, {});
  assert.match(el.textContent, /^[A-Za-z0-9_-]{43}$/);
});
