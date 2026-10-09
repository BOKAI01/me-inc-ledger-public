import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry } from '../src/parse.js';
import { computePockets, computeSummary, currentPeriodKey, periodRange, taipeiToday } from '../src/ledger.js';
import { verifySignature } from '../src/line.js';

const T = '2026-10-06';

test('parse: 基本支出', () => {
  assert.deepEqual(parseEntry('午餐 1', T), { type: 'outflow', category: 'food', amount: 1, client: '午餐', date: T });
  assert.equal(parseEntry('午餐120', T).amount, 120);
  assert.equal(parseEntry('計程車 $1,250元', T).amount, 1250);
  assert.equal(parseEntry('計程車 250', T).category, 'transport');
  assert.equal(parseEntry('房租 12000', T).category, 'housing');
  assert.equal(parseEntry('什麼東西 99', T).category, 'other_out');
});

test('parse: 全形、日期、收入', () => {
  assert.equal(parseEntry('午餐　１２０', T).amount, 120);
  assert.equal(parseEntry('昨天 晚餐 200', T).date, '2026-10-05');
  assert.equal(parseEntry('前天 晚餐 200', T).date, '2026-10-04');
  assert.equal(parseEntry('10/3 電影 300', T).date, '2026-10-03');
  assert.equal(parseEntry('12/31 電影 300', T).date, '2025-12-31');
  const s = parseEntry('薪水 50000', T);
  assert.equal(s.type, 'inflow'); assert.equal(s.category, 'salary');
  const p = parseEntry('+賣二手 800', T);
  assert.equal(p.type, 'inflow'); assert.equal(p.client, '賣二手'); assert.equal(p.category, 'other_in');
});

test('parse: 無效輸入', () => {
  for (const s of ['餘額', '午餐', '120', '午餐 0', '', '午餐 -5']) assert.equal(parseEntry(s, T), null, s);
});

test('period: 結算日', () => {
  assert.equal(currentPeriodKey(5, '2026-10-06'), '2026-10');
  assert.equal(currentPeriodKey(5, '2026-10-04'), '2026-09');
  assert.equal(currentPeriodKey(1, '2026-01-01'), '2026-01');
  assert.equal(currentPeriodKey(5, '2026-01-02'), '2025-12');
  assert.deepEqual(periodRange('2026-09', 5), { start: '2026-09-05', end: '2026-10-04' });
  assert.deepEqual(periodRange('2026-02', 1), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(periodRange('2025-12', 5), { start: '2025-12-05', end: '2026-01-04' });
  assert.equal(taipeiToday(Date.UTC(2026, 9, 5, 16, 30)), '2026-10-06');   // UTC 16:30 = 台灣 00:30
});

const TX = [
  { type: 'inflow',  category: 'salary',    amount: 50000, date: '2026-10-05', account: '' },
  { type: 'outflow', category: 'food',      amount: 300,   date: '2026-10-06', account: '' },
  { type: 'alloc',   category: 'alloc_in',  amount: 5000,  date: '2026-10-05', account: 'savings' },
  { type: 'alloc',   category: 'alloc_in',  amount: 2000,  date: '2026-10-05', account: 'emergency' },
  { type: 'outflow', category: 'other_out', amount: 1000,  date: '2026-10-05', client: '緊急備用金', account: '' }, // 舊資料：視為撥入
  { type: 'outflow', category: 'leisure',   amount: 800,   date: '2026-10-06', account: 'savings' },
  { type: 'outflow', category: 'food',      amount: 999,   date: '2026-10-01', account: '' },                       // 上一期
];

test('ledger: 口袋與網站算法一致', () => {
  const p = computePockets(TX, 10000);
  // total = 10000 + 50000 - 300 - 800 - 999 = 57901（alloc 不影響總額）
  assert.equal(p.total, 57901);
  assert.equal(p.savings, 5000 - 800);
  assert.equal(p.emergency, 2000 + 1000);
  assert.equal(p.daily, 57901 - 4200 - 3000);
  assert.equal(p.total, p.daily + p.savings + p.emergency);
});

test('ledger: 本期摘要', () => {
  const s = computeSummary(TX, 5, T);
  assert.equal(s.label, '2026/10/5 – 2026/11/4');
  assert.equal(s.inc, 50000);
  assert.equal(s.exp, 1100);
  assert.equal(s.net, 48900);
  assert.equal(s.depts[0].id, 'leisure');
});

test('line: 簽章驗證', async () => {
  const body = '{"events":[]}';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('base64');
  assert.equal(await verifySignature('sec', body, sig), true);
  assert.equal(await verifySignature('sec', body + ' ', sig), false);
  assert.equal(await verifySignature('sec', body, null), false);
  assert.equal(await verifySignature('', body, sig), false);
});

test('parse: 撥款', () => {
  const a = parseEntry('撥款 緊急 5000', T);
  assert.deepEqual(a, { type: 'alloc', category: 'alloc_in', account: 'emergency', client: '撥入緊急備用金', amount: 5000, date: T });
  assert.equal(parseEntry('撥款 儲蓄 3000', T).account, 'savings');
  assert.equal(parseEntry('撥款 3000', T).account, 'emergency');            // 同網站預設
  const b = parseEntry('撥回 儲蓄 2000', T);
  assert.equal(b.category, 'alloc_out'); assert.equal(b.account, 'savings');
  assert.equal(parseEntry('撥款 緊急→日常 1000', T).category, 'alloc_out');
  assert.equal(parseEntry('撥款 日常→儲蓄 1000', T).category, 'alloc_in');
  assert.equal(parseEntry('昨天 撥款 儲蓄 500', T).date, '2026-10-05');
});

test('ledger: 撥款不影響總額、只移動口袋', () => {
  const tx = [
    { type: 'inflow', category: 'salary', amount: 10000, date: T, account: '' },
    { type: 'alloc', category: 'alloc_in', amount: 3000, date: T, account: 'savings' },
    { type: 'alloc', category: 'alloc_out', amount: 1000, date: T, account: 'savings' },
  ];
  const p = computePockets(tx, 0);
  assert.equal(p.total, 10000); assert.equal(p.savings, 2000); assert.equal(p.daily, 8000);
  const s = computeSummary(tx, 1, T);
  assert.equal(s.inc, 10000); assert.equal(s.exp, 0);
});

import { normDate } from '../src/google.js';
test('google: 日期正規化與 Apps Script 一致', () => {
  assert.equal(normDate(46156), '2026-05-14');                    // 日期儲存格序號
  assert.equal(normDate('2026-05-16T16:00:00.000Z'), '2026-05-16'); // 舊資料字串取前 10 碼
  assert.equal(normDate('2026/5/4'), '2026-05-04');
  assert.equal(normDate('2026-10-07'), '2026-10-07');
});

test('ledger: 撥款口袋欄空白或填日常時，由品項判斷口袋', () => {
  const tx = [
    { type: 'alloc', category: 'alloc_in', amount: 3000, client: '儲蓄', account: '' },
    { type: 'alloc', category: 'alloc_in', amount: 3000, client: '緊急備用金', account: 'emergency' },
    { type: 'alloc', category: 'alloc_out', amount: 1180, client: '儲蓄口袋撥回日常', account: 'savings' },
    { type: 'alloc', category: 'alloc_in', amount: 500, client: '撥款', account: '' },
  ];
  const p = computePockets(tx, 10000);
  assert.equal(p.savings, 1820);
  assert.equal(p.emergency, 3500);
  assert.equal(p.total, 10000);
});
