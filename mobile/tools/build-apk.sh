#!/usr/bin/env bash
# 青鸟口袋版 APK 一键构建（在 PC 上跑）
# 产出：mobile/app/build/outputs/apk/debug/app-debug.apk
set -x
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-D:/android-sdk}"   # 可用环境变量覆盖
LOG() { echo "[$(date +%T)] $*"; }

export JAVA_HOME="${JAVA_HOME:-D:/jdk/jdk21}"   # 可用环境变量覆盖
export ANDROID_HOME="$SDK"
export PATH="$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$PATH"

# 1) Android cmdline-tools
if [ ! -d "$SDK/cmdline-tools/latest" ]; then
  mkdir -p "$SDK"
  cd "$SDK"
  curl -L -o cmdtools.zip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" || exit 1
  unzip -q cmdtools.zip
  mkdir -p cmdline-tools/latest
  mv cmdline-tools/bin cmdline-tools/lib cmdline-tools/NOTICE.txt cmdline-tools/source.properties cmdline-tools/latest/ 2>/dev/null
  rm cmdtools.zip
fi
LOG "cmdline-tools 就绪"

# 2) SDK 组件（licenses 自动接受）—— Windows 下必须用 sdkmanager.bat
SDKMAN="$SDK/cmdline-tools/latest/bin/sdkmanager.bat"
"$SDKMAN" --version || exit 1
yes | "$SDKMAN" --licenses > /dev/null 2>&1
"$SDKMAN" "platform-tools" "platforms;android-35" "build-tools;34.0.0" "ndk;27.0.12077973" "cmake;3.22.1" || exit 1
LOG "SDK 组件就绪"

# 3) llama.cpp 源码（github 失败则走镜像）
cd "$ROOT"
if [ ! -d app/src/main/cpp/llama.cpp ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp app/src/main/cpp/llama.cpp \
    || git clone --depth 1 https://gitee.com/mirrors/llama.cpp app/src/main/cpp/llama.cpp \
    || exit 1
fi
LOG "llama.cpp 就绪"

# 4) Gradle 发行版
GRADLE_VER="8.7"
if [ ! -d "D:/gradle-$GRADLE_VER" ]; then
  curl -L -o /d/gradle.zip "https://services.gradle.org/distributions/gradle-$GRADLE_VER-bin.zip" || exit 1
  unzip -q /d/gradle.zip -d /d/
  rm /d/gradle.zip
fi
LOG "Gradle 就绪"

# 5) local.properties + 构建
echo "sdk.dir=D:\\\\android-sdk" > "$ROOT/local.properties"
cd "$ROOT"
"D:/gradle-$GRADLE_VER/bin/gradle.bat" assembleDebug --no-daemon
LOG "构建结束，APK 位于 app/build/outputs/apk/debug/app-debug.apk"
