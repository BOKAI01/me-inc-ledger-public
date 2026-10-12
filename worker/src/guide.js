/* 圖文使用說明（/guide）：加入好友時自動附上連結，之後傳「說明」或按快捷列「說明」隨時回看。
 *   /guide#personal  個人記帳
 *   /guide#group     群組分帳
 * 示意圖全部用 HTML／CSS 畫成 LINE 對話的樣子，不需要額外圖片檔，載入快、手機上清楚。 */
import { SECURITY_HEADERS } from './oauth.js';

/* ---------- 示意圖元件（仿 LINE 聊天畫面） ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const me = (t) => `<div class="msg me"><div class="bub">${esc(t).replace(/\n/g, '<br>')}</div></div>`;
const bot = (t) => `<div class="msg bot"><span class="ava">📒</span><div class="bub">${esc(t).replace(/\n/g, '<br>')}</div></div>`;
const card = (title, rows, btns = [], tone = '') => `<div class="msg bot"><span class="ava">📒</span><div class="fx ${tone}">
  <div class="fx-h">${esc(title)}</div>
  <div class="fx-b">${rows.map(r => (Array.isArray(r)
    ? `<div class="kv"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`
    : `<p>${esc(r)}</p>`)).join('')}</div>
  ${btns.length ? `<div class="fx-f">${btns.map((b, i) => `<span class="fbtn${i === 0 ? ' pri' : ''}">${esc(b)}</span>`).join('')}</div>` : ''}
</div></div>`;
const chips = (list) => `<div class="chips">${list.map(c => `<span>${esc(c)}</span>`).join('')}</div>`;
const chat = (...items) => `<div class="phone" aria-hidden="true"><div class="bar"><span>‹</span>記帳小幫手<span>≡</span></div><div class="room">${items.join('')}</div></div>`;
const step = (n, title, body, pic, tone = '') => `<article class="step ${tone}">
  <div class="txt"><h3><b>${n}</b>${title}</h3>${body}</div>
  ${pic ? `<div class="pic">${pic}</div>` : ''}
</article>`;
const code = (t) => `<code>${esc(t)}</code>`;

/* ---------- 個人記帳 ---------- */
const PERSONAL = [
  step(1, '加入好友，1 分鐘開通',
    `<p>按「開始設定」後依序完成三步：</p>
     <ol><li><b>用 Google 登入</b>：在你自己的雲端硬碟建立帳本</li><li><b>輸入目前存款</b>：計算餘額的起點</li><li><b>選結算日</b>：每月幾號開始新的一期（通常選發薪日）</li></ol>
     <p class="mute">換了 LINE 帳號？用同一個 Google 帳號登入，就能接回原本的帳本。</p>`,
    chat(card('嗨！我是記帳機器人 👋', ['用 LINE 傳一句話就能記帳。', '開通共 3 步，大約 1 分鐘。'], ['開始設定', '看使用說明']),
      me('開始設定'), bot('步驟 1／3：連結 Google 帳號'))),
  step(2, '傳一句話就記一筆',
    `<p>格式是「<b>項目 金額</b>」。機器人會先給你一張確認卡片，按「<b>確認寫入</b>」才會記入。</p>
     <p>分類不對可以按「改分類」，下次同樣的項目會自動套用。</p>`,
    chat(me('午餐 120'), card('確認支出', [['項目', '午餐'], ['分類', '🍱 食 · 餐飲部'], ['日期', '今天'], ['金額', '-$120']], ['確認寫入', '改分類', '取消']),
      me('確認寫入'), bot('✅ 已寫入【我的帳本】'))),
  step(3, '更多寫法',
    `<p>日期、收入、一次多筆都可以：</p>
     <div class="ex">${code('昨天 計程車 250')}${code('10/3 電影 300')}${code('+薪水 50000')}</div>
     <ul><li>開頭加 <b>+</b> 代表收入</li><li>一次多筆：一行一筆；第一行只寫日期，後面各行都用那天</li></ul>`,
    chat(me('10/6\n早餐 35\n午餐 120\n飲料 55'), card('確認 3 筆', [['10/6 早餐', '-$35'], ['10/6 午餐', '-$120'], ['10/6 飲料', '-$55']], ['全部寫入', '取消']))),
  step(4, '隨時查詢',
    `<p>每次回覆下方都有快捷按鈕，點一下就能查：</p>
     <ul><li>${code('餘額')} 帳戶總額與三個口袋</li><li>${code('摘要')} 本期收入、支出、前三大花費</li><li>${code('網站')} 圖表與各期比較，也能修改、刪除紀錄</li><li>${code('我的帳本')} 打開 Google 試算表</li></ul>`,
    chat(me('餘額'), bot('💰 帳戶總額 $58,900\n👛 日常口袋 $46,700\n🏦 儲蓄口袋 $12,200 / $100,000\n　還差 $87,800\n🛟 緊急備用金 $0 / $50,000'),
      chips(['餘額', '本期摘要', '開啟網站', '和朋友分帳', '說明']))),
  step(5, '三個口袋：日常、儲蓄、緊急備用金',
    `<p>錢都在同一個帳戶，只是分成三個口袋管理。<b>撥款只是在口袋之間移動</b>，不算收入也不算支出。</p>
     <div class="ex">${code('撥款 儲蓄 3000')}${code('撥款 緊急 5000')}${code('撥回 儲蓄 2000')}</div>
     <p>兩個口袋都能設定目標，傳「餘額」就看得到進度：</p>
     <div class="ex">${code('儲蓄目標 100000')}${code('緊急目標 150000')}</div>`,
    `<div class="pockets" aria-hidden="true">
      <div class="pk daily"><i>👛</i><b>日常口袋</b><small>平常的收入、支出</small></div>
      <div class="arrows"><span>撥款 →</span><span>← 撥回</span></div>
      <div class="pk-col"><div class="pk save"><i>🏦</i><b>儲蓄口袋</b><small>目標 $100,000</small><em style="--p:30%"></em></div>
        <div class="pk emer"><i>🛟</i><b>緊急備用金</b><small>目標 $150,000</small><em style="--p:55%"></em></div></div>
    </div>`),
  step(6, '帳本網站',
    `<p>傳「網站」，按「開啟帳本網站」。在 LINE 裡打開會<b>自動用你的 LINE 帳號登入</b>；用電腦開啟時按一次「用 LINE 登入」。</p>
     <ul><li>連結轉給別人也看不到你的帳本，他只會看到自己的</li><li>懷疑被別人用過：傳 ${code('登出所有裝置')}</li></ul>`,
    `<div class="site" aria-hidden="true"><div class="site-h">個人營運帳本<span>10/5 – 11/4</span></div>
      <div class="site-b"><small>帳戶總額</small><strong>$58,900</strong>
      <div class="bars"><span style="--h:70%"></span><span style="--h:45%"></span><span style="--h:85%"></span><span style="--h:55%"></span><span style="--h:35%"></span><span style="--h:60%"></span></div>
      <div class="row"><span>🍱 食 · 餐飲部</span><b>$6,240</b></div><div class="row"><span>🏠 住 · 後勤部</span><b>$9,500</b></div></div></div>`),
].join('');

