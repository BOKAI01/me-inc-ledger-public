/**
 * 網站 API（第二階段）：與 Apps Script 相同的呼叫格式，網站只要換 API 網址。
 *   POST /api?key=XXX   body: FormData payload={"action":"load", ...}
 *   GET  /api?key=XXX&action=load
 * 回應：{ ok: true, data } 或 { ok: false, error }
 * 金鑰對應：KV  api:<key> → {"sheetId":"...","ledgerName":"主帳本"}
 */
import { rememberPockets } from './pocket-cache.js';
import { tokenFor } from './oauth.js';
import {
  readLedger, appendTxns, writeCells, deleteRow, txnCell, setSetting, backfillIds,
} from './google.js';
import { withSheetLock } from './entry.js';
import { addPocket, renamePocket, setPocketTarget, deletePocket, PocketError } from './pocket-ops.js';
import { taipeiToday } from './ledger.js';
import { bearer, bindFromSession, legacyKeyAllowed, logoutAll, createSession, deleteSession } from './session.js';

const DUP_WINDOW_MS = 60 * 1000;
const SETTABLE = new Set(['cycleDay', 'fundTarget', 'savingsTarget', 'openingBalance']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const json = (body) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

async function readPayload(request, url) {
  if (request.method === 'GET') {
    const action = url.searchParams.get('action');
    return action ? { action } : null;
  }
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const fd = await request.formData();
    const p = fd.get('payload');
    return p ? JSON.parse(String(p)) : null;
  }
  const t = await request.text();
  return t ? JSON.parse(t) : null;
}

export async function handleApi(request, env, ctx, deps = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const fetchImpl = deps.fetch || fetch;
  const url = new URL(request.url);
  if (url.pathname === '/api/session') {             // 用 LINE ID Token 換登入憑證
    if (request.method !== 'POST') return json({ ok: false, error: '請用 POST' });
    let body = {};
    try { body = await request.json(); } catch { return json({ ok: false, error: '請求格式錯誤' }); }
    return json(await createSession(env, String(body.idToken || ''), fetchImpl));
  }
  if (url.pathname === '/api/logout') {
    await deleteSession(env, bearer(request));
    return json({ ok: true, data: { loggedOut: true } });
  }
  if (url.pathname !== '/api') return json({ ok: false, error: '不支援的路徑' });
  const AUTH = (message) => json({ ok: false, error: 'auth', message });
  let bind = null, sess = null;
  const token = bearer(request);
  if (token) {                                       // 新方式：LINE 登入後取得的登入憑證
    const r = await bindFromSession(env, token);
    if (!r) return AUTH('登入已過期，請重新登入');
    ({ bind, sess } = r);
  } else {                                           // 舊方式：寫在連結裡的金鑰（過渡期後停用）
    const key = url.searchParams.get('key') || '';
    if (!key) return AUTH('請先用 LINE 登入');
    if (!legacyKeyAllowed(env)) return AUTH('舊的網站連結已停用，請在 LINE 傳「網站」重新開啟');
    bind = key.length >= 16 ? await env.KV.get(`api:${key}`, 'json') : null;
    if (!bind || !bind.sheetId) return json({ ok: false, error: 'API 金鑰無效' });
  }

  let p;
  try { p = await readPayload(request, url); } catch { return json({ ok: false, error: '請求格式錯誤' }); }
  if (!p || !p.action) return json({ ok: false, error: '缺少 action 參數' });

  if (p.action === 'logoutAll') {
    if (!sess) return AUTH('請先用 LINE 登入');
    await logoutAll(env, sess.ch, sess.uid);
    return json({ ok: true, data: { loggedOut: true } });
  }

  try {
    const data = await runAction(p, bind, env, fetchImpl);
    if (p.action !== 'load' && p.action !== 'scanDuplicates' && bind.auth !== 'oauth' && ctx?.waitUntil) {
      ctx.waitUntil(clearGasCache(env, fetchImpl));      // 舊後端快取同步失效（仍可切回）
    }
    return json({ ok: true, data });
  } catch (err) {
    console.error('api failed', p.action, err);
    return json({ ok: false, error: err.message || String(err) });
  }
}

