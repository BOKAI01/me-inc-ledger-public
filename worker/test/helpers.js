import { Entry } from '../src/entry.js';

export const HEADER = ['id', 'type', 'category', 'date', 'amount', 'client', 'description', 'paymentTerm', 'received', 'createdAt', 'account'];

export function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

/* 模擬 Durable Object：每個名稱一個實例，請求依序處理（等同 input gate） */
export function fakeEntryNS() {
  const inst = new Map();
  return {
    idFromName: (n) => n,
    get(id) {
      if (!inst.has(id)) {
        const store = new Map();
        const storage = {
          async get(k) { return store.get(k); },
          async put(k, v) { store.set(k, structuredClone(v)); },
          async setAlarm() {},
          async deleteAll() { store.clear(); },
          async delete(k) { store.delete(k); },
        };
        inst.set(id, { obj: new Entry({ storage }, {}), q: Promise.resolve() });
      }
      const it = inst.get(id);
      return {
        fetch(url, init) {
          const run = it.q.then(() => it.obj.fetch(new Request(url, init)));
          it.q = run.catch(() => {});
          return run;
        },
      };
    },
  };
}

export async function makeServiceAccount() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let s = ''; for (const b of der) s += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(s).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ type: 'service_account', client_email: 'bot@test.iam.gserviceaccount.com', private_key: pem });
}

/* 模擬外部服務：Google OAuth、Sheets、LINE、Apps Script */
export function fakeWorld({ rows = [], settings = { openingBalance: 0, cycleDay: 1, fundTarget: 50000 }, sheetStatus = 200, appendDelay = 0 } = {}) {
  const w = { rows: rows.map(r => [...r]), replies: [], gasCalls: [], appendCalls: 0 };
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (u.startsWith('https://sheets.googleapis.com/')) {
      if (sheetStatus !== 200) return new Response('no', { status: sheetStatus });
      if (u.includes('?fields=')) return Response.json({ sheets: [{ properties: { title: 'Transactions', sheetId: 0 } }, { properties: { title: 'Settings', sheetId: 1 } }] });
      if (u.includes(':batchGet') && decodeURIComponent(u).includes("'Settings'")) {
        w.ledgerReads = (w.ledgerReads || 0) + 1;
        const set = [['key', 'value'], ...Object.entries(settings).map(([k, v]) => [k, v])];
        return Response.json({ valueRanges: [{ values: [HEADER, ...w.rows] }, { values: set }] });
      }
      if (u.includes(':batchGet')) {
        return Response.json({ valueRanges: [{ values: [HEADER] }, { values: [['id'], ...w.rows.map(r => [r[0]])] }] });
      }
      if (u.includes('/values/') && !u.includes(':append')) {           // 讀最後一列（values.get）
        return Response.json({ values: [HEADER, ...w.rows].map(r => r.slice(0, 6)) });
      }
      if (u.includes('/values:batchUpdate')) {                            // 寫入指定列
        w.appendCalls++;
        if (appendDelay) await new Promise(r => setTimeout(r, appendDelay));
        for (const d of JSON.parse(init.body).data) {
          const row = Number(decodeURIComponent(d.range).match(/!A(\d+)$/)[1]);
          d.values.forEach((v, k) => { w.rows[row - 2 + k] = v; });
        }
        return Response.json({});
      }
    }
    if (u.startsWith('https://api.line.me/')) { w.replies.push(JSON.parse(init.body)); return Response.json({}); }
    if (u.startsWith('https://gas.test/')) {
      const p = JSON.parse(new URLSearchParams(String(init.body)).get('payload'));
      w.gasCalls.push(p.action);
      if (p.action === 'clearCache') return Response.json({ ok: true, data: {} });
      if (p.action === 'load') {
        const transactions = w.rows.map(r => Object.fromEntries(HEADER.map((h, i) => [h, r[i]])));
        return Response.json({ ok: true, data: { transactions, ...settings } });
      }
    }
    throw new Error('unexpected fetch ' + u);
  };
  w.lastText = () => {
    const m = w.replies.at(-1)?.messages?.[0];
    return m?.type === 'text' ? m.text : m;
  };
  return w;
}

/* 通用 Durable Object 模擬：Class 需有 fetch(request)；alarm 不會自動觸發 */
export function fakeNS(Klass) {
  const inst = new Map();
  return {
    inst,
    idFromName: (n) => n,
    get(id) {
      if (!inst.has(id)) {
        const store = new Map();
        const storage = {
          alarm: null,
          async get(k) { return store.get(k); },
          async put(k, v) { store.set(k, structuredClone(v)); },
          async setAlarm(t) { this.alarm = t; },
          async deleteAll() { store.clear(); },
          async delete(k) { store.delete(k); },
        };
        inst.set(id, { obj: new Klass({ storage }, {}), q: Promise.resolve(), storage, store });
      }
      const it = inst.get(id);
      return {
        fetch(url, init) {
          const run = it.q.then(() => it.obj.fetch(new Request(url, init)));
          it.q = run.catch(() => {});
          return run;
        },
      };
    },
  };
}