/* ---------- 群組分帳 ---------- */
const GROUP = [
  step(1, '把機器人邀進群組，建立分帳區',
    `<p>建立 LINE 群組（或用原本的群組），把「記帳小幫手」邀進來，按「<b>建立分帳區</b>」並輸入名稱。</p>
     <p class="mute">一個群組同時只有一個分帳區。群組裡的帳<b>只記在分帳區</b>，不會進任何人的個人帳本。</p>`,
    chat(card('嗨，我是記帳小幫手', ['我可以幫這個群組分帳：記下誰付了錢、算出誰該付誰多少。'], ['建立分帳區'], 'split'),
      me('週末出遊'), card('分帳區「週末出遊」已建立', ['成員 1 人：阿凱・建立者'], ['加入分帳', '新增臨時成員', '開啟分帳網頁'], 'split')), 'split'),
  step(2, '大家按「加入分帳」',
    `<p>每位要分帳的人按一次「加入分帳」，名字會自動用 LINE 名稱。</p>
     <ul><li>沒用 LINE 的朋友：按「新增臨時成員」</li><li>想換顯示名字：傳 ${code('改名 小明')}</li></ul>`,
    chat(me('加入分帳'), bot('✅ 小明 加入了分帳（共 2 人）'), bot('✅ 小華 加入了分帳（共 3 人）')), 'split'),
  step(3, '用「+」記一筆',
    `<p>傳「<b>+項目 金額</b>」，預設是你先付、全員平均分攤。記錄的人按「確認記入」才算數。</p>
     <div class="ex">${code('+晚餐 3000')}${code('+門票 1200 @小明付')}${code('+酒 600 不含小華')}</div>
     <p class="mute">要指定每個人的金額，按「記一筆」用網頁填寫。沒有 + 開頭的聊天訊息都不會被記。</p>`,
    chat(me('+晚餐 3000'), card('晚餐 $3,000，請確認', [['先付款', '阿凱'], '分攤（3 人，平均）', ['阿凱', '$1,000'], ['小明', '$1,000'], ['小華', '$1,000']], ['確認記入', '調整付款人或金額'], 'split')), 'split'),
  step(4, '結算：誰該付誰多少',
    `<p>傳「<b>結算</b>」，機器人算出最少的轉帳次數。收款人按「設定我的收款方式」（銀行轉帳、LINE Pay 或現金）。</p>
     <ul><li>付款人轉完按「<b>我已付款</b>」，收款人確認後按「<b>已收到</b>」</li><li>LINE Pay：按「複製金額」→「開啟 LINE 錢包」轉帳</li><li>銀行帳號加密保存，群組只顯示末 4 碼，分帳結束立即刪除</li></ul>`,
    chat(me('結算'), card('結算：2 筆轉帳', [['收款人', '阿凱（LINE Pay）'], ['小明 → 阿凱', '$1,000'], ['小華 → 阿凱', '$1,000']], ['我已付款', '已收到', '複製金額'], 'split')), 'split'),
  step(5, '結束分帳，轉入個人帳本',
    `<p>建立者傳「<b>結束分帳</b>」，可選保留紀錄 90 天或 7 天後刪除。</p>
     <p>結束後按「<b>轉入我的帳本</b>」，勾選要記的項目，<b>只會記入你自己負擔的部分</b>（例如晚餐 $1,000，而不是整筆 $3,000）。</p>`,
    chat(card('分帳區「週末出遊」已結束', ['總計 $4,800', '每個人可以把自己負擔的部分轉入個人帳本。'], ['轉入我的帳本', '開新的分帳區'], 'split'),
      `<div class="checklist"><label><i>☑</i>晚餐<b>$1,000</b></label><label><i>☑</i>門票<b>$400</b></label><label><i>☐</i>酒<b>$200</b></label><span class="fbtn pri">轉入 2 筆，共 $1,400</span></div>`), 'split'),
].join('');

