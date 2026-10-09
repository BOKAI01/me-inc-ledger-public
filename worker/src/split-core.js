/**
 * 群組分帳：純邏輯（不碰網路與儲存），由 Split Durable Object 呼叫。
 * apply(state, op, actor, args) → { state, res }
 *   res.ok = false 時 res.error 是給使用者看的中文訊息
 */
import { guessCategory } from './parse.js';

export const MAX_ENTRIES = 300;
export const MAX_MEMBERS = 50;
export const KEEP_DAYS = 90;
export const DELETE_DAYS = 7;

const fail = (state, error) => ({ state, res: { ok: false, error } });
const okr = (state, extra = {}) => ({ state, res: { ok: true, ...extra } });

export const memberName = (s, id) => (s.members.find(m => m.id === id) || {}).name || '成員';
export const isMember = (s, id) => s.members.some(m => m.id === id);
const isTemp = (s, id) => !!(s.members.find(m => m.id === id) || {}).temp;
/** 本人，或臨時成員由建立者代為操作 */
export const canActFor = (s, actor, owner) => actor === owner || (isTemp(s, owner) && actor === s.creator);

export function newSplit({ sid, gid, name, creator, creatorName, today }) {
  return {
    v: 1, sid, gid, name: String(name).trim().slice(0, 20) || '分帳', creator, status: 'open', createdAt: today,
    members: [{ id: creator, name: creatorName || '成員' }],
    entries: [], transfers: null, methods: {}, retain: null, transferred: {}, seq: 1,
  };
}

/** 平均分攤：除不盡的零頭由付款人優先吸收 */
export function equalShares(amount, parts, payer) {
  const n = parts.length, base = Math.floor(amount / n), r = amount - base * n, out = {};
  parts.forEach(p => { out[p] = base; });
  const order = parts.includes(payer) ? [payer, ...parts.filter(p => p !== payer)] : parts;
  for (let i = 0; i < r; i++) out[order[i % n]] += 1;
  return out;
}

export function balances(s) {
  const b = {};
  s.members.forEach(m => { b[m.id] = { paid: 0, share: 0 }; });
  for (const e of s.entries) {
    if (e.status !== 'ok') continue;
    (b[e.payer] = b[e.payer] || { paid: 0, share: 0 }).paid += e.amount;
    for (const [m, v] of Object.entries(e.shares)) (b[m] = b[m] || { paid: 0, share: 0 }).share += v;
  }
  return b;
}

/** 最少轉帳：每次讓最大欠款人付給最大應收人 */
export function minTransfers(b) {
  const cr = [], db = [], out = [];
  for (const [m, x] of Object.entries(b)) {
    const n = x.paid - x.share;
    if (n > 0) cr.push({ m, n }); else if (n < 0) db.push({ m, n: -n });
  }
  const order = (a, c) => c.n - a.n || (a.m < c.m ? -1 : 1);
  while (cr.length && db.length) {
    cr.sort(order); db.sort(order);
    const c = cr[0], d = db[0], v = Math.min(c.n, d.n);
    out.push({ from: d.m, to: c.m, amount: v, paid: false, recv: false });
    c.n -= v; d.n -= v;
    if (!c.n) cr.shift();
    if (!d.n) db.shift();
  }
  return out;
}

const toHalf = (t) => String(t).replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');

function findMember(s, name) {
  const n = String(name).trim().replace(/^@/, '');
  if (!n) return null;
  const exact = s.members.find(m => m.name === n);
  if (exact) return exact.id;
  const loose = s.members.filter(m => m.name.startsWith(n) || n.startsWith(m.name));
  return loose.length === 1 ? loose[0].id : null;
}

