/**
 * 群組分帳：LINE 群組事件處理與卡片。
 * 規則：群組訊息只會動到分帳區，絕不寫入任何人的個人帳本。
 */
import { text } from './line.js';
import { decryptText } from './crypto.js';
import { catLabel } from './ledger.js';
import { splitCall } from './split-do.js';
import { balances, memberName, KEEP_DAYS, DELETE_DAYS } from './split-core.js';

const ORANGE = '#CF6F22', SOFT = '#FBE9D9', INK = '#1D252E', MUTED = '#5F6B78', GREEN = '#23905A';
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const md = (d) => String(d).slice(5).replace('-', '/');
const ymd = (d) => String(d).replace(/-/g, '/');

export const SPLIT_HELP = [
  '🧾 群組分帳指令',
  '・+項目 金額　例：+晚餐 3000',
  '・+項目 金額 @名字付　指定誰先付',
  '・+項目 金額 不含名字　排除某人',
  '・分帳　看目前總覽',
  '・記一筆　用網頁輸入，可選付款人與分攤的人',
  '・結算　算出誰該付誰多少',
  '・結束分帳　建立者結束並決定是否保留',
  '',
  '沒有 + 開頭的聊天訊息，我都不會記。',
  '群組裡的帳只會記到分帳區，不會進任何人的個人帳本。',
].join('\n');

/* ---------- Flex 小工具 ---------- */
const T = (t, o = {}) => ({ type: 'text', text: String(t), size: 'sm', color: INK, wrap: true, ...o });
const note = (t) => T(t, { size: 'xs', color: MUTED });
const sep = () => ({ type: 'separator', margin: 'md' });
const kv = (l, r, o = {}) => ({ type: 'box', layout: 'horizontal', contents: [T(l, { flex: 3, ...(o.l || {}) }), T(r, { flex: 2, align: 'end', ...(o.r || {}) })] });
const pb = (label, data, primary) => ({ type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm',
  ...(primary ? { color: ORANGE } : {}), action: { type: 'postback', label, data, displayText: label } });
const say = (label, msg, primary) => ({ type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm',
  ...(primary ? { color: ORANGE } : {}), action: { type: 'message', label, text: msg } });
const link = (label, uri, primary) => ({ type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm',
  ...(primary ? { color: ORANGE } : {}), action: { type: 'uri', label, uri } });
const head = (s) => ({ type: 'box', layout: 'horizontal', backgroundColor: SOFT, paddingAll: '12px', contents: [
  T(`分帳區・${s.name}`, { color: ORANGE, weight: 'bold', flex: 4 }),
  T('群組共用', { color: ORANGE, size: 'xs', align: 'end', gravity: 'center', flex: 2 }),
] });
const bubble = (alt, s, body, footer = []) => ({
  type: 'flex', altText: alt.slice(0, 380),
  contents: {
    type: 'bubble', size: 'mega',
    ...(s ? { header: head(s) } : {}),
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
    ...(footer.length ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}),
  },
});
const qrPost = (items) => ({ items: items.map(([label, data]) => ({ type: 'action', action: { type: 'postback', label, data, displayText: label } })) });
const qrSay = (items) => ({ items: items.map(l => ({ type: 'action', action: { type: 'message', label: l, text: l } })) });

/** 分帳網頁（LIFF）連結；未設定 LIFF 時回傳 null */
export function webUrl(env, sid, tab = 'items', extra = '') {
  if (!env.LIFF_ID) return null;
  return `https://liff.line.me/${env.LIFF_ID}?sid=${encodeURIComponent(sid)}&tab=${tab}${extra}`;
}
const webBtn = (env, label, sid, tab, extra, primary) => {
  const u = webUrl(env, sid, tab, extra);
  return u ? link(label, u, primary) : pb(label, 'a=noweb', primary);
};

