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
    if (u.startsWith('https://www.googleapis.com/drive/v3/files')) {
      w.driveCalls = (w.driveCalls || 0) + 1;
      if (w.driveDown) return new Response('{"error":{"message":"Drive API has not been used"}}', { status: 403 });
      return Response.json({ files: (w.drive || []).map(id => ({ id, name: w.sheets[id]?.__title || 'Me, Inc. 記帳本', modifiedTime: '2026-09-30T10:00:00Z' })) });
    }
    if (u.includes('/values:batchGet')) w.lastAuth = init.headers?.Authorization;
    if (u === 'https://sheets.googleapis.com/v4/spreadsheets' && init.method === 'POST') w.createdBy = init.headers.Authorization;
    const sr = await sheets(url, init);
    if (sr) return sr;
    if (u === 'https://api.line.me/oauth2/v2.1/verify') {
      const t = new URLSearchParams(String(init.body)).get('id_token');
      return t.startsWith('tok-') ? Response.json({ sub: t.slice(4), name: '測試者', exp: Date.now() / 1000 + 3600 }) : new Response('bad', { status: 400 });
    }
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
    SPLIT_CHANNEL: 'pub', LINE_LOGIN_CHANNEL_ID: '2000000000', SITE_LIFF_ID: '2000000000-siteABCD',
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
  assert.equal(bind.apiKey, undefined);                                         // 不再產生連結金鑰

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
  assert.equal(site, 'https://liff.line.me/2000000000-siteABCD');               // 連結不含任何金鑰
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

  // 網站：用 LINE 登入換登入憑證，再用憑證呼叫 API（走使用者自己的 Google 權杖）
  const sess = await login(E, w, 'tok-' + UID);
  assert.equal(sess.ok, true, sess.message);
  const j = await callSite(E, sess.data.session, 'load');
  assert.equal(j.ok, true); assert.equal(j.data.transactions.length, 1); assert.equal(j.data.openingBalance, 52000);
});

async function login(E, w, idToken) {
  globalThis.fetch = w.fetch;
  return (await worker.fetch(new Request('https://bot.test/api/session', { method: 'POST', body: JSON.stringify({ idToken }) }), E, { waitUntil() {} })).json();
}
async function callSite(E, session, action, extra = {}, url = 'https://bot.test/api') {
  const fd = new FormData(); fd.append('payload', JSON.stringify({ action, ...extra }));
  const headers = session ? { Authorization: `Bearer ${session}` } : {};
  return (await worker.fetch(new Request(url, { method: 'POST', body: fd, headers }), E, { waitUntil() {} })).json();
}

