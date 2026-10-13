/* 與網站 app.js 相同的分類、口袋與期間算法（數字必須和網站一致） */

export const INCOME_CATS = [
  { id: 'salary',     name: '主要薪資',   emoji: '💼' },
  { id: 'side',       name: '副業 / 兼職', emoji: '💻' },
  { id: 'investment', name: '投資收益',   emoji: '📈' },
  { id: 'bonus',      name: '獎金 / 紅利', emoji: '🎁' },
  { id: 'other_in',   name: '其他收入',   emoji: '📦' },
];

export const DEPARTMENTS = [
  { id: 'food',      name: '食',   fullName: '食 · 餐飲部',   emoji: '🍱' },
  { id: 'cloth',     name: '衣',   fullName: '衣 · 形象部',   emoji: '👔' },
  { id: 'housing',   name: '住',   fullName: '住 · 後勤部',   emoji: '🏠' },
  { id: 'transport', name: '行',   fullName: '行 · 移動部',   emoji: '🚗' },
  { id: 'leisure',   name: '娛',   fullName: '娛 · 文化部',   emoji: '🎬' },
  { id: 'other_out', name: '其他', fullName: '其他 · 雜項部', emoji: '📂' },
];

export const findDept = (id) => DEPARTMENTS.find(d => d.id === id) || DEPARTMENTS[5];
export const findIncome = (id) => INCOME_CATS.find(c => c.id === id) || INCOME_CATS[4];
import { DEFAULT_POCKETS, pocketById, findPocket } from './pockets.js';

/** 撥款方向的文字，例如「👛 日常 → ✈️ 旅遊基金」。pockets 省略時用預設的兩個口袋 */
const pocketTag = (id, pockets) => {
  if (!id || id === 'daily') return '👛 日常';
  const pk = pocketById(pockets, id) || pocketById(DEFAULT_POCKETS, id) || { icon: '👝', name: id || '口袋' };
  return `${pk.icon} ${pk.name}`;
};
/** 撥款方向文字；alloc_move（口袋互轉）用 from 標示轉出的口袋 */
export const allocLabel = (category, account, pockets = DEFAULT_POCKETS, from = '') => {
  if (category === 'alloc_move') return `${pocketTag(from, pockets)} → ${pocketTag(account, pockets)}`;
  const p = pocketTag(account, pockets);
  return category === 'alloc_out' ? `${p} → 👛 日常` : `👛 日常 → ${p}`;
};
export const catLabel = (type, cat, account, pockets, from) => {
  if (type === 'alloc') return allocLabel(cat, account, pockets, from);
  const c = type === 'inflow' ? findIncome(cat) : findDept(cat);
  return `${c.emoji} ${type === 'inflow' ? c.name : c.fullName}`;
};

/* 舊資料相容：只認原本兩個口袋的說法 */
function legacyPocketByName(text) {
  const s = String(text || '');
  if (/儲蓄|存款/.test(s)) return 'savings';
  if (/備用金|緊急|急用/.test(s)) return 'emergency';
  return null;
}

/* 撥款的口袋：口袋欄是已知口袋就用它；空白或「日常」時（例如手動輸入）改由品項／備註判斷 */
function allocPocket(tx, pockets) {
  const acc = tx.account;
  if (acc && acc !== 'daily') return acc;                    // 已知口袋；認不得的名稱也當作一個口袋，錢不會不見
  const guess = (t) => (pockets ? findPocket(pockets, t, { includeDeleted: true })?.id : null) || legacyPocketByName(t);
  const fallback = !pockets || pocketById(pockets, 'emergency') ? 'emergency' : (pockets.find(p => p.active)?.id || 'emergency');
  return guess(tx.client) || guess(tx.description) || fallback;
}

export function classify(tx, pockets) {
  if (tx.type === 'alloc') {
    return { kind: 'alloc', dir: tx.category === 'alloc_out' ? 'out' : 'in', pocket: allocPocket(tx, pockets) };
  }
  if (tx.type === 'outflow' && tx.category === 'other_out' && (!tx.account || tx.account === 'daily')) {
    const p = legacyPocketByName(tx.client);
    if (p) return { kind: 'alloc', dir: 'in', pocket: p, legacy: true };
  }
  return { kind: 'flow', pocket: tx.account && tx.account !== '' ? tx.account : 'daily' };
}

/* ---------- 日期（全部以台灣時間的 yyyy-MM-dd 字串比較） ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => {                         // m 為 1–12，可溢位
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

export function taipeiToday(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function shiftDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ymd(y, m, d + delta);
}

/** 目前期間的起始月 key，例如 '2026-09'（cycleDay=5 時代表 9/5–10/4） */
export function currentPeriodKey(cycleDay, today) {
  const [y, m, d] = today.split('-').map(Number);
  if (cycleDay === 1 || d >= cycleDay) return `${y}-${pad(m)}`;
  return ymd(y, m - 1, 1).slice(0, 7);
}

