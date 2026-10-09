import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleEvent } from '../src/index.js';
import { apply, equalShares, minTransfers, balances, parsePlus, myShares } from '../src/split-core.js';
import { Split } from '../src/split-do.js';
import { encryptText, b64u } from '../src/crypto.js';
import { HEADER, fakeKV, fakeEntryNS, fakeNS } from './helpers.js';

const KEY = b64u(new Uint8Array(32).fill(9));
const A = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', C = 'Ucccccccccccccccccccccccccccccc3';
const NAMES = { [A]: '博凱', [B]: '小明', [C]: '小華' };

/* ---------- 純邏輯 ---------- */
function seed() {
  let { state: s } = apply(null, 'init', A, { sid: 'aaaaaaaaaaaa', gid: 'G1', name: '宜蘭兩天一夜', creatorName: '博凱', today: '2026-10-08' });
  s = apply(s, 'join', B, { name: '小明' }).state;
  s = apply(s, 'join', C, { name: '小華' }).state;
  s = apply(s, 'addTemp', A, { name: '阿美' }).state;
  return s;
}
function add(s, who, text) {
  const r = apply(s, 'add', who, { text, today: '2026-10-08' });
  assert.equal(r.res.ok, true, r.res.error);
  return apply(r.state, 'confirm', who, { eid: r.res.eid }).state;
}

test('平均分攤：零頭由付款人吸收', () => {
  assert.deepEqual(equalShares(1000, ['a', 'b', 'c'], 'b'), { a: 333, b: 334, c: 333 });
  assert.deepEqual(equalShares(10, ['a', 'b', 'c'], 'x'), { a: 4, b: 3, c: 3 });
});

test('解析 + 指令：付款人、排除、錯誤', () => {
  const s = seed();
  assert.deepEqual(parsePlus(s, A, '+晚餐 3000').parts.length, 4);
  const p = parsePlus(s, A, '+住宿 6,000 @小明付');
  assert.equal(p.payer, B); assert.equal(p.amount, 6000); assert.equal(p.cat, 'leisure');
  const q = parsePlus(s, A, '＋門票 1200 不含小華、阿美');
  assert.equal(q.parts.length, 2); assert.equal(q.desc, '門票');
  assert.match(parsePlus(s, A, '+晚餐 3000 @路人付').error, /找不到成員「路人」/);
  assert.match(parsePlus(s, A, '+晚餐').error, /格式/);
  assert.equal(parsePlus(s, A, '+7-11 零食 200').desc, '7-11 零食');
});

test('結算：與原型範例相同的最少轉帳', () => {
  let s = seed();
  s = add(s, A, '+高鐵車票 2920');
  s = add(s, B, '+民宿 6000');
  s = add(s, A, '+海鮮晚餐 3250 不含阿美');
  s = add(s, A, '+晚餐 3000 @小明付');
  const b = balances(s);
  const total = Object.values(b).reduce((a, x) => a + x.paid - x.share, 0);
  assert.equal(total, 0);
  const T = minTransfers(b);
  const sum = (who) => T.filter(t => t.from === who).reduce((a, t) => a + t.amount, 0);
  assert.equal(sum(C), 4063);
  assert.ok(T.length <= 3);
  assert.equal(myShares(s, C).reduce((a, x) => a + x.share, 0), 4063);
});

test('權限：只有記錄者確認；建立者可刪；收付款需本人', () => {
  let s = seed();
  const r = apply(s, 'add', B, { text: '+午餐 300', today: '2026-10-08' });
  s = r.state;
  assert.match(apply(s, 'confirm', A, { eid: r.res.eid }).res.error, /請由 小明 確認/);
  s = apply(s, 'confirm', B, { eid: r.res.eid }).state;
  assert.match(apply(s, 'delete', C, { eid: r.res.eid }).res.error, /只有記錄者/);
  assert.equal(apply(s, 'delete', A, { eid: r.res.eid }).res.ok, true);
  s = add(s, B, '+午餐 300');
  s = apply(s, 'settle', A).state;
  const t = s.transfers[0];
  assert.match(apply(s, 'paid', B, { from: t.from, to: t.to }).res.error, /本人按/);
  // 臨時成員由建立者代按
  const amei = s.members.find(m => m.temp).id;
  const ta = s.transfers.find(x => x.from === amei);
  assert.equal(apply(s, 'paid', A, { from: ta.from, to: ta.to }).res.ok, true);
});

