@echo off
rem bloom-hub mobile APK 构建（gradle assembleDebug）
set JAVA_HOME=D:\jdk\jdk21
set ANDROID_HOME=D:\android-sdk
cd /d "%~dp0.."
call D:\gradle-8.7\bin\gradle.bat assembleDebug --no-daemon
echo GRADLE_EXIT=%ERRORLEVEL%