test('帳本網站登入：只認 LINE 身分、未開通拒絕、登出所有裝置、舊金鑰過渡期', async () => {
  const U1 = 'Usite00000000000000000000000001', U2 = 'Usite00000000000000000000000002';
  const w = world(), E = env();
  w.sheets.S1 = { Transactions: [HEADER], Settings: [['key', 'value'], ['openingBalance', 100]] };
  E.KV.m.set(`tok:pub:${U1}`, await encryptText(E, 'RT'));
  E.KV.m.set(`bind:pub:${U1}`, JSON.stringify({ sheetId: 'S1', auth: 'oauth', tok: `tok:pub:${U1}`, apiKey: 'k'.repeat(24) }));
  E.KV.m.set(`api:${'k'.repeat(24)}`, JSON.stringify({ sheetId: 'S1', auth: 'oauth', tok: `tok:pub:${U1}` }));

  assert.equal((await callSite(E, '', 'load')).error, 'auth');                       // 沒登入
  assert.equal((await callSite(E, 'x'.repeat(43), 'load')).error, 'auth');           // 假憑證
  assert.equal((await login(E, w, 'forged')).error, 'auth');                         // 假 LINE 身分
  assert.equal((await login(E, w, 'tok-' + U2)).error, 'notBound');                  // 別人（未開通）拿到連結也進不來

  const s1 = (await login(E, w, 'tok-' + U1)).data.session;
  const s2 = (await login(E, w, 'tok-' + U1)).data.session;                          // 第二台裝置
  assert.equal((await callSite(E, s1, 'load')).data.openingBalance, 100);
  assert.ok(![...E.KV.m.values()].some(v => String(v).includes(s1)));                // 憑證只當作鍵，不外洩在值裡

  await callSite(E, s1, 'x', {}, 'https://bot.test/api/logout');                       // 登出這台
  assert.equal((await callSite(E, s1, 'load')).error, 'auth');
  assert.equal((await callSite(E, s2, 'load')).ok, true);

  assert.equal((await callSite(E, s2, 'logoutAll')).ok, true);                       // 登出所有裝置
  assert.equal((await callSite(E, s2, 'load')).error, 'auth');

  // LINE 指令「登出所有裝置」
  const s3 = (await login(E, w, 'tok-' + U1)).data.session;
  await handleEvent({ type: 'message', replyToken: 'r', source: { userId: U1 }, message: { type: 'text', text: '登出所有裝置' } }, E, { ch: 'pub', base: 'https://bot.test', fetch: w.fetch });
  assert.match(w.last()[0].text, /已登出所有裝置/);
  assert.equal((await callSite(E, s3, 'load')).error, 'auth');

  // 舊的連結金鑰：過渡期內可用，之後停用
  E.LEGACY_KEY_UNTIL = '2999-01-01T00:00:00Z';
  assert.equal((await callSite(E, '', 'load', {}, `https://bot.test/api?key=${'k'.repeat(24)}`)).ok, true);
  E.LEGACY_KEY_UNTIL = '2000-01-01T00:00:00Z';
  const old = await callSite(E, '', 'load', {}, `https://bot.test/api?key=${'k'.repeat(24)}`);
  assert.equal(old.error, 'auth'); assert.match(old.message, /舊的網站連結已停用/);
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

test('使用說明頁：可開啟、歡迎卡片與「說明」都帶連結', async () => {
  const E = env();
  const r = await worker.fetch(new Request('https://bot.test/guide'), E, {});
  const html = await r.text();
  assert.equal(r.status, 200);
  for (const s of ['開始使用', '午餐 120', '撥款 儲蓄 3000', '和朋友分帳', '刪除我的資料']) assert.ok(html.includes(s), s);
  const w = world();
  const deps = { ch: 'pub', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  await handleEvent({ type: 'follow', replyToken: 'r', source: { userId: 'Uguide000000000000000000000000001' } }, E, deps);
  assert.match(JSON.stringify(w.last()), /https:\/\/bot\.test\/guide/);
});


test('舊帳本重新綁定：新 LINE 帳號用同一個 Google 登入 → 找到舊帳本 → 接回、舊格式自動升級、舊綁定解除', async () => {
  const OLD = 'Uoldline000000000000000000000001', NEW = 'Unewline000000000000000000000002';
  const w = world(), E = env();
  // 舊帳本：舊版格式（英文工作表、沒有「口袋」欄、沒有格式版本），原本綁在舊 LINE 帳號
  w.sheets.OLDBOOK = {
    Transactions: [['id', 'type', 'category', 'date', 'amount', 'client', 'description', 'paymentTerm', 'received', 'createdAt'],
      ['1', 'inflow', 'salary', '2026-09-05', 40000, '薪水', '', 0, true, 'x'], ['2', 'outflow', 'food', '2026-09-06', 120, '午餐', '', 0, true, 'y']],
    Settings: [['key', 'value', 'note'], ['openingBalance', 5000, ''], ['cycleDay', 5, ''], ['fundTarget', 80000, '']],
    __title: '我的記帳本（改過名）',
  };
  w.sheets.OTHER = { Sheet1: [['不是帳本']] };
  w.drive = ['OTHER', 'OLDBOOK'];
  E.KV.m.set(`bind:pub:${OLD}`, JSON.stringify({ sheetId: 'OLDBOOK', auth: 'oauth', tok: `tok:pub:${OLD}`, apiKey: 'o'.repeat(24) }));
  E.KV.m.set(`tok:pub:${OLD}`, await encryptText(E, 'RT-old'));
  E.KV.m.set(`api:${'o'.repeat(24)}`, '{}');

  const deps = { ch: 'pub', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: NEW }, message: { type: 'text', text: t } }, E, deps);
  globalThis.fetch = w.fetch;
  const st = await signState(E, { ch: 'pub', uid: NEW, n: 'x' });
  const cb = await worker.fetch(new Request(`https://bot.test/auth/callback?code=C&state=${encodeURIComponent(st)}`), E, {});
  const html = await cb.text();
  assert.match(html, /找到你之前的帳本/);
  assert.match(html, /我的記帳本（改過名）/);                       // 依結構判斷，不看檔名
  assert.ok(!html.includes('OTHER') && !html.includes('不是帳本'));
  assert.equal(w.sheets.NEW, undefined);                            // 還沒建立新帳本
  assert.equal(E.KV.m.has(`bind:pub:${NEW}`), false);

  // 竄改帳本 ID 的連結無效
  const forged = await worker.fetch(new Request(`https://bot.test/auth/relink?s=${encodeURIComponent(await signState(E, { ch: 'pub', uid: NEW, act: 'use', id: 'OTHER' }))}`), E, {});
  assert.equal(forged.status, 400);

  const use = html.match(/href="(\/auth\/relink\?s=[^"]+)"/g).map(x => x.slice(6, -1)).find(Boolean);
  const r = await worker.fetch(new Request('https://bot.test' + use.replace(/&amp;/g, '&')), E, {});
  const done = await r.text();
  assert.match(done, /已接回你的帳本/);
  assert.match(done, /共 2 筆紀錄/);
  assert.match(done, /\$44,880/);                                   // 5000 + 40000 − 120

  // 綁定：新帳號接手、舊帳號解除、不用重新開通
  assert.equal(JSON.parse(E.KV.m.get(`bind:pub:${NEW}`)).sheetId, 'OLDBOOK');
  assert.equal(E.KV.m.has(`ob:pub:${NEW}`), false);
  for (const k of [`bind:pub:${OLD}`, `tok:pub:${OLD}`, `api:${'o'.repeat(24)}`]) assert.equal(E.KV.m.has(k), false, k);
  assert.deepEqual(JSON.parse(E.KV.m.get('own:OLDBOOK')), { ch: 'pub', uid: NEW });
  assert.equal(w.revokeCalled, undefined);                          // 不撤銷同一個 Google 帳號的授權

  // 舊格式自動升級：中文化、補上「口袋」欄、記錄格式版本；原本資料不變
  const T = w.sheets.OLDBOOK['記帳明細'], S = w.sheets.OLDBOOK['設定'];
  assert.equal(T[0][0], '編號'); assert.equal(T[0][10], '口袋');
  assert.deepEqual(T[1].slice(3, 6), ['2026-09-05', 40000, '薪水']);
  assert.ok(S.some(r => r[0] === '格式版本'));

  // 回到 LINE：直接可用
  await say('完成連結');
  assert.match(w.last()[0].text, /帳本已連結[\s\S]*帳戶總額 \$44,880/);
  await say('午餐 100');
  const pid = w.last()[0].contents.footer.contents[0].action.data.match(/p=(\w+)/)[1];
  await handleEvent({ type: 'postback', replyToken: 'r', source: { userId: NEW }, postback: { data: `a=ok&p=${pid}` } }, E, deps);
  assert.match(w.last()[0].text, /已寫入/);
  assert.equal(T.at(-1)[10], '日常');

  // 舊 LINE 帳號已無法使用這本帳本
  await handleEvent({ type: 'message', replyToken: 'r', source: { userId: OLD }, message: { type: 'text', text: '餘額' } }, E, deps);
  assert.ok(!JSON.stringify(w.last()).includes('44,880'));
});

