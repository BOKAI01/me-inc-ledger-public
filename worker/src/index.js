/**
 * Me, Inc. LINE 記帳機器人（Cloudflare Worker）
 *   GET  /health        → ok
 *   POST /line/webhook  → LINE Messaging API webhook
 */
import { verifySignature, reply, text, confirmCard, batchCard, categoryQuickReply, allocQuickReply } from './line.js';
import { parseEntry, parseDateOnly, guessCategory, allocEntry } from './parse.js';
import { readHeaderAndIds, readLedger, appendTxns, setSetting, GoogleAuthError, SheetAccessError } from './google.js';
import { tokenFor, AuthRevokedError, needsRelink, bindKey, tokKey, obKey, authLink, handleAuthStart, handleAuthCallback, handleFinish, handleRelink, privacyPage, page } from './oauth.js';
import { computePockets, computeSummary, taipeiToday, catLabel, fmt } from './ledger.js';
import { Entry, entryCall, withSheetLock } from './entry.js';
import { handleApi } from './api.js';
import { Split } from './split-do.js';
import { handleGroupEvent, tutorialCard, withQuickReply } from './split-line.js';
import { splitPage, handleSplitApi } from './split-web.js';
import { guidePage, guideCard } from './guide.js';
import { logoutAll } from './session.js';
import { findPocket, MAX_POCKETS } from './pockets.js';
import { addPocket, renamePocket, setPocketTarget, previewDelete, deletePocket, PocketError } from './pocket-ops.js';

export { Entry, Split };

const HELP = [
  '📒 記帳方式：項目 + 金額',
  '・午餐 120',
  '・昨天 計程車 250',
  '・10/3 電影 300',
  '・+薪水 50000（開頭 + 代表收入）',
  '',
  '📋 多筆一起記：一行一筆',
  '10/6 早餐 30',
  '10/6 午餐 150',
  '（第一行只寫日期，後面各行都用那天）',
  '',
  '💱 撥款（口袋間配置，不算收支）：',
  '・撥款 緊急 5000（日常 → 緊急備用金）',
  '・撥款 儲蓄 3000（日常 → 儲蓄口袋）',
  '・撥回 儲蓄 2000（儲蓄 → 日常）',
  '',
  '👝 自訂口袋（最多 8 個）：',
  '・口袋：查看所有口袋',
  '・新增口袋 旅遊基金',
  '・口袋改名 儲蓄 買房基金',
  '・刪除口袋 旅遊基金',
  '・旅遊基金目標 30000',
  '',
  '其他指令：',
  '・餘額：帳戶總額與各個口袋',
  '・摘要：本期收支',
  '・網站：開啟你的帳本網站',
  '・我的帳本：開啟 Google 試算表',
  '・登出所有裝置：讓所有裝置上的帳本網站重新登入',
  '・隱私：查看隱私重點',
  '・開分帳：和朋友在 LINE 群組分帳',
].join('\n');

const PRIVACY_SHORT = [
  '🔒 隱私重點',
  '・帳本存在「你自己的」Google 雲端硬碟，擁有者是你',
  '・機器人只能存取它建立的那一份帳本，看不到你的其他檔案',
  '・隨時可到 Google 帳戶移除授權，或在這裡輸入「刪除我的資料」',
].join('\n');
const RELINK_MSG = '❌ 你的 Google 授權已取消或過期。輸入「重新連結」重新授權後即可繼續使用，帳本資料不會遺失';
const DM_QUICK = { items: [['餘額', '餘額'], ['本期摘要', '摘要'], ['開啟網站', '網站'], ['和朋友分帳', '開分帳'], ['說明', '說明']]
  .map(([label, t]) => ({ type: 'action', action: { type: 'message', label, text: t } })) };
const SITE_DEFAULT = 'https://bokai01.github.io/me-inc-ledger/';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    if (url.pathname === '/line/webhook' && request.method === 'POST') return webhook(request, env, ctx, '');
    if (url.pathname === '/line/webhook/pub' && request.method === 'POST') return webhook(request, env, ctx, 'pub');
    if (url.pathname === '/api' || url.pathname === '/api/session' || url.pathname === '/api/logout') return handleApi(request, env, ctx);
    if (url.pathname === '/split') return splitPage(env);
    if (url.pathname === '/split/api') return handleSplitApi(request, env, { base: url.origin });
    if (url.pathname === '/auth/start') return handleAuthStart(request, env);
    if (url.pathname === '/auth/callback') return handleAuthCallback(request, env);
    const bg = ctx?.waitUntil ? { waitUntil: (p) => ctx.waitUntil(p) } : {};
    if (url.pathname === '/auth/finish') return handleFinish(request, env, bg);
    if (url.pathname === '/auth/relink') return handleRelink(request, env, bg);
    if (url.pathname === '/privacy') return privacyPage(env);
    if (url.pathname === '/guide') return guidePage(env);
    if (url.pathname === '/keygen') return keygenPage();
    if (url.pathname === '/') return page('Me, Inc. 記帳機器人', '<p>用 LINE 傳一句話就能記帳，資料存在你自己的 Google 雲端硬碟。</p><p><a href="/privacy">隱私權說明</a></p>');
    return new Response('Not found', { status: 404 });
  },
};

/** 頻道設定：'' = 原本的頻道；'pub' = 公開頻道 */
export function channel(env, ch) {
  return ch === 'pub'
    ? { ch, secret: env.LINE_PUB_CHANNEL_SECRET, token: env.LINE_PUB_CHANNEL_ACCESS_TOKEN }
    : { ch: '', secret: env.LINE_CHANNEL_SECRET, token: env.LINE_CHANNEL_ACCESS_TOKEN };
}

