/**
 * LINE 端的口袋清單快取（KV）。網站、LINE 任何一邊改了口袋都要更新，
 * 否則另一邊會看到舊清單（例如網站新增的口袋，在 LINE 撥款選單裡找不到）。
 */
export const pkKey = (sheetId) => `pk:${sheetId}`;
export const PK_TTL = 30 * 86400;            // 只在 Google 暫時連不上時當備援；平常每次都讀試算表
export const lite = (pockets) => (pockets || []).map(({ id, name, icon, active, target }) => ({ id, name, icon, active, target }));

export async function rememberPockets(env, sheetId, pockets) {
  if (!env?.KV || !sheetId || !Array.isArray(pockets)) return;
  const v = JSON.stringify(lite(pockets));
  if ((await env.KV.get(pkKey(sheetId))) !== v) await env.KV.put(pkKey(sheetId), v, { expirationTtl: PK_TTL });
}
export async function cachedPockets(env, sheetId) {
  const c = await env.KV.get(pkKey(sheetId), 'json');
  return Array.isArray(c) ? c : null;
}