/* ---------- 卡片 ---------- */
export function welcomeCard() {
  return bubble('記帳小幫手可以幫這個群組分帳', null, [
    T('嗨，我是記帳小幫手', { weight: 'bold', size: 'md' }),
    T('我可以幫這個群組分帳：記下誰付了錢、算出誰該付誰多少。結束後，每個人可以把自己負擔的部分轉入個人帳本。'),
    note('群組裡的訊息只會記到分帳區，不會進任何人的個人帳本。'),
  ], [pb('建立分帳區', 'a=sc', true)]);
}

export function createdCard(env, s) {
  const names = s.members.map(m => m.name + (m.temp ? '（臨時）' : '') + (m.id === s.creator ? '・建立者' : '')).join('、');
  return bubble(`分帳區「${s.name}」已建立`, s, [
    T('分帳區已建立', { weight: 'bold', size: 'md' }),
    T(`成員 ${s.members.length} 人：${names}`),
    note('記帳方式：傳「+項目 金額」，例如 +晚餐 3000。沒有 + 的聊天我不會記。'),
  ], [pb('加入分帳', `a=sj&s=${s.sid}`, true), pb('新增臨時成員', `a=st&s=${s.sid}`), webBtn(env, '開啟分帳網頁', s.sid, 'items')]);
}

export function entryCard(env, s, e) {
  const rows = e.parts.map(m => kv(memberName(s, m), money(e.shares[m])));
  return bubble(`${e.desc} ${money(e.amount)}，請確認`, s, [
    kv(e.desc, money(e.amount), { l: { weight: 'bold', size: 'md' }, r: { weight: 'bold', size: 'md' } }),
    note(`${catLabel('outflow', e.cat)}・${md(e.date)}・${memberName(s, e.by)} 記錄`),
    sep(),
    kv('先付款', memberName(s, e.payer), { l: { color: MUTED } }),
    T(`分攤（${e.parts.length} 人${e.mode === 'custom' ? '，自訂金額' : '，平均'}）`, { color: MUTED }),
    ...rows,
  ], [
    pb('確認記入', `a=eo&s=${s.sid}&e=${e.id}`, true),
    webBtn(env, '調整付款人或金額', s.sid, 'items', `&e=${e.id}`),
    pb('取消', `a=ec&s=${s.sid}&e=${e.id}`),
  ]);
}

export function summaryCard(env, s) {
  const ok = s.entries.filter(e => e.status === 'ok');
  const b = balances(s), total = ok.reduce((a, e) => a + e.amount, 0);
  const rows = s.members.map(m => {
    const n = b[m.id].paid - b[m.id].share;
    return kv(m.name, n > 0 ? `應收 ${money(n)}` : n < 0 ? `應付 ${money(-n)}` : '打平', { r: { color: n > 0 ? GREEN : n < 0 ? '#C03D3D' : MUTED } });
  });
  return bubble(`分帳總覽 ${money(total)}`, s, [
    kv('目前總覽', money(total), { l: { weight: 'bold', size: 'md' }, r: { weight: 'bold', size: 'md' } }),
    note(`已確認 ${ok.length} 筆・成員 ${s.members.length} 人${s.status === 'settling' ? '・結算中' : ''}`),
    sep(), ...rows,
  ], [say('結算', '結算', true), webBtn(env, '看明細', s.sid, 'items')]);
}

function methodText(s, mid) {
  const m = s.methods[mid];
  if (!m) return '尚未設定收款方式';
  if (m.type === 'bank') return m.wiped ? '銀行轉帳（帳號已刪除）' : `銀行轉帳 ${m.bank}-****${m.last4}`;
  if (m.type === 'linepay') return `LINE Pay：請轉給 ${memberName(s, mid)}`;
  return `現金：請當面交給 ${memberName(s, mid)}`;
}

