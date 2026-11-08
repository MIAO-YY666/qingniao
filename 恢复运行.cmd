@echo off
chcp 65001 >nul
title bloom-hub
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore-toggles.ps1" -Mode menu
echo.
pause
