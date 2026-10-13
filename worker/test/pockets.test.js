import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEvent } from '../src/index.js';
import { handleApi } from '../src/api.js';
import { findPocket, accountFromSheet, nameError, defaultPockets, MAX_POCKETS } from '../src/pockets.js';
import { computePockets } from '../src/ledger.js';
import { readLedger, resetSheetCaches } from '../src/google.js';
import { addPocket, renamePocket, deletePocket, setPocketTarget, PocketError } from '../src/pocket-ops.js';
import { encryptText, b64u } from '../src/crypto.js';
import { fakeKV, fakeEntryNS, fakeSheetsApi } from './helpers.js';
import { HEADER_ZH } from '../src/zh.js';

const T = '2026-10-12';
const book = () => ({
  '記帳明細': [HEADER_ZH,
    ['1', '收入', '主要薪資', '2026-10-05', 50000, '薪水', '', 0, '是', '', '日常'],
    ['2', '撥款', '撥入口袋', '2026-10-06', 3000, '撥入儲蓄口袋', '', 0, '是', '', '儲蓄口袋']],
  '設定': [['設定項目', '數值', '說明'], ['期初存款', 10000, ''], ['結算日', 5, ''], ['緊急備用金目標', 80000, ''], ['格式版本', 2, '']],
});

test('口袋：名稱比對、驗證與餘額計算', () => {
  const pk = [...defaultPockets(), { id: 'p1', name: '旅遊基金', icon: '✈️', target: 0, active: true }, { id: 'p0', name: '舊口袋（已刪除 10/01）', icon: '👝', active: false }];
  assert.equal(findPocket(pk, '旅遊').id, 'p1');
  assert.equal(findPocket(pk, '旅遊基金').id, 'p1');
  assert.equal(findPocket(pk, '儲蓄').id, 'savings');
  assert.equal(findPocket(pk, '緊急').id, 'emergency');
  assert.equal(findPocket(pk, '舊口袋'), null);                               // 已刪除的不能再撥款
  assert.equal(accountFromSheet('旅遊基金', pk), 'p1');
  assert.equal(accountFromSheet('日常', pk), '');
  assert.match(nameError(pk, '旅遊基金'), /已經有/);
  assert.match(nameError(pk, '日常'), /預設/);
  assert.match(nameError(pk, '2027旅遊'), /數字/);
  assert.equal(nameError(pk, '買房基金'), null);
  const p = computePockets([
    { type: 'inflow', category: 'salary', amount: 50000, account: '' },
    { type: 'alloc', category: 'alloc_in', amount: 2000, account: 'p1' },
    { type: 'outflow', category: 'leisure', amount: 500, account: 'p1' },     // 從旅遊基金直接花
  ], 0, pk);
  assert.equal(p.byId.p1, 1500); assert.equal(p.total, 49500); assert.equal(p.daily, 48000);
});

test('口袋工作表：舊帳本自動建立、新增、改名連同舊紀錄、設定目標、刪除時餘額歸零、上限 8 個', async () => {
  resetSheetCaches();
  const books = { S: book() };
  const f = fakeSheetsApi(books);
  let d = await readLedger('T', 'S', f);
  assert.deepEqual(d.pockets.map(p => [p.id, p.name, p.target]), [['savings', '儲蓄口袋', 0], ['emergency', '緊急備用金', 80000]]);   // 升級 v3：沿用原本目標
  assert.ok(books.S['口袋']);
  assert.equal(d.transactions[1].account, 'savings');

  const { pocket: trip } = await addPocket('T', 'S', '旅遊基金', {}, f);
  await assert.rejects(addPocket('T', 'S', '旅遊基金', {}, f), PocketError);
  await renamePocket('T', 'S', '儲蓄', '買房基金', f);
  assert.equal(books.S['記帳明細'][2][10], '買房基金');                         // 舊紀錄一起改名
  d = await readLedger('T', 'S', f);
  assert.equal(d.transactions[1].account, 'savings');                         // 代號不變，餘額不受影響
  assert.equal(computePockets(d.transactions, d.openingBalance, d.pockets).byId.savings, 3000);
  await setPocketTarget('T', 'S', trip.id, 30000, f);
  assert.equal((await readLedger('T', 'S', f)).pockets.find(p => p.id === trip.id).target, 30000);

  // 刪除有餘額的口袋：自動記一筆撥回日常，口袋歸零並標記已刪除；重複按也只記一次
  const r = await deletePocket('T', 'S', 'savings', { today: T, txnId: 'pkdelX' }, f);
  assert.equal(r.balance, 3000);
  await assert.rejects(deletePocket('T', 'S', 'savings', { today: T, txnId: 'pkdelX' }, f), PocketError);
  const rows = books.S['記帳明細'];
  assert.deepEqual(rows.at(-1).slice(1, 6), ['撥款', '撥回日常', T, 3000, '刪除口袋：買房基金撥回日常']);
  d = await readLedger('T', 'S', f);
  const bal = computePockets(d.transactions, d.openingBalance, d.pockets);
  assert.equal(bal.byId.savings, 0);
  assert.equal(bal.total, 60000); assert.equal(bal.daily, 60000);
  assert.ok(d.pockets.find(p => p.id === 'savings').name.startsWith('買房基金（已刪除'));
  assert.equal(rows[2][10], d.pockets.find(p => p.id === 'savings').name);    // 舊紀錄標記已刪除
  const { pocket: house2 } = await addPocket('T', 'S', '買房基金', {}, f);      // 名稱可以再使用
  const { header } = await (await import('../src/google.js')).readHeaderAndIds('T', 'S', f);
  d = await readLedger('T', 'S', f);
  await (await import('../src/google.js')).appendTxns('T', 'S', header, [{ id: 'h2', type: 'alloc', category: 'alloc_in', date: T, amount: 700, client: '', description: '', paymentTerm: 0, received: true, createdAt: 'x', account: house2.id }], f, d.pockets);
  d = await readLedger('T', 'S', f);
  assert.equal(d.transactions.at(-1).account, house2.id);                     // 同名新口袋不會被當成已刪除的舊口袋
  const b2 = computePockets(d.transactions, d.openingBalance, d.pockets);
  assert.equal(b2.byId[house2.id], 700); assert.equal(b2.byId.savings, 0);

  for (let i = 0; i < 10; i++) { try { await addPocket('T', 'S', `口袋${'甲乙丙丁戊己庚辛壬癸'[i]}`, {}, f); } catch (e) { assert.match(e.message, new RegExp(`最多 ${MAX_POCKETS}`)); } }
  assert.equal((await readLedger('T', 'S', f)).pockets.filter(p => p.active).length, MAX_POCKETS);
});