async function runAction(p, bind, env, fetchImpl) {
  const sheetId = bind.sheetId;
  const token = await tokenFor(env, bind, fetchImpl);
  switch (p.action) {
    case 'load': {
      let d = await readLedger(token, sheetId, fetchImpl);
      // 舊資料（手動輸入、舊系統寫入）沒有編號：第一次載入時就把編號寫進試算表，
      // 之後刪除、插入列都不會讓網站拿到的編號失效
      if (d.transactions.some(t => t._synth)) {
        try {
          d = await withLock(env, sheetId, async () => {
            const fresh = await readLedger(token, sheetId, fetchImpl);
            await backfillIds(token, sheetId, fresh, fetchImpl);
            return fresh;
          });
        } catch (err) { console.error('backfill ids on load failed', sheetId, err); }
      }
      await rememberPockets(env, sheetId, d.pockets).catch(() => {});      // 開網站時順便更新 LINE 端的口袋清單
      const out = { transactions: d.transactions, openingBalance: d.openingBalance, cycleDay: d.cycleDay, fundTarget: d.fundTarget, savingsTarget: d.savingsTarget,
        pockets: d.pockets.map(({ row, ...x }) => x) };
      for (const [k, v] of Object.entries(d.settings)) if (k.startsWith('openingBalance_')) out[k] = Number(v) || 0;
      return out;
    }
    case 'scanDuplicates': {
      const d = await readLedger(token, sheetId, fetchImpl);
      return { groups: scanDuplicates(d.transactions) };
    }
    case 'addTxn':
      return withLock(env, sheetId, async () => {
        const t = p.txn || {};
        if (!t.id) throw new Error('缺少 id');
        const d = await readLedger(token, sheetId, fetchImpl);
        await backfillIds(token, sheetId, d, fetchImpl);
        const dup = findDuplicate(d.transactions, t);
        if (dup) return { id: dup.id, duplicate: true };
        await appendTxns(token, sheetId, d.header, [{
          id: String(t.id), type: t.type, category: t.category, date: String(t.date || '').slice(0, 10),
          amount: Number(t.amount) || 0, client: t.client || '', description: t.description || '',
          paymentTerm: Number(t.paymentTerm) || 0, received: t.received !== false,
          createdAt: t.createdAt || new Date().toISOString(), account: t.account || '',
        }], fetchImpl, d.pockets);
        return { id: String(t.id) };
      });
    case 'updateTxn':
      return withLock(env, sheetId, async () => {
        if (!String(p.id ?? '').trim()) throw new Error('這筆紀錄沒有編號，請重新整理網頁後再修改');
        const d = await readLedger(token, sheetId, fetchImpl);
        const hits = d.transactions.filter(t => t.id === String(p.id));
        // 找不到或不只一列：不動任何資料，並明確告訴網站（不能假裝成功）
        if (hits.length > 1) throw new Error('有多筆紀錄使用同一個編號，請到「設定 → 檢查重複記錄」處理後再修改');
        if (!hits.length) throw new Error('找不到這筆紀錄，可能已在其他地方修改或刪除，請重新整理後再試');
        const row = hits[0];
        await backfillIds(token, sheetId, d, fetchImpl);
        const fields = p.fields || {};
        const cells = [];
        for (const [k, v] of Object.entries(fields)) {
          if (k === 'id') continue;
          const value = k === 'amount' ? Number(v) || 0 : k === 'date' ? String(v).slice(0, 10) : (v ?? '');
          const cell = txnCell(d, k, row._row, value);
          if (cell) cells.push(cell);
        }
        await writeCells(token, sheetId, cells, fetchImpl);
        return { id: p.id };
      });
    case 'deleteTxn':
      return withLock(env, sheetId, async () => {
        if (!String(p.id ?? '').trim()) throw new Error('這筆紀錄沒有編號，請重新整理網頁後再刪除');
        const d = await readLedger(token, sheetId, fetchImpl);
        const rows = d.transactions.filter(t => t.id === String(p.id));
        if (!rows.length) throw new Error('找不到這筆紀錄，可能已經刪除或被修改，請重新整理後再試');
        await backfillIds(token, sheetId, d, fetchImpl);
        await deleteRow(token, sheetId, d.tabs.txn, rows[rows.length - 1]._row, fetchImpl);   // 同 id 多列時刪最後一列
        return { id: p.id };
      });
    case 'setSetting':
    case 'setOpening': {
      const k = p.action === 'setOpening' ? 'openingBalance' : String(p.key || '');
      if (!SETTABLE.has(k)) throw new Error('不允許的設定：' + k);
      const v = Number(p.value);
      if (!Number.isFinite(v)) throw new Error('設定值必須是數字');
      if (k === 'cycleDay' && (v < 1 || v > 28)) throw new Error('結算日需介於 1–28');
      if (/Target$/.test(k) && v < 0) throw new Error('目標金額不能是負數');
      return withLock(env, sheetId, async () => {
        if (k === 'fundTarget' || k === 'savingsTarget') {             // 目標金額現在存在「口袋」工作表
          const r = await setPocketTarget(token, sheetId, k === 'fundTarget' ? 'emergency' : 'savings', v, fetchImpl);
          await rememberPockets(env, sheetId, r.pockets).catch(() => {});
          return { key: k, value: v };
        }
        const d = await readLedger(token, sheetId, fetchImpl);
        await setSetting(token, sheetId, d, k, v, fetchImpl);
        return { key: k, value: v };
      });
    }
    case 'addPocket':
    case 'renamePocket':
    case 'setPocketTarget':
    case 'deletePocket':
      return withLock(env, sheetId, async () => {
        try {
          // 每個動作完成後同步 LINE 端的口袋快取，LINE 撥款選單才會立刻看到
          const sync = async (r) => { await rememberPockets(env, sheetId, r.pockets).catch(() => {}); return r; };
          if (p.action === 'addPocket') return (await sync(await addPocket(token, sheetId, p.name, { icon: p.icon, target: p.target }, fetchImpl))).pocket;
          if (p.action === 'renamePocket') return (await sync(await renamePocket(token, sheetId, p.id, p.name, fetchImpl))).pocket;
          if (p.action === 'setPocketTarget') return (await sync(await setPocketTarget(token, sheetId, p.id, p.target, fetchImpl))).pocket;
          const r = await sync(await deletePocket(token, sheetId, p.id, { today: taipeiToday(), txnId: p.txnId }, fetchImpl));
          return { id: r.pocket.id, balance: r.balance, wrote: r.wrote };
        } catch (err) {
          if (err instanceof PocketError) throw new Error(err.message);
          throw err;
        }
      });
    default:
      throw new Error('不支援的 action：' + p.action);
  }
}

