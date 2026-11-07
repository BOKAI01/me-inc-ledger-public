import { html, render, useState, useEffect, useMemo, useCallback, useRef } from './vendor.js';

/* ============================================================
   Me, Inc. 個人營運帳本
   v2 — 無 CDN 依賴、期間制、防重複
   ============================================================ */

const K_SESS   = 'meinc_session';     // LINE 登入後取得的登入憑證（不是帳本金鑰，可隨時登出作廢）
const K_OWNER  = 'meinc_owner';       // 目前登入者，換人時清掉上一位的畫面快取
const K_NAME   = 'meinc_name';
const CFG = (typeof window !== 'undefined' && window.MEINC) || {};
const API = (CFG.api || '') + '/api';
const K_QUEUE  = 'meinc_offline_queue';
const K_CACHE  = 'meinc_data_cache';
const K_CYCLE  = 'meinc_cycle_day';   // 僅作離線快取，真值存於 Google Sheet

const INCOME_CATS = [
  { id: 'salary',     name: '主要薪資',   emoji: '💼' },
  { id: 'side',       name: '副業 / 兼職', emoji: '💻' },
  { id: 'investment', name: '投資收益',   emoji: '📈' },
  { id: 'bonus',      name: '獎金 / 紅利', emoji: '🎁' },
  { id: 'other_in',   name: '其他收入',   emoji: '📦' },
];

const DEPARTMENTS = [
  { id: 'food',      name: '食',   fullName: '食 · 餐飲部',   emoji: '🍱', color: '#D97B3E', desc: '三餐、咖啡飲料、聚餐、買菜、零食' },
  { id: 'cloth',     name: '衣',   fullName: '衣 · 形象部',   emoji: '👔', color: '#A87B3D', desc: '服飾、鞋包、美容美髮' },
  { id: 'housing',   name: '住',   fullName: '住 · 後勤部',   emoji: '🏠', color: '#1F3A2E', desc: '房租、水電、網路、家具、日用品' },
  { id: 'transport', name: '行',   fullName: '行 · 移動部',   emoji: '🚗', color: '#5B8C5A', desc: '大眾運輸、油錢、計程車、停車、保養' },
  { id: 'leisure',   name: '娛',   fullName: '娛 · 文化部',   emoji: '🎬', color: '#7A5A9F', desc: '訂閱、電影、旅遊、運動、興趣' },
  { id: 'medical',   name: '醫療', fullName: '醫療 · 保健部', emoji: '🏥', color: '#C0504D', desc: '看診、掛號、藥品、牙醫、健檢' },
  { id: 'loan',      name: '貸款', fullName: '貸款 · 財務部', emoji: '💸', color: '#4A5A8C', desc: '房貸、車貸、信貸、學貸、分期付款' },
  { id: 'insurance', name: '保險', fullName: '保險 · 保障部', emoji: '🛡️', color: '#2F7D74', desc: '壽險、醫療險、產險、健保費、勞保' },
  { id: 'advance',   name: '代墊', fullName: '代墊費用 · 待收部', emoji: '🧾', color: '#B5862F', desc: '先幫公司或別人付、之後會拿回來的錢' },
  { id: 'other_out', name: '其他', fullName: '其他 · 雜項部', emoji: '📂', color: '#888888', desc: '人情禮金、稅務、罰單、捐款' },
];

/* 口袋：同一個帳戶內的資金分配，不是多個帳戶。
   日常固定存在；其他口袋由使用者自訂（最多 8 個），清單來自帳本的「口袋」工作表 */
const MAX_POCKETS = 8;
const DAILY = { id: 'daily', name: '日常口袋', short: '日常', emoji: '👛', color: '#5B8C5A', active: true };
const DEFAULT_LIST = [
  { id: 'savings',   name: '儲蓄口袋',   icon: '🏦', target: 0,     active: true },
  { id: 'emergency', name: '緊急備用金', icon: '🛟', target: 50000, active: true },
];
const PALETTE = ['#A87B3D', '#A0421C', '#3E6A8A', '#7A5A9F', '#2F7D74', '#B5647A', '#6B7A2E', '#8A6A4F', '#4A5A8C', '#9C5B2E'];
const PRESET_COLOR = { savings: '#A87B3D', emergency: '#A0421C' };
let POCKETS = [], RESERVES = [], ALL_POCKETS = [];
function setPocketList(list) {
  const src = Array.isArray(list) ? list : DEFAULT_LIST;
  let ci = 0;
  ALL_POCKETS = [DAILY, ...src.map(p => {
    const name = String(p.name || '');
    const short = name.replace(/（已刪除.*）$/, '').replace(/口袋$/, '') || name;
    const color = PRESET_COLOR[p.id] || PALETTE[(2 + ci++) % PALETTE.length];
    return { id: p.id, name, short: short.length > 5 ? short.slice(0, 5) : short, emoji: p.icon || '👝', color, target: Math.max(0, Number(p.target) || 0), active: p.active !== false };
  })];
  POCKETS = ALL_POCKETS.filter(p => p.active);
  RESERVES = POCKETS.filter(p => p.id !== 'daily');
}
setPocketList(DEFAULT_LIST);
const findPocket = (id) => ALL_POCKETS.find(p => p.id === id)
  || (id && id !== 'daily' ? { id, name: String(id), short: String(id).slice(0, 4), emoji: '👝', color: '#888888', active: false } : DAILY);
const norm = (s) => String(s ?? '').replace(/[\s「」『』"'：:]/g, '').replace(/口袋$/, '').toLowerCase();

/* 由品項名稱推斷口袋，供舊資料辨識 */
function pocketByName(text) {
  const q = norm(text);
  if (!q) return null;
  const hit = RESERVES.filter(p => q.includes(norm(p.name)));
  if (hit.length === 1) return hit[0].id;
  if (/儲蓄|存款/.test(q) && RESERVES.some(p => p.id === 'savings')) return 'savings';
  if (/備用金|緊急|急用/.test(q) && RESERVES.some(p => p.id === 'emergency')) return 'emergency';
  return null;
}

/* 撥款的口袋：口袋欄空白或填「日常」時（例如手動輸入），改由品項／備註判斷，最後才預設緊急備用金或第一個口袋 */
function allocPocket(tx) {
  if (tx.account && tx.account !== 'daily') return tx.account;
  return pocketByName(tx.client) || pocketByName(tx.description)
    || (RESERVES.some(p => p.id === 'emergency') ? 'emergency' : (RESERVES[0]?.id || 'emergency'));
}

/**
 * 一筆分錄只有兩種語意：
 *   alloc  口袋之間的配置，帳戶總額不變，不是收入也不是支出
 *   flow   真實的現金進出，pocket 記錄這筆從哪個口袋進出
 */
function classify(tx) {
  if (tx.type === 'alloc') {
    return { kind: 'alloc', dir: tx.category === 'alloc_out' ? 'out' : 'in', pocket: allocPocket(tx) };
  }
  // 舊資料相容：記成「支出-其他」且品項為備用金／儲蓄者，實為口袋配置
  if (tx.type === 'outflow' && tx.category === 'other_out' && (!tx.account || tx.account === 'daily')) {
    const p = pocketByName(tx.client);
    if (p) return { kind: 'alloc', dir: 'in', pocket: p, legacy: true };
  }
  return { kind: 'flow', pocket: tx.account && tx.account !== '' ? tx.account : 'daily' };
}

const defaultReserve = () => (RESERVES.find(p => p.id === 'emergency') || RESERVES[0] || { id: 'emergency' }).id;

/* 口袋名稱規則：與後台 worker/src/pockets.js 的 nameError 相同，先在網頁提示，後台仍會再驗證一次 */
function pocketNameError(name, exceptId) {
  const n = String(name ?? '').trim();
  if (!n) return '請輸入口袋名稱';
  if (n.length > 12) return '口袋名稱最多 12 個字';
  if (['日常', '日常口袋', 'daily'].includes(n) || /^日常/.test(n)) return '「日常」是預設口袋，請換一個名稱';
  if (/[\d,，]/.test(n)) return '口袋名稱不能包含數字，避免和金額混淆';
  if (RESERVES.some(p => p.id !== exceptId && norm(p.name) === norm(n))) return `已經有叫「${n}」的口袋了`;
  return null;
}
/* 新增口袋可選的圖示：涵蓋後台依名稱自動建議的所有圖示 */
const POCKET_ICONS = ['✈️', '🏠', '🚗', '🎓', '💍', '🎁', '📱', '🐶', '🏥', '📈', '🌱', '🧾'];
const ICON_WORDS = [
  [/旅|遊|機票|出國|日本|韓國/, '✈️'], [/房|屋|頭期|裝潢/, '🏠'], [/車|機車/, '🚗'], [/學|教育|進修|課/, '🎓'],
  [/婚|結婚/, '💍'], [/禮|生日|節/, '🎁'], [/手機|電腦|3C|設備/, '📱'], [/寵物|貓|狗/, '🐶'],
  [/醫|健康|保險/, '🏥'], [/投資|股|基金/, '📈'], [/退休|養老/, '🌱'], [/稅|保費|年費/, '🧾'],
];
const guessPocketIcon = (name) => { for (const [re, i] of ICON_WORDS) if (re.test(name)) return i; return ''; };

const findDept   = (id) => DEPARTMENTS.find(d => d.id === id) || DEPARTMENTS.find(d => d.id === 'other_out');
const findIncome = (id) => INCOME_CATS.find(c => c.id === id) || INCOME_CATS[4];

/* ---------- 格式 ---------- */
const fmt = (n) => new Intl.NumberFormat('zh-TW').format(Math.round(Number(n) || 0));
const fmtK = (n) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + '萬';
  if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(0) + 'k';
  return String(v);
};
const money = (n) => (Math.round(Number(n) || 0) < 0 ? '−' : '') + '$' + fmt(Math.abs(Number(n) || 0));
const digitsOf = (s) => String(s ?? '').replace(/[^\d]/g, '').slice(0, 10);   // 金額輸入只留數字
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const isOnline = () => navigator.onLine !== false;

/* ---------- 期間（以「起始月」命名）----------
   cycleDay = 5 → periodKey '2026-07' 代表 7/5 – 8/4
   cycleDay = 1 → periodKey '2026-07' 代表 7/1 – 7/31
------------------------------------------------ */
function getCurrentPeriod(cycleDay) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  if (cycleDay === 1 || d >= cycleDay) return `${y}-${pad(m)}`;
  return ymOf(new Date(y, m - 2, 1));
}
function getPeriodRange(periodKey, cycleDay) {
  const [y, m] = periodKey.split('-').map(Number);
  if (cycleDay === 1) {
    return { start: new Date(y, m - 1, 1, 0, 0, 0), end: new Date(y, m, 0, 23, 59, 59) };
  }
  return { start: new Date(y, m - 1, cycleDay, 0, 0, 0), end: new Date(y, m, cycleDay - 1, 23, 59, 59) };
}
function getPeriodLabel(periodKey, cycleDay) {
  const { start, end } = getPeriodRange(periodKey, cycleDay);
  if (cycleDay === 1) return `${start.getFullYear()}/${start.getMonth() + 1}`;
  return `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
}
function getPeriodLabelFull(periodKey, cycleDay) {
  const { start, end } = getPeriodRange(periodKey, cycleDay);
  if (cycleDay === 1) return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月（${start.getMonth() + 1}/1–${end.getMonth() + 1}/${end.getDate()}）`;
  return `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()} – ${end.getFullYear()}/${end.getMonth() + 1}/${end.getDate()}`;
}
function shiftPeriod(periodKey, delta) {
  const [y, m] = periodKey.split('-').map(Number);
  return ymOf(new Date(y, m - 1 + delta, 1));
}
/** 交易日期 → 本地 Date（只取 yyyy-MM-dd，避免 UTC 位移） */
function txDate(tx) {
  if (!tx || !tx.date) return null;
  const s = String(tx.date).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}
function isInPeriod(tx, periodKey, cycleDay) {
  const td = txDate(tx);
  if (!td) return false;
  const { start, end } = getPeriodRange(periodKey, cycleDay);
  return td >= start && td <= end;
}