/** accts：{ mid: '822-1234567890' } 已解密，用於「複製帳號」 */
export function settleCard(env, s, accts = {}) {
  const T0 = s.transfers || [];
  if (!T0.length) return bubble('大家剛好打平', s, [T('大家剛好打平', { weight: 'bold', size: 'md' }), T('不需要任何轉帳。')]);
  const closed = s.status === 'closed';
  const tos = [...new Set(T0.map(t => t.to))];
  const body = [
    T(`結算：${T0.length} 筆轉帳就能結清`, { weight: 'bold', size: 'md' }),
    note('付款人按「我已付款」，收款人按「已收到」才算結清。'),
  ];
  for (const c of tos) {
    body.push(sep(), T(`收款人：${memberName(s, c)}`, { weight: 'bold' }), T(methodText(s, c), { color: MUTED, size: 'xs' }));
    if (accts[c] && !closed) body.push({ type: 'button', style: 'link', height: 'sm', color: ORANGE, action: { type: 'clipboard', label: '複製帳號', clipboardText: accts[c] } });
    for (const t of T0.filter(x => x.to === c)) {
      const st = t.recv ? '已收到' : t.paid ? '已付款，待確認' : '未付';
      body.push(kv(`${memberName(s, t.from)} → ${memberName(s, t.to)}`, money(t.amount), { r: { weight: 'bold' } }));
      body.push(T(st, { size: 'xs', color: t.recv ? GREEN : t.paid ? '#B97B0C' : MUTED }));
      if (!t.recv && !closed) {
        const f = `&s=${s.sid}&f=${t.from}&t=${t.to}`;
        body.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          ...(t.paid ? [] : [{ ...pb('我已付款', 'a=tp' + f), flex: 1 }]),
          { ...pb('已收到', 'a=tr' + f), flex: 1 },
        ] });
      }
    }
  }
  if (T0.every(t => t.recv)) body.push(sep(), T('全部結清 🎉', { color: GREEN, weight: 'bold', align: 'center' }));
  const footer = closed ? [] : [pb('設定我的收款方式', `a=mp&s=${s.sid}`, true), webBtn(env, '開啟分帳網頁', s.sid, 'settle')];
  return bubble(`結算：${T0.length} 筆轉帳`, s, body, footer);
}

export function closeCard(s) {
  const T0 = s.transfers, left = T0 ? T0.filter(t => !t.recv).length : null;
  const warn = T0 == null ? '還沒有結算。結束前建議先傳「結算」。' : left ? `還有 ${left} 筆轉帳未確認收到。` : '所有轉帳都已結清。';
  return bubble('要結束分帳嗎？', s, [
    T('要結束分帳嗎？', { weight: 'bold', size: 'md' }),
    T(warn, { color: T0 == null || left ? '#B97B0C' : GREEN }),
    note('結束後不能再記帳。銀行帳號會立即刪除；項目與金額可以選擇保留。'),
  ], [
    pb(`結束，保留紀錄 ${KEEP_DAYS} 天`, `a=cl&s=${s.sid}&m=keep`, true),
    pb(`結束，${DELETE_DAYS} 天後刪除`, `a=cl&s=${s.sid}&m=del`),
    pb('先不要', `a=cn&s=${s.sid}`),
  ]);
}

export function closedCard(env, s) {
  const total = s.entries.filter(e => e.status === 'ok').reduce((a, e) => a + e.amount, 0);
  const keep = s.retain?.mode === 'keep';
  return bubble(`分帳區「${s.name}」已結束`, s, [
    kv('分帳區已結束', money(total), { l: { weight: 'bold', size: 'md' }, r: { weight: 'bold', size: 'md' } }),
    note(keep ? `紀錄保留至 ${ymd(s.retain.until)}` : `紀錄將在 ${ymd(s.retain?.until || '')} 刪除`),
    T('每個人可以把「自己負擔的部分」轉入個人帳本。只有你本人能轉入你的帳本。'),
  ], [webBtn(env, '轉入我的帳本', s.sid, 'transfer', '', true), pb('開新的分帳區', 'a=sc')]);
}

export function tutorialCard(env) {
  return bubble('怎麼開始分帳', null, [
    T('怎麼開始分帳', { weight: 'bold', size: 'md' }),
    T('1. 建立 LINE 群組，邀請一起分帳的朋友\n2. 在群組裡邀請這個官方帳號（就是我）\n3. 我加入後會出現「建立分帳區」按鈕'),
    note('群組裡的帳只會記到分帳區，不會混進你的個人帳本。結束後，你可以勾選自己負擔的部分轉入帳本。'),
  ]);
}

