/**
 * 自訂口袋（子帳戶）：使用者可以命名、新增、刪除口袋，最多 MAX_POCKETS 個（不含日常）。
 * 口袋清單存在帳本的「口袋」工作表：代號｜名稱｜圖示｜目標金額｜狀態｜說明
 *   ・代號固定不變（舊有的 savings／emergency 沿用），交易的「口袋」欄顯示名稱，改名時一併更新
 *   ・刪除＝狀態改「已刪除」：舊紀錄仍查得到，餘額先自動撥回日常
 */
export const MAX_POCKETS = 8;
export const POCKET_TAB = '口袋';
export const POCKET_HEADER = ['代號', '名稱', '圖示', '目標金額', '狀態', '說明'];
export const ACTIVE = '使用中';
export const DELETED = '已刪除';
export const DEFAULT_POCKETS = [
  { id: 'savings', name: '儲蓄口袋', icon: '🏦', target: 0, active: true },
  { id: 'emergency', name: '緊急備用金', icon: '🛟', target: 50000, active: true },
];
const ICONS = ['🎯', '✈️', '🏠', '🚗', '🎓', '💍', '🎁', '📱', '🐶', '🏥', '💼', '🌱'];
const DAILY_WORDS = ['日常', '日常口袋', 'daily', ''];

export const activePockets = (pockets) => (pockets || []).filter(p => p.active);
export const pocketById = (pockets, id) => (pockets || []).find(p => p.id === id) || null;

const norm = (s) => String(s ?? '').replace(/[\s「」『』"'：:]/g, '').replace(/口袋$/, '').toLowerCase();

/** 舊帳本沒有「口袋」工作表時：用預設兩個口袋，目標沿用設定裡的值 */
export function defaultPockets(settings = {}) {
  return DEFAULT_POCKETS.map(p => ({
    ...p,
    target: p.id === 'emergency' ? (Number(settings.fundTarget) || 50000) : Math.max(0, Number(settings.savingsTarget) || 0),
  }));
}

/** 「口袋」工作表的資料列 → 口袋清單 */
export function parsePocketRows(rows) {
  const out = [];
  (rows || []).forEach((r, idx) => {
    if (idx === 0) return;
    const id = String(r?.[0] ?? '').trim();
    const name = String(r?.[1] ?? '').trim();
    if (!id || !name) return;
    out.push({
      id, name, icon: String(r?.[2] ?? '').trim() || '👝',
      target: Math.max(0, Number(String(r?.[3] ?? '').replace(/,/g, '')) || 0),
      active: String(r?.[4] ?? '').trim() !== DELETED,
      row: idx + 1,
    });
  });
  return out;
}
export const pocketRow = (p) => [p.id, p.name, p.icon, p.target || 0, p.active ? ACTIVE : DELETED, ''];

/** 依文字找口袋：完整名稱、去掉「口袋」、開頭相同、包含；舊說法「儲蓄／存款」「緊急／備用金」對應原本的口袋 */
export function findPocket(pockets, text, { includeDeleted = false } = {}) {
  const list = includeDeleted ? (pockets || []) : activePockets(pockets);
  const q = norm(text);
  if (!q) return null;
  const by = (fn) => list.filter(fn);
  for (const hits of [
    by(p => p.id === text),
    by(p => norm(p.name) === q),
    by(p => norm(p.name).startsWith(q) || q.startsWith(norm(p.name))),
    by(p => norm(p.name).includes(q)),
  ]) if (hits.length === 1) return hits[0];
  if (/儲蓄|存款/.test(text)) { const p = list.find(x => x.id === 'savings'); if (p) return p; }
  if (/緊急|備用金|急用/.test(text)) { const p = list.find(x => x.id === 'emergency'); if (p) return p; }
  return null;
}

/** 試算表「口袋」欄的值 → 口袋代號（日常回傳 ''；認不得的名稱原樣保留） */
export function accountFromSheet(v, pockets) {
  const s = String(v ?? '').trim();
  if (DAILY_WORDS.includes(s)) return '';
  if (pocketById(pockets, s)) return s;
  const hit = (pockets || []).find(p => p.name === s) || findPocket(pockets, s, { includeDeleted: true });
  return hit ? hit.id : s;
}

/** 口袋代號 → 試算表顯示的名稱 */
export function accountToSheet(id, pockets) {
  if (!id || id === 'daily') return '日常';
  const p = pocketById(pockets, id);
  return p ? p.name : String(id);
}

/** 驗證口袋名稱；回傳錯誤訊息或 null */
export function nameError(pockets, name, exceptId) {
  const n = String(name ?? '').trim();
  if (!n) return '請輸入口袋名稱，例如：新增口袋 旅遊基金';
  if (n.length > 12) return '口袋名稱最多 12 個字';
  if (DAILY_WORDS.includes(n) || /^日常/.test(n)) return '「日常」是預設口袋，請換一個名稱';
  if (/[\d,，]/.test(n)) return '口袋名稱不能包含數字，避免和金額混淆';
  if (activePockets(pockets).some(p => p.id !== exceptId && norm(p.name) === norm(n))) return `已經有叫「${n}」的口袋了`;
  return null;
}

const ICON_WORDS = [
  [/旅|遊|機票|出國|日本|韓國/, '✈️'], [/房|屋|頭期|裝潢/, '🏠'], [/車|機車/, '🚗'], [/學|教育|進修|課/, '🎓'],
  [/婚|結婚/, '💍'], [/禮|生日|節/, '🎁'], [/手機|電腦|3C|設備/, '📱'], [/寵物|貓|狗/, '🐶'],
  [/醫|健康|保險/, '🏥'], [/投資|股|基金/, '📈'], [/退休|養老/, '🌱'], [/稅|保費|年費/, '🧾'],
];
export function guessIcon(name) {
  for (const [re, ic] of ICON_WORDS) if (re.test(name)) return ic;
  return '';
}

export function newPocket(pockets, name, icon) {
  const used = new Set((pockets || []).map(p => p.icon));
  return {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: String(name).trim(),
    icon: icon || guessIcon(String(name)) || ICONS.find(i => !used.has(i)) || '👝',
    target: 0,
    active: true,
  };
}