test('自訂金額需等於總額；帳目變動會重新結算', () => {
  let s = seed();
  s = add(s, A, '+晚餐 1000');
  s = apply(s, 'settle', A).state;
  const eid = s.entries[0].id;
  assert.match(apply(s, 'edit', A, { eid, payer: A, shares: { [A]: 500, [B]: 400 } }).res.error, /要等於/);
  const r = apply(s, 'edit', A, { eid, payer: A, shares: { [A]: 500, [B]: 500 } });
  assert.equal(r.res.recalc, true);
  assert.equal(r.state.entries[0].mode, 'equal');
  assert.deepEqual(r.state.transfers, [{ from: B, to: A, amount: 500, paid: false, recv: false }]);
});

test('結束分帳：只有建立者；銀行帳號立即刪除', () => {
  let s = seed();
  s = add(s, A, '+晚餐 1000');
  s = apply(s, 'settle', A).state;
  s = apply(s, 'setMethod', A, { mid: A, type: 'bank', bank: '822', acctEnc: 'v1.x.y', last4: '5678' }).state;
  assert.match(apply(s, 'close', B, { mode: 'keep', today: '2026-10-09' }).res.error, /只有建立者/);
  const r = apply(s, 'close', A, { mode: 'keep', today: '2026-10-09' });
  assert.equal(r.state.retain.until, '2027-01-07');
  assert.equal(r.state.methods[A].acctEnc, undefined);
  assert.equal(r.state.methods[A].wiped, true);
  assert.match(apply(r.state, 'add', A, { text: '+宵夜 100' }).res.error, /已經結束/);
});

/* ---------- 群組流程（LINE 事件） ---------- */
function world() {
  const w = { replies: [], sheetCalls: 0, sheets: {} };
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    const pm = u.match(/\/v2\/bot\/group\/G1\/member\/(\w+)$/);
    if (pm) return Response.json({ displayName: NAMES[pm[1]] || '路人' });
    if (u.startsWith('https://api.line.me/v2/bot/message/reply')) { w.replies.push(JSON.parse(init.body)); return Response.json({}); }
    if (u === 'https://api.line.me/oauth2/v2.1/verify') {
      const t = new URLSearchParams(String(init.body)).get('id_token');
      return t.startsWith('tok-') ? Response.json({ sub: t.slice(4), name: NAMES[t.slice(4)], exp: Date.now() / 1000 + 3600 }) : new Response('bad', { status: 400 });
    }
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'AT', expires_in: 3600 });
    if (u.startsWith('https://sheets.googleapis.com/')) {
      w.sheetCalls++;
      const sh = w.sheets.S1;
      if (u.includes(':batchGet') && decodeURIComponent(u).includes("'Settings'")) return Response.json({ valueRanges: [{ values: sh.Transactions }, { values: sh.Settings }] });
      if (u.includes(':batchGet')) return Response.json({ valueRanges: [{ values: [sh.Transactions[0]] }, { values: sh.Transactions.map(r => [r[0]]) }] });
      if (u.includes(':append')) { const name = decodeURIComponent(u).match(/'(\w+)'/)[1]; sh[name].push(...JSON.parse(init.body).values); return Response.json({}); }
      if (u.includes(':batchUpdate')) return Response.json({});
    }
    throw new Error('unexpected ' + u);
  };
  w.last = () => w.replies.at(-1).messages;
  return w;
}
async function env() {
  const E = { TOKEN_ENC_KEY: KEY, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't',
    LIFF_ID: '2000000000-abcdEFGH', LINE_LOGIN_CHANNEL_ID: '2000000000', LINE_BASIC_ID: '@353ktrhx', SITE_URL: 'https://site.test/',
    KV: fakeKV(), ENTRY: fakeEntryNS(), SPLIT: fakeNS(Split) };
  // 小明已開通個人帳本（OAuth）
  E.KV.m.set(`tok:${B}`, await encryptText(E, 'RT'));
  E.KV.m.set(`bind:${B}`, JSON.stringify({ sheetId: 'S1', auth: 'oauth', tok: `tok:${B}`, apiKey: 'k'.repeat(24) }));
  return E;
}

