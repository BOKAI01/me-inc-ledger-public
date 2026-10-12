/**
 * 口袋管理（LINE 指令與網站共用）：新增、改名、設定目標、刪除。
 * 每個動作都從帳本重新讀取最新狀態再寫入，呼叫端需持有該帳本的寫入鎖。
 */
import { readLedger, ensurePocketTab, writePockets, rewriteAccountColumn, appendTxns, readHeaderAndIds } from './google.js';
import { computePockets } from './ledger.js';
import { MAX_POCKETS, activePockets, findPocket, nameError, newPocket, pocketById } from './pockets.js';

export class PocketError extends Error {}

async function fresh(token, sheetId, fetchImpl) {
  const d = await readLedger(token, sheetId, fetchImpl);
  if (!d.tabs.pk) await ensurePocketTab(token, sheetId, d.tabs, d.pockets, fetchImpl);   // 舊帳本：先建立口袋工作表
  return d;
}
const save = (token, sheetId, d, pockets, fetchImpl) => writePockets(token, sheetId, d.tabs, pockets, fetchImpl);
function resolve(d, ref) {
  const p = pocketById(d.pockets, ref) || findPocket(d.pockets, ref);
  if (!p || !p.active) throw new PocketError(`找不到「${ref}」這個口袋。目前的口袋：${activePockets(d.pockets).map(x => x.name).join('、') || '（沒有）'}`);
  return p;
}

export async function addPocket(token, sheetId, name, { icon, target } = {}, fetchImpl = fetch) {
  const d = await fresh(token, sheetId, fetchImpl);
  if (activePockets(d.pockets).length >= MAX_POCKETS) throw new PocketError(`口袋最多 ${MAX_POCKETS} 個，請先刪除不用的口袋`);
  const err = nameError(d.pockets, name);
  if (err) throw new PocketError(err);
  const p = { ...newPocket(d.pockets, name, icon), target: Math.max(0, Number(target) || 0) };
  await save(token, sheetId, d, [...d.pockets, p], fetchImpl);
  return { pocket: p, pockets: [...d.pockets, p] };
}

/** 改名：口袋代號不變，交易明細裡的舊名稱一起換成新名稱 */
export async function renamePocket(token, sheetId, ref, newName, fetchImpl = fetch) {
  const d = await fresh(token, sheetId, fetchImpl);
  const p = resolve(d, ref);
  const err = nameError(d.pockets, newName, p.id);
  if (err) throw new PocketError(err);
  const pockets = d.pockets.map(x => (x.id === p.id ? { ...x, name: String(newName).trim() } : x));
  await save(token, sheetId, d, pockets, fetchImpl);
  await rewriteAccountColumn(token, sheetId, d, pockets, fetchImpl);
  return { from: p.name, pocket: pockets.find(x => x.id === p.id), pockets };
}

export async function setPocketTarget(token, sheetId, ref, amount, fetchImpl = fetch) {
  const d = await fresh(token, sheetId, fetchImpl);
  const p = resolve(d, ref);
  const v = Math.max(0, Math.round(Number(amount) || 0));
  const pockets = d.pockets.map(x => (x.id === p.id ? { ...x, target: v } : x));
  await save(token, sheetId, d, pockets, fetchImpl);
  return { pocket: pockets.find(x => x.id === p.id), pockets };
}

/** 刪除前的確認資訊：目前餘額 */
export async function previewDelete(token, sheetId, ref, fetchImpl = fetch) {
  const d = await fresh(token, sheetId, fetchImpl);
  const p = resolve(d, ref);
  const bal = computePockets(d.transactions, d.openingBalance, d.pockets).byId[p.id] || 0;
  return { pocket: p, balance: bal };
}

/**
 * 刪除口袋：依「當下」餘額自動記一筆撥款讓口袋歸零（正數撥回日常；超支的負數由日常補回），再標記為已刪除。
 * 舊紀錄保留，報表照常顯示。txnId 讓重複按下也只會記一次。
 */
export async function deletePocket(token, sheetId, ref, { today, txnId } = {}, fetchImpl = fetch) {
  const d = await fresh(token, sheetId, fetchImpl);
  const p = resolve(d, ref);
  const bal = computePockets(d.transactions, d.openingBalance, d.pockets).byId[p.id] || 0;
  const tag = String(today || '').slice(5).replace('-', '/');
  const pockets = d.pockets.map(x => (x.id === p.id ? { ...x, active: false, name: `${p.name}（已刪除${tag ? ' ' + tag : ''}）` } : x));
  let wrote = null;
  if (Math.round(bal) !== 0) {
    const { header, ids } = await readHeaderAndIds(token, sheetId, fetchImpl);
    const id = txnId || `${Date.now()}pk`;
    if (!ids.includes(id)) {
      const out = bal > 0;
      const txn = {
        id, type: 'alloc', category: out ? 'alloc_out' : 'alloc_in', date: today, amount: Math.abs(Math.round(bal)),
        client: out ? `刪除口袋：${p.name}撥回日常` : `刪除口袋：日常補足${p.name}`, description: '刪除口袋時自動歸零',
        paymentTerm: 0, received: true, createdAt: new Date().toISOString(), account: p.id,
      };
      await appendTxns(token, sheetId, header, [txn], fetchImpl, pockets);
      wrote = txn;
    }
  }
  await save(token, sheetId, d, pockets, fetchImpl);
  await rewriteAccountColumn(token, sheetId, d, pockets, fetchImpl);   // 舊紀錄改標「（已刪除）」，名稱可以再拿來用
  return { pocket: p, balance: bal, wrote, pockets };
}