async function webhook(request, env, ctx, ch) {
  const body = await request.text();
  const C = channel(env, ch);
  const ok = await verifySignature(C.secret, body, request.headers.get('x-line-signature'));
  if (!ok) return new Response('Bad signature', { status: 401 });
  let payload;
  try { payload = JSON.parse(body); } catch { return new Response('Bad JSON', { status: 400 }); }
  const events = Array.isArray(payload.events) ? payload.events : [];
  const base = new URL(request.url).origin;
  ctx.waitUntil(Promise.all(events.map(ev => handleEvent(ev, env, { ch, base }).catch(err => console.error('event failed', err)))));
  return new Response('ok');
}

export async function handleEvent(ev, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const today = deps.today || taipeiToday();
  const uid = ev.source?.userId;
  const C = channel(env, deps.ch || '');
  let send = (msgs) => (ev.replyToken ? reply(C.token, ev.replyToken, msgs, fetchImpl) : null);

  // 群組／多人聊天室：只處理分帳，絕不寫入個人帳本
  if (ev.source?.type === 'group' || ev.source?.type === 'room') {
    return handleGroupEvent(ev, { env, token: C.token, fetchImpl, today, send, base: deps.base || env.PUBLIC_BASE_URL || '' });
  }
  if (!uid) return;
  const ctxo = { env, ch: C.ch, uid, base: deps.base || env.PUBLIC_BASE_URL || '', fetchImpl, send };

  const bind = await env.KV.get(bindKey(C.ch, uid), 'json');
  const msgText = ev.type === 'message' && ev.message?.type === 'text' ? ev.message.text.trim() : null;

  // 共用指令：隱私、刪除資料
  if (msgText && /^(隱私|隱私說明|隱私權)$/.test(msgText)) return send(text(PRIVACY_SHORT + `\n\n完整說明：${ctxo.base}/privacy`));
  if (msgText === '刪除我的資料') return send(text('確定要刪除嗎？\n會清除伺服器上的 Google 授權、帳本綁定與分類記憶。\n你雲端硬碟裡的帳本檔案不會被刪除。', {
    items: [
      { type: 'action', action: { type: 'postback', label: '確定刪除', data: 'a=wipe', displayText: '確定刪除' } },
      { type: 'action', action: { type: 'postback', label: '取消', data: 'a=nowipe', displayText: '取消' } },
    ] }));
  if (ev.type === 'postback' && ev.postback?.data === 'a=wipe') return send(text(await wipeUser(ctxo, bind)));
  if (ev.type === 'postback' && ev.postback?.data === 'a=nowipe') return send(text('好的，沒有刪除任何資料。'));
  if (msgText && /^(開分帳|分帳|群組分帳)$/.test(msgText)) return send(tutorialCard());

  // 尚未開通，或開通流程進行中
  const ob = bind ? await env.KV.get(obKey(C.ch, uid), 'json') : null;
  if (!bind || !bind.sheetId || ob) return onboarding(ev, ctxo, bind, ob, msgText);

  // 已開通：每則回覆附上快捷列
  const rawSend = send;
  send = (msgs) => rawSend(withQuickReply(msgs, DM_QUICK));

  if (ev.type === 'follow') return send([text('歡迎回來！你的帳本還在，可以直接記帳 🙌'), guideCard(ctxo.base)]);
  if (msgText && /^(網站|開啟網站|圖表)$/.test(msgText)) return send(siteMessage(ctxo, bind));
  if (msgText === '完成連結') return send(text(`✅ 帳本已連結，可以直接開始記帳。\n\n${await balanceText(env, bind, fetchImpl)}`));
  if (msgText && /^(登出所有裝置|登出網站)$/.test(msgText)) {
    await logoutAll(env, C.ch, uid);
    return send(text('✅ 已登出所有裝置上的帳本網站。\n下次打開網站時，需要重新用 LINE 登入。'));
  }
  if (msgText && /^(我的帳本|試算表)$/.test(msgText)) return send(text(`📄 你的帳本：\nhttps://docs.google.com/spreadsheets/d/${bind.sheetId}/edit`));
  if (msgText && /^(重新連結|重新授權)$/.test(msgText) && bind.auth === 'oauth') return send(await authCard(ctxo, true));
  const ledgerName = bind.ledgerName || '主帳本';

  if (ev.type === 'message' && ev.message?.type === 'text') {
    const msg = ev.message.text.trim();
    if (/^(餘額|余額|結餘)$/.test(msg)) return send(text(await balanceText(env, bind, fetchImpl)));
    if (/^(摘要|本期|本月)$/.test(msg)) return send(text(await summaryText(env, bind, today, fetchImpl)));
    /* ---------- 口袋管理 ---------- */
    if (/^(口袋|我的口袋|口袋列表|口袋設定|管理口袋)$/.test(msg)) {
      return send(text(`${await balanceText(env, bind, fetchImpl)}\n\n👝 管理口袋（最多 ${MAX_POCKETS} 個）：\n・新增口袋 名稱\n・口袋改名 舊名 新名\n・刪除口袋 名稱\n・名稱目標 金額`, POCKET_QR));
    }
    const pkOp = async (fn, ok) => {
      try {
        const r = await pocketOp(env, bind, fetchImpl, fn);
        return send(text(`${ok(r)}\n\n${await balanceText(env, bind, fetchImpl)}`));
      } catch (err) {
        if (err instanceof PocketError) return send(text(`⚠️ ${err.message}`));
        console.error('pocket op failed', err);
        return send(text(needsRelink(err, bind) ? RELINK_MSG + '。' : `❌ 設定失敗：${err.message}`));
      }
    };
    let pm;
    if ((pm = msg.match(/^(?:新增口袋|建立口袋|增加口袋)\s*(.*)$/))) {
      if (!pm[1].trim()) return send(text('請在後面加上口袋名稱，例如：新增口袋 旅遊基金'));
      return pkOp((tk) => addPocket(tk, bind.sheetId, pm[1].trim(), {}, fetchImpl), (r) => `✅ 已新增口袋「${r.pocket.icon} ${r.pocket.name}」\n撥款試試看：撥款 ${r.pocket.name} 1000`);
    }
    if ((pm = msg.match(/^(?:口袋改名|改名口袋|口袋更名)\s*(\S*)\s*(?:改成|改為|→|->|=)?\s*(\S*)$/))) {
      if (!pm[1] || !pm[2]) return send(text('請寫「口袋改名 舊名 新名」，例如：口袋改名 儲蓄 買房基金'));
      return pkOp((tk) => renamePocket(tk, bind.sheetId, pm[1], pm[2], fetchImpl), (r) => `✅ 已把「${r.from}」改名為「${r.pocket.name}」\n帳本裡的舊紀錄也已一起更新。`);
    }
    if ((pm = msg.match(/^(?:刪除口袋|移除口袋)\s*(.*)$/))) {
      if (!pm[1].trim()) return send(text('請寫要刪除的口袋，例如：刪除口袋 旅遊基金'));
      try {
        const token = await tokenFor(env, bind, fetchImpl);
        const r = await previewDelete(token, bind.sheetId, pm[1].trim(), fetchImpl);
        return send(deletePocketCard(r.pocket, r.balance));
      } catch (err) {
        if (err instanceof PocketError) return send(text(`⚠️ ${err.message}`));
        console.error('pocket preview failed', err);
        return send(text(needsRelink(err, bind) ? RELINK_MSG + '。' : `❌ 讀取帳本失敗：${err.message}`));
      }
    }
    const tg = msg.replace(/[,，\s]/g, '').match(/^(.{1,14}?)目標(\d{0,10})$/);
    if (tg) {
      const act = (await getPockets(env, bind, fetchImpl)).filter(x => x.active !== false);
      const pk = findPocket(act, tg[1]);
      if (!pk) return send(text(`找不到「${tg[1]}」這個口袋。目前的口袋：${act.map(x => x.name).join('、') || '（沒有）'}`));
      if (!tg[2]) return send(text(`請在後面加上金額，例如：${tg[1]}目標 100000\n（設 0 可取消目標）`));
      const v = Number(tg[2]);
      return pkOp((tk) => setPocketTarget(tk, bind.sheetId, pk.id, v, fetchImpl), (r) => (v > 0 ? `✅ ${r.pocket.name}的目標已設為 $${fmt(v)}` : `✅ 已取消${r.pocket.name}的目標`));
    }
    if (/^(說明|使用說明|教學|幫助|help|\?|？)$/i.test(msg)) return send([guideCard(ctxo.base), text(HELP)]);
    if (/^調整/.test(msg)) return send(text('「調整」類型要等網站改版後才開放，目前請在網站上操作。'));

    const { entries, bad } = parseMessage(msg, today);
    if (!entries.length) {
      return send(text(bad.length > 1
        ? `看不懂這幾行：\n${bad.map(b => '・' + b).join('\n')}\n每行請用「項目 金額」，例如：午餐 120`
        : `看不懂這筆，請用「項目 金額」，例如：午餐 120\n輸入「說明」看更多用法。`));
    }
    if (entries.length > MAX_BATCH) return send(text(`一次最多 ${MAX_BATCH} 筆，請分開傳送。`));

    // 撥款：依使用者自訂的口袋比對名稱
    let pockets;
    const notes = [];
    const allocs = entries.filter(e => e.type === 'alloc');
    if (allocs.length) {
      pockets = (await getPockets(env, bind, fetchImpl)).filter(x => x.active !== false);
      if (!pockets.length) return send(text('你目前沒有任何口袋。先傳「新增口袋 旅遊基金」建立一個，再撥款。'));
      for (const e of allocs) {
        const found = e.pocketText ? findPocket(pockets, e.pocketText) : null;
        const pk = found || pockets.find(x => x.id === 'emergency') || pockets[0];
        if (e.pocketText && !found) notes.push(`找不到「${e.pocketText}」這個口袋，先幫你選「${pk.name}」，可以按「改方向」換成其他口袋。`);
        Object.assign(e, allocEntry(e.category === 'alloc_out' ? 'out' : 'in', pk.id, pockets));
      }
    }
    for (const e of entries) delete e.pocketText;

    const now = Date.now();
    const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const items = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const mem = entry.type === 'alloc' ? null : await env.KV.get(`cat:${uid}:${entry.client}`, 'json');
      if (mem && mem.type && mem.category) { entry.type = mem.type; entry.category = mem.category; }
      items.push({ entry, txnId: `${now + i}${pid.slice(0, 4)}`, hadMemory: !!mem });
    }
    await entryCall(env, pid, 'create', { uid, sheetId: bind.sheetId, ledger: ledgerRef(bind), ledgerName, items, ...(pockets ? { pockets } : {}) });
    const card = cardFor(pid, items, ledgerName, pockets);
    const extra = [...notes.map(n => text(n)), ...(bad.length ? [text(`以下 ${bad.length} 行看不懂，沒有放進卡片：\n${bad.map(b => '・' + b).join('\n')}`)] : [])];
    return send(extra.length ? [card, ...extra].slice(0, 5) : card);
  }

  if (ev.type === 'postback') {
    const p = new URLSearchParams(ev.postback?.data || '');
    const a = p.get('a'), pid = p.get('p');
    const i = Number(p.get('i')) || 0;
    if (a === 'pkno') return send(text('好的，沒有刪除口袋。'));
    if (a === 'pkdel') {                                   // 刪除口袋：使用者在確認卡片按下「同意刪除」
      const k = p.get('k') || '', n = (p.get('n') || '').replace(/[^0-9a-z]/gi, '').slice(0, 16);
      const cur = (await getPockets(env, bind, fetchImpl)).find(x => x.id === k);
      if (!cur || cur.active === false) return send(text('這個口袋已經刪除了。'));
      try {
        const r = await pocketOp(env, bind, fetchImpl, (tk) => deletePocket(tk, bind.sheetId, k, { today, txnId: `pkdel${n}` }, fetchImpl));
        const b = Math.round(r.balance);
        const how = b > 0 ? `餘額 $${fmt(b)} 已自動撥回日常。` : b < 0 ? `已從日常補足 $${fmt(-b)}，讓口袋歸零。` : '口袋餘額為 0。';
        return send(text(`🗑️ 已刪除口袋「${r.pocket.name}」\n${how}\n舊紀錄仍保留在帳本中。\n\n${await balanceText(env, bind, fetchImpl)}`));
      } catch (err) {
        if (err instanceof PocketError) return send(text(`⚠️ ${err.message}`));
        console.error('pocket delete failed', err);
        return send(text(needsRelink(err, bind) ? RELINK_MSG + '。' : `❌ 刪除失敗：${err.message}`));
      }
    }
    if (!pid || !/^[0-9a-f]{16}$/.test(pid)) return;
    if (a !== 'ok') {                                // 取消、改分類也只限卡片本人（確認寫入另有檢查）
      const own = await entryCall(env, pid, 'get');
      if (own.ok && own.rec?.uid && own.rec.uid !== uid) return send(text('這張卡片不是你的。'));
    }

    if (a === 'ok') {
      const r = await confirmWrite(env, pid, uid, fetchImpl);
      await send(text(r.msg));
      if (r.wrote && !r.oauth) await clearLegacyCache(env, fetchImpl);   // 先回覆，再清網站快取（Apps Script 可能較慢）
      return;
    }

    if (a === 'no') {
      const r = await entryCall(env, pid, 'cancel');
      return send(text(r.ok ? '已取消，不會寫入。' : stateMsg(r.reason)));
    }

    if (a === 'pick') {
      const r = await entryCall(env, pid, 'get');
      if (!r.ok || r.rec.state !== 'pending') return send(text(stateMsg(r.ok ? r.rec.state : 'missing')));
      const it = r.rec.items[i];
      if (!it) return;
      const who = r.rec.items.length > 1 ? `第 ${i + 1} 筆「${it.entry.client}」` : '';
      if (it.entry.type === 'alloc') {
        const pk = (r.rec.pockets || await getPockets(env, bind, fetchImpl)).filter(x => x.active !== false);
        return send(text(`${who}請選擇撥款方向：`, allocQuickReply(pid, i, pk, p.get('o') || undefined)));
      }
      return send(text(`${who}請選擇分類：`, categoryQuickReply(pid, it.entry.type, i)));
    }

    if (a === 'cat' || a === 'type' || a === 'alloc') {
      const g = await entryCall(env, pid, 'get');
      if (!g.ok || g.rec.state !== 'pending') return send(text(stateMsg(g.ok ? g.rec.state : 'missing')));
      const cur = g.rec.items[i]?.entry;
      if (!cur) return;
      const origClient = cur.origClient || cur.client;
      let patch, pockets4card;
      if (a === 'cat') {
        patch = { category: p.get('c') };
      } else if (a === 'alloc') {
        const d = p.get('d') === 'out' ? 'out' : 'in';
        const pk = (g.rec.pockets || await getPockets(env, bind, fetchImpl)).filter(x => x.active !== false);
        if (!pk.length) return send(text('你目前沒有任何口袋。先傳「新增口袋 旅遊基金」建立一個。'));
        const k = (pk.find(x => x.id === p.get('k')) || pk.find(x => x.id === 'emergency') || pk[0]).id;
        patch = { ...allocEntry(d, k, pk), origClient: cur.type === 'alloc' ? cur.origClient : cur.client };
        if (!g.rec.pockets) pockets4card = pk;
      } else {
        const t = p.get('t') === 'inflow' ? 'inflow' : 'outflow';
        patch = { type: t, client: origClient, account: '', category: guessCategory(origClient, t) };
      }
      const r = await entryCall(env, pid, 'update', { i, patch });
      if (!r.ok) return send(text(stateMsg(r.reason)));
      return send(cardFor(pid, r.rec.items, r.rec.ledgerName, r.rec.pockets || pockets4card));
    }
  }
}