/* ---------- LINE 指令 ---------- */
function setup() {
  resetSheetCaches();
  const w = { sheets: { S: book() }, replies: [] };
  const sheets = fakeSheetsApi(w.sheets);
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'AT', expires_in: 3600 });
    const r = await sheets(url, init);
    if (r) return r;
    if (u.startsWith('https://api.line.me/')) { w.replies.push(JSON.parse(init.body)); return Response.json({}); }
    throw new Error('unexpected ' + u);
  };
  w.last = () => w.replies.at(-1).messages;
  w.text = () => w.last().map(m => m.text || m.altText).join('\n');
  return w;
}

test('LINE：新增、撥款到自訂口袋、改名、設定目標、刪除需確認、全部刪光', async () => {
  const U = 'Upocket0000000000000000000000001';
  const w = setup();
  const E = { TOKEN_ENC_KEY: b64u(new Uint8Array(32).fill(3)), GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', KV: fakeKV(), ENTRY: fakeEntryNS() };
  E.KV.m.set(`tok:${U}`, await encryptText(E, 'RT'));
  E.KV.m.set(`bind:${U}`, JSON.stringify({ sheetId: 'S', auth: 'oauth', tok: `tok:${U}`, ledgerName: '我的帳本' }));
  const deps = { ch: '', base: 'https://bot.test', fetch: w.fetch, today: T };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: U }, message: { type: 'text', text: t } }, E, deps);
  const tap = (d) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: U }, postback: { data: d } }, E, deps);
  const confirm = async () => { const pid = JSON.stringify(w.last()).match(/a=ok&p=(\w+)/)[1]; await tap(`a=ok&p=${pid}`); };

  await say('口袋');
  assert.match(w.text(), /儲蓄口袋[\s\S]*緊急備用金[\s\S]*新增口袋 名稱/);
  await say('新增口袋 旅遊基金');
  assert.match(w.text(), /已新增口袋「✈️ 旅遊基金」/);
  await say('撥款 旅遊 2000');
  assert.match(JSON.stringify(w.last()), /👛 日常 → ✈️ 旅遊基金/);
  await confirm();
  assert.equal(w.sheets.S['記帳明細'].at(-1)[10], '旅遊基金');
  await say('餘額');
  assert.match(w.text(), /✈️ 旅遊基金 \$2,000/);

  await say('口袋改名 旅遊 日本旅遊');
  assert.match(w.text(), /已把「旅遊基金」改名為「日本旅遊」/);
  assert.equal(w.sheets.S['記帳明細'].at(-1)[10], '日本旅遊');
  await say('日本旅遊目標 30000');
  assert.match(w.text(), /日本旅遊 \$2,000 \/ \$30,000\n　還差 \$28,000/);

  // 改方向的選單列出自訂口袋
  await say('撥款 100');
  await tap(`a=pick&p=${JSON.stringify(w.last()).match(/a=ok&p=(\w+)/)[1]}`);
  assert.match(JSON.stringify(w.last()), /撥入日本旅遊/);

  // 刪除：先出確認卡，按「取消」不會動
  await say('刪除口袋 日本旅遊');
  const card = JSON.stringify(w.last());
  assert.match(card, /目前餘額 \$2,000/);
  assert.match(card, /自動記一筆「日本旅遊撥回日常 \$2,000」/);
  await tap('a=pkno');
  assert.match(w.text(), /沒有刪除/);
  await say('刪除口袋 日本旅遊');
  const del = JSON.stringify(w.last()).match(/a=pkdel[^"]+/)[0].replace(/\\u0026/g, '&');
  await tap(del);
  assert.match(w.text(), /已刪除口袋「日本旅遊」\n餘額 \$2,000 已自動撥回日常/);
  assert.ok(!/日本旅遊 \$/.test(w.text()));
  await tap(del);                                                              // 重複按
  assert.match(w.text(), /已經刪除了/);
  assert.equal(w.sheets.S['記帳明細'].filter(r => /刪除口袋/.test(r[5] || '')).length, 1);

  await say('撥款 日本旅遊 100');                                               // 找不到 → 先選預設並提醒
  assert.match(w.text(), /找不到「日本旅遊」這個口袋/);

  // 刪光所有口袋：只剩日常，撥款會提示先建立口袋
  for (const n of ['儲蓄口袋', '緊急備用金']) {
    await say(`刪除口袋 ${n}`);
    await tap(JSON.stringify(w.last()).match(/a=pkdel[^"]+/)[0].replace(/\\u0026/g, '&'));
  }
  await say('餘額');
  assert.match(w.text(), /目前沒有其他口袋/);
  await say('撥款 500');
  assert.match(w.text(), /你目前沒有任何口袋/);
});

test('LINE：在網站新增的口袋，LINE 撥款「改方向」選單立刻看得到', async () => {
  const U = 'Upocket0000000000000000000000002';
  const w = setup();
  const E = { TOKEN_ENC_KEY: b64u(new Uint8Array(32).fill(3)), GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', KV: fakeKV(), ENTRY: fakeEntryNS(), LEGACY_KEY_UNTIL: '2099-01-01' };
  const bind = { sheetId: 'S', auth: 'oauth', tok: `tok:${U}`, ledgerName: '我的帳本' };
  E.KV.m.set(`tok:${U}`, await encryptText(E, 'RT'));
  E.KV.m.set(`bind:${U}`, JSON.stringify(bind));
  E.KV.m.set('api:k_pocket_web_key_000000', JSON.stringify(bind));
  const deps = { ch: '', base: 'https://bot.test', fetch: w.fetch, today: T };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: U }, message: { type: 'text', text: t } }, E, deps);
  const tap = (d) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: U }, postback: { data: d } }, E, deps);
  const web = async (action, payload) => {
    const fd = new FormData(); fd.append('payload', JSON.stringify({ action, ...payload }));
    const res = await handleApi(new Request('https://w/api?key=k_pocket_web_key_000000', { method: 'POST', body: fd }), E, { waitUntil() {} }, { fetch: w.fetch });
    return res.json();
  };

  await say('餘額');                                         // LINE 端先有了口袋清單快取（只有兩個）
  await say('撥款 3000');                                     // 卡片在新增口袋之前就建立
  const pid = JSON.stringify(w.last()).match(/a=ok&p=(\w+)/)[1];
  assert.equal((await web('addPocket', { name: '日用口袋' })).ok, true);
  await tap(`a=pick&p=${pid}`);
  const menu = JSON.stringify(w.last());
  assert.match(menu, /撥入日用口袋/);
  const k = (await web('load', {})).data.pockets.find(p => p.name === '日用口袋').id;
  await tap(`a=alloc&p=${pid}&i=0&d=in&k=${k}`);
  assert.match(JSON.stringify(w.last()), /日常 → .{1,3} 日用口袋/);
  await tap(`a=ok&p=${pid}`);
  assert.equal(w.sheets.S['記帳明細'].at(-1)[10], '日用口袋');
});

