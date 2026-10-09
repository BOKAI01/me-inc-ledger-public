/**
 * Entry Durable Object：一張確認卡片一個實例。
 * 強一致地保存待確認內容，並以 state 欄位確保「確認寫入」只會執行一次。
 * state: pending → writing → done ；cancelled
 */
const KEEP_MS = 7 * 24 * 3600 * 1000;
const WRITING_TIMEOUT_MS = 60 * 1000;

export class Entry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const { op, data } = await request.json();
    const out = await this.handle(op, data);
    return Response.json(out);
  }

  async handle(op, data = {}) {
    const s = this.storage;
    let cur = await s.get('rec');
    if (cur && !cur.items && cur.entry) {               // v1 單筆格式
      cur = { ...cur, items: [{ entry: cur.entry, txnId: cur.txnId, hadMemory: cur.hadMemory }] };
    }
    switch (op) {
      case 'create': {
        if (cur) return { ok: true, rec: cur };
        const rec = { ...data, state: 'pending', createdAt: Date.now() };
        await s.put('rec', rec);
        await s.setAlarm(Date.now() + KEEP_MS);
        return { ok: true, rec };
      }
      case 'get':
        return { ok: !!cur, rec: cur || null };
      case 'update': {                                   // 改第 i 筆的分類／收支，只限待確認
        if (!cur) return { ok: false, reason: 'missing' };
        if (cur.state !== 'pending') return { ok: false, reason: cur.state, rec: cur };
        const i = Number(data.i) || 0;
        if (!cur.items[i]) return { ok: false, reason: 'missing' };
        const items = cur.items.map((it, k) => (k === i ? { ...it, entry: { ...it.entry, ...data.patch } } : it));
        const rec = { ...cur, items };
        await s.put('rec', rec);
        return { ok: true, rec };
      }
      case 'acquire': {                                  // 取得寫入權
        if (!cur) return { ok: false, reason: 'missing' };
        const stale = cur.state === 'writing' && Date.now() - (cur.writingAt || 0) > WRITING_TIMEOUT_MS;
        if (cur.state !== 'pending' && !stale) return { ok: false, reason: cur.state, rec: cur };
        const rec = { ...cur, state: 'writing', writingAt: Date.now() };
        await s.put('rec', rec);
        return { ok: true, rec };
      }
      case 'finish': {
        if (!cur) return { ok: false, reason: 'missing' };
        const rec = { ...cur, state: 'done', doneAt: Date.now() };
        await s.put('rec', rec);
        return { ok: true, rec };
      }
      case 'release': {                                  // 寫入失敗，退回待確認
        if (!cur || cur.state !== 'writing') return { ok: false };
        const rec = { ...cur, state: 'pending' };
        await s.put('rec', rec);
        return { ok: true, rec };
      }
      case 'cancel': {
        if (!cur) return { ok: false, reason: 'missing' };
        if (cur.state !== 'pending') return { ok: false, reason: cur.state, rec: cur };
        const rec = { ...cur, state: 'cancelled' };
        await s.put('rec', rec);
        return { ok: true, rec };
      }
      case 'lock': {                                     // 試算表寫入鎖（租約制，逾時自動失效）
        const l = await s.get('lock');
        if (l && l.until > Date.now() && l.owner !== data.owner) return { ok: false };
        await s.put('lock', { owner: data.owner, until: Date.now() + (data.ttl || 20000) });
        return { ok: true };
      }
      case 'unlock': {
        const l = await s.get('lock');
        if (l && l.owner === data.owner) await s.delete('lock');
        return { ok: true };
      }
      default:
        return { ok: false, reason: 'bad-op' };
    }
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}

/** 從 Worker 呼叫 */
export async function entryCall(env, pid, op, data) {
  const stub = env.ENTRY.get(env.ENTRY.idFromName(pid));
  const res = await stub.fetch('https://entry/' + op, {
    method: 'POST',
    body: JSON.stringify({ op, data }),
  });
  return res.json();
}
