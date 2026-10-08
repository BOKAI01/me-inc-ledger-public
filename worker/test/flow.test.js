import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleEvent } from '../src/index.js';
import { resetTokenCache } from '../src/google.js';
import { fakeKV, fakeEntryNS, fakeWorld, makeServiceAccount, HEADER } from './helpers.js';

const UID = 'U1234567890abcdef1234567890abcdef';
const T = '2026-10-06';
const SA = await makeServiceAccount();

function setup(worldOpts) {
  resetTokenCache();
  const world = fakeWorld(worldOpts);
  const env = {
    LINE_CHANNEL_SECRET: 'sec', LINE_CHANNEL_ACCESS_TOKEN: 'lt', GOOGLE_SA_JSON: SA,
    LEGACY_GAS_URL: 'https://gas.test/exec',
    KV: fakeKV({ [`bind:${UID}`]: JSON.stringify({ sheetId: 'SHEET', ledgerName: '主帳本' }) }),
    ENTRY: fakeEntryNS(),
  };
  const deps = { fetch: world.fetch, today: T };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: UID }, message: { type: 'text', text: t } }, env, deps);
  const tap = (data, uid = UID) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: uid }, postback: { data } }, env, deps);
  const lastCard = () => world.replies.at(-1).messages[0];
  const pidOf = (card) => card.contents.footer.contents[0].action.data.match(/p=([0-9a-f]+)/)[1];
  return { world, env, say, tap, lastCard, pidOf };
}

test('health 與簽章', async () => {
  const env = { LINE_CHANNEL_SECRET: 'sec' };
  const ctx = { waitUntil() {} };
  const h = await worker.fetch(new Request('https://x/health'), env, ctx);
  assert.equal(await h.text(), 'ok');
  const bad = await worker.fetch(new Request('https://x/line/webhook', { method: 'POST', body: '{"events":[]}', headers: { 'x-line-signature': 'nope' } }), env, ctx);
  assert.equal(bad.status, 401);
  const body = '{"events":[]}';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('base64');
  const good = await worker.fetch(new Request('https://x/line/webhook', { method: 'POST', body, headers: { 'x-line-signature': sig } }), env, ctx);
  assert.equal(good.status, 200);   // LINE 後台的 Verify
});

test('午餐 1 → 卡片 → 確認寫入 → 試算表新增一列並清快取', async () => {
  const s = setup();
  await s.say('午餐 1');
  const card = s.lastCard();
  assert.equal(card.type, 'flex');
  const pid = s.pidOf(card);
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows.length, 1);
  const row = Object.fromEntries(HEADER.map((h, i) => [h, s.world.rows[0][i]]));
  assert.equal(row.type, 'outflow'); assert.equal(row.category, 'food'); assert.equal(row.amount, 1);
  assert.equal(row.client, '午餐'); assert.equal(row.date, T); assert.equal(row.received, true); assert.equal(row.account, '');
  assert.match(row.id, /^\d{13}[0-9a-f]{4}$/);
  assert.match(s.world.lastText(), /已寫入【主帳本】/);
  assert.deepEqual(s.world.gasCalls, ['clearCache']);
});

test('連按兩次（同時）只寫入一筆', async () => {
  const s = setup({ appendDelay: 30 });
  await s.say('午餐 1');
  const pid = s.pidOf(s.lastCard());
  await Promise.all([s.tap(`a=ok&p=${pid}`), s.tap(`a=ok&p=${pid}`), s.tap(`a=ok&p=${pid}`)]);
  assert.equal(s.world.rows.length, 1);
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows.length, 1);
  assert.match(s.world.lastText(), /已經寫入過了/);
});

test('改分類、改成收入，並記住選擇', async () => {
  const s = setup();
  await s.say('咖啡豆 450');
  let pid = s.pidOf(s.lastCard());
  await s.tap(`a=pick&p=${pid}`);
  assert.equal(s.world.replies.at(-1).messages[0].quickReply.items.length, 8);
  await s.tap(`a=cat&p=${pid}&c=leisure`);
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows[0][2], 'leisure');
  // 下次自動套用
  await s.say('咖啡豆 300');
  pid = s.pidOf(s.lastCard());
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows[1][2], 'leisure');
  // 改成收入
  await s.say('賣書 200');
  pid = s.pidOf(s.lastCard());
  await s.tap(`a=type&p=${pid}&t=inflow`);
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows[2][1], 'inflow');
});