/* ---------- 防重複（與 Apps Script v2 規則相同） ---------- */
const acct = (a) => (!a || a === 'daily' ? '' : String(a));
const sig = (t) => [t.type, t.category, String(t.date).slice(0, 10), Number(t.amount), t.client || '', acct(t.account)].join('|');

export function findDuplicate(rows, t) {
  const byId = rows.find(r => r.id === String(t.id));
  if (byId) return byId;
  const s = sig(t), ts = Date.parse(t.createdAt || '');
  if (!Number.isFinite(ts)) return null;
  return rows.find(r => sig(r) === s && Math.abs(Date.parse(r.createdAt || '') - ts) <= DUP_WINDOW_MS) || null;
}

export function scanDuplicates(rows) {
  const groups = [];
  const byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  const idMap = new Map();
  for (const r of rows) { if (!r.id) continue; if (!idMap.has(r.id)) idMap.set(r.id, []); idMap.get(r.id).push(r); }
  for (const [id, items] of idMap) if (items.length > 1) groups.push({ key: 'id:' + id, reason: 'id', items: [...items].sort(byTime) });
  const cMap = new Map();
  for (const [, items] of idMap) {
    const r = items[0];
    const k = sig(r);
    if (!cMap.has(k)) cMap.set(k, []);
    cMap.get(k).push(r);
  }
  for (const [k, items] of cMap) if (items.length > 1) groups.push({ key: 'c:' + k, reason: 'content', items: [...items].sort(byTime) });
  return groups;
}

/* 寫入鎖：同一本帳的修改依序執行 */
const withLock = withSheetLock;

async function clearGasCache(env, fetchImpl) {
  if (!env.LEGACY_GAS_URL) return;
  try {
    await fetchImpl(env.LEGACY_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payload: JSON.stringify({ action: 'clearCache' }) }),
      redirect: 'follow',
    });
  } catch (err) { console.error('clearCache failed', err); }
}
