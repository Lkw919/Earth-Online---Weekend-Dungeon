#!/bin/bash
# 一键：杀掉卡死的后端 + 重新启动
lsof -ti:8000 | xargs kill -9 2>/dev/null
sleep 2
cd "$(dirname "$0")/backend"
export PYTHONPATH="$PWD"
conda run -n AI_Hackathon uvicorn src.api.server:app --host 0.0.0.0 --port 8000 --env-file "$(dirname "$0")/.env" --reload