const MAX_BATCH = 20;

/** 一則訊息可多行，每行一筆；只有日期的行會成為後續各行的預設日期 */
export function parseMessage(msg, today) {
  const lines = msg.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [], bad = [];
  let def = null;
  for (const line of lines) {
    const d = lines.length > 1 ? parseDateOnly(line, today) : null;
    if (d) { def = d; continue; }
    const e = parseEntry(line, today, def);
    if (e) entries.push(e); else bad.push(line);
  }
  return { entries, bad };
}

const cardFor = (pid, items, ledgerName, pockets) => (items.length > 1
  ? batchCard(pid, items.map(it => it.entry), ledgerName, pockets)
  : confirmCard(pid, items[0].entry, ledgerName, pockets));

function stateMsg(reason) {
  switch (reason) {
    case 'done': return '這張卡片已經寫入過了 ✅';
    case 'writing': return '正在寫入，請稍候…';
    case 'cancelled': return '這張卡片已取消。';
    default: return '這張卡片已失效，請重新輸入一次。';
  }
}

async function confirmWrite(env, pid, uid, fetchImpl) {
  const r = await entryCall(env, pid, 'acquire');
  if (!r.ok) return { msg: stateMsg(r.reason) };
  const rec = r.rec;
  if (rec.uid !== uid) { await entryCall(env, pid, 'release'); return { msg: '這張卡片不是你的。' }; }
  const items = rec.items;

  try {
    const token = await tokenFor(env, rec.ledger || { sheetId: rec.sheetId }, fetchImpl);
    await withSheetLock(env, rec.sheetId, async () => {
    const { header, ids, pockets } = await readHeaderAndIds(token, rec.sheetId, fetchImpl);
    const have = new Set(ids);
    const createdAt = new Date().toISOString();
    const txns = items.filter(it => !have.has(it.txnId)).map(({ entry: e, txnId }) => ({
      id: txnId, type: e.type, category: e.category, date: e.date, amount: e.amount,
      client: e.client, description: '', paymentTerm: 0, received: true,
      createdAt, account: e.account || '',
    }));
    await appendTxns(token, rec.sheetId, header, txns, fetchImpl, pockets);
    });
  } catch (err) {
    await entryCall(env, pid, 'release');
    console.error('write failed', err);
    return { msg: needsRelink(err, rec.ledger) ? RELINK_MSG + '，再按一次「確認寫入」。' : writeErrMsg(err) };
  }
  await entryCall(env, pid, 'finish');

  // 記住使用者改過的分類（撥款不記）
  for (const { entry: e, hadMemory } of items) {
    if (e.type === 'alloc') continue;
    try {
      const key = `cat:${uid}:${e.client}`;
      const guessType = parseEntry(`${e.client} 1`, '2000-01-01')?.type || 'outflow';
      const changed = e.type !== guessType || e.category !== guessCategory(e.client, e.type);
      if (changed) await env.KV.put(key, JSON.stringify({ type: e.type, category: e.category }));
      else if (hadMemory) await env.KV.delete(key);
    } catch (err) { console.error('memory failed', err); }
  }

  const line = (e) => {
    const sign = e.type === 'inflow' ? '+' : e.type === 'alloc' ? '' : '-';
    const label = e.type === 'alloc' ? '撥款' : e.client;
    return { label, sign, cat: catLabel(e.type, e.category, e.account, rec.pockets) };
  };
  let body;
  if (items.length === 1) {
    const e = items[0].entry, l = line(e);
    body = `✅ 已寫入【${rec.ledgerName}】\n${l.label} ${l.sign}$${fmt(e.amount)}\n${l.cat}・${e.date}`;
  } else {
    body = `✅ 已寫入【${rec.ledgerName}】${items.length} 筆\n` + items.map(({ entry: e }) => {
      const l = line(e);
      return `${e.date.slice(5).replace('-', '/')} ${l.label} ${l.sign}$${fmt(e.amount)}`;
    }).join('\n');
  }
  return { msg: body, wrote: true, oauth: rec.ledger?.auth === 'oauth' };
}