/** 回傳 { start, end }（皆含），yyyy-MM-dd */
export function periodRange(key, cycleDay) {
  const [y, m] = key.split('-').map(Number);
  if (cycleDay === 1) return { start: ymd(y, m, 1), end: ymd(y, m + 1, 0) };
  return { start: ymd(y, m, cycleDay), end: ymd(y, m + 1, cycleDay - 1) };
}

export function periodLabelFull(key, cycleDay) {
  const { start, end } = periodRange(key, cycleDay);
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  if (cycleDay === 1) return `${sy} 年 ${sm} 月（${sm}/1–${em}/${ed}）`;
  return `${sy}/${sm}/${sd} – ${ey}/${em}/${ed}`;
}

const dateOf = (t) => String(t.date || '').slice(0, 10);
const amt = (t) => Number(t.amount || 0);

/** 帳戶總額與各口袋餘額（同網站 pockets）。byId：口袋代號 → 餘額；savings／emergency 保留給舊呼叫端 */
export function computePockets(transactions, openingBalance, pockets) {
  let total = Number(openingBalance) || 0;
  const byId = {};
  for (const p of pockets || []) byId[p.id] = 0;
  const bump = (id, v) => { byId[id] = (byId[id] || 0) + v; };
  for (const t of transactions) {
    const c = classify(t, pockets);
    const a = amt(t);
    if (c.kind === 'alloc') { bump(c.pocket, c.dir === 'in' ? a : -a); continue; }
    total += (t.type === 'inflow' ? 1 : -1) * a;
    if (c.pocket !== 'daily') bump(c.pocket, (t.type === 'inflow' ? 1 : -1) * a);
  }
  const inPockets = Object.values(byId).reduce((s, v) => s + v, 0);
  return { total, daily: total - inPockets, byId, savings: byId.savings || 0, emergency: byId.emergency || 0 };
}

/** 本期收支（同網站 inc / exp / netProfit / deptStats） */
export function computeSummary(transactions, cycleDay, today, pockets) {
  const key = currentPeriodKey(cycleDay, today);
  const { start, end } = periodRange(key, cycleDay);
  const flows = transactions.filter(t => {
    const d = dateOf(t);
    return d.length === 10 && d >= start && d <= end && classify(t, pockets).kind === 'flow';
  });
  const inc = flows.filter(t => t.type === 'inflow').reduce((s, t) => s + amt(t), 0);
  const exp = flows.filter(t => t.type === 'outflow').reduce((s, t) => s + amt(t), 0);
  const depts = DEPARTMENTS.map(d => {
    const total = flows.filter(t => t.type === 'outflow' && t.category === d.id).reduce((s, t) => s + amt(t), 0);
    return { ...d, total };
  }).filter(d => d.total > 0).sort((a, b) => b.total - a.total);
  return { key, label: periodLabelFull(key, cycleDay), inc, exp, net: inc - exp, depts, count: flows.length };
}

export const fmt = (n) => new Intl.NumberFormat('zh-TW').format(Math.round(Number(n) || 0));

/**
 * 撥款：從 from 口袋轉到 to 口袋（'' 代表日常）。
 * 一邊是日常 → 一般撥款；兩邊都是口袋 → alloc_move（寫入時拆成「轉出」「轉入」兩筆，帳戶總額不變）
 */
export function transferPatch(from, to, pockets = DEFAULT_POCKETS) {
  const f = from === 'daily' ? '' : from || '', t = to === 'daily' ? '' : to || '';
  const nm = (id) => (pocketById(pockets, id) || pocketById(DEFAULT_POCKETS, id) || { name: id }).name;
  if (!f) return { type: 'alloc', category: 'alloc_in', account: t, from: '', client: `撥入${nm(t)}` };
  if (!t) return { type: 'alloc', category: 'alloc_out', account: f, from: '', client: `${nm(f)}撥回日常` };
  return { type: 'alloc', category: 'alloc_move', account: t, from: f, client: `口袋互轉：${nm(f)}→${nm(t)}` };
}

/** 寫入試算表用：口袋互轉拆成兩筆撥款（同一個 id 前綴，重複按也不會多寫） */
export function expandTransfer(txn) {
  if (txn.type !== 'alloc' || txn.category !== 'alloc_move') return [txn];
  const { from, ...base } = txn;
  return [
    { ...base, id: `${txn.id}a`, category: 'alloc_out', account: from },
    { ...base, id: `${txn.id}b`, category: 'alloc_in', account: txn.account },
  ];
}
