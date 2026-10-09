import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { resetTokenCache, resetSheetCaches } from '../src/google.js';
import { scanDuplicates } from '../src/api.js';
import { fakeKV, fakeEntryNS, makeServiceAccount, HEADER, fakeSheetsApi } from './helpers.js';

const SA = await makeServiceAccount();
const KEY = 'k_0123456789abcdef0123';

/* 模擬一本試算表（舊的英文帳本，第一次讀取時會自動中文化） */
function fakeSheets(rows = [], settings = [['openingBalance', 1000], ['cycleDay', 5], ['fundTarget', 50000]]) {
  const books = { SHEET: { Transactions: [HEADER, ...rows.map(r => [...r])], Settings: [['key', 'value'], ...settings] } };
  const calls = [];
  const api = fakeSheetsApi(books);
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: 't', expires_in: 3600 });
    if (u.startsWith('https://gas.test/')) { calls.push('gas'); return Response.json({ ok: true, data: {} }); }
    const r = await api(url, init);
    if (r) return r;
    throw new Error('unexpected ' + u);
  };
  const S = {
    get Transactions() { return books.SHEET['記帳明細'] || books.SHEET.Transactions; },
    get Settings() { return books.SHEET['設定'] || books.SHEET.Settings; },
  };
  return { S, calls, fetch: f };
}