/**
 * 較完整的 Google Sheets 模擬：books = { [sheetId]: { [tabTitle]: rows[][] } }
 * 支援：建立、讀工作表清單、改名/格式（batchUpdate）、batchGet（整欄或指定範圍）、values:batchUpdate、append
 * 回傳 handler(url, init) → Response 或 null（不是 Sheets 的請求）
 */
export function fakeSheetsApi(books, log = []) {
  const API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const colNum = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (a1) => {
    const m = a1.match(/^'([^']+)'!([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/);
    return { tab: m[1], c1: m[2], r1: m[3], c2: m[4], r2: m[5] };
  };
  const get = (book, a1) => {
    const p = parse(a1);
    const rows = book[p.tab];
    if (!rows) throw new Error('no tab ' + p.tab);
    if (p.c1 === '' && p.r1 === '1') return rows.slice(0, 1);                   // 1:1
    if (p.c1 === 'A' && p.c2 === 'A') return rows.map(r => [r[0]]);             // A:A
    return rows.map(r => [...r]);                                                // A:Z / A:B / A:C
  };
  const put = (book, a1, values) => {
    const p = parse(a1);
    const rows = book[p.tab];
    const r0 = Number(p.r1 || 1) - 1, c0 = colNum(p.c1 || 'A');
    values.forEach((vals, k) => {
      rows[r0 + k] = [...(rows[r0 + k] || [])];          // 不改到呼叫端共用的陣列（例如 HEADER）
      vals.forEach((v, j) => { while (rows[r0 + k].length < c0 + j) rows[r0 + k].push(''); rows[r0 + k][c0 + j] = v; });
    });
  };
  return async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith(API)) return null;
    log.push(u.replace(API, '').split('?')[0] + (init.method === 'POST' ? ' POST' : ''));
    if (u === API && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const id = 'NEW';
      books[id] = Object.fromEntries(body.sheets.map(s => [s.properties.title, []]));
      books[id].__title = body.properties.title;
      return Response.json({ spreadsheetId: id, sheets: body.sheets.map((s, i) => ({ properties: { ...s.properties, sheetId: i } })) });
    }
    const m = u.slice(API.length + 1).match(/^([^/?:]+)(.*)$/);
    const book = books[m[1]], rest = decodeURIComponent(m[2]);
    const tabs = () => Object.keys(book).filter(k => k !== '__title');
    if (rest.startsWith('?fields=')) return Response.json({ sheets: tabs().map((title, i) => ({ properties: { title, sheetId: i, gridProperties: { rowCount: 1000 } } })) });
    if (rest.startsWith(':batchUpdate')) {
      for (const r of JSON.parse(init.body).requests) {
        const t = r.updateSheetProperties?.properties;
        if (t?.title) {
          const old = tabs()[t.sheetId];
          const entries = Object.entries(book).map(([k, v]) => [k === old ? t.title : k, v]);
          for (const k of Object.keys(book)) delete book[k];
          Object.assign(book, Object.fromEntries(entries));
        }
        if (r.deleteDimension) book[tabs()[r.deleteDimension.range.sheetId]].splice(r.deleteDimension.range.startIndex, 1);
        if (r.moveDimension) {
          const { source, destinationIndex } = r.moveDimension;
          const rows = book[tabs()[source.sheetId]];
          const moved = rows.splice(source.startIndex, source.endIndex - source.startIndex);
          rows.splice(destinationIndex - moved.length, 0, ...moved);
        }
      }
      return Response.json({});
    }
    if (rest.startsWith('/values:batchGet')) {
      const ranges = [...rest.matchAll(/ranges=([^&]+)/g)].map(x => x[1]);
      return Response.json({ valueRanges: ranges.map(a1 => ({ values: get(book, a1) })) });
    }
    if (rest.startsWith('/values/') && !rest.includes(':append') && (init.method || 'GET') === 'GET') {
      return Response.json({ values: get(book, rest.slice(8).split('?')[0]) });
    }
    if (rest.startsWith('/values:batchUpdate')) {
      for (const d of JSON.parse(init.body).data) put(book, decodeURIComponent(d.range), d.values);
      return Response.json({});
    }
    const ap = rest.match(/^\/values\/('[^']+')!A1:append/);
    if (ap) { book[ap[1].slice(1, -1)].push(...JSON.parse(init.body).values); return Response.json({}); }
    throw new Error('unexpected sheets ' + u);
  };
}
