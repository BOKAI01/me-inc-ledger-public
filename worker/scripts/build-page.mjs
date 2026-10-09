// 把 page/split.html 轉成 src/split-page.js（Worker 直接 import 字串）
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../page/split.html', import.meta.url), 'utf8');
writeFileSync(new URL('../src/split-page.js', import.meta.url),
  '/* 自動產生：請改 page/split.html 後執行 npm run build:page */\nexport default ' + JSON.stringify(html) + ';\n');