const CHEAT = `
<section class="cheat" id="cmds"><h2>指令速查</h2>
<div class="cols">
<div><h4>私訊機器人</h4><table>
<tr><td>${code('午餐 120')}</td><td>記一筆支出</td></tr>
<tr><td>${code('+薪水 50000')}</td><td>記一筆收入</td></tr>
<tr><td>${code('撥款 儲蓄 3000')}</td><td>撥到儲蓄口袋</td></tr>
<tr><td>${code('餘額')}／${code('摘要')}</td><td>查詢</td></tr>
<tr><td>${code('網站')}</td><td>開啟帳本網站</td></tr>
<tr><td>${code('儲蓄目標 100000')}</td><td>設定目標</td></tr>
<tr><td>${code('登出所有裝置')}</td><td>網站全部重新登入</td></tr>
<tr><td>${code('刪除我的資料')}</td><td>刪除伺服器上的資料</td></tr>
</table></div>
<div><h4>群組裡</h4><table>
<tr><td>${code('+晚餐 3000')}</td><td>記一筆分帳</td></tr>
<tr><td>${code('@小明付')}／${code('不含小華')}</td><td>指定付款人／排除</td></tr>
<tr><td>${code('分帳')}</td><td>看目前總覽</td></tr>
<tr><td>${code('結算')}</td><td>算出誰付誰</td></tr>
<tr><td>${code('改名 小明')}</td><td>修改顯示名字</td></tr>
<tr><td>${code('結束分帳')}</td><td>建立者結束分帳</td></tr>
</table></div>
</div></section>`;