/** 「+晚餐 3000」「+住宿 6000 @小明付」「+門票 1200 不含小華、阿美」 */
export function parsePlus(s, actor, raw) {
  const body = toHalf(raw).replace(/^\+\s*/, '').trim();
  const m = body.match(/^(.*\S)\s+([0-9][0-9,]*)\s*元?((?:\s|@|不含|不包含).*)?$/)
    || body.match(/^(.*?[^0-9\s])([0-9][0-9,]*)\s*元?(.*)$/);
  if (!m) return { error: '格式是「+項目 金額」，例如 +晚餐 3000' };
  const desc = m[1].trim().slice(0, 30), amount = Number(m[2].replace(/,/g, '')), rest = m[3] || '';
  if (!Number.isInteger(amount) || amount <= 0) return { error: '金額需是大於 0 的整數' };
  if (amount > 10000000) return { error: '金額太大了，請確認一下' };
  let payer = actor;
  const pm = rest.match(/@\s*([^\s@]+?)\s*(先)?付/);
  if (pm) {
    const id = findMember(s, pm[1]);
    if (!id) return { error: `找不到成員「${pm[1]}」。目前成員：${s.members.map(x => x.name).join('、')}` };
    payer = id;
  }
  let parts = s.members.map(x => x.id);
  const ex = rest.match(/不(?:包)?含\s*([^@]+)/);
  if (ex) {
    for (const n of ex[1].split(/[、,，\s]+/).filter(Boolean)) {
      const id = findMember(s, n);
      if (!id) return { error: `找不到成員「${n}」。目前成員：${s.members.map(x => x.name).join('、')}` };
      parts = parts.filter(p => p !== id);
    }
  }
  if (!parts.length) return { error: '至少要有一位分攤的人' };
  return { desc, amount, payer, parts, cat: guessCategory(desc, 'outflow') };
}

function recalc(s) {
  if (s.status !== 'settling') return false;
  s.transfers = minTransfers(balances(s));
  return true;
}