test('群組：建立 → 加入 → 記帳 → 結算 → 收付款 → 結束；群組訊息絕不寫入個人帳本', async () => {
  const w = world(), E = await env();
  w.sheets.S1 = { Transactions: [HEADER], Settings: [['key', 'value'], ['openingBalance', 0]] };
  const deps = { ch: '', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  const src = (u) => ({ type: 'group', groupId: 'G1', userId: u });
  const say = (u, t) => handleEvent({ type: 'message', replyToken: 'r', source: src(u), message: { type: 'text', text: t } }, E, deps);
  const tap = (u, d) => handleEvent({ type: 'postback', replyToken: 'r', source: src(u), postback: { data: d } }, E, deps);
  const btns = () => JSON.stringify(w.last());

  await handleEvent({ type: 'join', replyToken: 'r', source: { type: 'group', groupId: 'G1' } }, E, deps);
  assert.match(btns(), /建立分帳區/);

  await tap(A, 'a=sc');
  assert.match(w.last()[0].text, /博凱，請輸入分帳區名稱/);
  const n0 = w.replies.length;
  await say(B, '宜蘭兩天一夜');                  // 不是按按鈕的人 → 當一般聊天
  assert.equal(w.replies.length, n0);
  await say(A, '宜蘭兩天一夜');
  assert.match(btns(), /分帳區・宜蘭兩天一夜/);
  const sid = E.KV.m.get('grp:G1');
  assert.match(sid, /^[a-f0-9]{12}$/);
  assert.match(btns(), new RegExp(`liff\\.line\\.me/2000000000-abcdEFGH\\?sid=${sid}`));

  await say(B, '+晚餐 3000');                     // 還沒加入
  assert.match(w.last()[0].text, /請先加入分帳/);
  await tap(B, `a=sj&s=${sid}`);
  assert.match(w.last()[0].text, /小明 加入了分帳（共 2 人）/);
  await tap(C, `a=sj&s=${sid}`);

  // 已開通的小明在群組傳「午餐 120」：不回應、不碰試算表
  const n1 = w.replies.length;
  await say(B, '午餐 120');
  await say(B, '今天好累喔');
  assert.equal(w.replies.length, n1);
  assert.equal(w.sheetCalls, 0);

  await say(B, '+晚餐 3000');
  const card = btns();
  assert.match(card, /晚餐/); assert.match(card, /\$1,000/);
  const eid = card.match(/a=eo&s=\w+&e=(\w+)/)[1];
  await tap(A, `a=eo&s=${sid}&e=${eid}`);
  assert.match(w.last()[0].text, /請由 小明 確認/);
  await tap(B, `a=eo&s=${sid}&e=${eid}`);
  assert.match(w.last()[0].text, /已記入分帳區：晚餐 \$3,000/);
  assert.equal(w.sheetCalls, 0);

  await say(A, '分帳');
  assert.match(btns(), /應收 \$2,000/);
  await say(A, '結算');
  assert.match(btns(), /2 筆轉帳/);
  await tap(B, `a=mm&s=${sid}&t=cash`);
  assert.match(w.last()[0].text, /小明 改用現金收款/);
  await tap(A, `a=tp&s=${sid}&f=${A}&t=${B}`);
  assert.match(w.last()[0].text, /博凱 已付款給 小明 \$1,000/);
  await tap(B, `a=tr&s=${sid}&f=${A}&t=${B}`);
  await tap(B, `a=tr&s=${sid}&f=${C}&t=${B}`);
  assert.match(JSON.stringify(w.last()), /全部結清/);

  await say(B, '結束分帳');
  assert.match(w.last()[0].text, /只有建立者 博凱/);
  await say(A, '結束分帳');
  await tap(A, `a=cl&s=${sid}&m=keep`);
  assert.match(btns(), /分帳區已結束/); assert.match(btns(), /2027\/01\/06/);
  assert.equal(E.KV.m.has('grp:G1'), false);
  assert.ok(E.SPLIT.inst.get(sid).storage.alarm > 0);
  assert.equal(w.sheetCalls, 0);

  /* ---------- 分帳網頁 API ---------- */
  globalThis.fetch = w.fetch;
  const callApi = async (who, body) => (await worker.fetch(new Request('https://bot.test/split/api', {
    method: 'POST', body: JSON.stringify({ idToken: 'tok-' + who, sid, ...body }) }), E, {})).json();
  const bad = await worker.fetch(new Request('https://bot.test/split/api', { method: 'POST', body: JSON.stringify({ idToken: 'forged', sid, action: 'load' }) }), E, {});
  assert.equal(bad.status, 401);
  const v = await callApi(B, { action: 'load' });
  assert.equal(v.ok, true); assert.equal(v.data.member, true); assert.equal(v.data.bound, true);
  assert.deepEqual(v.data.mine.map(x => x.share), [1000]);
  assert.match(v.data.site, /^https:\/\/site\.test\/\?openExternalBrowser=1#api=/);
  const noBind = await callApi(C, { action: 'transfer', eids: [eid] });
  assert.match(noBind.error, /還沒開通/);
  const t1 = await callApi(B, { action: 'transfer', eids: [eid] });
  assert.equal(t1.ok, true, t1.error);
  assert.deepEqual(t1.data.wrote, { count: 1, total: 1000 });
  const row = w.sheets.S1.Transactions[1];
  assert.equal(row[0], `sp${sid}${eid}`); assert.equal(row[1], 'outflow'); assert.equal(row[4], 1000); assert.equal(row[5], '晚餐');
  const t2 = await callApi(B, { action: 'transfer', eids: [eid] });
  assert.match(t2.error, /尚未轉入/);
  assert.equal(w.sheets.S1.Transactions.length, 2);
});

test('分帳網頁：銀行帳號加密保存、成員才看得到、記住帳號寫入本人試算表', async () => {
  const w = world(), E = await env();
  w.sheets.S1 = { Transactions: [HEADER], Settings: [['key', 'value'], ['openingBalance', 0]] };
  const deps = { ch: '', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  const src = (u) => ({ type: 'group', groupId: 'G1', userId: u });
  const say = (u, t) => handleEvent({ type: 'message', replyToken: 'r', source: src(u), message: { type: 'text', text: t } }, E, deps);
  const tap = (u, d) => handleEvent({ type: 'postback', replyToken: 'r', source: src(u), postback: { data: d } }, E, deps);
  await tap(A, 'a=sc'); await say(A, '聚餐');
  const sid = E.KV.m.get('grp:G1');
  await tap(B, `a=sj&s=${sid}`);
  await say(A, '+火鍋 2000');
  const eid = JSON.stringify(w.last()).match(/a=eo&s=\w+&e=(\w+)/)[1];
  await tap(A, `a=eo&s=${sid}&e=${eid}`);
  await say(B, '結算');

  globalThis.fetch = w.fetch;
  const callApi = async (who, body) => (await worker.fetch(new Request('https://bot.test/split/api', {
    method: 'POST', body: JSON.stringify({ idToken: 'tok-' + who, sid, ...body }) }), E, {})).json();
  assert.match((await callApi(B, { action: 'setMethod', mid: A, type: 'bank', bank: '822', acct: '123456785678' })).error, /本人設定/);
  const r = await callApi(A, { action: 'setMethod', mid: A, type: 'bank', bank: '822', acct: '1234 5678 5678', remember: true });
  assert.equal(r.ok, true, r.error);
  const raw = JSON.stringify(E.SPLIT.inst.get(sid).store.get('s'));
  assert.ok(!raw.includes('123456785678'));            // 伺服器上是密文
  assert.equal(r.data.methods[A].acct, '123456785678');
  assert.equal((await callApi(C, { action: 'load' })).data.methods[A].acct, undefined);   // 非成員看不到
  assert.equal((await callApi(C, { action: 'load' })).data.member, false);

  // 群組卡片只顯示末 4 碼，複製按鈕帶完整帳號
  await say(B, '結算');
  const card = JSON.stringify(w.last());
  assert.match(card, /822-\*\*\*\*5678/);
  assert.match(card, /"clipboardText":"822-123456785678"/);

  // 小明記住帳號 → 寫進他自己的 Settings
  const r2 = await callApi(B, { action: 'setMethod', mid: B, type: 'bank', bank: '700', acct: '00112233445566', remember: true });
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual(w.sheets.S1.Settings.at(-1), ['payoutAccount', '700-00112233445566']);

  const page = await (await worker.fetch(new Request('https://bot.test/split'), E, {})).text();
  assert.match(page, /"liffId":"2000000000-abcdEFGH"/);
});

test('網頁記一筆：直接記入、自訂金額檢查、結算中會重算', () => {
  let s = seed();
  const ids = s.members.map(m => m.id);
  assert.match(apply(s, 'addItem', A, { desc: '', amount: 100, parts: ids }).res.error, /項目名稱/);
  assert.match(apply(s, 'addItem', A, { desc: '晚餐', amount: 1000, parts: [A, B], shares: { [A]: 600, [B]: 300 } }).res.error, /要等於/);
  let r = apply(s, 'addItem', A, { desc: '晚餐', amount: 1000, payer: B, parts: [A, B, C], today: '2026-10-08' });
  assert.equal(r.res.ok, true);
  const e = r.state.entries[0];
  assert.equal(e.status, 'ok'); assert.equal(e.payer, B); assert.equal(e.mode, 'equal');
  assert.deepEqual(e.shares, { [A]: 333, [B]: 334, [C]: 333 });
  s = apply(r.state, 'settle', A).state;
  r = apply(s, 'addItem', A, { desc: '飲料', amount: 300, parts: [A, B], shares: { [A]: 300, [B]: 0 }, today: '2026-10-08' });
  assert.equal(r.res.recalc, true);
  assert.deepEqual(r.state.entries[1].parts, [A]);
  assert.equal(r.state.entries[1].mode, 'custom');
  assert.match(apply(r.state, 'addItem', 'Uoutsider', { desc: 'x', amount: 1, parts: [A] }).res.error, /請先加入/);
});

test('快捷列：群組依狀態顯示、私訊已開通才顯示、不覆蓋原本的快捷選項', async () => {
  const w = world(), E = await env();
  w.sheets.S1 = { Transactions: [HEADER], Settings: [['key', 'value'], ['openingBalance', 0]] };
  const deps = { ch: '', base: 'https://bot.test', fetch: w.fetch, today: '2026-10-08' };
  const src = (u) => ({ type: 'group', groupId: 'G1', userId: u });
  const say = (u, t) => handleEvent({ type: 'message', replyToken: 'r', source: src(u), message: { type: 'text', text: t } }, E, deps);
  const tap = (u, d) => handleEvent({ type: 'postback', replyToken: 'r', source: src(u), postback: { data: d } }, E, deps);
  const labels = () => (w.last().at(-1).quickReply?.items || []).map(i => i.action.label);

  await say(A, '說明');
  assert.deepEqual(labels(), ['建立分帳區', '說明']);
  await tap(A, 'a=sc');
  assert.deepEqual(labels(), ['週末出遊', '同事聚餐', '室友公費']);       // 保留原本的選項
  await say(A, '宜蘭');
  const sid = E.KV.m.get('grp:G1');
  assert.deepEqual(labels(), ['記一筆', '分帳總覽', '結算', '加入分帳', '結束分帳', '說明']);
  assert.match(w.last().at(-1).quickReply.items[0].action.uri, new RegExp(`sid=${sid}&tab=add`));
  await say(A, '分帳總覽');
  assert.match(JSON.stringify(w.last()), /目前總覽/);

  // 私訊：已開通的小明有快捷列；未開通的小華沒有
  const dm = (u, t) => handleEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId: u }, message: { type: 'text', text: t } }, E, deps);
  await dm(B, '說明');
  assert.deepEqual(labels(), ['餘額', '本期摘要', '開啟網站', '和朋友分帳', '說明']);
  await dm(C, '說明');
  assert.equal(w.last().at(-1).quickReply, undefined);
});
