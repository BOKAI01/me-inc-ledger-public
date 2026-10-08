# Me, Inc. 記帳機器人（公開版）

用 LINE 傳一句話就能記帳，帳本存在**使用者自己的 Google 雲端硬碟**。

- **LINE 機器人**：記帳卡片、多筆記帳、撥款、餘額、摘要
- **帳本網站**（GitHub Pages）：圖表、各期比較、編輯與刪除
- **後台**（Cloudflare Worker `worker/`）：Google 登入（`drive.file`）、自動建立帳本、開通引導

## 隱私設計

| 項目 | 存放位置 |
|---|---|
| 帳本資料 | 使用者自己的 Google 雲端硬碟 |
| Google 授權 | 以 AES-GCM 加密存於 Cloudflare KV |
| 權限範圍 | `drive.file`：只能存取機器人建立的那份帳本 |

使用者可隨時在 LINE 輸入「刪除我的資料」，或到 Google 帳戶移除授權。

## 部署

推送到 `main` 後，GitHub Actions 會先跑測試，通過才部署；KV 會自動建立。

需要的設定：

| 位置 | 名稱 |
|---|---|
| GitHub Actions Secrets | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |
| Cloudflare Worker 機密 | `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`GOOGLE_CLIENT_SECRET`、`TOKEN_ENC_KEY`（可到 `/keygen` 產生） |
| `worker/wrangler.toml` | `GOOGLE_CLIENT_ID`、`LINE_BASIC_ID`、`SITE_URL` |

LINE Webhook：`https://<worker>.workers.dev/line/webhook`
Google OAuth 重新導向 URI：`https://<worker>.workers.dev/auth/callback`