function setup(rows, settings) {
  resetTokenCache();
  resetSheetCaches();
  const sh = fakeSheets(rows, settings);
  const env = {
    GOOGLE_SA_JSON: SA, LEGACY_GAS_URL: 'https://gas.test/exec',
    KV: fakeKV({ [`api:${KEY}`]: JSON.stringify({ sheetId: 'SHEET' }) }),
    ENTRY: fakeEntryNS(),
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (action, payload = {}, { key = KEY, get = false } = {}) => {
    globalThis.fetch = sh.fetch;   // 每個測試檔在獨立程序執行
    {
      let req;
      if (get) req = new Request(`https://w/api?key=${key}&action=${action}`);
      else {
        const fd = new FormData();
        fd.append('payload', JSON.stringify({ action, ...payload }));
        req = new Request(`https://w/api?key=${key}`, { method: 'POST', body: fd });
      }
      const res = await worker.fetch(req, env, ctx);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      await Promise.all(waits);
      return res.json();
    }
  };
  return { sh, env, call };
}

const row = (id, o = {}) => {
  const t = { id, type: 'outflow', category: 'food', date: 46302, amount: 100, client: '午餐', description: '', paymentTerm: 0, received: true, createdAt: '2026-10-07T01:00:00.000Z', account: '', ...o };
  return HEADER.map(h => t[h]);
};

test('api: 金鑰錯誤被拒', async () => {
  const s = setup();
  const r = await s.call('load', {}, { key: 'wrong-key-wrong-key' });
  assert.equal(r.ok, false);
});

test('api: load 格式與 Apps Script 相同（POST 與 GET）', async () => {
  const s = setup([row('1'), row('2', { type: 'inflow', category: 'salary', amount: 5000, date: '2026-10-05T16:00:00.000Z' })],
    [['openingBalance', 1000], ['cycleDay', 5], ['fundTarget', 150000], ['openingBalance_daily', 9]]);
  for (const get of [false, true]) {
    const r = await s.call('load', {}, { get });
    assert.equal(r.ok, true);
    assert.equal(r.data.openingBalance, 1000); assert.equal(r.data.cycleDay, 5); assert.equal(r.data.fundTarget, 150000);
    assert.equal(r.data.openingBalance_daily, 9);
    assert.deepEqual(r.data.transactions[0], { id: '1', type: 'outflow', category: 'food', date: '2026-10-07', amount: 100, client: '午餐', description: '', paymentTerm: 0, received: true, createdAt: '2026-10-07T01:00:00.000Z', account: '' });
    assert.equal(r.data.transactions[1].date, '2026-10-05');
  }
});

test('api: addTxn 冪等（同 id、60 秒內同內容）', async () => {
  const s = setup();
  const txn = { id: 'a1', type: 'outflow', category: 'food', date: '2026-10-07', amount: 80, client: '早餐', description: '', received: true, paymentTerm: 0, createdAt: '2026-10-07T00:00:00.000Z', account: '' };
  assert.equal((await s.call('addTxn', { txn })).ok, true);
  await s.call('addTxn', { txn });
  await s.call('addTxn', { txn: { ...txn, id: 'a2', createdAt: '2026-10-07T00:00:30.000Z' } });
  assert.equal(s.sh.S.Transactions.length, 2);
  await s.call('addTxn', { txn: { ...txn, id: 'a3', createdAt: '2026-10-07T00:05:00.000Z' } });   // 5 分鐘後算新的一筆
  assert.equal(s.sh.S.Transactions.length, 3);
  assert.ok(s.sh.calls.includes('gas'));   // 舊後端快取同步失效
});

test('api: 同時新增多筆不會遺失或重複', async () => {
  const s = setup();
  const mk = (i) => ({ id: 'p' + i, type: 'outflow', category: 'food', date: '2026-10-07', amount: i, client: 'x' + i, createdAt: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString() });
  await Promise.all([1, 2, 3, 4, 5].map(i => s.call('addTxn', { txn: mk(i) })));
  assert.equal(s.sh.S.Transactions.length, 6);
});

test('api: updateTxn 只改指定欄位；找不到也回成功', async () => {
  const s = setup([row('1'), row('2')]);
  const r = await s.call('updateTxn', { id: '2', fields: { amount: 999, client: '晚餐', date: '2026-10-06', account: 'savings' } });
  assert.equal(r.ok, true);
  const t = s.sh.S.Transactions[2];
  assert.equal(t[4], 999); assert.equal(t[5], '晚餐'); assert.equal(t[3], '2026-10-06'); assert.equal(t[10], '儲蓄口袋');
  assert.equal(t[9], '2026-10-07T01:00:00.000Z');   // 其他欄位不動
  assert.equal(s.sh.S.Transactions[1][4], 100);
  assert.equal((await s.call('updateTxn', { id: 'nope', fields: { amount: 1 } })).ok, true);
});

test('api: deleteTxn 刪正確的列；同 id 多列只刪一列', async () => {
  const s = setup([row('1'), row('2'), row('2', { createdAt: '2026-10-07T02:00:00.000Z' }), row('3')]);
  await s.call('deleteTxn', { id: '2' });
  assert.deepEqual(s.sh.S.Transactions.slice(1).map(r => r[0]), ['1', '2', '3']);
  assert.equal(s.sh.S.Transactions[2][9], '2026-10-07T01:00:00.000Z');   // 保留較早那列
  await s.call('deleteTxn', { id: '1' });
  assert.deepEqual(s.sh.S.Transactions.slice(1).map(r => r[0]), ['2', '3']);
  assert.equal((await s.call('deleteTxn', { id: 'nope' })).ok, true);
});

test('api: setSetting / setOpening', async () => {
  const s = setup();
  await s.call('setSetting', { key: 'cycleDay', value: 10 });
  await s.call('setSetting', { key: 'fundTarget', value: 200000 });
  await s.call('setOpening', { value: 777 });
  const r = await s.call('load');
  assert.equal(r.data.cycleDay, 10); assert.equal(r.data.fundTarget, 200000); assert.equal(r.data.openingBalance, 777);
  assert.equal((await s.call('setSetting', { key: 'evil', value: 1 })).ok, false);
  assert.equal((await s.call('setSetting', { key: 'cycleDay', value: 40 })).ok, false);
});

test('api: scanDuplicates', () => {
  const t = (id, o = {}) => ({ id, type: 'outflow', category: 'food', date: '2026-10-06', amount: 180, client: '晚餐', account: '', createdAt: '2026-10-06T10:00:00Z', ...o });
  const g = scanDuplicates([t('a'), t('a', { createdAt: '2026-10-06T09:00:00Z' }), t('b'), t('c', { amount: 5 })]);
  const byId = g.find(x => x.reason === 'id');
  assert.equal(byId.items.length, 2); assert.equal(byId.items[0].createdAt, '2026-10-06T09:00:00Z');
  const byC = g.find(x => x.reason === 'content');
  assert.deepEqual(byC.items.map(i => i.id).sort(), ['a', 'b']);
});
