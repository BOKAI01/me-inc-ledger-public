/**
 * 網站 API（第二階段）：與 Apps Script 相同的呼叫格式，網站只要換 API 網址。
 *   POST /api?key=XXX   body: FormData payload={"action":"load", ...}
 *   GET  /api?key=XXX&action=load
 * 回應：{ ok: true, data } 或 { ok: false, error }
 * 金鑰對應：KV  api:<key> → {"sheetId":"...","ledgerName":"主帳本"}
 */
import { tokenFor } from './oauth.js';
import {
  readLedger, appendTxns, writeCells, deleteRow, txnCell, setSetting,
} from './google.js';
import { entryCall } from './entry.js';

const DUP_WINDOW_MS = 60 * 1000;
const SETTABLE = new Set(['cycleDay', 'fundTarget', 'openingBalance']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  const key = url.searchParams.get('key') || '';
  const bind = key.length >= 16 ? await env.KV.get(`api:${key}`, 'json') : null;
  if (!bind || !bind.sheetId) return json({ ok: false, error: 'API 金鑰無效' });

  let p;
  try { p = await readPayload(request, url); } catch { return json({ ok: false, error: '請求格式錯誤' }); }
  if (!p || !p.action) return json({ ok: false, error: '缺少 action 參數' });

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
      const d = await readLedger(token, sheetId, fetchImpl);
      const out = { transactions: d.transactions, openingBalance: d.openingBalance, cycleDay: d.cycleDay, fundTarget: d.fundTarget };
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
        const dup = findDuplicate(d.transactions, t);
        if (dup) return { id: dup.id, duplicate: true };
        await appendTxns(token, sheetId, d.header, [{
          id: String(t.id), type: t.type, category: t.category, date: String(t.date || '').slice(0, 10),
          amount: Number(t.amount) || 0, client: t.client || '', description: t.description || '',
          paymentTerm: Number(t.paymentTerm) || 0, received: t.received !== false,
          createdAt: t.createdAt || new Date().toISOString(), account: t.account || '',
        }], fetchImpl);
        return { id: String(t.id) };
      });
    case 'updateTxn':
      return withLock(env, sheetId, async () => {
        const d = await readLedger(token, sheetId, fetchImpl);
        const row = d.transactions.find(t => t.id === String(p.id));
        if (!row) return { id: p.id, missing: true };            // 找不到也回成功，避免離線佇列卡住
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
        const d = await readLedger(token, sheetId, fetchImpl);
        const rows = d.transactions.filter(t => t.id === String(p.id));
        if (!rows.length) return { id: p.id, missing: true };
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
      return withLock(env, sheetId, async () => {
        const d = await readLedger(token, sheetId, fetchImpl);
        await setSetting(token, sheetId, d, k, v, fetchImpl);
        return { key: k, value: v };
      });
    }
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

/* ---------- 寫入鎖：同一本帳的修改依序執行 ---------- */
async function withLock(env, sheetId, fn) {
  const name = 'lock:' + sheetId;
  const owner = crypto.randomUUID();
  const deadline = Date.now() + 15000;
  for (;;) {
    const r = await entryCall(env, name, 'lock', { owner, ttl: 20000 });
    if (r.ok) break;
    if (Date.now() > deadline) throw new Error('帳本忙碌中，請稍後再試');
    await new Promise(res => setTimeout(res, 150));
  }
  try { return await fn(); }
  finally { await entryCall(env, name, 'unlock', { owner }).catch(() => {}); }
}

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