/* ---------- API ---------- */
const getSess = () => { try { return localStorage.getItem(K_SESS) || ''; } catch { return ''; } };
const authLost = () => {                       // 登入失效：清掉憑證，畫面回到登入
  try { localStorage.removeItem(K_SESS); } catch {}
  window.dispatchEvent(new Event('meinc-auth'));
};
const callApi = async (action, payload = {}, ms = 25000) => {
  const sess = getSess();
  if (!sess) { authLost(); throw Object.assign(new Error('請先用 LINE 登入'), { auth: true }); }
  const fd = new FormData();
  fd.append('payload', JSON.stringify({ action, ...payload }));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(API, { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + sess }, signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json.ok && json.error === 'auth') { authLost(); throw Object.assign(new Error(json.message || '請重新登入'), { auth: true }); }
    if (!json.ok) throw Object.assign(new Error(json.error || '未知錯誤'), { server: true });   // 伺服器明確拒絕：重送也不會成功
    return json.data;
  } finally { clearTimeout(timer); }
};
const api = (action, payload = {}) => callApi(action, payload);

/* index.html 已在載入程式的同時就發出 load 請求，這裡直接接手，省下解析時間 */
let bootReq = (typeof window !== 'undefined' && window.__boot) || null;
const apiLoad = async () => {
  if (bootReq) {
    const p = bootReq; bootReq = null;
    try { const j = await p; if (j && j.ok && j.data) return j.data; } catch (e) {}
  }
  return callApi('load', {}, 20000);
};

/* ---------- LINE 登入（LIFF）---------- */
const loadScript = (src) => new Promise((res, rej) => {
  const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('無法載入 LINE 登入元件，請檢查網路'));
  document.head.appendChild(el);
});
/** 用 LINE 身分登入 → 向伺服器換登入憑證。會轉到 LINE 登入頁時回傳 null */
async function lineLogin(force) {
  if (!/^\d+-\w+$/.test(CFG.liffId || '') || !CFG.api) throw new Error('網站尚未完成登入設定');
  if (!window.liff) await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
  const liff = window.liff;
  await liff.init({ liffId: CFG.liffId });
  if (force && liff.isLoggedIn() && !liff.isInClient()) liff.logout();
  if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.origin + location.pathname }); return null; }
  const idToken = liff.getIDToken();
  const r = await fetch(CFG.api + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }).then(x => x.json());
  if (!r.ok) throw Object.assign(new Error(r.message || r.error || '登入失敗'), { code: r.error });
  const owner = String(r.data.owner || '');
  if (localStorage.getItem(K_OWNER) !== owner) {          // 換了使用者：上一位的快取與待送資料都不能沿用
    localStorage.removeItem(K_CACHE); localStorage.removeItem(K_QUEUE);
    localStorage.setItem(K_OWNER, owner);
  }
  localStorage.setItem(K_SESS, r.data.session);
  localStorage.setItem(K_NAME, r.data.name || '');
  return r.data;
}

/* ---------- 離線佇列（單線同步，避免重複送出）---------- */
const getQueue = () => { try { return JSON.parse(localStorage.getItem(K_QUEUE) || '[]'); } catch { return []; } };
const setQueue = (q) => localStorage.setItem(K_QUEUE, JSON.stringify(q));
const queueOp  = (op) => { const q = getQueue(); q.push({ ...op, ts: Date.now() }); setQueue(q); };

let flushing = null;
const flushQueue = () => {
  if (flushing) return flushing;              // 同時只允許一次沖銷
  flushing = (async () => {
    const q = getQueue();
    if (!q.length) return { synced: 0, failed: 0 };
    const rest = [], dropped = []; let synced = 0;
    for (const op of q) {
      try { await api(op.action, op.payload); synced++; }
      catch (e) { if (!e.server) rest.push(op); else dropped.push(e.message); }   // 只有網路問題才保留重送
    }
    setQueue(rest);
    return { synced, failed: rest.length, dropped };
  })().finally(() => { flushing = null; });
  return flushing;
};

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ---------- 圖示 ---------- */
const ic = (paths, s = 16, sw = 2) => html`
  <svg viewBox="0 0 24 24" width=${s} height=${s} fill="none" stroke="currentColor"
       stroke-width=${sw} stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const IPlus  = (s = 24) => ic(html`<path d="M5 12h14"/><path d="M12 5v14"/>`, s, 2.5);
const ITrash = (s = 16) => ic(html`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`, s);
const IX     = (s = 20) => ic(html`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, s);
const ILeft  = (s = 18) => ic(html`<polyline points="15 18 9 12 15 6"/>`, s);
const IRight = (s = 18) => ic(html`<polyline points="9 18 15 12 9 6"/>`, s);
const IDown  = (s = 13) => ic(html`<polyline points="6 9 12 15 18 9"/>`, s);
const IRef   = (s = 16) => ic(html`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>`, s);
const ICog   = (s = 16) => ic(html`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`, s);
const ICloudOff = (s = 15) => ic(html`<line x1="2" y1="2" x2="22" y2="22"/><path d="M5.78 5.78A7 7 0 0 0 9 19h8.5"/><path d="M10.93 5.09A7 7 0 0 1 22 12a7 7 0 0 1-.5 2.59"/>`, s);
const IBag   = (s = 16) => ic(html`<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>`, s);
const IUp    = (s = 12) => ic(html`<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`, s);
const IDn    = (s = 12) => ic(html`<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>`, s);
const IFlame = (s = 14) => ic(html`<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`, s);
const IChart = (s = 14) => ic(html`<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>`, s);
const ICal   = (s = 14) => ic(html`<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`, s);
const ISwap  = (s = 17) => ic(html`<path d="M7 7h12l-3-3"/><path d="M17 17H5l3 3"/>`, s, 1.9);
const ISlide = (s = 16) => ic(html`<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>`, s, 1.9);
const IArrow = (s = 16) => ic(html`<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`, s, 2.2);

/* ============================================================
   設定精靈
   ============================================================ */
function LoginScreen({ onDone }) {
  const [state, setState] = useState('working');          // working | error | notBound
  const [error, setError] = useState('');
  const run = useCallback(async (force) => {
    setState('working'); setError('');
    try {
      const d = await lineLogin(force);
      if (d) onDone(d.session);
    } catch (e) {
      setError(String(e.message || e));
      setState(e.code === 'notBound' ? 'notBound' : 'error');
    }
  }, [onDone]);
  useEffect(() => { run(false); }, [run]);
  const friend = CFG.basicId ? 'https://line.me/R/ti/p/' + encodeURIComponent(CFG.basicId) : '';

  return html`
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
      <div class="card" style="max-width:420px;width:100%">
        <div class="card-hd tinted" style="display:block">
          <div class="row" style="gap:6px;margin-bottom:6px;color:var(--ink)">${IBag(15)}<span class="brand">Login</span></div>
          <div style="font-size:19px;font-weight:700;color:var(--ink)">歡迎來到 Me, Inc.</div>
          <div class="sub" style="margin-top:2px">用你的 LINE 帳號登入，只有你本人看得到自己的帳本</div>
        </div>
        <div class="card-bd" style="display:flex;flex-direction:column;gap:14px">
          ${state === 'working' && html`<div class="note">正在用 LINE 登入⋯</div>`}
          ${state === 'notBound' && html`
            <div class="err">${error}</div>
            ${friend && html`<a class="btn btn-p" style="text-align:center;text-decoration:none" href=${friend}>加入記帳機器人好友</a>`}`}
          ${state === 'error' && html`
            <div class="err">${error}</div>
            <button class="btn btn-p" onClick=${() => run(true)}>用 LINE 重新登入</button>`}
          <div class="mini">網站不會保存你的 LINE 密碼。在 LINE 傳「登出所有裝置」，可讓所有裝置上的網站重新登入。</div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   期間選擇器
   ============================================================ */
function PeriodPicker({ value, onChange, onClose, cycleDay }) {
  const [y, m] = value.split('-').map(Number);
  const [year, setYear] = useState(y);
  const curKey = getCurrentPeriod(cycleDay);
  const [curY, curM] = curKey.split('-').map(Number);

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="between" style="padding:8px 16px;border-bottom:1px solid var(--line-2)">
          <button class="iconbtn" onClick=${() => setYear(year - 1)}>${ILeft(20)}</button>
          <div class="mono" style="font-size:17px;font-weight:700;color:var(--ink)">${year} 年</div>
          <button class="iconbtn" onClick=${() => setYear(year + 1)} disabled=${year >= curY + 5}
                  style=${{ opacity: year >= curY + 5 ? .3 : 1 }}>${IRight(20)}</button>
        </div>
        <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${Array.from({ length: 12 }, (_, i) => i + 1).map(mm => {
            const key = `${year}-${pad(mm)}`;
            const sel = year === y && mm === m;
            const cur = year === curY && mm === curM;
            const future = year > curY || (year === curY && mm > curM);
            return html`
              <button key=${mm} disabled=${future} onClick=${() => { onChange(key); onClose(); }}
                class="mono"
                style=${{
                  padding: '12px 4px', borderRadius: '3px', fontSize: '13px', fontWeight: 600,
                  background: sel ? '#1F3A2E' : 'transparent',
                  color: sel ? '#fff' : (future ? '#D6D3CA' : '#3F3B35'),
                  border: `${cur && !sel ? 2 : 1}px solid ${sel ? '#1F3A2E' : (cur ? '#A87B3D' : '#E7E2D6')}`,
                }}>
                ${getPeriodLabel(key, cycleDay)}
              </button>`;
          })}
        </div>
        <div class="sheet-ft">
          <button class="btn btn-g" onClick=${() => { onChange(curKey); onClose(); }}>回到本期</button>
          <button class="btn btn-g" onClick=${onClose}>關閉</button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   圖表
   ============================================================ */
function AssetTrendChart({ history }) {
  if (history.length < 2) return null;
  const W = 320, H = 160, PL = 38, PR = 12, PT = 16, PB = 28;
  const values = history.map(h => h.endingCash);
  let max = Math.max(...values), min = Math.min(...values);
  if (max === min) { max += 1000; min -= 1000; }
  const r0 = max - min; max += r0 * 0.1; min -= r0 * 0.1;
  const rng = max - min;
  const sx = (i) => PL + (i / (history.length - 1)) * (W - PL - PR);
  const sy = (v) => PT + (1 - (v - min) / rng) * (H - PT - PB);
  const pts = history.map((h, i) => ({ x: sx(i), y: sy(h.endingCash), val: h.endingCash, key: h.period }));
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${path} L ${pts[pts.length - 1].x.toFixed(1)} ${H - PB} L ${PL} ${H - PB} Z`;
  const change = values[values.length - 1] - values[0];
  const pct = values[0] !== 0 ? (change / Math.abs(values[0])) * 100 : 0;
  const up = change >= 0;
  let drop = null;
  for (let i = 1; i < history.length; i++) {
    const d = history[i].endingCash - history[i - 1].endingCash;
    if (d < 0 && (!drop || d < drop.d)) drop = { i, d, label: history[i].label };
  }
  return html`
    <section class="card">
      <div class="card-hd">
        <div class="row" style="gap:6px;color:var(--ink)">${IChart()}<span class="eyebrow">資產走勢</span></div>
        <div class="row" style="gap:6px">
          <span class="mono" style=${{ fontSize: '12px', color: up ? '#15803d' : '#b91c1c' }}>${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</span>
          <span class="sub">近 ${history.length} 期</span>
        </div>
      </div>
      <div style="padding:14px 10px">
        <svg viewBox=${`0 0 ${W} ${H}`} style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
          ${[0, .5, 1].map(t => {
            const v = min + (1 - t) * rng, yy = PT + t * (H - PT - PB);
            return html`<g><line x1=${PL} y1=${yy} x2=${W - PR} y2=${yy} stroke="#EFEBE1" stroke-width="1"/>
              <text x=${PL - 5} y=${yy + 3} text-anchor="end" font-size="9" fill="#A8A29E">${fmtK(v)}</text></g>`;
          })}
          <path d=${area} fill="#1F3A2E" fill-opacity="0.08"/>
          <path d=${path} fill="none" stroke="#1F3A2E" stroke-width="2"/>
          ${pts.map((p, i) => {
            const show = history.length <= 6 || i % Math.ceil(history.length / 6) === 0 || i === history.length - 1;
            const last = i === pts.length - 1, isDrop = drop && drop.i === i;
            return html`<g>
              ${show && html`<text x=${p.x} y=${H - 10} text-anchor="middle" font-size="8" fill="#A8A29E">${history[i].label}</text>`}
              <circle cx=${p.x} cy=${p.y} r=${last ? 4 : isDrop ? 3.5 : 2.5} fill=${isDrop ? '#A0421C' : '#1F3A2E'} stroke="#fff" stroke-width="1.5"/>
              ${last && html`<text x=${p.x} y=${p.y - 9} text-anchor="middle" font-size="10" font-weight="bold" fill="#1F3A2E">${fmtK(p.val)}</text>`}
            </g>`;
          })}
        </svg>
      </div>
      <div class="g2" style="padding:12px 20px;border-top:1px solid var(--line)">
        <div><span class="sub">期間變動</span>
          <div class="mono" style=${{ fontSize: '13px', fontWeight: 600, color: up ? '#15803d' : '#b91c1c' }}>${up ? '+' : '−'}$${fmt(Math.abs(change))}</div></div>
        <div><span class="sub">最大單期跌幅</span>
          ${drop
            ? html`<div class="mono" style="font-size:13px;font-weight:600;color:#b91c1c">${drop.label} · −$${fmt(Math.abs(drop.d))}</div>`
            : html`<div class="sub">無下跌週期 🎉</div>`}</div>
      </div>
    </section>`;
}

