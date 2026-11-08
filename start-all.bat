@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   bloom-hub : start stack + keep-alive
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\service-control.ps1" -Action start
echo.
pause
