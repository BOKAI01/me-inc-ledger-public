/**
 * 帳本中文化：試算表上顯示中文，程式內部仍用英文代碼。
 * 讀取時中英文都接受（舊帳本、手動輸入都讀得懂），寫入時依該帳本的標題決定用中文或英文。
 */
import { DEPARTMENTS, INCOME_CATS } from './ledger.js';

export const TAB_TXN = '記帳明細';
export const TAB_SET = '設定';
export const TAB_TXN_EN = 'Transactions';
export const TAB_SET_EN = 'Settings';

const COLS = [
  ['id', '編號'], ['type', '類型'], ['category', '分類'], ['date', '日期'], ['amount', '金額'],
  ['client', '項目'], ['description', '備註'], ['paymentTerm', '收款天數'], ['received', '已收款'],
  ['createdAt', '建立時間'], ['account', '口袋'],
];
export const HEADER_EN = COLS.map(c => c[0]);
export const HEADER_ZH = COLS.map(c => c[1]);
/** 平常用不到、預設隱藏的系統欄位 */
export const HIDDEN_COLS = ['id', 'paymentTerm', 'createdAt'];

const COL_ZH = Object.fromEntries(COLS);
const COL_EN = Object.fromEntries(COLS.map(([e, z]) => [z, e]));
export const colKey = (h) => { const s = String(h ?? '').trim(); return COL_EN[s] || s; };
export const isZhHeader = (header) => String(header?.[0] ?? '').trim() === '編號';
export const zhHeaderOf = (header) => header.map(h => COL_ZH[colKey(h)] || h);

/* ---------- 欄位內容 ---------- */
const TYPE = { outflow: '支出', inflow: '收入', alloc: '撥款' };
const CAT = {
  ...Object.fromEntries(DEPARTMENTS.map(d => [d.id, d.fullName])),
  ...Object.fromEntries(INCOME_CATS.map(c => [c.id, c.name])),
  alloc_in: '撥入口袋', alloc_out: '撥回日常',
};
const ACC = { '': '日常', daily: '日常', savings: '儲蓄口袋', emergency: '緊急備用金' };

const squash = (s) => String(s ?? '').replace(/[\s·・\/／]/g, '');
function reverse(map, extra = {}) {
  const r = {};
  for (const [en, zh] of Object.entries(map)) { r[en] = en; r[squash(zh)] = en; }
  for (const [k, en] of Object.entries(extra)) r[squash(k)] = en;
  return r;
}
const TYPE_R = reverse(TYPE, { 支出: 'outflow', 收入: 'inflow', 撥款: 'alloc' });
const CAT_R = reverse(CAT, {
  ...Object.fromEntries(DEPARTMENTS.map(d => [d.name, d.id])),          // 「食」「衣」…
  餐飲: 'food', 交通: 'transport', 居家: 'housing', 娛樂: 'leisure', 其他支出: 'other_out', 薪資: 'salary',
});
const ACC_R = { ...reverse({ savings: '儲蓄口袋', emergency: '緊急備用金' }, { 儲蓄: 'savings', 緊急: 'emergency' }), 日常: '', daily: '', '': '' };

/** 內部值 → 試算表顯示值 */
export function toSheet(key, v) {
  switch (key) {
    case 'type': return TYPE[v] ?? v;
    case 'category': return CAT[v] ?? v;
    case 'account': return ACC[v ?? ''] ?? v;
    case 'received': return v === false || String(v).toUpperCase() === 'FALSE' || v === '否' ? '否' : '是';
    default: return v;
  }
}

/** 試算表值（中英文皆可）→ 內部值 */
export function fromSheet(key, v) {
  if (v == null) return v;
  switch (key) {
    case 'type': return TYPE_R[squash(v)] ?? v;
    case 'category': return CAT_R[squash(v)] ?? v;
    case 'account': { const k = squash(v); return k in ACC_R ? ACC_R[k] : String(v); }
    case 'received': return v === true || String(v).toUpperCase() === 'TRUE' || squash(v) === '是';
    default: return v;
  }
}

/* ---------- 設定工作表 ---------- */
const SET_COLS = [['key', '設定項目'], ['value', '數值'], ['note', '說明']];
export const SET_HEADER_ZH = SET_COLS.map(c => c[1]);
const SET = { openingBalance: '期初存款', cycleDay: '結算日', fundTarget: '緊急備用金目標', savingsTarget: '儲蓄目標', payoutAccount: '收款帳號', schemaVersion: '格式版本' };
const SET_R = Object.fromEntries(Object.entries(SET).map(([e, z]) => [z, e]));
const POCKET = { savings: '儲蓄口袋', emergency: '緊急備用金', daily: '日常' };
const POCKET_R = Object.fromEntries(Object.entries(POCKET).map(([e, z]) => [z, e]));

export const isZhSettings = (row) => String(row?.[0] ?? '').trim() === '設定項目';
export const setHeaderZh = (row) => row.map(h => (Object.fromEntries(SET_COLS)[String(h).trim()] || h));

export function settingToSheet(k) {
  if (SET[k]) return SET[k];
  const m = String(k).match(/^openingBalance_(.+)$/);
  return m ? `期初存款_${POCKET[m[1]] || m[1]}` : k;
}
export function settingFromSheet(k) {
  const s = String(k ?? '').trim();
  if (SET_R[s]) return SET_R[s];
  const m = s.match(/^期初存款_(.+)$/);
  return m ? `openingBalance_${POCKET_R[m[1]] || m[1]}` : s;
}