function PLBarChart({ history }) {
  if (history.length < 2) return null;
  const W = 320, H = 150, PL = 34, PR = 12, PT = 14, PB = 26;
  const absMax = Math.max(...history.map(h => Math.abs(h.netProfit)), 100);
  const yMid = PT + (H - PT - PB) / 2;
  const gw = (W - PL - PR) / history.length;
  const bw = Math.min(22, gw * 0.6);
  return html`
    <section class="card">
      <div class="card-hd">
        <div class="row" style="gap:6px;color:var(--ink)">${IBag(14)}<span class="eyebrow">期間損益</span></div>
        <span class="sub">淨利 = 收入 − 支出</span>
      </div>
      <div style="padding:14px 10px">
        <svg viewBox=${`0 0 ${W} ${H}`} style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
          <line x1=${PL} y1=${yMid} x2=${W - PR} y2=${yMid} stroke="#E7E2D6"/>
          <text x=${PL - 4} y=${yMid + 3} text-anchor="end" font-size="9" fill="#A8A29E">0</text>
          <text x=${PL - 4} y=${PT + 8} text-anchor="end" font-size="9" fill="#A8A29E">+${fmtK(absMax)}</text>
          <text x=${PL - 4} y=${H - PB + 3} text-anchor="end" font-size="9" fill="#A8A29E">−${fmtK(absMax)}</text>
          ${history.map((h, i) => {
            const cx = PL + gw * (i + 0.5);
            const bh = (Math.abs(h.netProfit) / absMax) * ((H - PT - PB) / 2);
            const pos = h.netProfit >= 0;
            const show = history.length <= 6 || i % Math.ceil(history.length / 6) === 0 || i === history.length - 1;
            return html`<g>
              <rect x=${cx - bw / 2} y=${pos ? yMid - bh : yMid} width=${bw} height=${Math.max(bh, 1)}
                    fill=${pos ? '#1F3A2E' : '#A0421C'} rx="1" opacity="0.85"/>
              ${show && html`<text x=${cx} y=${H - 9} text-anchor="middle" font-size="8" fill="#A8A29E">${h.label}</text>`}
            </g>`;
          })}
        </svg>
      </div>
    </section>`;
}

/* ============================================================
   記錄表單
   ============================================================ */
