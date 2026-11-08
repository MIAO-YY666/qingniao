#!/usr/bin/env bash
# 拉取 llama.cpp 源码到 mobile 工程的 native 目录（在 PC 上运行一次即可）
# 版本可固定：LLAMA_REF=<tag 或分支> bash tools/fetch-llamacpp.sh（如 LLAMA_REF=b6xxx）
# 不指定时拉 master —— 构建不可复现，上游 API 变动可能导致编译失败；正式构建建议固定 tag。
set -e
cd "$(dirname "$0")/.."
if [ -d app/src/main/cpp/llama.cpp ]; then
  echo "llama.cpp 已存在，跳过（如需更新请删除该目录后重跑）"
  exit 0
fi
LLAMA_REF="${LLAMA_REF:-master}"
git clone --depth 1 --branch "$LLAMA_REF" https://github.com/ggml-org/llama.cpp app/src/main/cpp/llama.cpp
echo "完成（llama.cpp @ $LLAMA_REF）。用 Android Studio 打开 mobile/ 工程即可构建。"
