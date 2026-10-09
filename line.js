/* LINE Messaging API：簽章驗證、回覆、卡片 */
import { DEPARTMENTS, INCOME_CATS, catLabel, fmt } from './ledger.js';

export async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let s = '';
  for (const b of mac) s += String.fromCharCode(b);
  const expected = btoa(s);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function reply(token, replyToken, messages, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: (Array.isArray(messages) ? messages : [messages]).slice(0, 5) }),
  });
  if (!res.ok) console.error('LINE reply failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}

export const text = (t, quickReply) => (quickReply ? { type: 'text', text: t, quickReply } : { type: 'text', text: t });

const row = (label, value) => ({
  type: 'box', layout: 'baseline', spacing: 'md',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#8A8A8A', flex: 2 },
    { type: 'text', text: value, size: 'sm', color: '#222222', flex: 5, wrap: true },
  ],
});

const btn = (label, data, style = 'secondary') => ({
  type: 'button', style, height: 'sm',
  ...(style === 'primary' ? { color: '#1F3A2E' } : {}),
  action: { type: 'postback', label, data, displayText: label },
});

/** 確認卡片 */
export function confirmCard(pid, e, ledgerName) {
  const isIn = e.type === 'inflow';
  const isAlloc = e.type === 'alloc';
  const title = isAlloc ? '確認撥款' : isIn ? '確認收入' : '確認支出';
  const color = isAlloc ? '#A87B3D' : isIn ? '#5B8C5A' : '#1F3A2E';
  const sign = isAlloc ? '' : isIn ? '+' : '-';
  const rows = isAlloc
    ? [
        row('方向', catLabel(e.type, e.category, e.account)),
        row('說明', '口袋間配置，帳戶總額不變，不算收入或支出'),
        row('日期', e.date),
        row('帳本', ledgerName || '主帳本'),
      ]
    : [
        row('項目', e.client),
        row('分類', catLabel(e.type, e.category)),
        row('日期', e.date),
        row('帳本', ledgerName || '主帳本'),
      ];
  return {
    type: 'flex',
    altText: `${title}：${e.client} $${fmt(e.amount)}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '14px',
        contents: [
          { type: 'text', text: title, color: '#FFFFFF', size: 'sm' },
          { type: 'text', text: `${sign}$${fmt(e.amount)}`, color: '#FFFFFF', size: 'xxl', weight: 'bold' },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          btn('確認寫入', `a=ok&p=${pid}`, 'primary'),
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [btn(isAlloc ? '改方向' : '改分類', `a=pick&p=${pid}`), btn('取消', `a=no&p=${pid}`)],
          },
        ],
      },
    },
  };
}

/** 撥款方向的快速選單 */
export function allocQuickReply(pid, i = 0) {
  const opts = [
    ['in', 'emergency', '👛→🛟 撥入緊急備用金'],
    ['in', 'savings', '👛→🏦 撥入儲蓄口袋'],
    ['out', 'emergency', '🛟→👛 緊急撥回日常'],
    ['out', 'savings', '🏦→👛 儲蓄撥回日常'],
  ];
  const items = opts.map(([d, k, label]) => ({
    type: 'action',
    action: { type: 'postback', label: label.slice(0, 20), data: `a=alloc&p=${pid}&i=${i}&d=${d}&k=${k}`, displayText: label },
  }));
  items.push({ type: 'action', action: { type: 'postback', label: '↔ 改成支出', data: `a=type&p=${pid}&i=${i}&t=outflow`, displayText: '改成支出' } });
  return { items };
}

/** 改分類的快速選單 */
export function categoryQuickReply(pid, type, i = 0) {
  const cats = type === 'inflow'
    ? INCOME_CATS.map(c => ({ id: c.id, label: `${c.emoji} ${c.name}` }))
    : DEPARTMENTS.map(d => ({ id: d.id, label: `${d.emoji} ${d.fullName}` }));
  const items = cats.map(c => ({
    type: 'action',
    action: { type: 'postback', label: c.label.slice(0, 20), data: `a=cat&p=${pid}&i=${i}&c=${c.id}`, displayText: c.label },
  }));
  items.push({
    type: 'action',
    action: {
      type: 'postback',
      label: type === 'inflow' ? '↔ 改成支出' : '↔ 改成收入',
      data: `a=type&p=${pid}&i=${i}&t=${type === 'inflow' ? 'outflow' : 'inflow'}`,
      displayText: type === 'inflow' ? '改成支出' : '改成收入',
    },
  });
  items.push({
    type: 'action',
    action: { type: 'postback', label: '↪ 改成撥款', data: `a=alloc&p=${pid}&i=${i}&d=in&k=emergency`, displayText: '改成撥款' },
  });
  return { items };
}

/** 多筆確認卡片：點任一列可改該筆分類 */
export function batchCard(pid, entries, ledgerName) {
  let inc = 0, exp = 0, alloc = 0;
  for (const e of entries) {
    if (e.type === 'inflow') inc += e.amount; else if (e.type === 'alloc') alloc += e.amount; else exp += e.amount;
  }
  const line = (e, i) => {
    const isAlloc = e.type === 'alloc';
    const label = isAlloc ? catLabel(e.type, e.category, e.account) : `${catLabel(e.type, e.category).split(' ')[0]} ${e.client}`;
    const sign = isAlloc ? '' : e.type === 'inflow' ? '+' : '-';
    const color = isAlloc ? '#A87B3D' : e.type === 'inflow' ? '#5B8C5A' : '#222222';
    return {
      type: 'box', layout: 'horizontal', spacing: 'sm', paddingTop: '6px', paddingBottom: '6px',
      action: { type: 'postback', label: `修改第 ${i + 1} 筆`, data: `a=pick&p=${pid}&i=${i}` },
      contents: [
        { type: 'text', text: e.date.slice(5).replace('-', '/'), size: 'xs', color: '#8A8A8A', flex: 2, gravity: 'center' },
        { type: 'text', text: label, size: 'sm', color: '#222222', flex: 6, wrap: true, gravity: 'center' },
        { type: 'text', text: `${sign}$${fmt(e.amount)}`, size: 'sm', color, flex: 3, align: 'end', gravity: 'center' },
      ],
    };
  };
  const totals = [];
  if (exp) totals.push(`支出 $${fmt(exp)}`);
  if (inc) totals.push(`收入 $${fmt(inc)}`);
  if (alloc) totals.push(`撥款 $${fmt(alloc)}`);
  return {
    type: 'flex',
    altText: `確認 ${entries.length} 筆記帳`,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1F3A2E', paddingAll: '14px',
        contents: [
          { type: 'text', text: `確認 ${entries.length} 筆・${ledgerName || '主帳本'}`, color: '#FFFFFF', size: 'sm' },
          { type: 'text', text: totals.join('　') || '$0', color: '#FFFFFF', size: 'lg', weight: 'bold', wrap: true },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'none',
        contents: [
          ...entries.map(line).flatMap((b, i) => (i ? [{ type: 'separator', color: '#EEEEEE' }, b] : [b])),
          { type: 'text', text: '點任一筆可修改分類', size: 'xxs', color: '#8A8A8A', margin: 'md' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          btn(`確認寫入 ${entries.length} 筆`, `a=ok&p=${pid}`, 'primary'),
          btn('全部取消', `a=no&p=${pid}`),
        ],
      },
    },
  };
}
