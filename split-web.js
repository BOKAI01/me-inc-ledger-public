/**
 * 分帳網頁（LIFF）：
 *   GET  /split      → 網頁（在 LINE 內開啟，以 LINE 身分登入）
 *   POST /split/api  → { idToken, sid, action, ... } → { ok, data } / { ok:false, error }
 * 身分以 LINE ID Token 驗證（LINE Login 頻道），不需要另外登入。
 */
import PAGE from './split-page.js';
import { splitCall } from './split-do.js';
import { myShares, balances } from './split-core.js';
import { encryptText, decryptText } from './crypto.js';
import { tokenFor, bindKey, obKey, needsRelink } from './oauth.js';
import { readHeaderAndIds, appendTxns, readLedger, writeCells, appendRow } from './google.js';

/** 公開版的個人帳本綁定在哪個頻道（目前 webhook 為 /line/webhook，即 ''） */
const chOf = (env) => env.SPLIT_CHANNEL || '';
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export function splitPage(env) {
  const cfg = JSON.stringify({ liffId: env.LIFF_ID || '', basicId: env.LINE_BASIC_ID || '' }).replace(/</g, '\\u003c');
  return new Response(PAGE.replace('/*__CFG__*/null', cfg), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* ---------- 身分驗證（LINE ID Token） ---------- */
const idCache = new Map();
export async function verifyIdToken(env, idToken, fetchImpl = fetch) {
  if (!idToken || !env.LINE_LOGIN_CHANNEL_ID) return null;
  const hit = idCache.get(idToken);
  if (hit && hit.exp > Date.now()) return hit.who;
  const r = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_LOGIN_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.sub) return null;
  const who = { uid: j.sub, name: String(j.name || '成員').slice(0, 20) };
  if (idCache.size > 500) idCache.clear();
  idCache.set(idToken, { who, exp: Math.min(Number(j.exp) * 1000 || 0, Date.now() + 10 * 60000) });
  return who;
}

async function bound(env, uid) {
  const b = await env.KV.get(bindKey(chOf(env), uid), 'json');
  if (!b || !b.sheetId) return null;
  if (await env.KV.get(obKey(chOf(env), uid))) return null;
  return b;
}

function siteUrl(env, base, b) {
  if (!b?.apiKey || !env.SITE_URL) return '';
  return `${env.SITE_URL}?openExternalBrowser=1#api=${encodeURIComponent(`${base}/api?key=${b.apiKey}`)}`;
}

/** 給網頁的資料：只有成員看得到完整帳號；結束後帳號已刪除 */
async function view(env, s, uid, base) {
  const member = s.members.some(m => m.id === uid);
  const methods = {};
  for (const [mid, m] of Object.entries(s.methods || {})) {
    const out = { type: m.type };
    if (m.type === 'bank') {
      Object.assign(out, { bank: m.bank, last4: m.last4, wiped: !!m.wiped });
      if (member && m.acctEnc) { try { out.acct = await decryptText(env, m.acctEnc); } catch { /* 略過 */ } }
    }
    methods[mid] = out;
  }
  const b = await bound(env, uid);
  return {
    sid: s.sid, name: s.name, status: s.status, creator: s.creator, retain: s.retain,
    me: uid, member,
    members: s.members.map(({ id, name, temp }) => ({ id, name, temp: !!temp })),
    entries: s.entries.filter(e => e.status === 'ok' || e.status === 'pending'),
    balances: balances(s), transfers: s.transfers, methods,
    transferred: s.transferred[uid] || [], mine: myShares(s, uid),
    bound: !!b, site: siteUrl(env, base, b),
  };
}

async function readPayout(env, b, fetchImpl) {
  const token = await tokenFor(env, b, fetchImpl);
  const d = await readLedger(token, b.sheetId, fetchImpl);
  const v = String(d.settings.payoutAccount || '');
  const m = v.match(/^(\d{3})-(\d{6,16})$/);
  return m ? { bank: m[1], acct: m[2] } : null;
}

async function savePayout(env, b, bank, acct, fetchImpl) {
  const token = await tokenFor(env, b, fetchImpl);
  const d = await readLedger(token, b.sheetId, fetchImpl);
  const v = `${bank}-${acct}`;
  if (d.settingRows.payoutAccount) await writeCells(token, b.sheetId, [{ a1: `'Settings'!B${d.settingRows.payoutAccount}`, value: v }], fetchImpl);
  else await appendRow(token, b.sheetId, 'Settings', ['payoutAccount', v], fetchImpl);
}

export async function handleSplitApi(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const base = deps.base || new URL(request.url).origin;
  if (request.method !== 'POST') return json({ ok: false, error: '請用 POST' }, 405);
  let p;
  try { p = await request.json(); } catch { return json({ ok: false, error: '請求格式錯誤' }, 400); }
  const who = await verifyIdToken(env, p.idToken, fetchImpl);
  if (!who) return json({ ok: false, error: 'auth', message: 'LINE 登入已過期，請重新開啟' }, 401);
  const sid = String(p.sid || '');
  if (!/^[a-f0-9]{12}$/.test(sid)) return json({ ok: false, error: '連結不完整，請從 LINE 群組的卡片重新開啟' });
  const uid = who.uid;
  const call = (op, args = {}) => splitCall(env, sid, op, uid, { today: deps.today, ...args });
  const done = async (r) => (r.res.ok ? json({ ok: true, data: await view(env, r.state, uid, base) }) : json({ ok: false, error: r.res.error }));

  try {
    switch (p.action) {
      case 'load': {
        const r = await call('get');
        if (!r.state) return json({ ok: false, error: '找不到這個分帳區，可能已經刪除了' });
        return json({ ok: true, data: await view(env, r.state, uid, base) });
      }
      case 'join': return done(await call('join', { name: who.name }));
      case 'addTemp': return done(await call('addTemp', { name: p.name }));
      case 'confirm': return done(await call('confirm', { eid: p.eid }));
      case 'delete': return done(await call('delete', { eid: p.eid }));
      case 'edit': return done(await call('edit', { eid: p.eid, payer: p.payer, shares: p.shares }));
      case 'paid': return done(await call('paid', { from: p.from, to: p.to }));
      case 'recv': return done(await call('recv', { from: p.from, to: p.to }));
      case 'setMethod': {
        if (p.type === 'bank') {
          const bank = String(p.bank || '').trim(), acct = String(p.acct || '').replace(/[\s-]/g, '');
          if (!/^\d{3}$/.test(bank)) return json({ ok: false, error: '銀行代碼是 3 位數字，例如 822' });
          if (!/^\d{8,16}$/.test(acct)) return json({ ok: false, error: '帳號請輸入 8 到 16 位數字' });
          const r = await call('setMethod', { mid: p.mid, type: 'bank', bank, acctEnc: await encryptText(env, acct), last4: acct.slice(-4) });
          if (r.res.ok && p.remember && p.mid === uid) {
            const b = await bound(env, uid);
            if (b) { try { await savePayout(env, b, bank, acct, fetchImpl); } catch (err) { console.error('save payout failed', err); } }
          }
          return done(r);
        }
        return done(await call('setMethod', { mid: p.mid, type: p.type }));
      }
      case 'resetMethod': return done(await call('resetMethod', { mid: p.mid }));
      case 'saved': {
        const b = await bound(env, uid);
        if (!b) return json({ ok: true, data: null });
        const v = await readPayout(env, b, fetchImpl).catch(() => null);
        return json({ ok: true, data: v ? { bank: v.bank, last4: v.acct.slice(-4) } : null });
      }
      case 'useSaved': {
        const b = await bound(env, uid);
        const v = b ? await readPayout(env, b, fetchImpl).catch(() => null) : null;
        if (!v) return json({ ok: false, error: '找不到上次的收款帳號' });
        return done(await call('setMethod', { mid: uid, type: 'bank', bank: v.bank, acctEnc: await encryptText(env, v.acct), last4: v.acct.slice(-4) }));
      }
      case 'transfer': {
        const g = await call('get');
        const s = g.state;
        if (!s) return json({ ok: false, error: '找不到這個分帳區' });
        if (s.status !== 'closed') return json({ ok: false, error: '分帳結束後才能轉入' });
        const b = await bound(env, uid);
        if (!b) return json({ ok: false, error: '你還沒開通個人帳本' });
        const want = new Set((p.eids || []).map(String));
        const already = new Set(s.transferred[uid] || []);
        const pick = myShares(s, uid).filter(x => want.has(x.id) && !already.has(x.id));
        if (!pick.length) return json({ ok: false, error: '請至少勾選一筆尚未轉入的項目' });
        const token = await tokenFor(env, b, fetchImpl);
        const { header, ids } = await readHeaderAndIds(token, b.sheetId, fetchImpl);
        const have = new Set(ids), createdAt = new Date().toISOString();
        const txns = pick.map(x => ({
          id: `sp${s.sid}${x.id}`, type: 'outflow', category: x.cat, date: x.date, amount: x.share,
          client: x.desc, description: `分帳：${s.name}`, paymentTerm: 0, received: true, createdAt, account: '',
        })).filter(t => !have.has(t.id));
        await appendTxns(token, b.sheetId, header, txns, fetchImpl);
        const r = await call('transferred', { eids: pick.map(x => x.id) });
        if (!r.res.ok) return json({ ok: false, error: r.res.error });
        const out = await view(env, r.state, uid, base);
        out.wrote = { count: pick.length, total: pick.reduce((a, x) => a + x.share, 0) };
        return json({ ok: true, data: out });
      }
      default:
        return json({ ok: false, error: '不支援的操作' });
    }
  } catch (err) {
    console.error('split api failed', p.action, err);
    if (needsRelink(err, { auth: 'oauth' })) return json({ ok: false, error: '你的 Google 授權已過期。請私訊記帳小幫手「重新連結」後再試一次' });
    return json({ ok: false, error: '系統忙碌，請稍後再試' });
  }
}