test('舊帳本重新綁定：選擇建立新帳本；Drive 無法搜尋時照常建立', async () => {
  const U = 'Uchoosenew0000000000000000000001';
  const w = world(), E = env();
  w.sheets.OLDBOOK = { '記帳明細': [['編號']], '設定': [['設定項目', '數值']] };
  w.drive = ['OLDBOOK'];
  globalThis.fetch = w.fetch;
  const st = await signState(E, { ch: 'pub', uid: U, n: 'x' });
  const html = await (await worker.fetch(new Request(`https://bot.test/auth/callback?code=C&state=${encodeURIComponent(st)}`), E, {})).text();
  const links = [...html.matchAll(/href="(\/auth\/relink\?s=[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  const done = await (await worker.fetch(new Request('https://bot.test' + links.at(-1)), E, {})).text();   // 最後一個是「建立新的帳本」
  assert.match(done, /帳本已建立/);
  assert.equal(JSON.parse(E.KV.m.get(`bind:pub:${U}`)).sheetId, 'NEW');
  assert.ok(E.KV.m.has(`ob:pub:${U}`));                            // 新帳本要走開通流程
  assert.ok(w.sheets.OLDBOOK);                                      // 舊帳本不會被刪除

  // Drive API 無法使用 → 不卡住，直接建立新帳本
  const U2 = 'Udrivedown000000000000000000001';
  const w2 = world(), E2 = env();
  w2.driveDown = true;
  globalThis.fetch = w2.fetch;
  const st2 = await signState(E2, { ch: 'pub', uid: U2, n: 'y' });
  const h2 = await (await worker.fetch(new Request(`https://bot.test/auth/callback?code=C&state=${encodeURIComponent(st2)}`), E2, {})).text();
  assert.match(h2, /帳本已建立/);
  assert.equal(JSON.parse(E2.KV.m.get(`bind:pub:${U2}`)).sheetId, 'NEW');
});
