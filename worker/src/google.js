/* Google Sheets：服務帳戶 JWT 授權 + 讀寫 */
import {
  TAB_TXN, TAB_SET, TAB_TXN_EN, TAB_SET_EN, HEADER_ZH, HEADER_EN, HIDDEN_COLS, colKey, isZhHeader, zhHeaderOf, toSheet, fromSheet,
  isZhSettings, setHeaderZh, settingToSheet, settingFromSheet,
} from './zh.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const TXN_SHEET = 'Transactions';

let cached = null; // { token, exp, email }

const b64url = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlStr = (str) => b64url(new TextEncoder().encode(str));

function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseServiceAccount(json) {
  let sa;
  try { sa = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new GoogleAuthError('GOOGLE_SA_JSON 不是有效的 JSON'); }
  if (!sa || !sa.client_email || !sa.private_key) throw new GoogleAuthError('GOOGLE_SA_JSON 缺少 client_email 或 private_key');
  return sa;
}

export class GoogleAuthError extends Error {}
export class SheetAccessError extends Error {}

export async function getAccessToken(saJson, fetchImpl = fetch) {
  const sa = parseServiceAccount(saJson);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === sa.client_email && cached.exp - 60 > now) return cached.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claim))}`;
  let key;
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch { throw new GoogleAuthError('私鑰格式錯誤'); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new GoogleAuthError(`取得 Google 權杖失敗（HTTP ${res.status}）`);
  const j = await res.json();
  cached = { token: j.access_token, exp: now + Number(j.expires_in || 3600), email: sa.client_email };
  return cached.token;
}

export function resetTokenCache() { cached = null; }

async function sheetsFetch(token, path, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 403 || res.status === 404) throw new SheetAccessError(`無法存取試算表（HTTP ${res.status}）`);
  if (res.status === 401) throw Object.assign(new GoogleAuthError('Google 授權失敗（HTTP 401）'), { status: 401 });
  if (!res.ok) throw new Error(`Sheets API 錯誤（HTTP ${res.status}）`);
  return res.json();
}

const rngIn = (tab, a1) => encodeURIComponent(`'${tab}'!${a1}`);

/* ---------- 工作表名稱（中文化後為「記帳明細」「設定」，舊帳本為英文） ---------- */
const tabCache = new Map();          // sheetId → { txn, set, gids: {title: gid} }
const migrating = new Map();         // sheetId → 中文化檢查的 Promise（同時多個請求只做一次）

export async function sheetTabs(token, sheetId, fetchImpl = fetch) {
  if (tabCache.has(sheetId)) return tabCache.get(sheetId);
  const j = await sheetsFetch(token, `/${sheetId}?fields=sheets.properties(sheetId,title,gridProperties.rowCount)`, {}, fetchImpl);
  const props = (j.sheets || []).map(x => x.properties);
  const titles = props.map(p => p.title);
  const pick = (zh, en, i) => (titles.includes(zh) ? zh : titles.includes(en) ? en : titles[i] || en);
  const t = {
    txn: pick(TAB_TXN, TAB_TXN_EN, 0), set: pick(TAB_SET, TAB_SET_EN, 1),
    gids: Object.fromEntries(props.map(p => [p.title, p.sheetId])),
    rows: Object.fromEntries(props.map(p => [p.title, p.gridProperties?.rowCount || 0])),
  };
  tabCache.set(sheetId, t);
  return t;
}
export function resetSheetCaches() { tabCache.clear(); migrating.clear(); }

/**
 * 舊帳本（英文標題）一次性轉成中文：工作表改名、標題與內容翻譯、凍結標題列、隱藏系統欄位、金額千分位。
 * 只改「類型、分類、已收款、口袋」這幾欄與標題，不動日期與金額的儲存格。失敗不影響記帳。
 */
export async function ensureZh(token, sheetId, fetchImpl = fetch) {
  if (!migrating.has(sheetId)) migrating.set(sheetId, migrate(token, sheetId, fetchImpl));
  await migrating.get(sheetId);
  return sheetTabs(token, sheetId, fetchImpl);
}

/**
 * 帳本格式版本：每次調整帳本格式（新增欄位、改名…）就把版本加一，並在 upgrade() 補上對應步驟。
 * 任何舊版本的帳本（包含重新綁定回來的舊帳本）第一次被讀取時會自動升級，使用者不用做任何事。
 *   v1：中文化（工作表、標題、內容）
 *   v2：補齊缺少的欄位、標題列回到第一列、記錄格式版本
 */
export const SCHEMA_VERSION = 2;

async function migrate(token, sheetId, fetchImpl) {
  const t = await toZh(token, sheetId, fetchImpl);
  await upgrade(token, sheetId, t, fetchImpl);
  return t;
}

/** 依格式版本補齊帳本：缺少的欄位、格式設定與版本紀錄。失敗不影響記帳，下次會再試 */
async function upgrade(token, sheetId, t, fetchImpl) {
  try {
    const j = await sheetsFetch(token,
      `/${sheetId}/values:batchGet?ranges=${rngIn(t.txn, 'A1:Z50')}&ranges=${rngIn(t.set, 'A:C')}&valueRenderOption=UNFORMATTED_VALUE`, {}, fetchImpl);
    let top = j.valueRanges?.[0]?.values || [];
    const sets = j.valueRanges?.[1]?.values || [];
    const h = top.findIndex(r => ['編號', 'id'].includes(String(r?.[0] ?? '').trim()));
    if (h > 0 && await fixHeaderTop(token, sheetId, t, fetchImpl)) top = [top[h]];   // 標題列被擠下去 → 先移回第一列
    const verRow = sets.findIndex(r => settingFromSheet(r?.[0]) === 'schemaVersion');
    const ver = verRow >= 0 ? Number(sets[verRow][1]) || 0 : 0;
    if (ver >= SCHEMA_VERSION) return;

    const zh = t.txn === TAB_TXN;
    const header = (h >= 0 ? top[Math.min(h, top.length - 1)] : []).map(String);
    const data = [];
    let keys = header.map(colKey);
    if (!header.length || h < 0) {                               // 沒有標題列（空白或被刪掉）→ 補上完整標題
      if (top.length === 0) { data.push({ range: `'${t.txn}'!A1`, values: [zh ? HEADER_ZH : HEADER_EN] }); keys = [...HEADER_EN]; }
    } else {
      const missing = HEADER_EN.filter(k => !keys.includes(k));  // 舊版本沒有的欄位（例如「口袋」）補在最右邊
      if (missing.length) {
        data.push({ range: `'${t.txn}'!${colName(header.length)}1`, values: [missing.map(k => (zh ? zhHeaderOf([k])[0] : k))] });
        keys = [...keys, ...missing];
      }
    }
    if (sets.length === 0) data.push({ range: `'${t.set}'!A1`, values: [zh ? ['設定項目', '數值', '說明'] : ['key', 'value', 'note']] });
    const note = '帳本格式版本（系統自動維護，請勿修改）';
    if (verRow >= 0) data.push({ range: `'${t.set}'!B${verRow + 1}`, values: [[SCHEMA_VERSION]] });
    else data.push({ range: `'${t.set}'!A${Math.max(sets.length, 1) + 1}`, values: [[zh ? settingToSheet('schemaVersion') : 'schemaVersion', SCHEMA_VERSION, note]] });
    await sheetsFetch(token, `/${sheetId}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) }, fetchImpl);
    const reqs = formatRequests(t.gids[t.txn], t.gids[t.set], keys);
    if (reqs.length) await sheetsFetch(token, `/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: reqs }) }, fetchImpl);
    console.log('ledger upgraded', sheetId, ver, '→', SCHEMA_VERSION);
  } catch (err) {
    console.error('ledger upgrade failed', sheetId, err);
  }
}

async function toZh(token, sheetId, fetchImpl) {
  let t;
  try { t = await sheetTabs(token, sheetId, fetchImpl); } catch (err) { migrating.delete(sheetId); throw err; }
  if (t.txn === TAB_TXN && t.set === TAB_SET) return t;       // 已是中文（改名是最後一步，代表內容也已轉好）
  try {
    const j = await sheetsFetch(token,
      `/${sheetId}/values:batchGet?ranges=${rngIn(t.txn, 'A:Z')}&ranges=${rngIn(t.set, 'A:C')}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, {}, fetchImpl);
    const rows = j.valueRanges?.[0]?.values || [];
    const sets = j.valueRanges?.[1]?.values || [];
    const header = (rows[0] || []).map(String);
    const needTabs = t.txn !== TAB_TXN || t.set !== TAB_SET;
    const needHead = header.length > 0 && !isZhHeader(header);
    const needSet = sets.length > 0 && !isZhSettings(sets[0]);
    if (!needTabs && !needHead && !needSet) return t;

    // 1. 標題與內容（用目前的工作表名稱）
    const keys = header.map(colKey);
    const data = [];
    if (needHead) {
      data.push({ range: `'${t.txn}'!A1`, values: [zhHeaderOf(header)] });
      for (const k of ['type', 'category', 'received', 'account']) {
        const ci = keys.indexOf(k);
        if (ci < 0 || rows.length < 2) continue;
        const col = rows.slice(1).map(r => {
          const v = r[ci];
          const empty = v === '' || v == null;
          if (empty && k !== 'account') return [''];
          if (k === 'account' && !r.some(c => c !== '' && c != null)) return [''];
          return [toSheet(k, fromSheet(k, v))];
        });
        data.push({ range: `'${t.txn}'!${colName(ci)}2:${colName(ci)}${rows.length}`, values: col });
      }
    }
    if (needSet) {
      data.push({ range: `'${t.set}'!A1`, values: [setHeaderZh(sets[0].map(String))] });
      if (sets.length > 1) data.push({ range: `'${t.set}'!A2:A${sets.length}`, values: sets.slice(1).map(r => [settingToSheet(settingFromSheet(r[0]))]) });
    }
    if (data.length) {
      await sheetsFetch(token, `/${sheetId}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) }, fetchImpl);
    }
    // 2. 最後才改名＋格式：中途失敗時，下次會重新檢查
    const gTxn = t.gids[t.txn], gSet = t.gids[t.set];
    const reqs = [];
    if (t.txn !== TAB_TXN && gTxn != null) reqs.push({ updateSheetProperties: { properties: { sheetId: gTxn, title: TAB_TXN }, fields: 'title' } });
    if (t.set !== TAB_SET && gSet != null) reqs.push({ updateSheetProperties: { properties: { sheetId: gSet, title: TAB_SET }, fields: 'title' } });
    reqs.push(...formatRequests(gTxn, gSet, keys));
    if (reqs.length) {
      await sheetsFetch(token, `/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: reqs }) }, fetchImpl);
      const nt = { txn: TAB_TXN, set: TAB_SET, gids: { ...t.gids, [TAB_TXN]: gTxn, [TAB_SET]: gSet }, rows: { ...t.rows, [TAB_TXN]: t.rows[t.txn], [TAB_SET]: t.rows[t.set] } };
      tabCache.set(sheetId, nt);
      Object.assign(t, nt);
    }

    console.log('ledger migrated to zh', sheetId);
  } catch (err) {
    console.error('zh migration failed', sheetId, err);
  }
  return t;
}