function writeErrMsg(err) {
  if (err instanceof AuthRevokedError) return '❌ 你的 Google 授權已取消或過期。輸入「重新連結」重新授權後，再按一次「確認寫入」。';
  if (err instanceof SheetAccessError) return '❌ 無法存取試算表：請確認已共用給服務帳戶，且權限為編輯者。可再按一次「確認寫入」重試。';
  if (err instanceof GoogleAuthError) return `❌ Google 授權失敗：${err.message}。請檢查 GOOGLE_SA_JSON。`;
  return '❌ 寫入失敗，請稍後再按一次「確認寫入」。';
}

/* ---------- 舊後端（Apps Script） ---------- */
async function gasCall(env, action, fetchImpl, ms = 20000) {
  if (!env.LEGACY_GAS_URL) throw new Error('尚未設定 LEGACY_GAS_URL');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(env.LEGACY_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payload: JSON.stringify({ action }) }),
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '未知錯誤');
    return j.data;
  } finally { clearTimeout(timer); }
}

async function clearLegacyCache(env, fetchImpl) {
  try { await gasCall(env, 'clearCache', fetchImpl, 25000); return true; }
  catch (err) { console.error('clearCache failed', err); return false; }
}

async function loadLedger(env, bind, fetchImpl) {
  const token = await tokenFor(env, bind, fetchImpl);
  const d = await readLedger(token, bind.sheetId, fetchImpl);
  await rememberPockets(env, bind.sheetId, d.pockets).catch(() => {});
  return d;
}