/* ---------- 事件處理 ---------- */
const CMD = /^(開分帳|建立分帳區|分帳區|分帳|分帳總覽|結算|結束分帳|分帳說明|說明)$/;
const gidOf = (src) => src.groupId || src.roomId;
const curKey = (gid) => `grp:${gid}`;
const waitKey = (gid) => `grpw:${gid}`;

async function profileName(c, uid) {
  const src = c.src;
  const path = src.type === 'room' ? `room/${src.roomId}` : `group/${src.groupId}`;
  try {
    const r = await c.fetchImpl(`https://api.line.me/v2/bot/${path}/member/${uid}`, { headers: { Authorization: `Bearer ${c.token}` } });
    if (r.ok) { const j = await r.json(); if (j.displayName) return String(j.displayName).slice(0, 20); }
  } catch (err) { console.error('profile failed', err); }
  return '成員' + String(uid).slice(-4);
}

async function current(c) {
  const sid = await c.env.KV.get(curKey(c.gid));
  if (!sid) return null;
  const { state } = await splitCall(c.env, sid, 'get', '');
  return state && state.status !== 'closed' ? state : null;
}

async function accountsOf(env, s) {
  const out = {};
  for (const [mid, m] of Object.entries(s.methods || {})) {
    if (m.type === 'bank' && m.acctEnc) {
      try { out[mid] = `${m.bank}-${await decryptText(env, m.acctEnc)}`; } catch (err) { console.error('decrypt failed', err); }
    }
  }
  return out;
}

/**
 * deps: { env, token, fetchImpl, today, send }
 */
/** 群組快捷列：附在每則回覆的最後一則訊息上（訊息自己有快捷列時不覆蓋） */
export function groupQuickReply(env, s) {
  const items = [];
  const add = (action) => items.push({ type: 'action', action });
  if (s) {
    const u = webUrl(env, s.sid, 'add');
    if (u) add({ type: 'uri', label: '記一筆', uri: u });
    add({ type: 'message', label: '分帳總覽', text: '分帳' });
    add({ type: 'message', label: '結算', text: '結算' });
    add({ type: 'postback', label: '加入分帳', data: `a=sj&s=${s.sid}`, displayText: '加入分帳' });
    add({ type: 'message', label: '結束分帳', text: '結束分帳' });
  } else {
    add({ type: 'postback', label: '建立分帳區', data: 'a=sc', displayText: '建立分帳區' });
  }
  add({ type: 'message', label: '說明', text: '分帳說明' });
  return { items };
}

export function withQuickReply(msgs, qr) {
  const arr = (Array.isArray(msgs) ? msgs : [msgs]).filter(Boolean);
  if (!arr.length) return arr;
  const last = arr[arr.length - 1];
  if (!last.quickReply) arr[arr.length - 1] = { ...last, quickReply: qr };
  return arr;
}

