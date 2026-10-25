@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  花开总控 bloom-hub 启动（整栈）
echo ============================================
echo QQ 客户端 → SnowLuma → DSH web → 管理平台 → QQ 桥接，缺哪个拉哪个。
node scripts\ensure-running.mjs --wait-login
echo.
echo 完成。管理平台：http://127.0.0.1:3160（令牌在 config\suite.json 或 state\hub-token）
pause