const CSS = `
:root{--bg:#F6F1E7;--card:#FFFDF8;--ink:#1F2A24;--muted:#6B6B6B;--brand:#1F3A2E;--line:#E4DDCF;--split:#CF6F22;--chip:#EFE8DA;
  --room:#9DB4D3;--me:#A6E384;--bub:#FFFFFF;--bubink:#1F2A24;--fxh:#1F3A2E}
@media (prefers-color-scheme:dark){:root{--bg:#141815;--card:#1C221E;--ink:#E7ECE8;--muted:#9AA39D;--brand:#8CC7A5;--line:#2C342F;--split:#EF9550;--chip:#252C27;
  --room:#33435A;--me:#5E9E46;--bub:#2A312C;--bubink:#E7ECE8;--fxh:#2D5A44}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:0 16px 56px}
.hero{padding:28px 0 8px}
.hero h1{font-size:24px;margin:0 0 4px;color:var(--brand)}
.hero p{margin:0;color:var(--muted)}
nav.tabs{position:sticky;top:0;z-index:5;background:var(--bg);display:flex;gap:8px;padding:10px 0;margin-bottom:6px;border-bottom:1px solid var(--line)}
nav.tabs a{flex:1;text-align:center;text-decoration:none;font-weight:700;padding:9px 6px;border-radius:999px;background:var(--chip);color:var(--ink);font-size:14px}
nav.tabs a.on{background:var(--brand);color:var(--card)}
nav.tabs a.g.on{background:var(--split)}
h2.sec{font-size:19px;margin:22px 0 4px;display:flex;align-items:center;gap:8px}
h2.sec.g{color:var(--split)} h2.sec.p{color:var(--brand)}
.lead{margin:0 0 10px;color:var(--muted);font-size:14px}
.step{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:12px 0;display:grid;gap:14px}
@media (min-width:680px){.step{grid-template-columns:1fr 300px;align-items:start}}
.step h3{margin:0 0 6px;font-size:16px;display:flex;gap:8px;align-items:center;color:var(--brand)}
.step h3 b{flex:none;display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--brand);color:var(--card);font-size:13px}
.step.split h3{color:var(--split)} .step.split h3 b{background:var(--split)}
.step p{margin:4px 0} .step ul,.step ol{margin:4px 0;padding-left:20px} .step li{margin:2px 0}
.mute{color:var(--muted);font-size:13px}
code{background:var(--chip);border-radius:6px;padding:1px 7px;font-family:inherit;font-size:13.5px;white-space:nowrap}
.ex{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
/* 仿 LINE 對話 */
.phone{border-radius:18px;overflow:hidden;border:1px solid var(--line);background:var(--room);font-size:13px;line-height:1.5;max-width:340px;width:100%;margin:0 auto}
.phone .bar{display:flex;justify-content:space-between;background:#2B3A4F;color:#fff;padding:8px 12px;font-weight:700;font-size:13px}
.room{padding:10px;display:flex;flex-direction:column;gap:8px}
.msg{display:flex;gap:6px;align-items:flex-start}
.msg.me{justify-content:flex-end}
.ava{flex:none;width:26px;height:26px;border-radius:50%;background:#fff;display:grid;place-items:center;font-size:14px}
.bub{max-width:78%;background:var(--bub);color:var(--bubink);padding:7px 10px;border-radius:14px;border-top-left-radius:4px;white-space:normal}
.me .bub{background:var(--me);color:#10200A;border-radius:14px;border-top-right-radius:4px}
.fx{width:78%;background:var(--bub);color:var(--bubink);border-radius:12px;overflow:hidden}
.fx-h{background:var(--fxh);color:#fff;font-weight:700;padding:8px 10px}
.fx.split .fx-h{background:var(--split)}
.fx-b{padding:8px 10px}
.fx-b p{margin:2px 0}
.kv{display:flex;justify-content:space-between;gap:8px;padding:1px 0}
.kv span{color:var(--muted)}
.fx-f{padding:0 10px 10px;display:flex;flex-direction:column;gap:5px}
.fbtn{display:block;text-align:center;border-radius:8px;padding:6px;background:var(--chip);font-weight:600;font-size:12.5px}
.fbtn.pri{background:var(--fxh);color:#fff}
.fx.split .fbtn.pri{background:var(--split)}
.chips{display:flex;gap:5px;overflow:hidden;padding-top:4px}
.chips span{flex:none;background:var(--bub);color:var(--bubink);border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px}
/* 口袋示意 */
.pockets{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;max-width:340px;margin:0 auto}
.pk{background:var(--chip);border-radius:12px;padding:10px;text-align:center;display:flex;flex-direction:column;gap:2px;position:relative;overflow:hidden}
.pk i{font-style:normal;font-size:22px} .pk b{font-size:13px} .pk small{color:var(--muted);font-size:11px}
.pk em{display:block;height:6px;border-radius:3px;background:var(--line);margin-top:4px;position:relative}
.pk em::after{content:"";position:absolute;inset:0;width:var(--p);border-radius:3px;background:var(--brand)}
.pk.emer em::after{background:#A0421C}
.pk-col{display:flex;flex-direction:column;gap:8px}
.arrows{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--muted);text-align:center;font-weight:700}
/* 網站示意 */
.site{max-width:340px;margin:0 auto;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card);font-size:13px}
.site-h{display:flex;justify-content:space-between;background:var(--brand);color:var(--card);padding:8px 12px;font-weight:700}
.site-h span{font-weight:400;opacity:.8}
.site-b{padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.site-b small{color:var(--muted)} .site-b strong{font-size:20px}
.bars{display:flex;align-items:flex-end;gap:6px;height:60px;margin:6px 0}
.bars span{flex:1;height:var(--h);background:var(--brand);border-radius:4px 4px 0 0;opacity:.8}
.row{display:flex;justify-content:space-between}
.checklist{width:78%;margin-left:32px;background:var(--bub);color:var(--bubink);border-radius:12px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.checklist label{display:flex;gap:6px;align-items:center} .checklist label b{margin-left:auto} .checklist i{font-style:normal}
.cheat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:22px}
.cheat h2{margin:0 0 6px;font-size:18px;color:var(--brand)}
.cheat h4{margin:10px 0 4px}
.cols{display:grid;gap:8px}
@media (min-width:680px){.cols{grid-template-columns:1fr 1fr}}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:5px 4px;border-top:1px solid var(--line);vertical-align:top}
td:first-child{white-space:nowrap}
.foot{margin-top:18px;display:flex;flex-direction:column;gap:8px}
a.btn{display:block;text-align:center;background:var(--brand);color:var(--card);text-decoration:none;padding:12px;border-radius:12px;font-weight:700}
.foot .mute{text-align:center}
`;