export async function handleGroupEvent(ev, deps) {
  const src = ev.source || {};
  const gid = gidOf(src);
  if (!gid) return;
  const c = { ...deps, src, gid, uid: src.userId };
  const { env } = c;
  const send = async (msgs) => {
    let s = null;
    try { s = await current(c); } catch (err) { console.error('quick reply state failed', err); }
    return deps.send(withQuickReply(msgs, groupQuickReply(env, s)));
  };
  c.send = send;

  if (ev.type === 'join') return send(welcomeCard());
  if (!c.uid) return;

  if (ev.type === 'message' && ev.message?.type === 'text') {
    const t = ev.message.text.trim();
    const plus = /^[+＋]/.test(t);
    const aw = await env.KV.get(waitKey(gid), 'json');
    if (aw && aw.uid === c.uid && !plus && !CMD.test(t)) {
      await env.KV.delete(waitKey(gid));
      if (aw.type === 'name') return createSplit(c, t);
      if (aw.type === 'temp') return addTemp(c, aw.sid, t);
    }
    if (plus) return addEntry(c, t);
    if (!CMD.test(t)) return;                                   // 一般聊天：不回應
    if (/^(分帳說明|說明)$/.test(t)) return send(text(SPLIT_HELP));
    const s = await current(c);
    if (/^(開分帳|建立分帳區|分帳區)$/.test(t)) return send(s ? createdCard(env, s) : welcomeCard());
    if (!s) return send(text('目前沒有進行中的分帳區。', qrPost([['建立分帳區', 'a=sc']])));
    if (t === '分帳' || t === '分帳總覽') return send(summaryCard(env, s));
    if (t === '結算') {
      const r = await splitCall(env, s.sid, 'settle', c.uid);
      if (!r.res.ok) return send(text(r.res.error));
      const msgs = [settleCard(env, r.state, await accountsOf(env, r.state))];
      if (r.res.pending) msgs.unshift(text(`還有 ${r.res.pending} 筆尚未確認，這次結算先不算進去。`));
      return send(msgs);
    }
    if (t === '結束分帳') {
      if (c.uid !== s.creator) return send(text(`只有建立者 ${memberName(s, s.creator)} 可以結束分帳。`));
      return send(closeCard(s));
    }
    return;
  }

  if (ev.type !== 'postback') return;
  const p = new URLSearchParams(ev.postback?.data || '');
  const a = p.get('a'), sid = p.get('s') || '';
  if (sid && !/^[a-f0-9]{12}$/.test(sid)) return;
  const call = (op, args) => splitCall(env, sid, op, c.uid, { today: c.today, ...args });
  const recalcNote = (r) => (r.res.recalc ? '\n帳目有變動，已重新結算，付款狀態已重設。傳「結算」看最新結果。' : '');

  switch (a) {
    case 'noweb': return send(text('分帳網頁尚未啟用，請先使用群組指令。'));
    case 'sc': {
      const s = await current(c);
      if (s) return send(text(`這個群組已經有進行中的分帳區「${s.name}」。一個群組同時只能有一個分帳區。`));
      await env.KV.put(waitKey(gid), JSON.stringify({ uid: c.uid, type: 'name' }), { expirationTtl: 600 });
      const name = await profileName(c, c.uid);
      return send(text(`${name}，請輸入分帳區名稱：`, qrSay(['週末出遊', '同事聚餐', '室友公費'])));
    }
    case 'sj': {
      const name = await profileName(c, c.uid);
      const r = await call('join', { name });
      if (!r.res.ok) return send(text(r.res.error));
      return send(text(r.res.already ? `${name} 已經在分帳區裡了。` : `✅ ${name} 加入了分帳（共 ${r.res.count} 人）`));
    }
    case 'st': {
      await env.KV.put(waitKey(gid), JSON.stringify({ uid: c.uid, type: 'temp', sid }), { expirationTtl: 600 });
      return send(text('請輸入臨時成員的名字（不在群組裡、或沒用 LINE 的朋友）：'));
    }
    case 'eo': case 'ec': case 'ed': {
      const op = { eo: 'confirm', ec: 'cancel', ed: 'delete' }[a];
      const r = await call(op, { eid: p.get('e') });
      if (!r.res.ok) return send(text(r.res.error));
      const e = r.state.entries.find(x => x.id === p.get('e'));
      if (op === 'cancel') return send(text(`已取消「${e.desc}」，不會記入。`));
      if (op === 'delete') return send(text(`🗑️ 已刪除「${e.desc}」${money(e.amount)}${recalcNote(r)}`));
      return send(text(`✅ 已記入分帳區：${e.desc} ${money(e.amount)}\n${memberName(r.state, e.payer)} 先付・${e.parts.length} 人分攤${recalcNote(r)}`,
        qrPost([['刪除這筆', `a=ed&s=${sid}&e=${e.id}`]])));
    }
    case 'mp': {
      const u = webUrl(env, sid, 'settle', '&m=bank');
      const items = [
        ...(u ? [{ type: 'action', action: { type: 'uri', label: '銀行轉帳', uri: u } }] : []),
        { type: 'action', action: { type: 'postback', label: 'LINE Pay', data: `a=mm&s=${sid}&t=linepay`, displayText: '用 LINE Pay 收款' } },
        { type: 'action', action: { type: 'postback', label: '現金', data: `a=mm&s=${sid}&t=cash`, displayText: '用現金收款' } },
      ];
      return send(text('你想用哪種方式收款？銀行帳號會在網頁填寫，群組只顯示末 4 碼。', { items }));
    }
    case 'mm': {
      const type = p.get('t') === 'cash' ? 'cash' : 'linepay';
      const r = await call('setMethod', { mid: c.uid, type });
      if (!r.res.ok) return send(text(r.res.error));
      return send(text(`✅ ${memberName(r.state, c.uid)} 改用${type === 'cash' ? '現金' : ' LINE Pay '}收款。傳「結算」可看最新的付款資訊。`));
    }
    case 'tp': case 'tr': {
      const r = await call(a === 'tp' ? 'paid' : 'recv', { from: p.get('f'), to: p.get('t') });
      if (!r.res.ok) return send(text(r.res.error));
      const t = r.res.t, s = r.state;
      if (a === 'tp') return send(text(`💸 ${memberName(s, t.from)} 已付款給 ${memberName(s, t.to)} ${money(t.amount)}，等待 ${memberName(s, t.to)} 按「已收到」。`));
      const msgs = [text(`✅ ${memberName(s, t.to)} 確認收到 ${memberName(s, t.from)} 的 ${money(t.amount)}${r.res.left ? `（還剩 ${r.res.left} 筆）` : ''}`)];
      if (!r.res.left) msgs.push(text(`🎉「${s.name}」全部結清了！建立者 ${memberName(s, s.creator)} 可以傳「結束分帳」。`));
      return send(msgs);
    }
    case 'cl': {
      const r = await call('close', { mode: p.get('m') === 'keep' ? 'keep' : 'del' });
      if (!r.res.ok) return send(text(r.res.error));
      if ((await env.KV.get(curKey(gid))) === sid) await env.KV.delete(curKey(gid));
      return send(closedCard(env, r.state));
    }
    case 'cn': return send(text('好的，分帳區繼續進行。'));
    default: return;
  }
}