/**
 * 修復：標題列被擠到下面、上方出現資料列時（舊版用 append 寫入可能發生），把那些資料列移回標題列下方。
 */
export async function fixHeaderTop(token, sheetId, t, fetchImpl = fetch) {
  try {
    const j = await sheetsFetch(token, `/${sheetId}/values/${rngIn(t.txn, 'A1:A50')}?majorDimension=ROWS`, {}, fetchImpl);
    const col = (j.values || []).map(r => String(r[0] ?? '').trim());
    const h = col.findIndex(v => v === '編號' || v === 'id');
    if (h <= 0) return false;
    const gid = t.gids[t.txn];
    await sheetsFetch(token, `/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [
      { moveDimension: { source: { sheetId: gid, dimension: 'ROWS', startIndex: 0, endIndex: h }, destinationIndex: h + 1 } },
      { repeatCell: { range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { repeatCell: { range: { sheetId: gid, startRowIndex: 1, endRowIndex: h + 1 }, cell: { userEnteredFormat: { textFormat: { bold: false } } }, fields: 'userEnteredFormat.textFormat.bold' } },
    ] }) }, fetchImpl);
    console.log('header moved back to top', sheetId, h);
    return true;
  } catch (err) {
    console.error('fix header failed', sheetId, err);
    return false;
  }
}

/**
 * 在工作表最後一列的下一列寫入（不用 append：append 會自己猜表格範圍，可能寫到標題列上方）。
 * 呼叫端需持有該帳本的寫入鎖，避免兩筆同時寫到同一列。
 */
export async function appendRows(token, sheetId, tab, rows, fetchImpl = fetch) {
  if (!rows.length) return null;
  const j = await sheetsFetch(token, `/${sheetId}/values/${rngIn(tab, 'A:F')}?majorDimension=ROWS`, {}, fetchImpl);
  const start = (j.values || []).length + 1;
  const need = start + rows.length - 1;
  const t = await sheetTabs(token, sheetId, fetchImpl);
  const have = t.rows?.[tab] || 0;
  if (have && need > have) {
    const add = need - have + 200;
    await sheetsFetch(token, `/${sheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [
      { appendDimension: { sheetId: t.gids[tab], dimension: 'ROWS', length: add } },
    ] }) }, fetchImpl);
    t.rows[tab] = have + add;
  }
  await sheetsFetch(token, `/${sheetId}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({
    valueInputOption: 'RAW', data: [{ range: `'${tab}'!A${start}`, values: rows }],
  }) }, fetchImpl);
  return { start };
}

/** 凍結標題列、標題粗體、隱藏系統欄位、金額千分位 */
export function formatRequests(gTxn, gSet, keys) {
  const reqs = [];
  if (gTxn == null) return reqs;
  for (const g of [gTxn, gSet]) {
    if (g == null) continue;
    reqs.push({ updateSheetProperties: { properties: { sheetId: g, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    reqs.push({ repeatCell: { range: { sheetId: g, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
  }
  for (const k of HIDDEN_COLS) {
    const ci = keys.indexOf(k);
    if (ci >= 0) reqs.push({ updateDimensionProperties: { range: { sheetId: gTxn, dimension: 'COLUMNS', startIndex: ci, endIndex: ci + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
  }
  const ai = keys.indexOf('amount');
  if (ai >= 0) reqs.push({ repeatCell: { range: { sheetId: gTxn, startRowIndex: 1, startColumnIndex: ai, endColumnIndex: ai + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } });
  if (gSet != null) reqs.push({ repeatCell: { range: { sheetId: gSet, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } });
  return reqs;
}

/** 讀標題列與 id 欄 */
export async function readHeaderAndIds(token, sheetId, fetchImpl = fetch) {
  const t = await ensureZh(token, sheetId, fetchImpl);
  const j = await sheetsFetch(token,
    `/${sheetId}/values:batchGet?ranges=${rngIn(t.txn, '1:1')}&ranges=${rngIn(t.txn, 'A:A')}&majorDimension=ROWS`, {}, fetchImpl);
  const header = (j.valueRanges?.[0]?.values?.[0] || []).map(String);
  const ids = (j.valueRanges?.[1]?.values || []).slice(1).map(r => String(r[0] ?? ''));
  return { header, ids, tabs: t };
}

/* 試算表日期序號（1899-12-30 起算的天數）→ yyyy-MM-dd */
function serialToDate(n) {
  const d = new Date(Math.round((Number(n) - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}
/** 日期欄正規化：與 Apps Script load 相同，字串取前 10 碼，日期儲存格轉 yyyy-MM-dd */
export function normDate(v) {
  if (typeof v === 'number') return serialToDate(v);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s.slice(0, 10);
}

/** 日期時間儲存格序號 → ISO（試算表時區預設台北 +8） */
function serialToIso(n, tzOffsetMin = 480) {
  return new Date(Math.round((Number(n) - 25569) * 86400000) - tzOffsetMin * 60000).toISOString();
}

/**
 * 直接讀整本帳（交易＋設定），取代 Apps Script 的 load
 * 每筆交易附 _row（試算表列號，1 起算），供修改／刪除使用
 */
export async function readLedger(token, sheetId, fetchImpl = fetch) {
  const tabs = await ensureZh(token, sheetId, fetchImpl);
  const j = await sheetsFetch(token,
    `/${sheetId}/values:batchGet?ranges=${rngIn(tabs.txn, 'A:Z')}&ranges=${rngIn(tabs.set, 'A:B')}`
    + `&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, {}, fetchImpl);
  const rows = j.valueRanges?.[0]?.values || [];
  const header = (rows[0] || []).map(String);
  const keys = header.map(colKey);
  const transactions = [];
  rows.forEach((r, idx) => {
    if (idx === 0 || !r.some(c => c !== '' && c != null)) return;
    const t = Object.fromEntries(keys.map((k, i) => [k, fromSheet(k, r[i] ?? '')]));
    t.id = String(t.id ?? '');
    t.date = normDate(t.date);
    t.amount = Number(String(t.amount).replace(/,/g, '')) || 0;
    t.account = String(t.account ?? '');
    if (typeof t.createdAt === 'number') t.createdAt = serialToIso(t.createdAt);
    if (keys.includes('received')) t.received = fromSheet('received', r[keys.indexOf('received')]);
    if (keys.includes('paymentTerm')) t.paymentTerm = Number(t.paymentTerm) || 0;
    Object.defineProperty(t, '_row', { value: idx + 1, enumerable: false });
    transactions.push(t);
  });
  const settings = {}, settingRows = {};
  (j.valueRanges?.[1]?.values || []).forEach((r, idx) => {
    if (idx === 0 || !r[0]) return;
    const k = settingFromSheet(r[0]);
    settings[k] = r[1];
    settingRows[k] = idx + 1;
  });
  return {
    header,
    tabs,
    transactions,
    settings,
    settingRows,
    openingBalance: Number(settings.openingBalance) || 0,
    cycleDay: Number(settings.cycleDay) || 1,
    fundTarget: Number(settings.fundTarget) || 50000,
    savingsTarget: Math.max(0, Number(settings.savingsTarget) || 0),
  };
}