const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export function apply(state, op, actor, args = {}) {
  const s = state ? structuredClone(state) : null;
  if (op === 'init') {
    if (s) return fail(s, '分帳區已存在');
    return okr(newSplit({ ...args, creator: actor }));
  }
  if (!s) return fail(s, '找不到這個分帳區，可能已經刪除了');
  const closed = s.status === 'closed';
  const entry = (eid) => s.entries.find(e => e.id === eid);

  switch (op) {
    case 'get':
      return okr(s);

    case 'join': {
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (isMember(s, actor)) return okr(s, { already: true });
      if (s.members.length >= MAX_MEMBERS) return fail(s, `成員最多 ${MAX_MEMBERS} 人`);
      s.members.push({ id: actor, name: String(args.name || '成員').slice(0, 20) });
      return okr(s, { count: s.members.length });
    }

    case 'rename': {                                     // 改顯示名稱：本人，或建立者幫臨時成員改
      const mid = args.mid || actor;
      const m = s.members.find(x => x.id === mid);
      if (!m) return fail(s, '請先加入分帳');
      if (!canActFor(s, actor, mid)) return fail(s, '只能修改自己的名字');
      const name = String(args.name || '').trim().slice(0, 20);
      if (!name) return fail(s, '請輸入名字，例如：改名 小明');
      if (s.members.some(x => x.id !== mid && x.name === name)) return fail(s, `已經有叫「${name}」的成員了`);
      if (args.auto && !/^成員/.test(m.name)) return okr(s);   // 自動更新只覆蓋預設名稱
      m.name = name;
      return okr(s, { name });
    }

    case 'addTemp': {
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (!isMember(s, actor)) return fail(s, '請先加入分帳，再新增臨時成員');
      const name = String(args.name || '').trim().slice(0, 10);
      if (!name) return fail(s, '請輸入名字');
      if (s.members.some(m => m.name === name)) return fail(s, `已經有叫「${name}」的成員了`);
      if (s.members.length >= MAX_MEMBERS) return fail(s, `成員最多 ${MAX_MEMBERS} 人`);
      const id = 't' + (s.seq++);
      s.members.push({ id, name, temp: true, by: actor });
      return okr(s, { id, name });
    }

    case 'add': {
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (!isMember(s, actor)) return fail(s, 'notMember');
      if (s.entries.length >= MAX_ENTRIES) return fail(s, `一個分帳區最多 ${MAX_ENTRIES} 筆`);
      const p = parsePlus(s, actor, args.text);
      if (p.error) return fail(s, p.error);
      const e = {
        id: 'e' + (s.seq++), ...p, shares: equalShares(p.amount, p.parts, p.payer), mode: 'equal',
        by: actor, status: 'pending', date: args.today,
      };
      s.entries.push(e);
      return okr(s, { eid: e.id });
    }

    case 'addItem': {                                    // 網頁「記一筆」：送出即記入
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (!isMember(s, actor)) return fail(s, '請先加入分帳');
      if (s.entries.length >= MAX_ENTRIES) return fail(s, `一個分帳區最多 ${MAX_ENTRIES} 筆`);
      const desc = String(args.desc || '').trim().slice(0, 30);
      const amount = Number(args.amount);
      if (!desc) return fail(s, '請輸入項目名稱');
      if (!Number.isInteger(amount) || amount <= 0) return fail(s, '金額需是大於 0 的整數');
      if (amount > 10000000) return fail(s, '金額太大了，請確認一下');
      const payer = args.payer || actor;
      if (!isMember(s, payer)) return fail(s, '付款人不在分帳區裡');
      const parts = s.members.map(m => m.id).filter(m => (args.parts || []).includes(m));
      if (!parts.length) return fail(s, '至少要有一位分攤的人');
      let shares = equalShares(amount, parts, payer), mode = 'equal';
      if (args.shares) {
        let sum = 0;
        const c = {};
        for (const m of parts) {
          const n = Number(args.shares[m]);
          if (!Number.isInteger(n) || n < 0) return fail(s, '每人金額需是 0 以上的整數');
          c[m] = n; sum += n;
        }
        if (sum !== amount) return fail(s, `每人金額加總 $${sum.toLocaleString('en-US')}，要等於 $${amount.toLocaleString('en-US')}`);
        if (parts.some(m => c[m] !== shares[m])) { shares = c; mode = 'custom'; }
      }
      const e = {
        id: 'e' + (s.seq++), desc, amount, payer, parts: parts.filter(m => shares[m] > 0), shares, mode,
        cat: guessCategory(desc, 'outflow'), by: actor, status: 'ok', date: args.today,
      };
      for (const m of Object.keys(e.shares)) if (!e.shares[m]) delete e.shares[m];
      s.entries.push(e);
      return okr(s, { eid: e.id, recalc: recalc(s) });
    }

    case 'confirm':
    case 'cancel': {
      const e = entry(args.eid);
      if (!e) return fail(s, '找不到這筆');
      if (e.status !== 'pending') return fail(s, e.status === 'ok' ? '這筆已經記入了' : '這筆已經處理過了');
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (actor !== e.by) return fail(s, `這筆由 ${memberName(s, e.by)} 記錄，請由 ${memberName(s, e.by)} 確認或取消`);
      e.status = op === 'confirm' ? 'ok' : 'cancel';
      return okr(s, { eid: e.id, recalc: op === 'confirm' && recalc(s) });
    }

    case 'delete': {
      const e = entry(args.eid);
      if (!e || e.status === 'deleted' || e.status === 'cancel') return fail(s, '這筆已經刪除或取消了');
      if (closed) return fail(s, '分帳區已結束，不能再修改');
      if (actor !== e.by && actor !== s.creator) return fail(s, `只有記錄者 ${memberName(s, e.by)} 或建立者 ${memberName(s, s.creator)} 可以刪除`);
      const was = e.status;
      e.status = 'deleted';
      return okr(s, { eid: e.id, recalc: was === 'ok' && recalc(s) });
    }

    case 'edit': {
      const e = entry(args.eid);
      if (!e || !['ok', 'pending'].includes(e.status)) return fail(s, '找不到這筆');
      if (closed) return fail(s, '分帳區已結束，不能再修改');
      if (actor !== e.by && actor !== s.creator) return fail(s, `只有記錄者 ${memberName(s, e.by)} 或建立者 ${memberName(s, s.creator)} 可以修改`);
      if (!isMember(s, args.payer)) return fail(s, '付款人不在分帳區裡');
      const shares = {};
      let sum = 0;
      for (const [m, v] of Object.entries(args.shares || {})) {
        const n = Number(v);
        if (!isMember(s, m)) return fail(s, '分攤的人不在分帳區裡');
        if (!Number.isInteger(n) || n < 0) return fail(s, '每人金額需是 0 以上的整數');
        if (n > 0) { shares[m] = n; sum += n; }
      }
      if (!Object.keys(shares).length) return fail(s, '至少要有一位分攤的人');
      if (sum !== e.amount) return fail(s, `每人金額加總 $${sum.toLocaleString('en-US')}，要等於 $${e.amount.toLocaleString('en-US')}`);
      e.payer = args.payer;
      e.parts = s.members.map(m => m.id).filter(m => shares[m]);
      e.shares = shares;
      const eq = equalShares(e.amount, e.parts, e.payer);
      e.mode = e.parts.every(m => eq[m] === shares[m]) ? 'equal' : 'custom';
      return okr(s, { eid: e.id, recalc: e.status === 'ok' && recalc(s) });
    }

    case 'settle': {
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (!s.entries.some(e => e.status === 'ok')) return fail(s, '還沒有已確認的項目，記幾筆再結算吧');
      s.status = 'settling';
      s.transfers = minTransfers(balances(s));
      return okr(s, { pending: s.entries.filter(e => e.status === 'pending').length });
    }

    case 'setMethod': {
      const mid = args.mid;
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (!isMember(s, mid)) return fail(s, '找不到這位成員');
      if (!canActFor(s, actor, mid)) return fail(s, `收款方式要由 ${memberName(s, mid)} 本人設定${isTemp(s, mid) ? `（臨時成員由建立者 ${memberName(s, s.creator)} 代填）` : ''}`);
      if (!['bank', 'linepay', 'cash'].includes(args.type)) return fail(s, '不支援的收款方式');
      if (args.type === 'bank') {
        if (!/^\d{3}$/.test(args.bank || '')) return fail(s, '銀行代碼是 3 位數字，例如 822');
        if (!args.acctEnc || !args.last4) return fail(s, '請輸入帳號');
        s.methods[mid] = { type: 'bank', bank: args.bank, acctEnc: args.acctEnc, last4: args.last4 };
      } else s.methods[mid] = { type: args.type };
      return okr(s);
    }

    case 'resetMethod': {
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (!canActFor(s, actor, args.mid)) return fail(s, `只有 ${memberName(s, args.mid)} 本人可以變更收款方式`);
      delete s.methods[args.mid];
      return okr(s);
    }

    case 'paid':
    case 'recv': {
      const t = (s.transfers || []).find(x => x.from === args.from && x.to === args.to);
      if (!t) return fail(s, '這筆轉帳已經不存在，可能帳目有變動。請傳「結算」看最新結果');
      if (op === 'paid') {
        if (!canActFor(s, actor, t.from)) return fail(s, `「我已付款」要由 ${memberName(s, t.from)} 本人按`);
        if (t.paid) return fail(s, '已經標記為已付款了');
        t.paid = true;
      } else {
        if (!canActFor(s, actor, t.to)) return fail(s, `「已收到」要由收款人 ${memberName(s, t.to)} 按`);
        if (t.recv) return fail(s, '已經確認收到了');
        t.paid = true; t.recv = true;
      }
      return okr(s, { t, left: s.transfers.filter(x => !x.recv).length });
    }

    case 'close': {
      if (closed) return fail(s, '這個分帳區已經結束了');
      if (actor !== s.creator) return fail(s, `只有建立者 ${memberName(s, s.creator)} 可以結束分帳`);
      const keep = args.mode === 'keep';
      s.status = 'closed';
      s.closedAt = args.today;
      s.retain = { mode: keep ? 'keep' : 'del', until: addDays(args.today, keep ? KEEP_DAYS : DELETE_DAYS) };
      for (const m of Object.values(s.methods)) if (m.type === 'bank') { delete m.acctEnc; m.wiped = true; }
      return okr(s, { until: s.retain.until });
    }

    case 'transferred': {
      if (!closed) return fail(s, '分帳結束後才能轉入');
      const done = new Set(s.transferred[actor] || []);
      for (const id of args.eids || []) done.add(id);
      s.transferred[actor] = [...done];
      return okr(s);
    }

    case 'wipeMember': {
      for (const [mid, m] of Object.entries(s.methods)) if (mid === actor && m.type === 'bank') { delete m.acctEnc; m.wiped = true; }
      return okr(s);
    }

    default:
      return fail(s, '不支援的操作');
  }
}

/** 轉入個人帳本：此人在已確認項目中負擔的部分 */
export function myShares(s, uid) {
  return s.entries.filter(e => e.status === 'ok' && (e.shares[uid] || 0) > 0)
    .map(e => ({ id: e.id, desc: e.desc, cat: e.cat, date: e.date, amount: e.amount, share: e.shares[uid] }));
}