export function guidePage(env) {
  const basic = env.LINE_BASIC_ID || '';
  const chatUrl = basic ? `https://line.me/R/ti/p/${encodeURIComponent(basic)}` : '';
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>使用說明｜記帳小幫手</title><style>${CSS}</style></head><body><div class="wrap">
<header class="hero"><h1>📒 記帳小幫手 使用說明</h1><p>在 LINE 傳一句話就能記帳，也能和朋友在群組分帳。帳本存在你自己的 Google 雲端硬碟。</p></header>
<nav class="tabs"><a href="#personal" class="on" data-s="personal">👤 個人記帳</a><a href="#group" class="g" data-s="group">👥 群組分帳</a><a href="#cmds" data-s="cmds">⌨️ 指令</a></nav>
<section id="personal"><h2 class="sec p">👤 個人記帳</h2><p class="lead">私訊機器人，記自己的收支。只有你本人看得到。</p>${PERSONAL}</section>
<section id="group"><h2 class="sec g">👥 群組分帳</h2><p class="lead">出遊、聚餐、室友共同開銷：在 LINE 群組裡記帳，自動算出誰該付誰。</p>${GROUP}</section>
${CHEAT}
<div class="foot">${chatUrl ? `<a class="btn" href="${chatUrl}">回到 LINE 開始記帳</a>` : ''}
<p class="mute">忘記怎麼用？隨時在 LINE 傳「說明」或按快捷列的「說明」就能回到這頁。<br><a href="/privacy">隱私權說明</a></p></div>
</div>
<script>
(function(){var tabs=[].slice.call(document.querySelectorAll('nav.tabs a'));
function on(id){tabs.forEach(function(a){a.classList.toggle('on',a.dataset.s===id);});}
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)on(e.target.id);});},{rootMargin:'-45% 0px -50% 0px'});
['personal','group','cmds'].forEach(function(id){var el=document.getElementById(id);if(el)io.observe(el);});}
if(location.hash){on(location.hash.slice(1));}})();
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS } });
}