function EntryForm({ initial, onClose, onSave, onDelete }) {
  const initKind = initial ? (classify(initial).kind === 'alloc' ? 'alloc' : initial.type) : 'outflow';
  const initC = initial ? classify(initial) : null;

  const [kind, setKind] = useState(initKind);                       // outflow | inflow | alloc
  const [category, setCategory] = useState(initial && initKind !== 'alloc' ? initial.category : 'food');
  const [pocket, setPocket] = useState(initC ? (initC.kind === 'alloc' ? initC.pocket : initC.pocket) : 'daily');
  const [dir, setDir] = useState(initC && initC.kind === 'alloc' ? initC.dir : 'in');
  const [date, setDate] = useState((initial?.date || todayStr()).slice(0, 10));
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [client, setClient] = useState(initial?.client || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const isEdit = !!initial;

  const setKindTo = (k) => {
    setKind(k);
    if (k === 'outflow') setCategory('food');
    if (k === 'inflow') setCategory('salary');
    if (k === 'alloc' && pocket === 'daily') setPocket(defaultReserve());
  };

  const submit = () => {
    if (busyRef.current) return;
    const amt = parseFloat(amount);
    if (!amount || isNaN(amt)) { alert('請填寫金額'); return; }
    if (kind === 'alloc' && !reserveOpts.length) { alert('目前沒有其他口袋，請先到「口袋」頁新增'); return; }
    if (amt < 0) { alert('金額請填正數，方向以上方按鈕選擇'); return; }
    busyRef.current = true; setBusy(true);
    if (kind === 'alloc') {
      onSave({
        type: 'alloc',
        category: dir === 'in' ? 'alloc_in' : 'alloc_out',
        account: pocket === 'daily' ? defaultReserve() : pocket,
        date, amount: amt, client: client.trim(), description: description.trim(),
      });
    } else {
      onSave({
        type: kind, category, account: pocket === 'daily' ? '' : pocket,
        date, amount: amt, client: client.trim(), description: description.trim(),
      });
    }
  };

  const cats = kind === 'inflow' ? INCOME_CATS : DEPARTMENTS;
  /* 編輯舊紀錄時，原本的口袋即使已刪除也要能看到 */
  const cur = findPocket(pocket);
  const reserveOpts = cur.id !== 'daily' && !cur.active ? [...RESERVES, cur] : RESERVES;
  const pocketOpts = cur.id !== 'daily' && !cur.active ? [...POCKETS, cur] : POCKETS;
  const segs = [
    { k: 'outflow', l: '支出', bg: '#A0421C' },
    { k: 'inflow',  l: '收入', bg: '#1F3A2E' },
    { k: 'alloc',   l: '撥款', bg: '#A87B3D' },
  ];

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="sheet-hd">
          <h3>${isEdit ? '編輯記錄' : '新增記錄'}</h3>
          <button class="iconbtn" onClick=${onClose} style="color:var(--t3)">${IX()}</button>
        </div>
        <div class="sheet-bd">
          <div class="g3">
            ${segs.map(g => html`
              <button key=${g.k} class=${'seg' + (kind === g.k ? ' on' : '')}
                style=${kind === g.k ? { background: g.bg } : {}} onClick=${() => setKindTo(g.k)}>${g.l}</button>`)}
          </div>

          ${kind === 'alloc' ? html`
            <div class="box" style="background:#FFFBF3;border-color:#E7D6B5">
              <div class="note" style="color:var(--ink-2);margin:0">
                撥款只是把同一個帳戶裡的錢分配到不同口袋，帳戶總額不變，不列為收入或支出。
              </div>
            </div>
            <div>
              <div class="lbl" style="margin-bottom:8px">方向</div>
              <div class="g2" style="gap:8px">
                <button class=${'seg' + (dir === 'in' ? ' on' : '')} style=${dir === 'in' ? { background: '#A87B3D' } : {}}
                  onClick=${() => setDir('in')}>日常 → 口袋</button>
                <button class=${'seg' + (dir === 'out' ? ' on' : '')} style=${dir === 'out' ? { background: '#A87B3D' } : {}}
                  onClick=${() => setDir('out')}>口袋 → 日常</button>
              </div>
            </div>
            <div>
              <div class="lbl" style="margin-bottom:8px">口袋</div>
              <div class="g2" style="gap:8px">
                ${!reserveOpts.length && html`<div class="mini">目前沒有其他口袋，請先到「口袋」頁新增</div>`}
                ${reserveOpts.map(pk => html`
                  <button key=${pk.id} class=${'opt' + (pocket === pk.id ? ' on' : '')}
                    style=${pocket === pk.id ? { background: pk.color } : {}} onClick=${() => setPocket(pk.id)}>
                    <div class="em">${pk.emoji}</div><div class="nm">${pk.name}</div>
                  </button>`)}
              </div>
            </div>
          ` : html`
            <div>
              <div class="lbl" style="margin-bottom:8px">${kind === 'inflow' ? '收入來源' : '部門 Department'}</div>
              <div class="g3">
                ${cats.map(c => html`
                  <button key=${c.id} class=${'opt' + (category === c.id ? ' on' : '')}
                    style=${category === c.id ? { background: kind === 'inflow' ? '#1F3A2E' : c.color } : {}}
                    onClick=${() => setCategory(c.id)}>
                    <div class="em">${c.emoji}</div><div class="nm">${c.name}</div>
                  </button>`)}
              </div>
            </div>
            <div>
              <div class="lbl" style="margin-bottom:8px">${kind === 'inflow' ? '進入哪個口袋' : '從哪個口袋支付'}</div>
              <div class="g3">
                ${pocketOpts.map(pk => html`
                  <button key=${pk.id} class=${'opt' + (pocket === pk.id ? ' on' : '')}
                    style=${pocket === pk.id ? { background: pk.color } : {}} onClick=${() => setPocket(pk.id)}>
                    <div class="em">${pk.emoji}</div><div class="nm">${pk.short}</div>
                  </button>`)}
              </div>
              ${pocket !== 'daily' && html`<div class="mini">這筆會從${findPocket(pocket).name}扣除，仍計入該部門的支出統計</div>`}
            </div>
          `}

          <div>
            <div class="lbl" style="margin-bottom:8px">金額 (NT$)</div>
            <input class="inp big" type="number" inputmode="decimal" placeholder="0"
                   value=${amount} onInput=${e => setAmount(e.target.value)} />
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">日期</div>
            <input class="inp" type="date" value=${date} onInput=${e => setDate(e.target.value)} />
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">${kind === 'inflow' ? '收入來源（公司／單位）' : kind === 'alloc' ? '說明（選填）' : '商家 / 對象'}</div>
            <input class="inp" type="text" value=${client} onInput=${e => setClient(e.target.value)}
                   placeholder=${kind === 'inflow' ? '例：典試科技、五蘊' : kind === 'alloc' ? '例：每月固定撥款' : '例：房租、信用卡、全家'} />
          </div>
          ${kind !== 'alloc' && html`
            <div>
              <div class="lbl" style="margin-bottom:8px">備註（選填）</div>
              <input class="inp" type="text" value=${description} onInput=${e => setDescription(e.target.value)} placeholder="例：午餐便當" />
            </div>`}
        </div>
        <div class="sheet-ft">
          ${onDelete && html`<button class="btn btn-d" onClick=${onDelete}>${ITrash()}</button>`}
          <button class="btn btn-g" onClick=${onClose}>取消</button>
          <button class="btn btn-p" disabled=${busy} onClick=${submit}>${busy ? '儲存中⋯' : (isEdit ? '儲存修改' : '記一筆')}</button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   重複檢查
   ============================================================ */
function DuplicateSheet({ groups, loading, onClose, onDelete, onRescan }) {
  const [working, setWorking] = useState('');
  const total = groups.reduce((s, g) => s + (g.reason === 'id' ? g.items.length - 1 : g.items.length - 1), 0);

  const del = async (id, tag) => {
    setWorking(tag);
    await onDelete(id);
    setWorking('');
  };

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="sheet-hd">
          <h3>重複檢查</h3>
          <button class="iconbtn" onClick=${onClose} style="color:var(--t3)">${IX()}</button>
        </div>
        <div class="sheet-bd">
          ${loading
            ? html`<div class="row" style="gap:8px;justify-content:center;padding:32px 0;color:var(--t2)">
                <span class="spin">${IRef()}</span>掃描中⋯</div>`
            : groups.length === 0
              ? html`<div style="padding:32px 0;text-align:center;color:var(--t2);font-size:14px">沒有發現重複記錄 🎉</div>`
              : html`
                <div class="box" style="background:#FFFBF3;border-color:#E7D6B5">
                  <div class="note" style="margin:0;color:var(--ink-2)">
                    共 ${groups.length} 組可疑記錄，多餘 ${total} 筆。刪除前請先確認，這個動作無法復原。
                  </div>
                </div>
                ${groups.map((g, gi) => {
                  const first = g.items[0];
                  const cat = first.type === 'inflow' ? findIncome(first.category) : findDept(first.category);
                  const name = first.client || cat.name;
                  return html`
                    <div key=${g.key + gi} class="box" style="padding:0;overflow:hidden">
                      <div class="between" style="padding:10px 14px;background:#FAFAF8;border-bottom:1px solid var(--line)">
                        <div>
                          <div style="font-size:14px;font-weight:500">${name}</div>
                          <div class="sub">${first.date} · $${fmt(first.amount)} · ${g.items.length} 筆</div>
                        </div>
                        <span class="tag" style=${g.reason === 'id'
                          ? { color: '#991B1B', borderColor: '#FCA5A5' }
                          : { color: '#7A5A2C', borderColor: '#E7D6B5' }}>
                          ${g.reason === 'id' ? '確定重複' : '疑似重複'}
                        </span>
                      </div>
                      ${g.items.map((it, ii) => {
                        const tag = g.key + ':' + ii;
                        const busy = working === tag;
                        return html`
                          <div key=${tag} class="between" style="padding:10px 14px;border-bottom:1px solid var(--line)">
                            <div style="min-width:0">
                              <div class="mono" style="font-size:12px;color:var(--t2)">
                                ${it.createdAt ? String(it.createdAt).replace('T', ' ') : '無建立時間'}
                              </div>
                              <div class="sub">id ${it.id}${it.description ? ' · ' + it.description : ''}</div>
                            </div>
                            <div class="row" style="gap:6px;flex:0 0 auto">
                              ${ii === 0
                                ? html`<span class="tag" style="color:#15803d;border-color:#A8D5B5">建議保留</span>`
                                : html`<button class="btn btn-d" style="padding:6px 10px;font-size:12px"
                                    disabled=${busy} onClick=${() => del(it.id, tag)}>
                                    ${busy ? '刪除中⋯' : '刪除這筆'}</button>`}
                            </div>
                          </div>`;
                      })}
                    </div>`;
                })}`}
        </div>
        <div class="sheet-ft">
          <button class="btn btn-g" onClick=${onRescan}>重新掃描</button>
          <button class="btn btn-p" onClick=${onClose}>完成</button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   口袋：同一個帳戶內的資金分配（不是銀行帳戶）
   ============================================================ */
const K_POCKET_INTRO = 'meinc_pocket_intro_closed';   // 口袋頁頂端說明關閉後不再顯示（只記在這台裝置）
const balOf = (pk, b) => (pk.id === 'daily' ? b.daily : (b.byId[pk.id] || 0));
const tint = (c) => c + '1F';
const goalText = (bal, target) => (bal >= target ? '已達標' : Math.max(0, Math.floor((bal / target) * 100)) + '%');

/* 各口袋占比：只計正餘額，超支的口袋不佔比例 */
function shareOf(balances) {
  const rows = POCKETS.map(pk => ({ pk, bal: balOf(pk, balances) }));
  const pos = rows.reduce((s, r) => s + Math.max(0, r.bal), 0);
  return rows.map(r => ({ ...r, share: pos > 0 ? (Math.max(0, r.bal) / pos) * 100 : 0 }));
}

function StackBar({ rows }) {
  const seg = rows.filter(r => r.share > 0);
  const label = '各口袋占比：' + (seg.length ? seg.map(r => `${r.pk.short} ${Math.round(r.share)}%`).join('、') : '目前沒有餘額');
  return html`
    <div class="stack" role="img" aria-label=${label}>
      ${seg.length
        ? seg.map(r => html`<i key=${r.pk.id} style=${{ flex: `${r.share} 1 0`, background: r.pk.color }}></i>`)
        : html`<i style="flex:1;background:#EFEADF"></i>`}
    </div>`;
}

/* 總覽頁的口袋摘要：點進口袋頁撥款與管理 */
function PocketSummary({ balances, onOpen }) {
  const rows = shareOf(balances);
  return html`
    <section class="rcard" aria-label="口袋摘要" style="gap:12px">
      <div class="between" style="align-items:baseline">
        <h2 style="margin:0;font-size:16px;font-weight:700;color:var(--ink)">口袋</h2>
        <span style="font-size:13px;color:#5A544D">帳戶總額 <b class="num" style=${{ color: balances.total < 0 ? 'var(--red)' : 'var(--ink)' }}>${money(balances.total)}</b></span>
      </div>
      <${StackBar} rows=${rows} />
      <ul class="pk-list">
        ${rows.map(({ pk, bal }) => html`
          <li key=${pk.id}>
            <span class="dot" aria-hidden="true" style=${bal < 0 ? { border: '1.5px solid var(--red)' } : { background: pk.color }}></span>
            <span aria-hidden="true" style="font-size:18px">${pk.emoji}</span>
            <span class="nm">
              ${pk.name}
              ${pk.id !== 'daily' && pk.target > 0 && bal >= 0 && html`<small>· 目標 ${goalText(bal, pk.target)}</small>`}
              ${bal < 0 && html`<span class="overtag">已超支</span>`}
            </span>
            <b style=${{ color: bal < 0 ? 'var(--red)' : 'var(--ink)' }}>${money(bal)}</b>
          </li>`)}
      </ul>
      <button class="pk-more" onClick=${onOpen}>查看口袋、撥款與管理 ${IRight(15)}</button>
    </section>`;
}

function PocketCard({ pk, bal, total, mv, onTransfer, onManage }) {
  const isDaily = pk.id === 'daily';
  const over = bal < 0;
  const hasGoal = !isDaily && pk.target > 0;
  const m = mv || { in: 0, spend: 0 };
  let lab, pctText, width, msg = '';
  if (hasGoal) {
    lab = '目標進度'; pctText = goalText(bal, pk.target);
    width = Math.max(0, Math.min(100, (bal / pk.target) * 100));
    msg = bal >= pk.target ? '已達成目標' : `還差 ${money(pk.target - Math.max(0, bal))}`;
  } else {
    lab = '占帳戶總額';
    width = total > 0 ? Math.max(0, Math.min(100, (bal / total) * 100)) : 0;
    pctText = Math.round(width) + '%';
    if (!isDaily) msg = '按「管理」可以設定目標金額';
  }
  if (over) msg = isDaily ? '日常口袋已超支，可以從其他口袋撥回補足' : `超支 ${money(-bal)}，從日常撥款補回後恢復`;
  /* 日常的「撥出」是本期淨撥到各口袋的金額；其他口袋的「撥入」是本期淨撥入 */
  const flow = isDaily ? -m.in : m.in;
  const flowLab = isDaily ? (flow >= 0 ? '本期撥出到口袋' : '本期從口袋撥回') : (flow >= 0 ? '本期撥入' : '本期撥回日常');
  const sub = isDaily ? '平常收支都從這裡進出' : hasGoal ? `目標 ${money(pk.target)}` : '未設定目標';

  return html`
    <article class=${'rcard' + (over ? ' over' : '')} aria-label=${pk.name}>
      <div class="pk-hd">
        <div class="pk-ic" aria-hidden="true" style=${{ background: tint(pk.color) }}>${pk.emoji}</div>
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:8px;min-width:0">
            <h3 class="pk-nm">${pk.name}</h3>
            ${over && html`<span class="overtag">已超支</span>`}
          </div>
          <div class="pk-sub">${sub}</div>
        </div>
        <div class=${'pk-bal' + (over ? ' neg' : '')}>${money(bal)}</div>
      </div>
      <div class="pk-prog">
        <div class="lab"><span>${lab}</span><span style="font-weight:700">${pctText}</span></div>
        <div class="pbar"><i style=${{ width: width + '%', background: pk.color }}></i></div>
        ${msg && html`<div class=${'msg' + (over ? ' warn' : '')}>${msg}</div>`}
      </div>
      <div class="pk-stats">
        <div class="pk-stat"><div class="k">${flowLab}</div><div class="v">${money(Math.abs(flow))}</div></div>
        <div class="pk-stat"><div class="k">${isDaily ? '本期支出' : '本期動用'}</div><div class="v">${money(m.spend)}</div></div>
      </div>
      ${isDaily
        ? (RESERVES.length
            ? html`<div class="pk-acts"><button class="pk-btn sec grow" onClick=${() => onTransfer('daily')}>${ISwap()} 撥款到其他口袋</button></div>`
            : html`<div class="pk-sub" style="margin:0">新增口袋後，就能從日常撥款過去。</div>`)
        : html`
          <div class="pk-acts">
            <button class="pk-btn pri" onClick=${() => onTransfer(pk.id)}>${ISwap()} ${over ? '撥款補回' : '撥款'}</button>
            <button class="pk-btn sec fix" aria-label=${'管理' + pk.name} onClick=${() => onManage(pk.id)}>${ISlide()} 管理</button>
          </div>`}
    </article>`;
}

/* 口袋頁 */
function PocketsPage({ balances, moves, onTransfer, onManage, onAdd }) {
  const [intro, setIntro] = useState(() => { try { return localStorage.getItem(K_POCKET_INTRO) !== '1'; } catch { return true; } });
  const closeIntro = () => { setIntro(false); try { localStorage.setItem(K_POCKET_INTRO, '1'); } catch {} };
  const rows = shareOf(balances);
  const total = balances.total;
  const left = MAX_POCKETS - RESERVES.length;

  return html`
    ${intro && html`
      <div class="intro" role="note">
        <div class="ico" aria-hidden="true">${ISwap()}</div>
        <p>撥款只是把同一個帳戶裡的錢分配到不同口袋，帳戶總額不變，不列為收入或支出。</p>
        <button class="x" aria-label="關閉說明，之後不再顯示" onClick=${closeIntro}>${IX(16)}</button>
      </div>`}

    <section class="rcard" aria-label="帳戶總額" style="gap:12px">
      <div class="between" style="align-items:baseline">
        <span style="font-size:13px;color:#6B645D">帳戶總額</span>
        <span style="font-size:12px;color:#6B645D">分成 ${POCKETS.length} 個口袋</span>
      </div>
      <div class="num" style=${{ fontSize: '32px', fontWeight: 700, lineHeight: 1.1, color: total < 0 ? 'var(--red)' : 'var(--ink)' }}>${money(total)}</div>
      <${StackBar} rows=${rows} />
      <div class="legend">
        ${rows.map(({ pk, bal }) => html`
          <span key=${pk.id} class=${bal < 0 ? 'o' : ''}><i style=${bal < 0 ? {} : { background: pk.color }}></i>${pk.short}${bal < 0 ? ' 超支' : ''}</span>`)}
      </div>
    </section>

    <div class="sec-hd"><h2>我的口袋</h2><span>已用 ${RESERVES.length} / ${MAX_POCKETS} 個</span></div>

    ${rows.map(({ pk, bal }) => html`<${PocketCard} key=${pk.id} pk=${pk} bal=${bal} total=${total} mv=${moves[pk.id]}
      onTransfer=${onTransfer} onManage=${onManage} />`)}

    ${left > 0
      ? html`<button class="pk-add" onClick=${onAdd}>${IPlus(18)}<b>新增口袋</b><small>還可新增 ${left} 個</small></button>`
      : html`<div class="pk-full">口袋已達 ${MAX_POCKETS} 個上限，要新增請先刪除不用的口袋</div>`}
    <p style="margin:2px 0 0;text-align:center;font-size:12px;color:#6B645D">也可以在 LINE 傳「口袋」查看與管理</p>`;
}

/* 撥款：從口袋卡片發起；從日常發起時可選擇口袋 */
function TransferSheet({ pocketId, balances, onSave, onClose }) {
  const fromDaily = pocketId === 'daily';
  const [pid, setPid] = useState(fromDaily ? defaultReserve() : pocketId);
  const [dir, setDir] = useState('in');                 // in：日常 → 口袋；out：口袋 → 日常
  const [amtText, setAmtText] = useState('');
  const [date, setDate] = useState(todayStr());
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);

  const pk = findPocket(pid);
  const amt = Number(digitsOf(amtText)) || 0;
  const daily = balances.daily, bal = balances.byId[pid] || 0;
  const into = dir === 'in';
  const afterDaily = into ? daily - amt : daily + amt;
  const afterPk = into ? bal + amt : bal - amt;
  const from = into ? { e: DAILY.emoji, n: DAILY.name, b: daily } : { e: pk.emoji, n: pk.name, b: bal };
  const to = into ? { e: pk.emoji, n: pk.name, b: bal } : { e: DAILY.emoji, n: DAILY.name, b: daily };

  const chips = [{ l: '1,000', v: 1000 }, { l: '5,000', v: 5000 }];
  if (into && bal < 0) chips.push({ l: `補足超支 ${fmt(-bal)}`, v: Math.round(-bal) });
  if (into && pk.target > bal) chips.push({ l: `補到目標 ${fmt(pk.target - bal)}`, v: Math.round(pk.target - bal) });
  if (!into && bal > 0) chips.push({ l: `全部撥回 ${fmt(bal)}`, v: Math.round(bal) });
  /* 超過餘額只提醒、不阻擋 */
  const warn = !amt ? '' : into
    ? (amt > daily ? `日常口袋只剩 ${money(daily)}，這筆撥款會讓日常變成負數。` : '')
    : (amt > bal ? `${pk.name}只剩 ${money(bal)}，這筆撥款會讓口袋超支。` : '');

  const typeAmt = (v) => { const d = digitsOf(v); setAmtText(d ? fmt(Number(d)) : ''); };
  const submit = async () => {
    if (busy || !(amt > 0) || !date) return;
    setBusy(true);
    try {
      await onSave({ type: 'alloc', category: into ? 'alloc_in' : 'alloc_out', account: pid, date, amount: amt, client: memo.trim(), description: '' });
    } finally { setBusy(false); }
  };

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet psheet" role="dialog" aria-modal="true" aria-label="撥款" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="psheet-in">
          <div class="ps-hd">
            <div style="flex:1;min-width:0"><h2>撥款</h2><div class="sub2">從「${fromDaily ? DAILY.name : pk.name}」發起</div></div>
            <button class="ps-x" aria-label="關閉" onClick=${onClose}>${IX(18)}</button>
          </div>

          ${fromDaily && html`
            <div class="f-row">
              <span class="f-lbl" id="tf-pk">撥到哪個口袋</span>
              <div class="qchips" role="group" aria-labelledby="tf-pk">
                ${RESERVES.map(p => html`
                  <button key=${p.id} class=${'qchip' + (p.id === pid ? ' on' : '')} aria-pressed=${p.id === pid ? 'true' : 'false'}
                    onClick=${() => setPid(p.id)}>${p.emoji} ${p.short}</button>`)}
              </div>
            </div>`}

          <div class="dseg" role="group" aria-label="撥款方向">
            <button class=${into ? 'on' : ''} aria-pressed=${into ? 'true' : 'false'} onClick=${() => setDir('in')}>日常 → ${pk.short}</button>
            <button class=${into ? '' : 'on'} aria-pressed=${into ? 'false' : 'true'} onClick=${() => setDir('out')}>${pk.short} → 日常</button>
          </div>

          <div class="ft">
            <div><div class="k">轉出</div><div class="n">${from.e} ${from.n}</div><div class="b">餘額 ${money(from.b)}</div></div>
            <span class="arr" aria-hidden="true">${IArrow()}</span>
            <div><div class="k">轉入</div><div class="n">${to.e} ${to.n}</div><div class="b">餘額 ${money(to.b)}</div></div>
          </div>

          <div class="f-row" style="gap:8px">
            <label class="f-lbl" for="tf-amt">金額</label>
            <div class="f-money big">
              <span aria-hidden="true">$</span>
              <input id="tf-amt" type="text" inputmode="numeric" autocomplete="off" placeholder="0"
                value=${amtText} onInput=${e => typeAmt(e.target.value)} />
            </div>
            <div class="qchips">
              ${chips.map(c => html`<button key=${c.l} class=${'qchip' + (amt === c.v ? ' on' : '')} onClick=${() => typeAmt(String(c.v))}>${c.l}</button>`)}
            </div>
          </div>

          <div class="after" aria-live="polite">
            <div class="t">撥款後</div>
            <div class="r"><span>${DAILY.emoji} ${DAILY.name}</span><b style=${afterDaily < 0 ? { color: 'var(--red)' } : {}}>${money(afterDaily)}</b></div>
            <div class="r"><span>${pk.emoji} ${pk.name}</span>
              <b style=${afterPk < 0 ? { color: 'var(--red)' } : {}}>${money(afterPk)}${pk.target > 0 && html`<small>（目標 ${goalText(afterPk, pk.target)}）</small>`}</b></div>
            ${warn && html`<div class="w">${warn}</div>`}
          </div>

          <div class="f-2col">
            <div class="f-row"><label class="f-lbl" for="tf-d">日期</label>
              <input id="tf-d" class="f-inp" type="date" style="padding:0 10px;font-size:15px" value=${date} onInput=${e => setDate(e.target.value)} /></div>
            <div class="f-row"><label class="f-lbl" for="tf-m">說明（選填）</label>
              <input id="tf-m" class="f-inp" type="text" maxlength="40" placeholder="例：每月固定撥款" value=${memo} onInput=${e => setMemo(e.target.value)} /></div>
          </div>

          <div class="f-hint">帳戶總額不變，不列為收入或支出。</div>
          <div class="f-acts">
            <button class="f-btn sec" onClick=${onClose}>取消</button>
            <button class="f-btn pri" disabled=${busy || !(amt > 0) || !date} onClick=${submit}>
              ${busy ? '撥款中⋯' : amt > 0 ? `確認撥款 ${money(amt)}` : '確認撥款'}</button>
          </div>
        </div>
      </div>
    </div>`;
}

/* 管理口袋：改名、設定目標、刪除 */
function PocketManageSheet({ pocket, balance, onSave, onDelete, onClose }) {
  const [name, setName] = useState(pocket.name);
  const [tgText, setTgText] = useState(pocket.target > 0 ? fmt(pocket.target) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState(false);
  const nm = name.trim();
  const tg = Number(digitsOf(tgText)) || 0;
  const nameErr = nm === pocket.name ? null : pocketNameError(nm, pocket.id);
  const changed = nm !== pocket.name || tg !== pocket.target;
  const over = balance < 0;

  const save = async () => {
    if (busy || !changed || nameErr) return;
    setBusy(true); setErr('');
    try { await onSave({ name: nm, target: tg }); }
    catch (e) { setErr(e.message || '儲存失敗，請稍後再試'); setBusy(false); }
  };

  return html`
    <div class="mask" onClick=${() => { if (!busy) onClose(); }}>
      <div class="sheet psheet" role="dialog" aria-modal="true" aria-label=${'管理' + pocket.name} onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="psheet-in" style="gap:18px">
          <div class="ps-hd">
            <div class="pk-ic" aria-hidden="true" style=${{ background: tint(pocket.color) }}>${pocket.emoji}</div>
            <div style="flex:1;min-width:0">
              <h2 style="font-size:18px">${pocket.name}</h2>
              <div class="sub2">目前餘額 <b class="num" style=${{ color: over ? 'var(--red)' : 'var(--ink)' }}>${money(balance)}</b>${over ? ' · 已超支' : ''}</div>
            </div>
            <button class="ps-x" aria-label="關閉" onClick=${onClose}>${IX(18)}</button>
          </div>

          <div class="f-row">
            <label class="f-lbl" for="pm-nm">名稱<small>${nm.length} / 12</small></label>
            <input id="pm-nm" class="f-inp" type="text" maxlength="12" value=${name} onInput=${e => setName(e.target.value)}
              aria-invalid=${nameErr ? 'true' : 'false'} aria-describedby="pm-nm-h" />
            ${nameErr
              ? html`<div id="pm-nm-h" class="f-err">${nameErr}</div>`
              : html`<div id="pm-nm-h" class="f-hint">1–12 字，不可含數字、不可叫「日常」，也不能和其他口袋同名。改名後，過去紀錄的口袋名稱會一起更新。</div>`}
          </div>

          <div class="f-row">
            <label class="f-lbl" for="pm-tg">目標金額</label>
            <div class="f-money">
              <span aria-hidden="true">$</span>
              <input id="pm-tg" type="text" inputmode="numeric" autocomplete="off" placeholder="0" aria-describedby="pm-tg-h"
                value=${tgText} onInput=${e => { const d = digitsOf(e.target.value); setTgText(d ? fmt(Number(d)) : ''); }} />
            </div>
            <div id="pm-tg-h" class="f-hint">留空或填 0 代表不設目標，卡片就不顯示目標進度。</div>
          </div>

          ${err && html`<div class="f-err" role="alert">${err}</div>`}
          <button class="f-btn pri" disabled=${busy || !changed || !!nameErr} onClick=${save}>${busy ? '儲存中⋯' : '儲存變更'}</button>

          <div style="border-top:1px solid #EEE8DC;padding-top:16px;display:flex;flex-direction:column;gap:8px">
            <button class="f-btn out" disabled=${busy} onClick=${() => setAsk(true)}>${ITrash()} 刪除這個口袋</button>
            <div class="f-hint" style="text-align:center">刪除前會先顯示餘額，並請你確認</div>
          </div>
        </div>
      </div>
    </div>
    ${ask && html`<${DeletePocketDialog} pocket=${pocket} balance=${balance} onCancel=${() => setAsk(false)} onConfirm=${onDelete} />`}`;
}

/* 刪除確認：說明會自動記哪一筆撥款讓口袋歸零 */
function DeletePocketDialog({ pocket, balance, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const b = Math.round(balance);
  const now = new Date();
  const tag = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  const steps = [
    b > 0 ? `自動記一筆「${pocket.name}撥回日常 ${money(b)}」，讓口袋歸零`
      : b < 0 ? `自動記一筆「日常補足${pocket.name} ${money(-b)}」，讓口袋歸零`
      : '這個口袋沒有餘額，不會新增任何紀錄',
    `口袋標示為「${pocket.name}（已刪除 ${tag}）」，過去紀錄全部保留，報表照常顯示`,
    `「${pocket.name}」這個名稱之後可以再使用`,
  ];
  const go = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { await onConfirm(); }
    catch (e) { setErr(e.message || '刪除失敗，請稍後再試'); setBusy(false); }
  };

  return html`
    <div class="dlg-mask" onClick=${() => { if (!busy) onCancel(); }}>
      <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dp-t" onClick=${e => e.stopPropagation()}>
        <div class="row" style="gap:12px">
          <div aria-hidden="true" style="flex:0 0 auto;width:44px;height:44px;border-radius:14px;background:#FBE6DE;color:#9B2C12;display:flex;align-items:center;justify-content:center">${ITrash(20)}</div>
          <h2 id="dp-t">刪除「${pocket.emoji} ${pocket.name}」？</h2>
        </div>
        <div class="bal">
          <span>目前餘額</span>
          <span class="row" style="gap:8px"><b style=${{ color: b < 0 ? 'var(--red)' : 'var(--ink)' }}>${money(b)}</b>${b < 0 && html`<span class="overtag">已超支</span>`}</span>
        </div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#3F3B35;margin-bottom:10px">同意後會：</div>
          <ol>${steps.map((s, i) => html`<li key=${i}><span aria-hidden="true">${i + 1}</span><span>${s}</span></li>`)}</ol>
        </div>
        ${err && html`<div class="f-err" role="alert">${err}</div>`}
        <div class="f-acts">
          <button class="f-btn sec" style="flex:1" disabled=${busy} onClick=${onCancel}>取消</button>
          <button class="f-btn dan" disabled=${busy} onClick=${go}>${busy ? '刪除中⋯' : '同意刪除'}</button>
        </div>
      </div>
    </div>`;
}

/* 新增口袋：圖示依名稱自動建議，也可以自己選 */
function AddPocketSheet({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState('');
  const [tgText, setTgText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nm = name.trim();
  const nameErr = pocketNameError(nm);
  const used = new Set(RESERVES.map(p => p.emoji));
  const icon = picked || guessPocketIcon(nm) || POCKET_ICONS.find(i => !used.has(i)) || POCKET_ICONS[0];
  const left = MAX_POCKETS - RESERVES.length;

  const add = async () => {
    if (busy || nameErr) return;
    setBusy(true); setErr('');
    try { await onAdd(nm, icon, Number(digitsOf(tgText)) || 0); }
    catch (e) { setErr(e.message || '新增失敗，請稍後再試'); setBusy(false); }
  };

  return html`
    <div class="mask" onClick=${() => { if (!busy) onClose(); }}>
      <div class="sheet psheet" role="dialog" aria-modal="true" aria-label="新增口袋" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="psheet-in" style="gap:18px">
          <div class="ps-hd">
            <div style="flex:1;min-width:0"><h2>新增口袋</h2><div class="sub2">已有 ${RESERVES.length} 個，還可新增 ${left} 個</div></div>
            <button class="ps-x" aria-label="關閉" onClick=${onClose}>${IX(18)}</button>
          </div>

          <div class="f-row">
            <label class="f-lbl" for="ap-nm">名稱<small>${nm.length} / 12</small></label>
            <input id="ap-nm" class="f-inp" type="text" maxlength="12" placeholder="例：學習基金" value=${name}
              onInput=${e => setName(e.target.value)} aria-invalid=${nm && nameErr ? 'true' : 'false'} aria-describedby="ap-nm-h" />
            ${nm && nameErr
              ? html`<div id="ap-nm-h" class="f-err">${nameErr}</div>`
              : html`<div id="ap-nm-h" class="f-hint">1–12 字，不可含數字、不可叫「日常」，也不能和其他口袋同名。</div>`}
          </div>

          <div class="f-row" style="gap:8px">
            <span class="f-lbl" id="ap-ic">圖示<small>依名稱自動建議，也可以自己選</small></span>
            <div class="icgrid" role="group" aria-labelledby="ap-ic">
              ${POCKET_ICONS.map(i => html`
                <button key=${i} class=${i === icon ? 'on' : ''} aria-pressed=${i === icon ? 'true' : 'false'} aria-label=${'圖示 ' + i}
                  onClick=${() => setPicked(i)}>${i}</button>`)}
            </div>
          </div>

          <div class="f-row">
            <label class="f-lbl" for="ap-tg">目標金額（選填）</label>
            <div class="f-money">
              <span aria-hidden="true">$</span>
              <input id="ap-tg" type="text" inputmode="numeric" autocomplete="off" placeholder="不填就不設目標"
                value=${tgText} onInput=${e => { const d = digitsOf(e.target.value); setTgText(d ? fmt(Number(d)) : ''); }} />
            </div>
          </div>

          ${err && html`<div class="f-err" role="alert">${err}</div>`}
          <div class="f-acts">
            <button class="f-btn sec" onClick=${onClose}>取消</button>
            <button class="f-btn pri" disabled=${busy || !!nameErr} onClick=${add}>${busy ? '建立中⋯' : '建立口袋'}</button>
          </div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   設定
   ============================================================ */
function SettingsSheet({ userName, onLogout, onLogoutAll, openingBalance, currentBalance, cycleDay, onOpenPockets, onChangeCycle, onClose, onSaveOpening, onDedupe }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(openingBalance));
  const [tmp, setTmp] = useState(cycleDay);
  const [dirty, setDirty] = useState(false);
  const preview = getPeriodLabelFull(getCurrentPeriod(tmp), tmp);

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="sheet-hd">
          <h3>設定 · 經營後台</h3>
          <button class="iconbtn" onClick=${onClose} style="color:var(--t3)">${IX()}</button>
        </div>
        <div class="sheet-bd">

          <div class="box box-w">
            <div class="row" style="gap:6px;margin-bottom:6px;color:var(--gold)">
              ${ICal(15)}<span style="font-size:14px;font-weight:700;color:var(--ink-2)">結算週期</span>
            </div>
            <p class="note" style="margin:0 0 12px;color:var(--ink-2)">
              設定每月結算起始日。設 5 → 一期為 5 日至隔月 4 日，全 App 的期間、圖表、燃燒率都依此計算。上期期末自動成為下期期初。
            </p>
            <div class="row" style="gap:8px;margin-bottom:8px">
              <button class="box" style="padding:10px" onClick=${() => { setTmp(Math.max(1, tmp - 1)); setDirty(true); }}>${ILeft()}</button>
              <div class="box" style="flex:1;text-align:center;padding:8px">
                <span class="mono" style="font-size:22px;font-weight:700;color:var(--ink)">${tmp}</span>
                <span class="sub"> 號</span>
              </div>
              <button class="box" style="padding:10px" onClick=${() => { setTmp(Math.min(28, tmp + 1)); setDirty(true); }}>${IRight()}</button>
            </div>
            <div class="note" style="color:var(--ink-2);margin-bottom:10px">目前當期：<strong>${preview}</strong></div>
            ${dirty && html`<button class="btn" style="width:100%;background:#A87B3D;color:#fff"
              onClick=${() => { onChangeCycle(tmp); setDirty(false); }}>套用結算日 ${tmp} 號</button>`}
            <div class="mini">此設定儲存於 Google Sheet，換手機或清除瀏覽器資料都不會遺失</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">期初餘額（公司開張資本）</div>
            ${editing
              ? html`<div class="row" style="gap:8px">
                  <input class="inp mono" type="number" inputmode="decimal" value=${val} onInput=${e => setVal(e.target.value)} />
                  <button class="btn btn-p" style="flex:0 0 auto" onClick=${() => { onSaveOpening(parseFloat(val) || 0); setEditing(false); }}>儲存</button>
                </div>`
              : html`<button class="mono" style="font-size:17px;font-weight:600;color:var(--ink)" onClick=${() => setEditing(true)}>
                  $${fmt(openingBalance)} <span class="sub">編輯</span></button>`}
            <div class="mini">只在首次設定，之後系統自動延續</div>
          </div>

          <div class="box between" style="gap:12px">
            <div style="min-width:0">
              <div style="font-size:14px;font-weight:700;color:var(--ink)">口袋</div>
              <div class="mini">新增、改名、設定目標與刪除，都移到「口袋」頁了</div>
            </div>
            <button class="btn btn-g" style="flex:0 0 auto;padding:10px 14px" onClick=${onOpenPockets}>前往口袋頁</button>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">目前公司現金</div>
            <div class="mono" style=${{ fontSize: '17px', fontWeight: 600, color: currentBalance >= 0 ? '#1F3A2E' : '#A0421C' }}>$${fmt(currentBalance)}</div>
            <div class="mini">期初 + 累計收入 − 累計支出</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">資料維護</div>
            <button class="btn btn-g" style="width:100%" onClick=${onDedupe}>檢查重複記錄</button>
            <div class="mini">列出可疑記錄供你逐筆確認，不會自動刪除任何資料</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">登入身分</div>
            <div style="font-size:15px;font-weight:600;color:var(--ink)">${userName || 'LINE 使用者'}</div>
            <div class="row" style="gap:8px;margin-top:8px">
              <button class="btn btn-g" style="flex:1" onClick=${onLogout}>登出這台裝置</button>
              <button class="btn btn-g" style="flex:1" onClick=${onLogoutAll}>登出所有裝置</button>
            </div>
            <div class="mini">懷疑別人用過你的帳號時，按「登出所有裝置」，所有裝置都要重新用 LINE 登入</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:8px">部門說明</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${DEPARTMENTS.map(d => html`
                <div key=${d.id} class="row" style="gap:10px;padding:10px;background:#FAFAF8;border-radius:3px">
                  <div style="font-size:19px">${d.emoji}</div>
                  <div>
                    <div style=${{ fontSize: '13px', fontWeight: 600, color: d.color }}>${d.fullName}</div>
                    <div class="sub">${d.desc}</div>
                  </div>
                </div>`)}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   主程式
   ============================================================ */
function App() {
  const [sess, setSess] = useState(() => getSess());
  useEffect(() => { const h = () => setSess(''); window.addEventListener('meinc-auth', h); return () => window.removeEventListener('meinc-auth', h); }, []);
  const cached = useMemo(() => { try { return JSON.parse(localStorage.getItem(K_CACHE) || 'null'); } catch { return null; } }, []);

  const [transactions, setTransactions] = useState(() => (cached?.transactions) || []);
  const [openingBalance, setOpeningBalance] = useState(() => cached?.openingBalance || 0);
  const [pocketList, setPocketListState] = useState(() => {
    const l = Array.isArray(cached?.pockets) ? cached.pockets : DEFAULT_LIST.map(p => ({ ...p,
      target: p.id === 'emergency' ? (Number(cached?.fundTarget) || 50000) : p.id === 'savings' ? (Number(cached?.savingsTarget) || 0) : p.target }));
    setPocketList(l);
    return l;
  });
  const applyPockets = useCallback((l) => { setPocketList(l); setPocketListState(l); }, []);
  const [syncedAt, setSyncedAt] = useState(() => cached?.syncedAt || null);
  const [cycleDay, setCycleDay] = useState(() => Number(cached?.cycleDay || localStorage.getItem(K_CYCLE)) || 1);
  const [hasData, setHasData] = useState(() => !!cached);   // 是否已有可顯示的資料
  const [loadState, setLoadState] = useState('loading');    // loading | ok | error
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(isOnline());
  const [toast, setToast] = useState(null);
  const [period, setPeriod] = useState(() => getCurrentPeriod(Number(cached?.cycleDay || localStorage.getItem(K_CYCLE)) || 1));
  const [periodTouched, setPeriodTouched] = useState(false);
  const [filter, setFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const [showDup, setShowDup] = useState(false);
  const [dupGroups, setDupGroups] = useState([]);
  const [dupLoading, setDupLoading] = useState(false);
  const [view, setView] = useState(() => (location.hash === '#pockets' ? 'pockets' : 'home'));   // home：總覽；pockets：口袋
  const [transferFrom, setTransferFrom] = useState(null);   // 發起撥款的口袋代號
  const [managing, setManaging] = useState(null);           // 正在管理的口袋代號
  const [adding, setAdding] = useState(false);
  const pushedRef = useRef(false);
  const loadingRef = useRef(null);

  /* 頁面切換用網址 #pockets，手機的返回鍵可以回到總覽 */
  useEffect(() => {
    const h = () => { const v = location.hash === '#pockets' ? 'pockets' : 'home'; if (v === 'home') pushedRef.current = false; setView(v); };
    window.addEventListener('hashchange', h);
    window.addEventListener('popstate', h);
    return () => { window.removeEventListener('hashchange', h); window.removeEventListener('popstate', h); };
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);
  const goView = (v) => {
    if (v === view) { window.scrollTo(0, 0); return; }
    if (v === 'pockets') { pushedRef.current = true; location.hash = 'pockets'; setView('pockets'); }
    else if (pushedRef.current) { pushedRef.current = false; window.history.back(); }   // App 內的 history 是圖表資料，要用 window.history
    else { window.history.replaceState(null, '', location.pathname + location.search); setView('home'); }
  };

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  }, []);

  /* 讀取（單線，避免並行造成佇列重複沖銷） */
  const reload = useCallback(async () => {
    if (!sess) return;
    if (loadingRef.current) return loadingRef.current;
    setSyncing(true); setLoadState('loading');
    loadingRef.current = (async () => {
      try {
        if (isOnline() && getQueue().length) {
          bootReq = null;                       // 有待送出的異動，預抓結果已過期
          const r = await flushQueue();
          if (r.dropped?.length) showToast(`有 ${r.dropped.length} 筆異動無法套用：${r.dropped[0]}`, 'error');
          else if (r.synced) showToast(`已同步 ${r.synced} 筆離線記錄`);
        }
        let data = null, lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { data = await apiLoad(); lastErr = null; break; }
          catch (err) {
            lastErr = err;
            if (attempt < 1) await new Promise(r => setTimeout(r, 1500));
          }
        }
        if (!data) throw lastErr || new Error('載入失敗');
        const txns = (data.transactions || []).map(t => ({ ...t, date: String(t.date || '').slice(0, 10) }));
        setTransactions(txns);
        setOpeningBalance(Number(data.openingBalance) || 0);
        const pl = Array.isArray(data.pockets) ? data.pockets : DEFAULT_LIST.map(p => ({ ...p,
          target: p.id === 'emergency' ? (Number(data.fundTarget) || 50000) : Math.max(0, Number(data.savingsTarget) || 0) }));
        applyPockets(pl);
        const cd = Number(data.cycleDay) || 1;
        setCycleDay(cd);
        localStorage.setItem(K_CYCLE, String(cd));
        const now = Date.now();
        setSyncedAt(now);
        localStorage.setItem(K_CACHE, JSON.stringify({ transactions: txns, openingBalance: data.openingBalance, cycleDay: cd, pockets: pl, syncedAt: now }));
        setHasData(true); setLoadState('ok');
      } catch (e) {
        setLoadState('error');
      } finally {
        setSyncing(false); loadingRef.current = null;
      }
    })();
    return loadingRef.current;
  }, [sess, showToast, applyPockets]);

  useEffect(() => { if (sess) reload(); }, [sess, reload]);

  /* 連線狀態 + 回到前景時背景更新 */
  useEffect(() => {
    const on = () => { setOnline(true); reload(); };
    const off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === 'visible' && loadState !== 'loading') reload(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); };
  }, [reload, loadState]);

  /* 結算日改變 → 若使用者沒手動選期間，跳回當期 */
  useEffect(() => {
    if (!periodTouched) setPeriod(getCurrentPeriod(cycleDay));
  }, [cycleDay]);

  /* ---- 期間統計 ---- */
  const periodTx = useMemo(() => transactions.filter(t => isInPeriod(t, period, cycleDay)), [transactions, period, cycleDay]);

  /* 只有 flow 是真實現金進出；alloc 只是口袋之間的配置 */
  const periodFlows = useMemo(() => periodTx.filter(t => classify(t).kind === 'flow'), [periodTx]);
  const inc = periodFlows.filter(t => t.type === 'inflow').reduce((s, t) => s + Number(t.amount || 0), 0);
  const exp = periodFlows.filter(t => t.type === 'outflow').reduce((s, t) => s + Number(t.amount || 0), 0);
  const netProfit = inc - exp;
  const margin = inc > 0 ? (netProfit / inc) * 100 : 0;

  const periodStartCash = useMemo(() => {
    const { start } = getPeriodRange(period, cycleDay);
    let v = openingBalance;
    for (const t of transactions) {
      if (classify(t).kind !== 'flow') continue;
      const td = txDate(t); if (!td || td >= start) continue;
      v += (t.type === 'inflow' ? 1 : -1) * Number(t.amount || 0);
    }
    return v;
  }, [transactions, period, cycleDay, openingBalance]);
  const periodEndCash = periodStartCash + netProfit;

  /* 口袋餘額：各口袋為累計配置減去由該口袋支付者，日常為總額減去所有口袋 */
  const pockets = useMemo(() => {
    let total = openingBalance;
    const byId = {};
    const bump = (id, v) => { byId[id] = (byId[id] || 0) + v; };
    for (const t of transactions) {
      const c = classify(t);
      const amt = Number(t.amount || 0);
      if (c.kind === 'alloc') { bump(c.pocket, c.dir === 'in' ? amt : -amt); continue; }
      total += (t.type === 'inflow' ? 1 : -1) * amt;
      if (c.pocket !== 'daily') bump(c.pocket, (t.type === 'inflow' ? 1 : -1) * amt);
    }
    const reserved = Object.values(byId).reduce((a, v) => a + v, 0);
    return { total, byId, daily: total - reserved };
  }, [transactions, openingBalance, pocketList]);
  const currentBalance = pockets.total;

  /* 本期各口袋的變動：in 為淨撥入（日常為負數代表撥出到其他口袋），spend 為由該口袋支付的支出 */
  const pocketMoves = useMemo(() => {
    const m = { daily: { in: 0, spend: 0 } };
    for (const p of RESERVES) m[p.id] = { in: 0, spend: 0 };
    for (const t of periodTx) {
      const c = classify(t);
      const amt = Number(t.amount || 0);
      if (c.kind === 'alloc') {
        const v = c.dir === 'in' ? amt : -amt;
        if (m[c.pocket]) m[c.pocket].in += v;
        m.daily.in -= v;
        continue;
      }
      if (m[c.pocket] && t.type === 'outflow') m[c.pocket].spend += amt;
    }
    return m;
  }, [periodTx, pocketList]);

  const deptStats = useMemo(() => DEPARTMENTS.map(d => {
    const txs = periodFlows.filter(t => t.type === 'outflow' && t.category === d.id);
    const total = txs.reduce((s, t) => s + Number(t.amount || 0), 0);
    return { ...d, total, count: txs.length, pct: exp > 0 ? (total / exp) * 100 : 0 };
  }).sort((a, b) => b.total - a.total), [periodFlows, exp]);

  const history = useMemo(() => {
    const out = [];
    const curK = getCurrentPeriod(cycleDay);
    for (let k = 11; k >= 0; k--) {
      const key = shiftPeriod(curK, -k);
      const { end } = getPeriodRange(key, cycleDay);
      let cash = openingBalance, pi = 0, pe = 0;
      for (const t of transactions) {
        if (classify(t).kind !== 'flow') continue;
        const td = txDate(t); if (!td) continue;
        const amt = Number(t.amount || 0);
        if (td <= end) cash += (t.type === 'inflow' ? 1 : -1) * amt;
        if (isInPeriod(t, key, cycleDay)) { if (t.type === 'inflow') pi += amt; else pe += amt; }
      }
      out.push({ period: key, label: getPeriodLabel(key, cycleDay), endingCash: cash, netProfit: pi - pe });
    }
    const first = out.findIndex(h => h.netProfit !== 0 || h.endingCash !== openingBalance);
    return first > 0 ? out.slice(Math.max(0, first - 1)) : out;
  }, [transactions, cycleDay, openingBalance]);

  const burnRate = useMemo(() => {
    const curK = getCurrentPeriod(cycleDay);
    const arr = [];
    for (let i = 1; i <= 3; i++) {
      const key = shiftPeriod(curK, -i);
      const e = transactions
        .filter(t => t.type === 'outflow' && classify(t).kind === 'flow' && isInPeriod(t, key, cycleDay))
        .reduce((s, t) => s + Number(t.amount || 0), 0);
      if (e > 0) arr.push(e);
    }
    return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
  }, [transactions, cycleDay]);
  const runway = burnRate > 0 ? currentBalance / burnRate : Infinity;

  const filteredTx = useMemo(() => periodTx.filter(t => {
    const c = classify(t);
    if (filter === 'all') return true;
    if (filter === 'alloc') return c.kind === 'alloc';
    if (filter.startsWith('pk:')) return c.pocket === filter.slice(3);
    if (c.kind === 'alloc') return false;
    if (filter === 'income') return t.type === 'inflow';
    if (filter === 'expense') return t.type === 'outflow';
    return t.type === 'outflow' && t.category === filter;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date))), [periodTx, filter, pocketList]);

  /* ---- 動作 ---- */
  const handleSave = async (data) => {
    const isEdit = !!editingTx;
    const tx = isEdit
      ? { ...editingTx, ...data }
      : { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ...data, received: true, paymentTerm: 0, createdAt: new Date().toISOString() };
    setTransactions(prev => isEdit ? prev.map(t => (t.id === tx.id ? tx : t)) : [tx, ...prev]);
    setShowForm(false); setEditingTx(null);
    setSyncing(true);
    const op = isEdit
      ? { action: 'updateTxn', payload: { id: tx.id, fields: { type: tx.type, category: tx.category, date: tx.date, amount: tx.amount, client: tx.client, description: tx.description, account: tx.account || '' } } }
      : { action: 'addTxn', payload: { txn: tx } };
    try {
      if (!isOnline()) throw new Error('offline');
      const r = await api(op.action, op.payload);
      if (r && r.missing) {                  // 試算表裡找不到原本那一列（例如在試算表手動改過），不寫入任何資料
        showToast('找不到原本那筆紀錄，可能已在試算表修改過，已重新整理', 'error');
        bootReq = null; reload(); return;
      }
      showToast('已同步到 Google Sheet');
    } catch (e) {
      if (e.server || e.auth) { showToast(e.message, 'error'); bootReq = null; setSyncing(false); reload(); return; }   // 伺服器拒絕：不放進離線佇列
      queueOp(op);
      showToast(isOnline() ? '暫存到佇列，稍後自動重送' : '離線儲存，連線後自動同步', 'info');
    } finally { setSyncing(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('確定刪除？')) return;
    setTransactions(prev => prev.filter(t => t.id !== id));
    setShowForm(false); setEditingTx(null);
    setSyncing(true);
    try {
      if (!isOnline()) throw new Error('offline');
      const r = await api('deleteTxn', { id });
      if (r && r.missing) { showToast('找不到這筆紀錄，已重新整理', 'error'); bootReq = null; reload(); return; }
      showToast('已刪除');
    } catch (e) {
      if (e.server || e.auth) { showToast(e.message, 'error'); bootReq = null; setSyncing(false); reload(); return; }   // 伺服器拒絕：不放進離線佇列
      queueOp({ action: 'deleteTxn', payload: { id } });
      showToast('離線刪除，連線後同步', 'info');
    } finally { setSyncing(false); }
  };

  const scanDuplicates = async () => {
    setShowSettings(false); setShowDup(true); setDupLoading(true);
    try {
      const r = await api('scanDuplicates');
      setDupGroups(r.groups || []);
    } catch (e) {
      setDupGroups([]); showToast('掃描失敗：' + e.message, 'error');
    } finally { setDupLoading(false); }
  };

  /* 只刪除使用者指定的那一列；同 id 的多列一次刪一筆 */
  const deleteDuplicate = async (id) => {
    try {
      await api('deleteTxn', { id });
      setDupGroups(prev => prev
        .map(g => {
          let dropped = false;
          const items = g.items.filter(it => {
            if (!dropped && it.id === id && g.items.indexOf(it) !== 0) { dropped = true; return false; }
            return true;
          });
          return { ...g, items };
        })
        .filter(g => g.items.length > 1));
      setTransactions(prev => {
        const i = prev.findIndex(t => t.id === id);
        return i < 0 ? prev : [...prev.slice(0, i), ...prev.slice(i + 1)];
      });
      showToast('已刪除 1 筆');
      reload();
    } catch (e) { showToast('刪除失敗：' + e.message, 'error'); }
  };

  const changeCycle = async (d) => {
    const prev = cycleDay;
    setCycleDay(d); setPeriodTouched(false); localStorage.setItem(K_CYCLE, String(d));
    try { await api('setSetting', { key: 'cycleDay', value: d }); showToast(`結算日已設為每月 ${d} 號`); }
    catch (e) { setCycleDay(prev); showToast('儲存失敗：' + e.message, 'error'); }
  };

  /* 口袋管理：成功後重新讀取，讓餘額、紀錄名稱都與試算表一致；失敗時也重新讀取，避免畫面停在一半的狀態 */
  const pocketRun = async (fn, okMsg) => {
    if (!isOnline()) throw new Error('目前離線，口袋設定需要連線才能修改');
    setSyncing(true);
    let ok = false;
    try { await fn(); ok = true; }
    finally { setSyncing(false); if (!ok) reload(); }
    showToast(okMsg);
    await reload();
  };
  const addPocket = (name, icon, target) =>
    pocketRun(() => api('addPocket', { name, icon, target }), `已新增口袋「${name}」`);
  const savePocket = (id, { name, target }) => {
    const cur = findPocket(id);
    const renamed = name !== cur.name, retarget = target !== cur.target;
    return pocketRun(async () => {
      if (renamed) await api('renamePocket', { id, name });
      if (retarget) await api('setPocketTarget', { id, target });
    }, renamed && retarget ? '口袋已更新' : renamed ? `已改名為「${name}」` : target > 0 ? '目標已更新' : '已取消目標');
  };
  const deletePocket = (id) => {
    const name = findPocket(id).name;
    return pocketRun(() => api('deletePocket', { id, txnId: `pkdelw${Date.now().toString(36)}` }), `已刪除口袋「${name}」`);
  };

  const saveOpening = async (v) => {
    const prev = openingBalance;
    setOpeningBalance(v);
    try { await api('setOpening', { value: v }); showToast('期初餘額已更新'); }
    catch (e) { setOpeningBalance(prev); showToast('儲存失敗：' + e.message, 'error'); }
  };

  /* ---- 畫面 ---- */
  const logout = async (all) => {
    const t = getSess();
    try {
      if (all) await api('logoutAll');
      else await fetch(CFG.api + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } });
    } catch (e) {}
    try { localStorage.removeItem(K_SESS); localStorage.removeItem(K_CACHE); if (window.liff && window.liff.isLoggedIn && !window.liff.isInClient()) window.liff.logout(); } catch (e) {}
    setShowSettings(false); setSess('');
  };

  if (!sess) return html`<${LoginScreen} onDone=${setSess} />`;

  const label = getPeriodLabel(period, cycleDay);
  const isCur = period === getCurrentPeriod(cycleDay);

  return html`
    <div class="app">
      ${toast && html`<div class="toast" style=${{
        background: toast.type === 'error' ? '#FEE2E2' : toast.type === 'info' ? '#FEF3C7' : '#E8F0EA',
        color:      toast.type === 'error' ? '#991B1B' : toast.type === 'info' ? '#92400E' : '#1F3A2E',
        border: `1px solid ${toast.type === 'error' ? '#FCA5A5' : toast.type === 'info' ? '#FCD34D' : '#A8D5B5'}`,
      }}>${toast.msg}</div>`}

      <header class="hdr">
        <div class="hdr-in">
          <div class="between" style="margin-bottom:8px">
            <div class="row" style="gap:6px;color:var(--ink)">
              ${IBag(15)}<span class="brand">Me, Inc.</span>
              ${syncing && html`<span class="spin" style="color:var(--t3)">${IRef(13)}</span>`}
              ${!online && html`<span style="color:#B45309">${ICloudOff()}</span>`}
            </div>
            <div class="row">
              <button class="iconbtn" style="color:var(--t2)" aria-label="重新整理" onClick=${reload}>${IRef()}</button>
              <button class="iconbtn" style="color:var(--t2)" aria-label="設定" onClick=${() => setShowSettings(true)}>${ICog()}</button>
            </div>
          </div>
          <div class="between" style="gap:8px;flex-wrap:wrap">
            <h1 class="sr-only">個人營運帳本</h1>
            <nav class="navseg" aria-label="頁面">
              <button class=${view === 'home' ? 'on' : ''} aria-current=${view === 'home' ? 'page' : null} onClick=${() => goView('home')}>總覽</button>
              <button class=${view === 'pockets' ? 'on' : ''} aria-current=${view === 'pockets' ? 'page' : null} onClick=${() => goView('pockets')}>口袋</button>
            </nav>
            <button class="periodbtn" aria-label=${'切換期間，目前 ' + label + (isCur ? '' : '（歷史期間）')} onClick=${() => setShowPicker(true)}>
              <span style="color:var(--t2)">${ICal()}</span>
              ${!isCur && html`<span class="hist">歷史</span>`}
              <span class="rng">${label}</span>
              <span style="color:var(--t3)">${IDown()}</span>
            </button>
          </div>
        </div>
      </header>

      <main class="main">
        ${!hasData && loadState === 'loading' && html`
          <div class="statusbar">
            <span class="spin">${IRef(13)}</span>正在連線 Google Sheet 後台⋯
          </div>`}
        ${loadState === 'error' && html`
          <div class="statusbar err-bar">
            <span>
              ${hasData ? '後台連線失敗，顯示的是上次同步的資料' : '後台連線失敗，尚未取得資料'}
              ${syncedAt && html`<div class="mini" style="color:inherit;opacity:.8">上次同步 ${new Date(syncedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>`}
            </span>
            <button class="retry" onClick=${reload}>重試</button>
          </div>`}

        ${view === 'pockets' ? html`
        <${PocketsPage} balances=${pockets} moves=${pocketMoves}
          onTransfer=${setTransferFrom} onManage=${setManaging} onAdd=${() => setAdding(true)} />
        ` : html`
        <!-- 本期損益 -->
        <section class="card">
          <div class="card-hd tinted">
            <span class="eyebrow">Period P&L</span>
            <span class="sub mono">${getPeriodLabelFull(period, cycleDay)}</span>
          </div>
          <div class="card-bd">
            <div class="lbl" style="margin-bottom:4px">本期淨利</div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <span class="big" style=${{ color: netProfit >= 0 ? '#1F3A2E' : '#A0421C' }}>
                ${netProfit >= 0 ? '+' : '−'}$${fmt(Math.abs(netProfit))}
              </span>
              ${inc > 0 && html`<span class="badge" style=${{
                background: margin >= 20 ? '#E8F0EA' : margin >= 0 ? '#FFF3DC' : '#FEE2E2',
                color:      margin >= 20 ? '#1F3A2E' : margin >= 0 ? '#7A5A2C' : '#991B1B',
              }}>淨利率 ${margin.toFixed(1)}%</span>`}
            </div>
            <div class="g2 divider-t">
              <div>
                <div class="row" style="gap:5px;margin-bottom:2px;color:var(--ink)">${IUp()}<span class="lbl">營運收入</span></div>
                <div class="kpi" style="color:#1F3A2E">$${fmt(inc)}</div>
              </div>
              <div>
                <div class="row" style="gap:5px;margin-bottom:2px;color:var(--red)">${IDn()}<span class="lbl">營運支出</span></div>
                <div class="kpi" style="color:#A0421C">$${fmt(exp)}</div>
              </div>
            </div>
            <div class="g2 divider-t">
              <div>
                <span class="lbl">期初現金</span>
                <div class="kpi-s" style="color:#7A5A2C">$${fmt(periodStartCash)}</div>
                <div class="mini">自上期期末延續</div>
              </div>
              <div>
                <span class="lbl">期末現金</span>
                <div class="kpi-s" style=${{ color: periodEndCash >= 0 ? '#1F3A2E' : '#A0421C' }}>$${fmt(periodEndCash)}</div>
                <div class="mini">= 期初 + 淨利</div>
              </div>
            </div>
          </div>
        </section>

        <!-- 口袋摘要：撥款與管理在口袋頁 -->
        <${PocketSummary} balances=${pockets} onOpen=${() => goView('pockets')} />

        <!-- 部門支出 -->
        ${exp > 0 && html`
        <section class="card">
          <div class="card-hd"><span class="eyebrow">各部門支出佔比</span><span class="sub">by Department</span></div>
          <div class="card-bd" style="display:flex;flex-direction:column;gap:10px">
            ${deptStats.filter(d => d.total > 0).map(d => html`
              <button key=${d.id} class="deptrow" onClick=${() => setFilter(d.id)}>
                <div class="between" style="margin-bottom:4px">
                  <div class="row" style="gap:8px">
                    <span style="font-size:16px">${d.emoji}</span>
                    <span style="font-size:14px;font-weight:500">${d.name}</span>
                    <span class="sub">${d.count} 筆</span>
                  </div>
                  <div class="row" style="gap:8px">
                    <span class="sub mono">${d.pct.toFixed(0)}%</span>
                    <span class="mono" style="font-size:14px;font-weight:600">$${fmt(d.total)}</span>
                  </div>
                </div>
                <div class="bar"><i style=${{ width: d.pct + '%', background: d.color }}></i></div>
              </button>`)}
          </div>
        </section>`}

        ${history.length >= 2 && html`<${AssetTrendChart} history=${history} />`}
        ${history.length >= 2 && html`<${PLBarChart} history=${history} />`}

        <!-- 指標 -->
        <section class="g2">
          <div class="card" style="padding:14px">
            <div class="row" style="gap:6px;margin-bottom:6px;color:var(--red)">${IFlame()}<span class="lbl">期燃燒率</span></div>
            <div class="kpi" style="color:#1F3A2E">$${fmt(burnRate)}</div>
            <div class="mini">近 3 期平均支出</div>
          </div>
          <div class="card" style="padding:14px">
            <div class="row" style="gap:6px;margin-bottom:6px;color:var(--ink)">${IBag(14)}<span class="lbl">公司跑道</span></div>
            <div class="kpi" style=${{ color: runway >= 6 ? '#1F3A2E' : runway >= 3 ? '#A87B3D' : '#A0421C' }}>
              ${runway === Infinity ? '∞' : runway.toFixed(1) + ' 期'}
            </div>
            <div class="mini">沒收入還能撐多久</div>
          </div>
        </section>

        <!-- 篩選 -->
        <section class="chips">
          ${[{ k: 'all', l: '全部' }, { k: 'income', l: '收入' }, { k: 'expense', l: '支出' },
             { k: 'alloc', l: '🔁 撥款' },
             ...RESERVES.map(p => ({ k: 'pk:' + p.id, l: p.emoji + ' ' + p.short })),
             ...DEPARTMENTS.map(d => ({ k: d.id, l: d.emoji + ' ' + d.name }))].map(f => html`
            <button key=${f.k} class=${'chip' + (filter === f.k ? ' on' : '')} onClick=${() => setFilter(f.k)}>${f.l}</button>`)}
        </section>

        <!-- 明細 -->
        <section class="card">
          <div class="card-hd"><span class="eyebrow">交易明細</span><span class="sub">${filteredTx.length} 筆</span></div>
          ${filteredTx.length === 0
            ? html`<div style="padding:48px 20px;text-align:center;color:var(--t3);font-size:14px">本期此類別暫無記錄</div>`
            : filteredTx.map(tx => {
                const c = classify(tx);
                if (c.kind === 'alloc') {
                  const pk = findPocket(c.pocket);
                  const into = c.dir === 'in';
                  return html`
                    <button key=${tx.id} class="tx" onClick=${() => { setEditingTx(tx); setShowForm(true); }}>
                      <div class="tx-ic" style="background:#EFEDE6">🔁</div>
                      <div style="flex:1;min-width:0">
                        <div class="tx-nm">${into ? `撥入${pk.name}` : `${pk.name}撥回日常`}</div>
                        <div class="tx-mt">口袋配置 · ${tx.date}${tx.client ? ' · ' + tx.client : ''}${c.legacy ? ' · 舊格式' : ''}</div>
                      </div>
                      <div class="tx-am" style="color:#78716C">${into ? '→' : '←'}$${fmt(tx.amount)}</div>
                    </button>`;
                }
                const isInc = tx.type === 'inflow';
                const cat = isInc ? findIncome(tx.category) : findDept(tx.category);
                const pk = findPocket(c.pocket);
                return html`
                  <button key=${tx.id} class="tx" onClick=${() => { setEditingTx(tx); setShowForm(true); }}>
                    <div class="tx-ic" style=${{ background: isInc ? '#E8F0EA' : cat.color + '22' }}>${cat.emoji}</div>
                    <div style="flex:1;min-width:0">
                      <div class="tx-nm">
                        ${tx.client || cat.name}
                        ${c.pocket !== 'daily' && html`<span class="tag" style=${{ color: pk.color, borderColor: pk.color + '55' }}>${pk.short}</span>`}
                      </div>
                      <div class="tx-mt">${cat.name} · ${tx.date}${tx.description ? ' · ' + tx.description : ''}</div>
                    </div>
                    <div class="tx-am" style=${{ color: isInc ? '#1F3A2E' : '#A0421C' }}>
                      ${isInc ? '+' : '−'}$${fmt(tx.amount)}
                    </div>
                  </button>`;
              })}
        </section>

        `}

        <footer class="sub" style="text-align:center;padding:16px 0">
          資料儲存於你的 Google Sheet · ${online ? '線上' : '離線'} · Me, Inc.
        </footer>
      </main>

      <button class="fab" onClick=${() => { setEditingTx(null); setShowForm(true); }}>${IPlus()}</button>

      ${showPicker && html`<${PeriodPicker} value=${period} cycleDay=${cycleDay}
        onChange=${(k) => { setPeriod(k); setPeriodTouched(true); }} onClose=${() => setShowPicker(false)} />`}

      ${showForm && html`<${EntryForm} initial=${editingTx}
        onClose=${() => { setShowForm(false); setEditingTx(null); }}
        onSave=${handleSave}
        onDelete=${editingTx ? () => handleDelete(editingTx.id) : null} />`}

      ${transferFrom && html`<${TransferSheet} pocketId=${transferFrom} balances=${pockets}
        onSave=${async (d) => { setTransferFrom(null); await handleSave(d); }}
        onClose=${() => setTransferFrom(null)} />`}

      ${managing && html`<${PocketManageSheet} key=${managing} pocket=${findPocket(managing)} balance=${pockets.byId[managing] || 0}
        onSave=${async (v) => { await savePocket(managing, v); setManaging(null); }}
        onDelete=${async () => { await deletePocket(managing); setManaging(null); }}
        onClose=${() => setManaging(null)} />`}

      ${adding && html`<${AddPocketSheet}
        onAdd=${async (name, icon, target) => { await addPocket(name, icon, target); setAdding(false); }}
        onClose=${() => setAdding(false)} />`}

      ${showDup && html`<${DuplicateSheet} groups=${dupGroups} loading=${dupLoading}
        onDelete=${deleteDuplicate} onRescan=${scanDuplicates} onClose=${() => setShowDup(false)} />`}

      ${showSettings && html`<${SettingsSheet} userName=${localStorage.getItem(K_NAME) || ''} onLogout=${() => logout(false)} onLogoutAll=${() => { if (confirm('確定要登出所有裝置嗎？每台裝置都需要重新用 LINE 登入。')) logout(true); }} openingBalance=${openingBalance}
        currentBalance=${currentBalance} cycleDay=${cycleDay}
        onOpenPockets=${() => { setShowSettings(false); goView('pockets'); }} onChangeCycle=${changeCycle} onSaveOpening=${saveOpening} onDedupe=${scanDuplicates}
        onClose=${() => setShowSettings(false)}
        />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('root'));

/* 測試用匯出（瀏覽器不影響） */
export { getCurrentPeriod, getPeriodRange, getPeriodLabel, getPeriodLabelFull, shiftPeriod, isInPeriod, txDate };
