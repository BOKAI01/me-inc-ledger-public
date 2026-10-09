/* 使用說明頁（/guide）：加入好友後從歡迎卡片開啟，或傳「說明」取得連結 */

export function guidePage(env) {
  const basic = env.LINE_BASIC_ID || '';
  const chat = basic ? `https://line.me/R/ti/p/${encodeURIComponent(basic)}` : '';
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>使用說明｜記帳小幫手</title>
<style>
:root{--bg:#F6F1E7;--card:#FFFDF8;--ink:#1F2A24;--muted:#6B6B6B;--brand:#1F3A2E;--line:#E4DDCF;--split:#CF6F22;--chip:#EFE8DA}
@media (prefers-color-scheme:dark){:root{--bg:#141815;--card:#1C221E;--ink:#E7ECE8;--muted:#9AA39D;--brand:#8CC7A5;--line:#2C342F;--split:#EF9550;--chip:#252C27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;padding:0 16px;padding-block:24px 48px}
main{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
h1{font-size:22px;margin:0;color:var(--brand)}
.lead{margin:0;color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
h2{font-size:16px;margin:0 0 6px;color:var(--brand);display:flex;gap:8px;align-items:center}
h2 b{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--brand);color:var(--card);font-size:12px}
.split h2{color:var(--split)} .split h2 b{background:var(--split)}
p{margin:4px 0}
ul{margin:4px 0;padding-left:20px} li{margin:2px 0}
code{background:var(--chip);border-radius:6px;padding:1px 7px;font-family:inherit;font-size:14px;white-space:nowrap}
.ex{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.mute{color:var(--muted);font-size:13px}
a.btn{display:block;text-align:center;background:var(--brand);color:var(--card);text-decoration:none;padding:12px;border-radius:10px;font-weight:600}
</style></head><body><main>
<h1>記帳小幫手 使用說明</h1>
<p class="lead">在 LINE 傳一句話就能記帳。帳本存在你自己的 Google 雲端硬碟。</p>

<section><h2><b>1</b>開始使用（約 1 分鐘）</h2>
<p>加入好友後按「開始設定」，依序完成：</p>
<ul><li>用 Google 登入：在你的雲端硬碟建立帳本</li><li>輸入目前存款：計算餘額的起點</li><li>選結算日：每月幾號開始新的一期（通常選發薪日）</li></ul>
</section>

<section><h2><b>2</b>記帳</h2>
<p>傳「項目 金額」，按卡片上的「確認寫入」才會記入，分類可以在卡片上改。</p>
<div class="ex"><code>午餐 120</code><code>昨天 計程車 250</code><code>10/3 電影 300</code><code>+薪水 50000</code></div>
<p class="mute">開頭加「+」代表收入。一次記多筆：一行一筆送出即可。</p>
</section>

<section><h2><b>3</b>查詢與網站</h2>
<ul><li><code>餘額</code> 帳戶總額與三個口袋</li><li><code>摘要</code> 本期收入、支出與前三大花費</li><li><code>網站</code> 看圖表、各期比較，修改或刪除紀錄</li><li><code>我的帳本</code> 打開 Google 試算表</li></ul>
<p class="mute">每次回覆下方都有快捷按鈕，點一下就能查。</p>
</section>

<section><h2><b>4</b>三個口袋與撥款</h2>
<p>錢分成「日常、儲蓄、緊急備用金」三個口袋。撥款只是在口袋之間移動，不算收入或支出。</p>
<div class="ex"><code>撥款 儲蓄 3000</code><code>撥款 緊急 5000</code><code>撥回 儲蓄 2000</code></div>
</section>

<section class="split"><h2><b>5</b>和朋友分帳</h2>
<ul><li>建立 LINE 群組，把這個 LINE 官方帳號邀進群組</li><li>按「建立分帳區」，大家按「加入分帳」</li><li>傳 <code>+晚餐 3000</code>，或按「記一筆」選付款人與分攤的人</li><li>傳 <code>結算</code> 算出誰該付誰，付款人按「我已付款」、收款人按「已收到」</li><li>結束後，每個人可把自己負擔的部分轉入個人帳本</li></ul>
<p class="mute">群組裡的帳只會記到分帳區，不會進任何人的個人帳本。</p>
</section>

<section><h2><b>6</b>隱私</h2>
<ul><li>帳本存在你自己的 Google 雲端硬碟，擁有者是你</li><li>機器人只能存取它建立的那一份帳本，看不到你的其他檔案</li><li>隨時傳 <code>刪除我的資料</code>，或到 Google 帳戶移除授權</li></ul>
<p class="mute"><a href="/privacy">完整隱私權說明</a></p>
</section>

${chat ? `<a class="btn" href="${chat}">回到 LINE 開始記帳</a>` : ''}
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