/** LINE 卡片：圖文說明入口（加入好友時、傳「說明」時） */
export function guideCard(base, opts = {}) {
  const g = opts.group;
  const color = g ? '#CF6F22' : '#1F3A2E';
  const tile = (emoji, title, sub) => ({ type: 'box', layout: 'horizontal', spacing: 'md', paddingAll: '10px', cornerRadius: '10px', backgroundColor: g ? '#FBEFE3' : '#EEF3EF',
    contents: [{ type: 'text', text: emoji, size: 'xl', flex: 0, gravity: 'center' },
      { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: title, weight: 'bold', size: 'sm', color: '#1F2A24' }, { type: 'text', text: sub, size: 'xs', color: '#6B6B6B', wrap: true }] }] });
  const btn = (label, uri, primary) => ({ type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm', ...(primary ? { color } : {}), action: { type: 'uri', label, uri } });
  return {
    type: 'flex', altText: '📖 記帳小幫手圖文說明',
    contents: {
      type: 'bubble', size: 'mega',
      hero: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '18px', spacing: 'xs', contents: [
        { type: 'text', text: '📖 3 分鐘看懂怎麼用', color: '#FFFFFF', weight: 'bold', size: 'lg' },
        { type: 'text', text: g ? '群組分帳：記帳、結算、轉入個人帳本' : '個人記帳與群組分帳，圖文一步步說明', color: '#FFFFFFCC', size: 'xs', wrap: true },
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: g
        ? [tile('➕', '+晚餐 3000', '記一筆，預設你先付、全員平均分攤'), tile('🧮', '結算', '算出誰該付誰、確認付款與收款'), tile('📥', '轉入我的帳本', '結束後把自己負擔的部分記到個人帳本')]
        : [tile('✍️', '午餐 120', '傳一句話就記一筆，按確認才寫入'), tile('💰', '餘額／摘要', '看三個口袋與本期花費'), tile('👥', '和朋友分帳', '在 LINE 群組記帳、自動算出誰付誰')] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: g
        ? [btn('看群組分帳圖文說明', `${base}/guide#group`, true), btn('看全部說明', `${base}/guide`)]
        : [btn('看個人記帳圖文說明', `${base}/guide#personal`, true), btn('看群組分帳說明', `${base}/guide#group`)] },
    },
  };
}
