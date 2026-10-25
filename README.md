# 青鸟（qingniao）

> 「蓬山此去无多路，青鸟殷勤为探看。」
> 一只替你传信、替你值守的 AI 信使：QQ 陪伴 · B站值班 · 谷时推送 · 本地生图 · 跨平台记忆。

## 这是什么

青鸟是一套跑在 Windows 上的**个人 AI 陪伴与自动化中枢**，把这几件事拧成了一体：

| 能力 | 说明 |
|---|---|
| **QQ 陪伴** | 接入 OneBot v11（如 SnowLuma），AI 以仿真群友/私聊助手身份在 QQ 里聊天（桥接 DeepSeek Harness / 任意兼容 Web API 的 agent 宿主） |
| **B站值班** | 定时搜片、读字幕、写日报、评论区 @你（B站 MCP 工具集：搜索/字幕/弹幕/评论/私信/发动态/发图文） |
| **峰谷调度推送** | 自定义"谷时"窗口，值班日报自动私聊推送给你；峰时产生的自动排队补发 |
| **本地生图** | 对接本机 ComfyUI（默认 Qwen-Image 工作流），AI 可自主生图发给你，用完自动删；支持自主下载模型（限定目录） |
| **跨平台记忆** | 按人存长期印象（QQ 号 ↔ B站号自动关联），聊天/B站/推送共用同一份记忆，项目外自动备份 |
| **统一人格** | 一个 YAML 定义人格（语气/外貌/边界），编译到 QQ 角色卡、B站值班、日报推送、生图提示词 |
| **管理平台** | `http://127.0.0.1:3160` 一页管所有：状态/值班/推送/人格/生图/记忆/密钥/日志 |

```
QQ ──SnowLuma(OneBot)──► qq-bridge ──► DeepSeek Harness ──► DeepSeek API
                              │              ▲
B站 ◄──bili-duty(MCP)────────┘   dsh-link(:3080 固定入口, 动态发现桌面端端口)
                              │
管理平台(:3160) ◄── services/hub.js（调度/推送/记忆/ComfyUI/人格编译）
```

## 目录结构

```
qingniao/
├── config/
│   ├── suite.json          # 总配置（身份/峰谷窗口/推送/ComfyUI/路径）——按需填写
│   └── persona.yaml        # ★ 统一人格（单一事实源，改这里全端生效）
├── services/               # 管理平台与核心服务（hub / dsh-link / 调度 / 推送 / 记忆 / ComfyUI / 人格编译）
├── qq-bridge/              # QQ 桥接（基于开源 qq-bridge 深度改造：仿真社交、MCP 安全工具、跨聊天记忆）
├── bili-duty/              # B站值班（值班章程 + B站 MCP 工具集，Python）
├── manage/public/          # 管理平台前端
├── scripts/                # 整栈保活 / 自启 / 运维脚本
└── tools/                  # B站发布 CLI 等
```

## 快速开始

1. **环境**：Node.js ≥ 22.13、Python 3.12（B站部分）、DeepSeek Harness（或其他兼容 agent 宿主）、OneBot v11 协议端（如 SnowLuma + QQ 客户端）
2. **安装**：
   ```bash
   npm install          # 根目录
   cd qq-bridge && npm install && cd ..
   pip install -r bili-duty/requirements.txt   # B站功能（可选）
   ```
3. **配置**：编辑 `config/suite.json`（占位符全部换成你的）与 `config/persona.yaml`（人设）；QQ 桥接配置见 `qq-bridge/config.example.json` → `config.json`
4. **启动**：`start-all.bat`（或 `node scripts/ensure-running.mjs`，幂等保活，可挂计划任务）
5. **打开**：`http://127.0.0.1:3160`（首次启动自动生成访问令牌，见 `state/hub-token`）

## 手机端

配套安卓端 **qingniao-mobile**：本地小模型 + 无障碍读屏操作 + 联网搜索 + 截图汇报，与本项目同人格、同记忆格式。

## 安全提醒

- 管理平台只应监听本机/可信局域网；不要暴露公网
- `config/suite.json`、`qq-bridge/config.json`、`bili-duty/bili_credential.json` 均含凭据，**不要提交到仓库**
- 所有对外发布的内容都以你的账号发出，请谨慎配置自动发布开关

## 致谢

- QQ 桥接基于开源项目 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 深度改造
- 本地推理 / 生图使用 [llama.cpp](https://github.com/ggml-org/llama.cpp) 与 [ComfyUI](https://github.com/comfyanonymous/ComfyUI)

## License

MIT
