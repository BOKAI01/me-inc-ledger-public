import test from 'node:test';
import assert from 'node:assert/strict';
import { readLedger, readHeaderAndIds, appendTxns, txnCell, writeCells, setSetting, resetSheetCaches, SCHEMA_VERSION } from '../src/google.js';
import { HEADER_ZH, toSheet, fromSheet } from '../src/zh.js';
import { HEADER, fakeSheetsApi } from './helpers.js';

function oldBook() {
  return {
    Transactions: [
      HEADER,
      ['1', 'outflow', 'food', 46303, 120, '午餐', '', 0, true, 46303.5, ''],
      ['2', 'inflow', 'salary', '2026-10-05', 50000, '薪水', '十月', 0, 'TRUE', '2026-10-05T01:00:00.000Z', ''],
      ['3', 'alloc', 'alloc_in', '2026-10-06', 3000, '撥入儲蓄口袋', '', 0, true, '', 'savings'],
      ['4', 'outflow', 'transport', '2026-10-07', 250, '計程車', '', 0, false, '', 'daily'],
    ],
    Settings: [['key', 'value', 'note'], ['openingBalance', 52000, '期初金額'], ['cycleDay', 5, ''], ['fundTarget', 50000, ''], ['openingBalance_savings', 1000, '']],
  };
}

test('中英對照：讀寫都可逆，手動輸入的簡寫也看得懂', () => {
  for (const [k, v] of [['type', 'outflow'], ['type', 'alloc'], ['category', 'food'], ['category', 'other_in'], ['category', 'alloc_out'], ['account', 'savings'], ['account', '']]) {
    assert.equal(fromSheet(k, toSheet(k, v)), v, `${k}:${v}`);
  }
  assert.equal(fromSheet('category', '餐飲'), 'food');
  assert.equal(fromSheet('category', '食・餐飲部'), 'food');
  assert.equal(fromSheet('category', '行'), 'transport');
  assert.equal(fromSheet('account', '儲蓄'), 'savings');
  assert.equal(fromSheet('received', '是'), true);
  assert.equal(fromSheet('received', '否'), false);
  assert.equal(toSheet('received', true), '是');
});

test('舊帳本自動中文化：改名、翻譯、格式；日期金額不動；讀出結果與轉換前相同', async () => {
  resetSheetCaches();
  const books = { S: oldBook() }, log = [];
  const api = fakeSheetsApi(books, log);
  let formatReqs = null;
  const f = async (url, init = {}) => {
    if (String(url).endsWith('S:batchUpdate')) formatReqs = JSON.parse(init.body).requests;
    return api(url, init);
  };
  const before = structuredClone(books.S.Transactions);
  const d = await readLedger('T', 'S', f);

  // 工作表改名、標題與內容中文
  assert.deepEqual(Object.keys(books.S), ['記帳明細', '設定']);
  const T = books.S['記帳明細'], S = books.S['設定'];
  assert.deepEqual(T[0], HEADER_ZH);
  assert.deepEqual(T.slice(1).map(r => [r[1], r[2], r[8], r[10]]), [
    ['支出', '食 · 餐飲部', '是', '日常'],
    ['收入', '主要薪資', '是', '日常'],
    ['撥款', '撥入口袋', '是', '儲蓄口袋'],
    ['支出', '行 · 移動部', '否', '日常'],
  ]);
  // 日期、金額、建立時間沒有被改寫
  for (let i = 1; i < before.length; i++) for (const c of [0, 3, 4, 5, 6, 9]) assert.equal(T[i][c], before[i][c]);
  assert.deepEqual(S.map(r => r[0]), ['設定項目', '期初存款', '結算日', '緊急備用金目標', '期初存款_儲蓄口袋', '格式版本']);
  assert.equal(S.at(-1)[1], SCHEMA_VERSION);                       // 記下格式版本，之後不再重複檢查
  assert.equal(S[1][2], '期初金額');           // 說明欄保留

  // 格式：凍結、隱藏編號／收款天數／建立時間、金額千分位
  const hidden = formatReqs.filter(r => r.updateDimensionProperties).map(r => r.updateDimensionProperties.range.startIndex);
  assert.deepEqual(hidden, [0, 7, 9]);
  assert.ok(formatReqs.some(r => r.repeatCell?.cell.userEnteredFormat.numberFormat?.pattern === '#,##0' && r.repeatCell.range.startColumnIndex === 4));
  assert.ok(formatReqs.some(r => r.updateSheetProperties?.properties.gridProperties?.frozenRowCount === 1));

  // 讀出的內部資料與轉換前一致
  assert.deepEqual(d.transactions.map(t => [t.type, t.category, t.account, t.received]), [
    ['outflow', 'food', '', true], ['inflow', 'salary', '', true], ['alloc', 'alloc_in', 'savings', true], ['outflow', 'transport', '', false],
  ]);
  assert.equal(d.transactions[0].date, '2026-10-08');
  assert.equal(d.openingBalance, 52000); assert.equal(d.cycleDay, 5); assert.equal(d.settings.openingBalance_savings, 1000);

  // 之後的寫入都是中文
  const { header } = await readHeaderAndIds('T', 'S', f);
  await appendTxns('T', 'S', header, [{ id: '5', type: 'outflow', category: 'leisure', date: '2026-10-08', amount: 300, client: '電影', description: '', paymentTerm: 0, received: true, createdAt: 'x', account: '' }], f);
  assert.deepEqual(T.at(-1).slice(0, 6), ['5', '支出', '娛 · 文化部', '2026-10-08', 300, '電影']);
  assert.equal(T.at(-1)[10], '日常');
  const d2 = await readLedger('T', 'S', f);
  await writeCells('T', 'S', [txnCell(d2, 'category', 2, 'cloth')], f);
  assert.equal(T[1][2], '衣 · 形象部');
  await setSetting('T', 'S', d2, 'cycleDay', 10, f);
  await setSetting('T', 'S', d2, 'payoutAccount', '822-123', f);
  assert.deepEqual(S[2], ['結算日', 10, '']);
  assert.deepEqual(S.at(-1), ['收款帳號', '822-123']);

  // 轉換只做一次
  const n = log.filter(x => x.endsWith(':batchUpdate POST')).length;
  await readLedger('T', 'S', f);
  assert.equal(log.filter(x => x.endsWith(':batchUpdate POST')).length, n);
});