test('取消後不能寫入；別人的卡片不能確認', async () => {
  const s = setup();
  await s.say('午餐 100');
  const pid = s.pidOf(s.lastCard());
  await s.tap(`a=no&p=${pid}`);
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows.length, 0);
  assert.match(s.world.lastText(), /已取消/);

  await s.say('晚餐 100');
  const pid2 = s.pidOf(s.lastCard());
  s.env.KV.m.set('bind:Uother', JSON.stringify({ sheetId: 'X' }));
  await s.tap(`a=ok&p=${pid2}`, 'Uother');
  assert.equal(s.world.rows.length, 0);
  await s.tap(`a=ok&p=${pid2}`);
  assert.equal(s.world.rows.length, 1);
});

test('試算表無權限 → 提示並可重試', async () => {
  const s = setup({ sheetStatus: 403 });
  await s.say('午餐 100');
  const pid = s.pidOf(s.lastCard());
  await s.tap(`a=ok&p=${pid}`);
  assert.match(s.world.lastText(), /無法存取試算表/);
  const r = await s.env.ENTRY.get(pid).fetch('https://e', { method: 'POST', body: JSON.stringify({ op: 'get' }) }).then(r => r.json());
  assert.equal(r.rec.state, 'pending');
});

test('未綁定帳號 → 回覆 User ID', async () => {
  const s = setup();
  await handleEvent({ type: 'message', replyToken: 'r', source: { userId: 'Unew' }, message: { type: 'text', text: '午餐 1' } }, s.env, { fetch: s.world.fetch, today: T });
  assert.match(s.world.lastText(), /bind:Unew/);
});

test('餘額、摘要與網站算法一致', async () => {
  const rows = [
    ['1', 'inflow', 'salary', '2026-10-05', 50000, '薪水', '', 0, true, '', ''],
    ['2', 'outflow', 'food', '2026-10-06', 300, '午餐', '', 0, true, '', ''],
    ['3', 'alloc', 'alloc_in', '2026-10-05', 5000, '撥款', '', 0, true, '', 'savings'],
    ['4', 'outflow', 'leisure', '2026-10-06', 800, '電影', '', 0, true, '', 'savings'],
  ];
  const s = setup({ rows, settings: { openingBalance: 10000, cycleDay: 5, fundTarget: 50000 } });
  await s.say('餘額');
  const b = s.world.lastText();
  assert.match(b, /帳戶總額 \$58,900/);
  assert.match(b, /日常口袋 \$54,700/);
  assert.match(b, /儲蓄口袋 \$4,200/);
  assert.match(b, /緊急備用金 \$0 \/ \$50,000/);
  await s.say('摘要');
  const m = s.world.lastText();
  assert.match(m, /2026\/10\/5 – 2026\/11\/4/);
  assert.match(m, /收入 \$50,000/);
  assert.match(m, /支出 \$1,100/);
});

test('看不懂的訊息與說明', async () => {
  const s = setup();
  await s.say('你好');
  assert.match(s.world.lastText(), /看不懂/);
  await s.say('說明');
  assert.match(s.world.lastText(), /記帳方式/);
});

test('撥款：卡片 → 寫入 alloc 分錄，餘額只移動口袋', async () => {
  const s = setup({ rows: [['1', 'inflow', 'salary', '2026-10-05', 50000, '薪水', '', 0, true, '', '']] });
  await s.say('撥款 儲蓄 5000');
  const card = s.lastCard();
  assert.equal(card.contents.header.contents[0].text, '確認撥款');
  const pid = s.pidOf(card);
  await s.tap(`a=ok&p=${pid}`);
  const row = Object.fromEntries(HEADER.map((h, i) => [h, s.world.rows[1][i]]));
  assert.equal(row.type, 'alloc'); assert.equal(row.category, 'alloc_in'); assert.equal(row.account, 'savings');
  assert.match(s.world.lastText(), /日常 → 🏦 儲蓄口袋/);
  await s.say('餘額');
  assert.match(s.world.lastText(), /帳戶總額 \$50,000/);
  assert.match(s.world.lastText(), /儲蓄口袋 \$5,000/);
  assert.match(s.world.lastText(), /日常口袋 \$45,000/);
});