/* ---------- 口袋：清單快取在 KV（撥款時不用每次讀帳本），來源以帳本「口袋」工作表為準 ---------- */
const pkKey = (sheetId) => `pk:${sheetId}`;
const lite = (pockets) => pockets.map(({ id, name, icon, active, target }) => ({ id, name, icon, active, target }));
async function rememberPockets(env, sheetId, pockets) {
  const v = JSON.stringify(lite(pockets || []));
  if ((await env.KV.get(pkKey(sheetId))) !== v) await env.KV.put(pkKey(sheetId), v, { expirationTtl: 30 * 86400 });
}
async function getPockets(env, bind, fetchImpl) {
  const c = await env.KV.get(pkKey(bind.sheetId), 'json');
  if (Array.isArray(c)) return c;
  return lite((await loadLedger(env, bind, fetchImpl)).pockets);
}
async function pocketOp(env, bind, fetchImpl, fn) {
  const token = await tokenFor(env, bind, fetchImpl);
  return withSheetLock(env, bind.sheetId, async () => {
    const r = await fn(token);
    if (r?.pockets) await rememberPockets(env, bind.sheetId, r.pockets);
    return r;
  });
}
const POCKET_QR = { items: [['新增口袋', '新增口袋'], ['餘額', '餘額'], ['說明', '說明']]
  .map(([label, t]) => ({ type: 'action', action: { type: 'message', label, text: t } })) };