test('修復：資料列跑到標題列上方時，自動移回標題下方，之後寫在最後一列', async () => {
  resetSheetCaches();
  const row = ['9', '支出', '食 · 餐飲部', '2026-10-09', 35, '早餐', '', 0, '是', 'x', '日常'];
  const books = { S: { '記帳明細': [row, HEADER_ZH], '設定': [['設定項目', '數值'], ['期初存款', 100]] } };
  const f = fakeSheetsApi(books);
  const d = await readLedger('T', 'S', f);
  assert.deepEqual(books.S['記帳明細'][0], HEADER_ZH);
  assert.deepEqual(books.S['記帳明細'][1], row);
  assert.equal(d.transactions.length, 1);
  assert.equal(d.transactions[0].client, '早餐');
  const { header } = await readHeaderAndIds('T', 'S', f);
  await appendTxns('T', 'S', header, [{ id: '10', type: 'outflow', category: 'food', date: '2026-10-09', amount: 80, client: '午餐', received: true, account: '' }], f);
  assert.equal(books.S['記帳明細'].length, 3);
  assert.equal(books.S['記帳明細'][2][5], '午餐');
});

test('帳本格式升級：舊版本缺少的欄位自動補上、記錄版本、只做一次，資料不動', async () => {
  resetSheetCaches();
  const books = { S: {
    '記帳明細': [['編號', '類型', '分類', '日期', '金額', '項目', '備註', '收款天數', '已收款', '建立時間'],   // 舊版：沒有「口袋」
      ['1', '支出', '食 · 餐飲部', '2026-09-01', 100, '早餐', '', 0, '是', 'x']],
    '設定': [['設定項目', '數值', '說明'], ['期初存款', 1000, ''], ['結算日', 1, '']],
  } }, log = [];
  const f = fakeSheetsApi(books, log);
  const d = await readLedger('T', 'S', f);
  const T = books.S['記帳明細'], S = books.S['設定'];
  assert.equal(T[0][10], '口袋');                                   // 補上新欄位
  assert.deepEqual(T[1].slice(0, 6), ['1', '支出', '食 · 餐飲部', '2026-09-01', 100, '早餐']);
  assert.deepEqual(S.at(-1).slice(0, 2), ['格式版本', SCHEMA_VERSION]);
  assert.equal(d.transactions[0].amount, 100);

  // 新欄位可以正常寫入
  const { header } = await readHeaderAndIds('T', 'S', f);
  await appendTxns('T', 'S', header, [{ id: '2', type: 'alloc', category: 'alloc_in', date: '2026-09-02', amount: 500, client: '撥入儲蓄口袋', description: '', paymentTerm: 0, received: true, createdAt: 'y', account: 'savings' }], f);
  assert.equal(T.at(-1)[10], '儲蓄口袋');

  // 已是最新版本：換一個執行個體重新讀取，不會再寫入任何東西
  resetSheetCaches(); log.length = 0;
  await readLedger('T', 'S', f);
  assert.ok(!log.some(x => x.endsWith('POST')), log.join(','));
});
