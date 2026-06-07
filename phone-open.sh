#!/bin/bash
# 手机打不开局域网地址时，用这个脚本生成「公网链接」
# 前提：前端 npm run dev 已在跑（5173），后端已在跑（8000）
echo "正在生成手机可打开的公网链接（约 10 秒）..."
echo "请保持这个窗口不要关，链接出来后在手机浏览器打开即可。"
echo ""
cd "$(dirname "$0")/fronted"
npx --yes localtunnel --port 5173