function deletePocketCard(pk, balance) {
  const b = Math.round(balance), n = Math.random().toString(36).slice(2, 10);
  const how = b > 0 ? `按「同意刪除」後，會自動記一筆「${pk.name}撥回日常 $${fmt(b)}」，再把這個口袋歸零並刪除。`
    : b < 0 ? `這個口袋超支 $${fmt(-b)}。按「同意刪除」後，會自動從日常補足 $${fmt(-b)}，讓口袋歸零並刪除。`
    : '這個口袋目前沒有餘額，可以直接刪除。';
  return bubble(`刪除口袋「${pk.name}」？`, '#A0421C', [
    { type: 'text', text: `${pk.icon} ${pk.name}　目前餘額 $${fmt(b)}`, size: 'md', weight: 'bold', color: '#222222', wrap: true },
    how,
    note('舊紀錄會保留在帳本中，之後也可以再建立同名的口袋。'),
  ], [pbBtn('同意刪除', `a=pkdel&k=${encodeURIComponent(pk.id)}&n=${n}`, true), pbBtn('取消', 'a=pkno')]);
}

async function balanceText(env, bind, fetchImpl) {
  try {
    const d = await loadLedger(env, bind, fetchImpl);
    const p = computePockets(d.transactions, d.openingBalance, d.pockets);
    const goal = (cur, target) => (target - cur > 0 ? `　還差 $${fmt(target - cur)}` : '　已達標 🎉');
    const lines = [
      `💰 帳戶總額 $${fmt(p.total)}`,
      `👛 日常口袋 $${fmt(p.daily)}${p.daily < 0 ? '（超支）' : ''}`,
    ];
    const act = d.pockets.filter(x => x.active);
    for (const pk of act) {
      const bal = p.byId[pk.id] || 0;
      if (pk.target > 0) lines.push(`${pk.icon} ${pk.name} $${fmt(bal)} / $${fmt(pk.target)}`, goal(bal, pk.target));
      else lines.push(`${pk.icon} ${pk.name} $${fmt(bal)}${bal < 0 ? '（超支）' : ''}`);
    }
    for (const [id, bal] of Object.entries(p.byId)) {               // 帳本裡手動寫的、認不得的口袋名稱
      if (!d.pockets.some(x => x.id === id) && Math.round(bal) !== 0) lines.push(`👝 ${id} $${fmt(bal)}（不在口袋清單）`);
    }
    if (!act.length) lines.push('', '💡 目前沒有其他口袋，傳「新增口袋 旅遊基金」可以建立');
    else {
      const noTarget = act.find(x => !(x.target > 0));
      if (noTarget) lines.push('', `💡 傳「${noTarget.name.replace(/口袋$/, '')}目標 100000」可設定目標`);
    }
    return lines.join('\n');
  } catch (err) {
    console.error('balance failed', err);
    if (needsRelink(err, bind)) return RELINK_MSG + '。';
    return `❌ 讀取帳本失敗：${err.message}`;
  }
}

async function summaryText(env, bind, today, fetchImpl) {
  try {
    const d = await loadLedger(env, bind, fetchImpl);
    const s = computeSummary(d.transactions, d.cycleDay, today);
    const lines = [
      `📊 本期 ${s.label}`,
      `收入 $${fmt(s.inc)}`,
      `支出 $${fmt(s.exp)}`,
      `淨利 ${s.net < 0 ? '-' : ''}$${fmt(Math.abs(s.net))}${s.inc > 0 ? `（${Math.round((s.net / s.inc) * 100)}%）` : ''}`,
    ];
    if (s.depts.length) {
      lines.push('', '支出前三名：');
      for (const dp of s.depts.slice(0, 3)) lines.push(`${dp.emoji} ${dp.fullName} $${fmt(dp.total)}`);
    }
    return lines.join('\n');
  } catch (err) {
    console.error('summary failed', err);
    if (needsRelink(err, bind)) return RELINK_MSG + '。';
    return `❌ 讀取帳本失敗：${err.message}`;
  }
}

/* ====================== 開通引導 ====================== */
const oauthReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENC_KEY);
const ledgerRef = (b) => ({ sheetId: b.sheetId, auth: b.auth || 'sa', tok: b.tok });

const qr = (items) => ({ items: items.map(([label, data, displayText]) => ({
  type: 'action', action: { type: 'postback', label, data, displayText: displayText || label },
})) });

