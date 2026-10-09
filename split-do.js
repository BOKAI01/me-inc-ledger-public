/**
 * Split Durable Object：一個分帳區一個實例。
 * 所有修改都在這裡依序執行（強一致），結束後依保留期限以 alarm 自動刪除。
 */
import { apply } from './split-core.js';

export class Split {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const { op, actor, args } = await request.json();
    const cur = (await this.storage.get('s')) || null;
    const { state, res } = apply(cur, op, actor, args);
    if (res.ok && op !== 'get' && state) {
      await this.storage.put('s', state);
      if (op === 'close' && state.retain) {
        await this.storage.setAlarm(Date.parse(state.retain.until + 'T00:00:00+08:00'));
      }
    }
    return Response.json({ res, state: res.ok || cur ? state : null });
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}

/** 呼叫分帳區：回傳 { res, state } */
export async function splitCall(env, sid, op, actor, args = {}) {
  const stub = env.SPLIT.get(env.SPLIT.idFromName(sid));
  const r = await stub.fetch('https://split/op', { method: 'POST', body: JSON.stringify({ op, actor, args }) });
  return r.json();
}
