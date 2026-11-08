# 模型下载与选型（骁龙 8+ Gen 1 / 8GB RAM）

## 推荐：Qwen3-1.7B Q4_K_M（默认）

- HuggingFace（国内镜像）：https://hf-mirror.com/Qwen/Qwen3-1.7B-GGUF
- 下载文件：`Qwen3-1.7B-Q4_K_M.gguf`（约 1.1GB）
- 直接下载链接形如：
  `https://hf-mirror.com/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf`
- 手机浏览器下载到 `Download/`，或 PC 下载后拷过去。

## 备选

| 场景 | 模型 | 文件 |
|---|---|---|
| 更快更听话（不想等思考） | Qwen2.5-1.5B-Instruct | https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF `*Q4_K_M.gguf` |
| 更聪明（慢，可接受） | Qwen2.5-3B-Instruct | https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF `*Q4_K_M.gguf` |

## 放进手机后

App 内「导入本地 GGUF 模型」→ 文件选择器里选 `.gguf` → 等待复制（约 1~3 分钟）
→ 状态栏出现「模型就绪 ✓」。

> 8GB RAM 手机上 3B Q4 约占 2.5GB；如果系统杀后台严重，退回 1.5B/1.7B。