const bubble = (title, color, lines, buttons) => ({
  type: 'flex', altText: title,
  contents: {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '16px',
      contents: [{ type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'md', wrap: true }] },
    body: { type: 'box', layout: 'vertical', spacing: 'md',
      contents: lines.map(l => (typeof l === 'string'
        ? { type: 'text', text: l, size: 'sm', color: '#333333', wrap: true }
        : l)) },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
  },
});
const uriBtn = (label, uri, primary) => ({ type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm',
  ...(primary ? { color: '#1F3A2E' } : {}), action: { type: 'uri', label, uri } });
const pbBtn = (label, data, primary) => ({ type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm',
  ...(primary ? { color: '#1F3A2E' } : {}), action: { type: 'postback', label, data, displayText: label } });
const note = (t) => ({ type: 'text', text: t, size: 'xs', color: '#8A8A8A', wrap: true });

function welcomeCard(c) {
  return bubble('嗨！我是記帳機器人 👋', '#1F3A2E', [
    '用 LINE 傳一句話就能記帳，例如「午餐 120」。',
    '資料會存在「你自己的」Google 雲端硬碟，不在我這裡。',
    '開通大約 1 分鐘，共 3 步：\n1. 連結 Google 帳號（建立你的帳本）\n2. 輸入目前存款（計算餘額的起點）\n3. 選結算日（每一期從幾號開始）',
  ], [pbBtn('開始設定', 'a=ob_start', true), uriBtn('看圖文使用說明', `${c.base}/guide`), uriBtn('隱私說明', `${c.base}/privacy`)]);
}

async function authCard(c, again = false) {
  const link = await authLink(c.env, c.base, c.ch, c.uid);
  return bubble(again ? '重新連結 Google 帳號' : '步驟 1／3：連結 Google 帳號', '#1F3A2E', [
    { type: 'text', text: '為什麼需要這一步？', size: 'sm', weight: 'bold', color: '#1F3A2E' },
    again ? '你的授權已取消或過期，重新連結後就能繼續使用原本的帳本，資料不會遺失。'
          : '我要在你的雲端硬碟建立一份帳本，之後你記的每一筆帳都會寫進去。',
    '🔒 我只能存取「我建立的那一份帳本」，看不到你的其他檔案、信件或聯絡人。',
    '🔓 不想用時，隨時可以在 Google 帳戶移除授權。',
    note('按下按鈕會用手機瀏覽器開啟 Google 登入頁。看到「建立及編輯檔案」的權限時按「繼續」，完成後會引導你回到 LINE。'),
  ], [uriBtn('用 Google 登入', link, true), uriBtn('隱私說明', `${c.base}/privacy`)]);
}

function askOpening(retry) {
  return text((retry ? '請直接輸入數字就好，例如 50000 🙂\n\n' : '✅ Google 帳號連結完成，帳本已建立在你的雲端硬碟！\n\n')
    + '步驟 2／3：目前存款\n'
    + '為什麼要問這個？我需要一個起點，才算得出你的「目前餘額」。填大概的數字就可以，之後能在網站修改。\n\n'
    + '你現在戶頭大約有多少錢？（直接輸入數字，例如 50000）',
  qr([['之後再設定', 'a=obo&v=skip', '之後再設定']]));
}

function askCycle(n, retry) {
  return text((retry ? '請選下方的日期，或輸入 1–28 的數字 🙂\n\n'
    : (n != null ? `✅ 目前存款 $${fmt(n)} 已記下。\n\n` : '好的，之後可以在網站設定。\n\n'))
    + '步驟 3／3：結算日\n'
    + '為什麼要問這個？我會依結算日把帳分成一期一期，方便你比較每期花了多少。通常會選發薪日。\n\n'
    + '每月幾號算新的一期？（其他日期請直接輸入 1–28）',
  qr([1, 5, 10, 15, 20, 25].map(d => [`${d} 號`, `a=obc&d=${d}`, `每月 ${d} 號`])));
}

/** 帳本網站連結：不含任何金鑰，打開後用 LINE 身分登入（轉傳給別人也只會看到他自己的帳本） */
export function siteLink(c) {
  if (c.env.SITE_LIFF_ID) return `https://liff.line.me/${c.env.SITE_LIFF_ID}`;
  return c.env.SITE_URL || SITE_DEFAULT;
}

function siteMessage(c, bind) {
  return bubble('📊 你的帳本網站', '#1F3A2E', [
    '在網站可以看圖表、各期比較，並修改或刪除記錄。',
    note('用你的 LINE 帳號登入，只有你本人看得到。用電腦開啟時，請按「用 LINE 登入」。'),
  ], [
    uriBtn('開啟帳本網站', siteLink(c), true),
    uriBtn('開啟 Google 試算表', `https://docs.google.com/spreadsheets/d/${bind.sheetId}/edit`),
  ]);
}

async function setLedgerSetting(c, bind, key, value) {
  const token = await tokenFor(c.env, bind, c.fetchImpl);
  const d = await readLedger(token, bind.sheetId, c.fetchImpl);
  await setSetting(token, bind.sheetId, d, key, value, c.fetchImpl);
}

