/* 解析 LINE 文字訊息為一筆記帳 */
import { shiftDays } from './ledger.js';

const EXPENSE_KW = [
  ['food',      /早餐|午餐|晚餐|早午餐|宵夜|消夜|便當|飲料|咖啡|手搖|奶茶|紅茶|綠茶|點心|零食|聚餐|買菜|超市|全聯|麵包|麵|飯|水果|餐|吃/],
  ['cloth',     /衣|褲|裙|鞋|襪|包包|剪髮|理髮|美髮|燙髮|染髮|美容|美甲|保養品|化妝/],
  ['transport', /捷運|公車|客運|高鐵|台鐵|火車|計程車|小黃|uber|加油|油錢|停車|過路|etag|機車|汽車|保養|悠遊卡|youbike|交通|車資/i],
  ['housing',   /房租|租金|水費|電費|瓦斯|網路費|網路|電話費|手機費|電信|管理費|日用品|衛生紙|清潔|家具|家電|洗衣/],
  ['leisure',   /電影|訂閱|netflix|spotify|youtube|disney|遊戲|旅遊|旅行|住宿|飯店|健身|運動|門票|書|演唱會|ktv|展覽/i],
  ['other_out', /醫|診所|藥|掛號|保險|稅|紅包|禮金|白包|卡費|貸款|捐|罰單/],
];

const INCOME_KW = [
  ['salary',     /薪水|薪資|月薪|工資/],
  ['bonus',      /獎金|紅利|年終|分紅/],
  ['investment', /股息|股利|配息|利息|投資|出場/],
  ['side',       /副業|兼職|接案|稿費|外快|案子/],
  ['other_in',   /收入|進帳|退款|退費|中獎/],
];

export function guessCategory(item, type) {
  const list = type === 'inflow' ? INCOME_KW : EXPENSE_KW;
  for (const [id, re] of list) if (re.test(item)) return id;
  return type === 'inflow' ? 'other_in' : 'other_out';
}

export const POCKET_NAMES = { savings: '儲蓄口袋', emergency: '緊急備用金' };

export function allocEntry(dir, pocket) {
  const name = POCKET_NAMES[pocket];
  return {
    type: 'alloc',
    category: dir === 'out' ? 'alloc_out' : 'alloc_in',
    account: pocket,
    client: dir === 'out' ? `${name}撥回日常` : `撥入${name}`,
  };
}

/**
 * 「撥款 緊急 5000」「撥款 儲蓄 3000」→ 日常 → 口袋
 * 「撥回 儲蓄 2000」「撥款 緊急→日常 2000」→ 口袋 → 日常
 * 沒寫口袋時與網站相同，預設緊急備用金
 */
function parseAlloc(head) {
  const m = head.match(/^(撥款|撥入|轉入|存入|撥回|轉回|提領|動用)\s*(.*)$/);
  if (!m) return null;
  const rest = m[2];
  let dir = /^(撥回|轉回|提領|動用)$/.test(m[1]) ? 'out' : 'in';
  if (/(→|->|到|回|至)\s*日常/.test(rest)) dir = 'out';
  const pocket = /儲蓄|存款/.test(rest) ? 'savings' : 'emergency';
  return allocEntry(dir, pocket);
}

const toHalfWidth =(s) => s
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');

/** 行首日期：今天／昨天／前天／M/D。回傳 { date, rest }，日期無效回傳 { error: true } */
function takeDate(s, today) {
  let m;
  if ((m = s.match(/^(今天|昨天|前天)\s*/))) {
    return { date: shiftDays(today, { 今天: 0, 昨天: -1, 前天: -2 }[m[1]]), rest: s.slice(m[0].length) };
  }
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(\s+|$)/))) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { error: true };
    let y = Number(today.slice(0, 4));
    const fmtD = (yy) => `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (fmtD(y) > today) y -= 1;                    // 未來日期視為去年
    return { date: fmtD(y), rest: s.slice(m[0].length) };
  }
  return null;
}

/** 整行只有日期（多筆輸入時當作後續各行的預設日期） */
export function parseDateOnly(raw, today) {
  const s = toHalfWidth(String(raw || '')).trim();
  const t = takeDate(s, today);
  return t && !t.error && !t.rest.trim() ? t.date : null;
}

/**
 * 「午餐 120」「昨天 計程車 250」「10/3 電影 300」「+薪水 50000」「收入 獎金 3000」
 * 回傳 { type, category, amount, client, date } 或 null
 * defaultDate：行首沒寫日期時使用（預設今天）
 */
export function parseEntry(raw, today, defaultDate) {
  let s = toHalfWidth(String(raw || '')).trim();
  if (!s || s.length > 60) return null;

  let date = defaultDate || today;
  const t = takeDate(s, today);
  if (t && t.error) return null;
  if (t) { date = t.date; s = t.rest; }
  let m;

  let forceIncome = false;
  if ((m = s.match(/^(\+|收入\s+)/))) { forceIncome = true; s = s.slice(m[0].length); }

  // 金額：最後一個數字（可含 $、逗號、元）
  const am = s.match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(元|塊)?\s*$/);
  if (!am || /-\s*$/.test(s.slice(0, am.index))) return null;   // 負數不收
  const amount = Number(am[1].replace(/,/g, ''));
  if (!(amount > 0) || amount > 100000000) return null;

  // 撥款：口袋之間的配置，不是收入也不是支出
  const alloc = !forceIncome && parseAlloc(s.slice(0, am.index).trim());
  if (alloc) return { ...alloc, amount, date };

  const client = s.slice(0, am.index).trim();
  if (!client || /^\d+$/.test(client)) return null;

  const incomeByKw = INCOME_KW.some(([, re]) => re.test(client));
  const type = forceIncome || incomeByKw ? 'inflow' : 'outflow';
  return { type, category: guessCategory(client, type), amount, client, date };
}