test('撥款：改方向、支出改成撥款再改回', async () => {
  const s = setup();
  await s.say('撥款 緊急 2000');
  let pid = s.pidOf(s.lastCard());
  await s.tap(`a=pick&p=${pid}`);
  assert.equal(s.world.replies.at(-1).messages[0].quickReply.items.length, 5);
  await s.tap(`a=alloc&p=${pid}&d=out&k=savings`);
  await s.tap(`a=ok&p=${pid}`);
  assert.equal(s.world.rows[0][2], 'alloc_out'); assert.equal(s.world.rows[0][10], 'savings');

  await s.say('存起來 1000');
  pid = s.pidOf(s.lastCard());
  await s.tap(`a=alloc&p=${pid}&d=in&k=emergency`);
  await s.tap(`a=type&p=${pid}&t=outflow`);
  await s.tap(`a=ok&p=${pid}`);
  const r = s.world.rows[1];
  assert.equal(r[1], 'outflow'); assert.equal(r[5], '存起來'); assert.equal(r[10], '');
});

test('多筆：一則訊息 3 筆 → 一張卡 → 一次寫入 3 列', async () => {
  const s = setup();
  await s.say('10/6 早餐 30\n10/6 午餐 150\n10/6 其他 14371');
  const card = s.lastCard();
  assert.match(card.altText, /確認 3 筆/);
  const pid = s.pidOf(card);
  await Promise.all([s.tap(`a=ok&p=${pid}`), s.tap(`a=ok&p=${pid}`)]);
  assert.equal(s.world.rows.length, 3);
  assert.equal(s.world.appendCalls, 1);
  assert.deepEqual(s.world.rows.map(r => [r[3], r[5], r[4], r[2]]), [
    ['2026-10-06', '早餐', 30, 'food'], ['2026-10-06', '午餐', 150, 'food'], ['2026-10-06', '其他', 14371, 'other_out'],
  ]);
  assert.equal(new Set(s.world.rows.map(r => r[0])).size, 3);       // id 不重複
  assert.match(s.world.replies.find(r => /已寫入【主帳本】3 筆/.test(r.messages[0].text || ''))?.messages[0].text, /10\/06 其他 -\$14,371/);
});

test('多筆：日期標題行、改第 2 筆分類、看不懂的行另外列出', async () => {
  const s = setup();
  await s.say('10/5\n早餐 30\n電影 300\n亂打\n撥款 儲蓄 1000');
  const [card, warn] = s.world.replies.at(-1).messages;
  assert.match(card.altText, /確認 3 筆/);
  assert.match(warn.text, /亂打/);
  const pid = s.pidOf(card);
  await s.tap(`a=pick&p=${pid}&i=1`);
  assert.match(s.world.lastText(), /第 2 筆「電影」/);
  await s.tap(`a=cat&p=${pid}&i=1&c=other_out`);
  await s.tap(`a=ok&p=${pid}`);
  assert.deepEqual(s.world.rows.map(r => [r[3], r[1], r[2]]), [
    ['2026-10-05', 'outflow', 'food'], ['2026-10-05', 'outflow', 'other_out'], ['2026-10-05', 'alloc', 'alloc_in'],
  ]);
});

test('多筆：全部看不懂、超過上限', async () => {
  const s = setup();
  await s.say('abc\ndef');
  assert.match(s.world.lastText(), /看不懂這幾行/);
  await s.say(Array.from({ length: 21 }, (_, i) => `午餐 ${i + 1}`).join('\n'));
  assert.match(s.world.lastText(), /一次最多 20 筆/);
});