async function onboarding(ev, c, bind, ob, msgText) {
  const { env, send, ch, uid } = c;
  const pb = ev.type === 'postback' ? new URLSearchParams(ev.postback?.data || '') : null;

  if (!oauthReady(env)) {
    if (ev.type === 'message' || ev.type === 'follow') {
      await send(text(`這個 LINE 帳號還沒綁定帳本。\n你的 User ID：${uid}\n請在 Cloudflare KV 新增 ${bindKey(ch, uid)}`));
    }
    return;
  }

  // 尚未連結 Google
  if (!bind || !bind.sheetId) {
    if (msgText === '完成連結') {
      return send([text('我還沒收到 Google 授權完成的通知 🤔\n請確認在 Google 頁面按了「繼續」。可以再試一次：'), await authCard(c)]);
    }
    if (pb?.get('a') === 'ob_start' || (msgText && /^(開始|開始設定|開通)$/.test(msgText))) return send(await authCard(c));
    if (ev.type === 'follow' || (msgText && /^(說明|使用說明|教學)$/.test(msgText))) return send([guideCard(c.base), welcomeCard(c)]);   // 剛加入：先附上圖文說明
    if (ev.type === 'message') return send(welcomeCard(c));
    return;
  }

  try {
    if (ob.step === 'opening') {
      if (pb?.get('a') === 'obo') {
        await env.KV.put(obKey(ch, uid), JSON.stringify({ step: 'cycle' }));
        return send(askCycle(null));
      }
      const raw = (msgText || '').replace(/[,，$＄元\s]/g, '').replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
      if (/^\d+(\.\d+)?$/.test(raw)) {
        const n = Number(raw);
        await setLedgerSetting(c, bind, 'openingBalance', n);
        await env.KV.put(obKey(ch, uid), JSON.stringify({ step: 'cycle' }));
        return send(askCycle(n));
      }
      return send(askOpening(msgText !== '完成連結' && ev.type !== 'follow'));
    }

    if (ob.step === 'cycle') {
      let d = pb?.get('a') === 'obc' ? Number(pb.get('d')) : NaN;
      const m = (msgText || '').match(/^(\d{1,2})\s*(號|日)?$/);
      if (m) d = Number(m[1]);
      if (!(d >= 1 && d <= 28)) return send(askCycle(null, true));
      await setLedgerSetting(c, bind, 'cycleDay', d);
      await env.KV.delete(obKey(ch, uid));
      return send([
        text(`🎉 開通完成！結算日：每月 ${d} 號\n\n現在試試看，傳一句：\n午餐 120\n\n我會先給你一張確認卡片，按「確認寫入」才會記進帳本。\n\n📖 使用說明：${c.base}/guide`),
        siteMessage(c, bind),
      ]);
    }
  } catch (err) {
    console.error('onboarding failed', err);
    if (needsRelink(err, bind)) return send(await authCard(c, true));
    return send(text('😵 設定時發生錯誤，請稍後再傳一次。'));
  }
  await env.KV.delete(obKey(ch, uid));
}

async function wipeUser(c, bind) {
  const { env, ch, uid } = c;
  if (bind && bind.auth !== 'oauth') return '這個帳號是由管理員手動綁定的，如需刪除請聯絡管理員。';
  try {
    const tk = tokKey(ch, uid);
    const blob = await env.KV.get(tk);
    if (blob) {
      try {   // 同時向 Google 撤銷授權
        const { decryptText } = await import('./crypto.js');
        const rt = await decryptText(env, blob);
        const doFetch = c.fetchImpl;   // 以一般函式呼叫，避免 Workers 的 Illegal invocation
        await doFetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: rt }),
        });
      } catch (err) { console.error('revoke failed', err); }
    }
    const dels = [env.KV.delete(tk), env.KV.delete(bindKey(ch, uid)), env.KV.delete(obKey(ch, uid))];
    if (bind?.apiKey) dels.push(env.KV.delete(`api:${bind.apiKey}`));
    if (env.KV.list) {
      const l = await env.KV.list({ prefix: `cat:${uid}:` });
      for (const k of l.keys || []) dels.push(env.KV.delete(k.name));
    }
    await Promise.all(dels);
  } catch (err) {
    console.error('wipe failed', err);
    return '😵 刪除時發生錯誤，請稍後再試一次。';
  }
  return '🗑️ 已刪除伺服器上的授權、綁定與分類記憶，Google 授權也已撤銷。\n你雲端硬碟裡的帳本檔案仍保留，可自行決定是否刪除。\n想再使用時，輸入「開始」即可重新開通。';
}

/* 產生加密金鑰：在使用者自己的瀏覽器產生，不經過伺服器 */
function keygenPage() {
  return page('產生加密金鑰', `
<p>這把金鑰用來加密使用者的 Google 授權。<b>在你的瀏覽器裡產生，不會傳到任何伺服器。</b></p>
<p style="word-break:break-all;font-family:monospace;background:#fff;padding:12px;border-radius:8px;border:1px solid #ddd;user-select:all" id="k">產生中…</p>
<a class="btn" href="#" id="c">複製金鑰</a>
<p class="mute">複製後貼到 Cloudflare → Worker → 設定 → 變數與機密，名稱填 <b>TOKEN_ENC_KEY</b>，類型選「機密」。<br>
若按鈕無法複製，請點一下上方金鑰（會整串選取）再按 Ctrl+C。<br>設定後請勿更換，否則已授權的使用者需要重新連結 Google。</p>
<script>
var b = crypto.getRandomValues(new Uint8Array(32)), s = '';
for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
var k = btoa(s).split('+').join('-').split('/').join('_').split('=').join('');
var el = document.getElementById('k');
el.textContent = k;
document.getElementById('c').onclick = function (e) {
  e.preventDefault();
  var done = function () { e.target.textContent = '已複製 ✅'; };
  var r = document.createRange(); r.selectNodeContents(el);
  var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(k).then(done, function () { if (document.execCommand('copy')) done(); });
  } else if (document.execCommand('copy')) done();
};
</script>`);
}
