#!/bin/bash
# 一键：启动前端（手机也能访问，加 --host）
cd "$(dirname "$0")/fronted"
npm run dev -- --host