/** 交易某欄的 A1 位置與寫入值（依帳本是中文或英文） */
export function txnCell(d, key, row, value) {
  const ci = d.header.map(colKey).indexOf(key);
  if (ci < 0) return null;
  return { a1: `'${d.tabs.txn}'!${colName(ci)}${row}`, value: isZhHeader(d.header) ? toSheet(key, value) : value };
}

/** 寫入一項設定（存在就更新，否則新增一列） */
export async function setSetting(token, sheetId, d, key, value, fetchImpl = fetch) {
  if (d.settingRows[key]) return writeCells(token, sheetId, [{ a1: `'${d.tabs.set}'!B${d.settingRows[key]}`, value }], fetchImpl);
  const zh = d.tabs.set === TAB_SET;
  return appendRow(token, sheetId, d.tabs.set, [zh ? settingToSheet(key) : key, value], fetchImpl);
}

/** 一次寫入多個儲存格：[{ a1: "'Transactions'!C5", value }] */
export async function writeCells(token, sheetId, cells, fetchImpl = fetch) {
  if (!cells.length) return null;
  return sheetsFetch(token, `/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: cells.map(c => ({ range: c.a1, values: [[c.value]] })) }),
  }, fetchImpl);
}

/** 附加一列到任意工作表 */
export async function appendRow(token, sheetId, sheetName, row, fetchImpl = fetch) {
  return appendRows(token, sheetId, sheetName, [row], fetchImpl);
}

/** 取得工作表的數字 id（刪除列需要） */
export async function sheetGid(token, sheetId, title, fetchImpl = fetch) {
  const t = await sheetTabs(token, sheetId, fetchImpl);
  if (t.gids[title] == null) throw new Error(`找不到工作表 ${title}`);
  return t.gids[title];
}

/** 刪除指定列（1 起算） */
export async function deleteRow(token, sheetId, title, rowNumber, fetchImpl = fetch) {
  const gid = await sheetGid(token, sheetId, title, fetchImpl);
  return sheetsFetch(token, `/${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }] }),
  }, fetchImpl);
}

/** 欄號（0 起算）→ A1 欄名 */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 依標題順序附加多列（一次 API 呼叫）；中文帳本自動翻譯內容 */
export async function appendTxns(token, sheetId, header, txns, fetchImpl = fetch) {
  const keys = header.map(colKey);
  if (!keys.length || keys[0] !== 'id') throw new Error('記帳明細工作表標題列不符');
  if (!txns.length) return null;
  const zh = isZhHeader(header);
  const tabs = await sheetTabs(token, sheetId, fetchImpl);
  const values = txns.map(txn => keys.map(k => {
    const v = txn[k] === undefined ? '' : txn[k];
    return zh && v !== '' ? toSheet(k, v) : zh && k === 'account' ? toSheet(k, '') : v;
  }));
  return appendRows(token, sheetId, tabs.txn, values, fetchImpl);
}
export const appendTxn = (token, sheetId, header, txn, fetchImpl = fetch) =>
  appendTxns(token, sheetId, header, [txn], fetchImpl);