async function createSplit(c, name) {
  const { env, send } = c;
  if (await current(c)) return send(text('這個群組已經有進行中的分帳區了。'));
  const sid = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  const creatorName = await profileName(c, c.uid);
  const r = await splitCall(env, sid, 'init', c.uid, { sid, gid: c.gid, name, creatorName, today: c.today });
  if (!r.res.ok) return send(text('建立失敗，請再試一次。'));
  await env.KV.put(curKey(c.gid), sid);
  return send(createdCard(env, r.state));
}

async function addTemp(c, sid, name) {
  const r = await splitCall(c.env, sid, 'addTemp', c.uid, { name });
  if (!r.res.ok) return c.send(text(r.res.error));
  return c.send(text(`✅ 已新增臨時成員「${r.res.name}」（共 ${r.state.members.length} 人）\n臨時成員的收款與付款，由建立者代為操作。`));
}

async function addEntry(c, t) {
  const { env, send } = c;
  const s = await current(c);
  if (!s) return send(text('目前沒有進行中的分帳區。', qrPost([['建立分帳區', 'a=sc']])));
  const r = await splitCall(env, s.sid, 'add', c.uid, { text: t, today: c.today });
  if (!r.res.ok) {
    if (r.res.error === 'notMember') return send(text('請先加入分帳，再用「+」記帳。', qrPost([['加入分帳', `a=sj&s=${s.sid}`]])));
    return send(text(r.res.error));
  }
  const e = r.state.entries.find(x => x.id === r.res.eid);
  return send(entryCard(env, r.state, e));
}