test('LINE：直接在試算表「口袋」分頁新增的口袋，下一則訊息就能撥款', async () => {
  const U = 'Upocket0000000000000000000000003';
  const w = setup();
  const E = { TOKEN_ENC_KEY: b64u(new Uint8Array(32).fill(3)), GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', KV: fakeKV(), ENTRY: fakeEntryNS() };
  E.KV.m.set(`tok:${U}`, await encryptText(E, 'RT'));
  E.KV.m.set(`bind:${U}`, JSON.stringify({ sheetId: 'S', auth: 'oauth', tok: `tok:${U}`, ledgerName: '我的帳本' }));
  const deps = { ch: '', base: 'https://bot.test', fetch: w.fetch, today: T };
  const say = (t) => handleEvent({ type: 'message', replyToken: 'r', source: { userId: U }, message: { type: 'text', text: t } }, E, deps);
  const tap = (d) => handleEvent({ type: 'postback', replyToken: 'r', source: { userId: U }, postback: { data: d } }, E, deps);

  await say('餘額');                                                          // 建立口袋分頁、記住清單
  w.sheets.S['口袋'].push(['pmanual', '日用口袋', '🧴', 0, '使用中', '']);       // 使用者直接在試算表加一列
  await say('撥款 日用 500');
  assert.match(JSON.stringify(w.last()), /日常 → 🧴 日用口袋/);
  assert.doesNotMatch(w.text(), /找不到/);
  const pid = JSON.stringify(w.last()).match(/a=ok&p=(\w+)/)[1];
  await tap(`a=pick&p=${pid}`);
  assert.match(JSON.stringify(w.last()), /撥入日用口袋/);
});
