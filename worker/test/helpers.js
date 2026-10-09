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
      if (u.includes(':batchGet') && decodeURIComponent(u).includes("'Settings'")) {
        w.ledgerReads = (w.ledgerReads || 0) + 1;
        const set = [['key', 'value'], ...Object.entries(settings).map(([k, v]) => [k, v])];
        return Response.json({ valueRanges: [{ values: [HEADER, ...w.rows] }, { values: set }] });
      }
      if (u.includes(':batchGet')) {
        return Response.json({ valueRanges: [{ values: [HEADER] }, { values: [['id'], ...w.rows.map(r => [r[0]])] }] });
      }
      if (u.includes(':append')) {
        w.appendCalls++;
        if (appendDelay) await new Promise(r => setTimeout(r, appendDelay));
        const body = JSON.parse(init.body);
        w.rows.push(...body.values);
        return Response.json({ updates: { updatedRows: 1 } });
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
