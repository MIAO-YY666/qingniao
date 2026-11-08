# 青鸟（qingniao）

> QQ 陪伴（桥接）+ B站值班 + 峰谷调度推送 + 统一人格 + 语音 + 管理平台 —— 一个个人 AI 中枢。

## 这是什么

项目由三个部分组成：

| 目录 | 作用 |
|---|---|
| `qq-bridge/` | QQ ↔ DSH 桥接（仿真群友、私聊助手、控制台 :3100） |
| `bili-duty/` | B站值班：谷时刷B站、读字幕、写日报、评论区 @你的B站昵称 |
| `services/` + `manage/` | 管理平台、峰谷推送、人向记忆、生图/语音/直播适配 |

QQ 协议端使用 SnowLuma（OneBot v11，Hook 进官方 QQ 客户端工作）；第三方发行包的
EULA 禁止再分发，请自行获取，并在 `config/suite.json` 的 `paths.snowlumaHome` 指向它。

在此之上，qingniao 提供这些能力层：

1. **峰谷调度与推送**（`services/`）——谷时窗口内自动把值班日报私聊推给你；
2. **人向记忆**（`memory/` + `services/memory.js`）——按人存长期印象：唤醒时自动注入上下文，agent 可用 memory_* 工具自主增删改，管理平台「记忆」页可视化编辑；自动镜像备份到项目外 `%USERPROFILE%\.qingniao-backup/`；
3. **统一 API 密钥**（平台「模型·密钥」页）——QQ 聊天与 B站值班共用 DEEPSEEK_API_KEY，平台可改，原凭据自动备份；
4. **dsh-link 固定入口**（:3080）——桥接连桌面客户端的内嵌 web（动态端口自动发现）；
2. **统一人格接口**（`config/persona.yaml`）——QQ 聊天、B站评论、日报、推送共用同一套语气与红线；
3. **管理平台**（`http://127.0.0.1:3160`）——一个页面管所有：状态、值班配置、推送、人格、B站发布、QQ 能力、日志。

## 兼容性说明

对外部路径的引用全部收在 `config/suite.json` 的 `paths` 段（QQ 客户端、SnowLuma、
DeepSeek Harness 桌面端、ffmpeg、ComfyUI 模型目录），换机器只改这一处。

## 目录结构

```
qingniao/
├── config/
│   ├── suite.json          # 总配置：身份、峰谷窗口、推送、B站定时动态、路径
│   └── persona.yaml        # ★ 统一人格与语言风格（单一事实源；公开模板默认小鲸鱼，可自行增改人格）
├── qq-bridge/              # QQ 桥接（原 qq-bridge，独立 git 仓库保留）
│   ├── src/bridge.js       #   主程序（收发 QQ、社交策略、:3100 控制台）
│   └── roles/              #   角色卡目录（统一人格生成的卡带「统一-」前缀）
├── bili-duty/              # B站值班（原 .dsh/bili-duty，含 .venv）
│   ├── duty.md             #   值班章程（新增统一人格挂钩段）
│   ├── AGENTS.md           #   ★ 由 persona.yaml 自动生成的开场必读
│   ├── mcp_server.py       #   B站 MCP 工具（搜索/字幕/评论/发动态/发图文/私信…）
│   └── out/                #   日报产物（推送服务监听这里）
├── SnowLuma/               # QQ 协议端（第三方，EULA 禁止再分发，自行获取后放这里或用 paths.snowlumaHome 指向）
├── services/
│   ├── hub.js              # 管理平台后端（:3160）
│   ├── dsh-link.js         # DSH 固定入口（:3080 → 桌面客户端内嵌 web，动态端口发现）
│   ├── scheduler.js        # 峰谷窗口计算
│   ├── push-service.js     # 谷时日报推送 + 补发
│   ├── persona.js          # 人格加载/保存/编译（→角色卡、AGENTS.md、推送文案）
│   └── qq-social.js        # QQ 社交能力适配器（能力探测 + 显式声明不支持项）
├── scripts/
│   ├── ensure-running.mjs  # 整栈拉起（自启/手动启动/doctor 共用，幂等 + 并发锁 + --force）
│   ├── doctor.mjs          # ★ 全栈体检 + 自愈 + 报告（保活任务每 5 分钟跑它）
│   ├── doctor-hidden.vbs   # 保活任务入口（隐藏窗口跑 doctor.mjs）
│   ├── watch-qq.mjs        # QQ 多开账号探测（期望账号不在线时提示/拉起，在线时自动补起桥接）
│   └── install-autostart.ps1
├── manage/public/index.html# 管理平台前端
├── tools/bili_cli.py       # B站发布 CLI（复用 bili-duty 的 MCP 工具与 venv）
├── autostart.vbs           # 开机自启入口（注册表 Run 键指向它，隐藏运行 doctor.mjs）
├── memory/                 # 人向记忆（一人一文件；项目外 D:\.qingniao-backup 自动备份）
├── state/                  # 运行时状态（hub-token、push-history.json、auto-post.json）
├── logs/                   # 平台日志（hub.log、ensure-running.log、doctor.log）
├── start-all.bat           # 启动整栈 + 启用/触发 5 分钟保活
├── stop-all.bat            # 停止管理平台与桥接 + 禁用 5 分钟保活
└── 恢复运行.cmd            # 救命菜单（只启动一次 / 恢复自启与保活）
```

## 启动与开机自启

```bat
双击 start-all.bat        # 启动整栈 + 启用并触发 5 分钟保活
双击 stop-all.bat         # 停止整栈 + 禁用 5 分钟保活（防 5 分钟内被拉回）
```

**启停与保活联动**（实际逻辑在 `scripts/service-control.ps1`）：

- `start-all.bat` 写回 `state/service-toggles.json` 的 `doctor=true`、启用并立即触发
  `BloomHub-KeepAlive`，**由计划任务托管拉起整栈（唯一的启动链路）**，最多等 60 秒并
  每 15 秒报一次进度；超时如实报错并提示看日志，不再补跑第二遍。之所以只留一条链路：
  `ensure-running.mjs` 的 10 分钟去抖锁对 `--force` 不生效，两条 `--force` 并发会重复
  拉起 QQ / DSH / 整栈，而且交互式会话起的服务正是「任务托管」要规避的情况。
- `stop-all.bat` **先**写回 `doctor=false` 并禁用保活任务，再按 pid / lock 精确停 hub 与桥接。
  只改开关不禁用任务（或反过来）都不行：体检会把被禁用的任务重新启用，5 分钟内把服务拉回。
- 两者都不改 `autostart`（注册表 Run 键）。所以 stop 之后重启电脑，登录时仍会通过
  `autostart.vbs` 拉起一次整栈；想连这个也关掉，在管理平台关「开机自启」。
- 只读查看状态：`powershell -File scripts\service-control.ps1 -Action status`。
- 调试桥接时用 `powershell -File scripts\service-control.ps1 -Action restart-bridge`：只停/起桥接，
  hub、保活开关、QQ / SnowLuma / DSH 桌面端都不动，比整栈启停少两轮中断，也少一次会话缓存失效。
  启动仍由保活任务托管（保持唯一启动链路）。
- ⚠️ 批处理文件必须保持 **CRLF + 纯 ASCII**：cmd.exe 对含中文的 UTF-8 批处理会按字节偏移
  错乱，把 `rem` / `echo` 行从中间切开当命令执行；`chcp 65001` + 无 BOM 同样会触发，
  加 BOM 又会让首行 `@echo off` 失效。中文提示统一放在带 BOM 的 `.ps1` 里。见 `.gitattributes`。

**开机自启 + 保活**（已安装，无需管理员）：

- 注册表 `HKCU\...\CurrentVersion\Run` 的 `BloomHub` 键 → 登录 Windows 时隐藏运行 `autostart.vbs`
  → `scripts/doctor.mjs`（体检 + 自愈，缺组件时自动调 `ensure-running.mjs`）；
- 计划任务 `BloomHub-KeepAlive` **每 5 分钟**跑一次 `scripts/doctor.mjs`（关掉了「电池上不启动」，
  并打开「错过后补跑」，所以合盖/断网后也会追上）；
- 装/修自启都走 `scripts/install-autostart.ps1`（幂等；doctor 发现自启缺失也会自动调用它）。

**体检脚本 `scripts/doctor.mjs`**（也建议手动排障时先跑它）：

```bash
node scripts/doctor.mjs              # 体检 + 自动修复（保活任务用这个）
node scripts/doctor.mjs --no-repair  # 只体检不动手
node scripts/doctor.mjs --json       # 给程序读的结构化结果
```

检查 11 项：配置、僵尸锁/失效 pid、开机自启与保活任务、QQ 账号与协议端、DSH 桌面客户端与
dsh-link、管理平台、QQ 桥接（含 dshReady）、谷时推送、保活心跳、保活日志崩溃。退出码 0 = 全好。

**双开多账号**：每个 QQ 账号在 SnowLuma 里有独立的 OneBot 端口（如账号A = HTTP 3010 / WS 3011，
账号B = 3000/3001，账号C = 3020/3021），互不抢占；桥接固定连期望账号的端口，你登谁都不影响她。
双开登录后 SnowLuma 的 hookAutoLoad 会自动挂载所有 QQ 进程。

**自动登录链**：`ensure-running` 先按账号探测（期望账号不在线会提示或拉起 QQ 客户端） → 拉起 SnowLuma（`hookAutoLoad: true`，
自动发现并挂上 QQ 进程，免 WebUI 手动接入）→ 确保 **DeepSeek Harness 桌面客户端**在运行
（桥接不连独立 `dsh web`：hub 的 **dsh-link** 服务监听固定端口 3080，自动发现桌面客户端的
内嵌 web 端口并转发，含 WebSocket 事件流；桌面端重启换端口也自动跟随，桥接零改动）→
管理平台与桥接随后拉起，桥接自动连 OneBot 与 DSH 并持续重连。
QQ 免扫码登录依赖 QQ 客户端自己记住的会话：如果登录窗停住，在 QQ 客户端里**勾选
一次「自动登录」**即可，之后开机全自动。若 OneBot 登录的账号不是期望账号，
`ensure-running` 会在日志里明确警告。启动探测日志见 `logs/ensure-running.log`。
（若 DSH 掉了，症状是 QQ 回复「消息未被接受：bridge/transport: fetch failed」；
保活任务每 5 分钟跑一次 doctor，会把桌面客户端拉回来。doctor 只在 dsh-link 连续 3 次
都拿不到内嵌 web 时才重启客户端，避免 DSH 刚启动时被误杀。）

DSH 照常自己启动（:3080）。

- 管理平台：`http://127.0.0.1:3160`，访问令牌在 `config/suite.json` 的 `hub.token`
  （首次启动自动生成，也写在 `state/hub-token`）。
- QQ 聊天深度设置（模式/白名单/社交参数/黑话/表情库）仍在桥接控制台
  `http://127.0.0.1:3100`，管理平台「总览」页有直达链接。

## 核心行为

### 峰谷时间（默认窗口，可在管理平台改）

- 深夜谷 `23:00 ~ 07:30`、午间谷 `12:30 ~ 13:59`（`config/suite.json` → `valley.windows`）。
- **谷时**：值班轮刷B站、写日报 → 平台自动把日报摘要私聊推给 `pushTargetQQ`（10000）。
- **峰时产生的日报**不会丢：进入待发队列，下一个谷窗自动补发（只补最新一份，旧的标记跳过，避免刷屏）。
- **回复不看峰谷**：你任何时候发 QQ 消息，她都回——回复链路在 qq-bridge 里是常驻的，
  与谷时推送互不阻塞（`valley.alwaysReply: true` 只是把这个承诺写进配置，供平台展示）。

### 统一人格（config/persona.yaml，公开模板默认「小鲸鱼」）

一个文件定义「她」：人格列表（小鲸鱼 / 千秋）、全出口共享的语言风格（短句、去 AI 味、
不空夸、不用 Markdown、拿不准不编）、每人格的互动细则、B站评论/日报口吻、推送文案模板、
硬边界。

管理平台「人格」页编辑保存后一键同步：

- **同步到 B站值班** → 重写 `bili-duty/AGENTS.md`（值班章程开场必读，下一轮生效）；
- **同步到 QQ** → 生成 `qq-bridge/roles/统一-<名>.md` 角色卡（带前缀是为了不覆盖你手写的
  小鲸鱼.md / 少女.md），可选同时把 `current-role.json` 指过去（桥接重载后生效）；
- 推送文案的开场白/落款实时取自 `pushVoice` 段。

### B站功能打通

`bili-duty/mcp_server.py` 里的 27 个工具（搜索、字幕、弹幕、评论、收存、私信、**发动态**、
**发图文（Opus）**、甚至传视频）现在有三条出口：

1. **值班轮**（DSH headless 会话 + overlay MCP）——照旧自动跑；
2. **管理平台「B站发布」页**——手动发动态/发图文，走 `tools/bili_cli.py`（复用 duty 的 venv 与凭据）；
3. **定时日报动态**（可选开关）——每天到点把当天日报自动转成一条B站动态（`bili.autoDigestDynamic`）。

### QQ 侧能力（如实说明）

经 SnowLuma OneBot 协议端，管理平台「QQ发布」页提供：

| 能力 | 状态 | 说明 |
|---|---|---|
| 私聊推送 / 群消息 | ✅ | 推送服务用它发日报 |
| 名片赞（个人主页点赞） | ✅ | `send_like` |
| 群公告 | ✅ | `send_group_notice` |
| 戳一戳 | ✅ | `friend_poke` / `group_poke` |
| **发说说 / 空间动态 / 空间相册** | ❌ | **SnowLuma 1.14.15 的 OneBot 协议端未提供 Qzone 接口**（协议端能力缺口，已与其 SDK 类型定义逐一核对）。平台如实显示「不可用」，协议端更新支持后可直接接入，无需改平台。 |

## 配置速查（config/suite.json）

```jsonc
{
  "hub": { "port": 3160, "token": "" },          // token 空 = 首启自动生成
  "identity": {
    "botName": "小鲸鱼", "botQQ": 10001,     // 网关当前登录的 QQ（期望账号）
    "pushTargetQQ": 10000,                   // 谷时日报推给谁
    "biliMentionName": "你的B站昵称"                  // B站评论 @ 谁
  },
  "valley": { "windows": [ ... ] },               // 峰谷窗口，支持跨午夜
  "push": { "enabled": true, "onlyInValley": true, "catchUp": true },
  "bili": { "autoDigestDynamic": { "enabled": false, "time": "12:45" } },
  "paths": {
    "qqExe": "C:\\Program Files\\Tencent\\QQNT\\QQ.exe",  // ensure-running 自启 QQ 用
    "autoLoginQQ": 10001                              // 期望的自动登录账号
  }
}
```

值班本身的调度仍由 DSH 的值班机制负责（`bili-duty/config.json` 的 `peakValley/noon/night` 等，
管理平台「值班」页可直接改，下一轮生效）。

## QQ 唤醒策略与 token 成本（2026-11-06）

**群聊潜水 / 私聊活跃**（`qq-bridge/config.json → socialV2.groupDiving`）：

- 私聊保持原来的活跃模式，每条消息都唤醒。
- 群聊默认潜水，消息照常入库但不唤醒，只有以下情况放行：`@她`、引用她、说昵称、
  **戳一戳**、**关注度为 5 的人说话**（主人按 `treatOwnerAsLevel5` 也算 5 级）、
  **未唤醒消息累计到 `unreadWakeThreshold`（默认 12 条）**。
- 这条是**平台级硬闸门**（在 `scheduleWakeV2` 与 `sendWakePromptV2` 两处），
  agent 用 `qq_set_wake_config` 把 mode 改回 active 也绕不过去；30 秒一次的
  `replyCheck`、随机 `proactiveCheck`、`timeout`、`anyMessage`、概率触发在群聊一律拦掉。
- `allowKeyword` / `allowQuestion` 默认 false，`unreadWakeMaxWaitMs` 默认 0（不做时间兜底），
  想放宽改配置即可；`maxWakePerHour` 默认 6，给群聊单独加一道成本上限。
- `qq-bridge/config.json` 属本地配置、不入库，所以 `src/bridge.js` 里固化了同名默认值
  （`GROUP_DIVING_DEFAULTS` / `SESSION_ROTATION_DEFAULTS`）：换机器或重置配置后行为不变。
  运行时状态 `state/social-v2.json` 同样不入库，但平台闸门作用在代码层，状态重置也不会漂回活跃。
- 只读自检：`GET http://127.0.0.1:3100/api/socialV2/policy`（带 `x-console-token`），
  返回放行/拦截原因、待轮换会话与交接摘要预演（`?brief=1`，不产生 LLM 请求）。

**会话历史治理**（`socialV2.sessionRotation`）：DSH 每次请求都带 system prompt + 全部历史 +
工具定义，平时靠 prefix 缓存压价；缓存一失效就把几十万 token 全价重发。所以按
**跨自然日 / 会话超龄 12h / 投递数超 120 / 老会话首次纳管** 新建会话，并在轮换后的
第一次投递注入一份规则拼装的交接摘要（人设、形象更正、话题、印象、最近 12 条消息），
不额外调 LLM。旧会话归档、`sessions.json` 里的 `sessionMeta` 记录轮换次数。
调试重启后老会话不会再背着 20MB 历史继续跑，等于把「重启前主动 compact」并进同一条链路。

**按天用量监控**：

```bash
npm run usage                                   # 今天
node scripts/usage-report.mjs --all            # 全部日期
node scripts/usage-report.mjs --by-hour        # 今天按小时
node scripts/usage-report.mjs --by-session     # 今天按会话
node scripts/usage-report.mjs --calibrate 11   # 用当天实际账单反推等效单价
```

脚本逐帧解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，不能整文件一次解压），
按北京时间汇总请求数、未命中输入、缓存读、输出，并列出**缓存失效大请求**
（未命中 >5 万且缓存读 <20%）。11-06 实测：当天 ¥11 里 89% 的未命中输入来自 7 次
全量历史重发；历史上大请求为 0 的日子基本 ¥1 上下，7~9 次就涨到 ¥11~15。
`config/usage-pricing.json` 的等效单价由用户账单反推，仅供趋势对比，不是官方报价。

## 推送文案与记忆分层（2026-11-06）

**推送文案三级优先**：① 值班轮自己写好的 `## 给他的QQ` 段（零额外请求；
`services/persona.js` 生成的 `bili-duty/AGENTS.md` 现已把它列为每轮必写，之前 14 天只有 2 天写了）；
② 没写时 hub 把日报摘要发给桥接 `POST /api/socialV2/generate-push`，由一个**独立 DSH 会话**
（不复用 QQ 聊天会话，避免任务型 prompt 污染人设上下文）按角色卡生成开场白；
③ 桥接未就绪/超时/生成过短 → `renderPushText` 模板兜底，绝不阻断推送。
`push-history.json` 的 `introSource` 会记录本次用的是哪条路径。

**记忆分层**：`services/memory.js` 给印象加 `kind`（`episode` 日常/印象、`log` 平台流水账）。
`log` 默认不进 `renderForPrompt`，仍可用 `memory_read` 查；平台推送按 `keepLatestOfKind:1`
滚动保留一条。旧数据没有 `kind` 时按文本特征自动识别，所以历史推送记录无需迁移就会被降级。
`mcp-memory-server.js` 的 `memory_write` 描述去掉了「你给他推过的东西」并加了流水账硬兜底，
preset 第 19 条从「偶尔用，别当笔记本」改成「日常多记、流水账少记」。

## 三级记忆评估（2026-11-06）

实证结论：**这套系统其实已经有三级，只是没按三层来治理**。

| 层 | 现在对应什么 | 生命周期 | 注入方式 |
|---|---|---|---|
| L1 工作记忆 | DSH 会话历史 + 本轮未读消息 + 角色卡 / system prompt / 73 个工具定义 | 单会话，跨日或超龄轮换 | 全量进上下文，靠 prefix 缓存压价 |
| L2 情景记忆 | `social-v2.json` 的 `recentMessages` / `activeTopics` / `pendingThoughts` / `memberImpressions`，以及轮换时的交接摘要 | 最近 100 条、24h~14 天不等 | `formatMemoryV2` 每轮注入 |
| L3 语义记忆 | `memory/people/*.json` 长期印象 | 永久（60 条上限） | `renderForPrompt` 最近 12 条 / 2000 字 |

已验证：正常唤醒的 `user/message`（约 7000 字）确实含【当前角色】【记忆·关于】【此刻状态】等块；
轮换后的新会话首次请求 2 万 input，之后每次只有 150~200 未命中、其余全走缓存（老会话缓存失效一次 57 万）。

**全量印象的成本核算**（决定「能不能全加」）：

实测三个人合计 24 条 `episode`、2462 字符；原 `max=12 / chars=2000` **从未触发截断**，
全量（含 log）也才 2952 字符，而 log 默认被排除 —— 所以放宽到全量后，**当前数据下成本增量为 0**。
真正缺的是「长期印象写得太少」（`memory_write` 一天 4 次、`qq_memory_append` 全历史 0 次），
不是上限太低。现在 `renderForPrompt` 默认取 `MAX_IMPRESSIONS=60` 条，并保留 `chars=6000`
安全阀：真写满 60 条时，最坏每轮多约 4500 token（按校准单价约 ¥0.018/次），且按 salience
排序保证截断时留的是精华。按现在的写入速度，几个月内不会碰到这个上限。

**路线与进度**（2026-11-06 晚更新）：

1. **P0 已做**：L1 会话轮换 + 交接摘要、L3 `episode`/`log` 分层、推送流水账降级。
2. **P1 已做**：印象带 `salience` / `mentions` / `superseded`，按显著性 + 近因 + 重复提及
   加权挑选、输出仍按时间正序；`memory_write` 新增 `importance` / `supersedes`，旧说法退场但
   数据保留可回滚。**没有做「猜模型有没有想起这条」的自动检测**（不可靠、易造假信号），
   改用「同一主题后来又被写了一次」这个真实写入行为，用中文 bigram 重叠系数判定。
3. **P2 已做，且改成懒执行**：不做凌晨定时任务（用户不能保证深夜在线 / 关机时间稳定）。
   `qq-bridge/src/scene-digest.js` 在每次取会话状态时判断「上次记录日期 != 今天」，是就把
   昨天积累的消息归纳成一条规则式摘要（**不额外调 LLM**），清空桶、只留最近 3 天，
   以【最近几天的情景】注入。几点开机、关了几天都能补上，日期做幂等、一天只做一次；
   摘要从独立的当日桶生成，不依赖 `recentMessages` 的 100 条滚动窗口。
4. **P3 当前不建议**：向量检索 / embedding / 知识图谱。单机单用户、每天几百条消息，
   固定注入的收益已经够；多引入一个向量服务 + 索引同步，维护成本远大于收益。

**风险**：三级越自动，越怕「记忆污染」。本项目已有真实案例——「Q 版是鱼」的旧自述沉淀进 L3 后
被反复强化，最后要靠「标注过期」纠正。所以任何自动沉淀都必须保留**来源、时间、可标过期、可回滚**，
不要让模型自己覆写长期事实。

## 验证 / 运维

```bash
npm run check                       # 全部服务模块语法检查
node scripts/doctor.mjs             # ★ 体检 + 自愈（保活任务每 5 分钟跑的就是它）
node scripts/ensure-running.mjs     # 只做整栈拉起（幂等；--force 忽略 10 分钟去抖）
node services/hub.js                # 单独启动管理平台
powershell -File scripts/install-autostart.ps1   # 重装/修复开机自启与保活任务
```

- 推送记录：`state/push-history.json`（管理平台「推送」页可视化）。
- 平台日志：`logs/hub.log`；整栈拉起探测：`logs/ensure-running.log`；体检报告：`logs/doctor.log`。
- 修改 `persona.yaml` → 平台里点同步（或直接重写 `bili-duty/AGENTS.md` / `qq-bridge/roles/`）。
- core 桥接异常：`qq-bridge/restart.bat`。
- ⚠️ **冷启动时整栈一起拉起有竞争**：SnowLuma 刚起、QQ 账号还没挂上时，桥接首次 WS 会被
  `1006` 断开。以前 `startConsoleServer()` 写在 `await bot.connect()` 之后，连接卡住就导致
  `:3100` 永远不监听 → 体检与 `start-all` 误判「桥接没起来」并超时（2026-11-06 22:58 实录）。
  现已把控制台与 DSH 监控提到连接之前、并给 `connect()` 加 try/catch：桥接会先在线、
  后台持续重连，QQ 登录后自动恢复。保活任务通常在一个 5 分钟周期内自愈。

### 推送与消息读取的两个坑（2026-11-06 修）

- **谷时日报反复推旧内容 + 失败刷屏**：`dispatchQueue` 成功不出队，让 11-02 的旧日报
  被反复补发到 11-06；失败分支 `armNextValleyTimer()` 在谷时内同步递归，1 秒打了 198 次
  `send_private_msg`（全部 `fetch failed`），把 `push-history.json` 的 200 条历史槽位冲光。
  现改为：成功出队、启动即清理「已推过却还在 queue」的僵尸项、失败指数退避且防重入、
  同类失败折叠成一条带 `count`。回归测试 `test/contract/push-service.test.mjs`（3 例）。
- **她不知道自己推过**：日报由 hub 直连 OneBot 发出，桥接会话流里没有任何记录；推送记忆
  又只写到 `bili-<昵称>`，而 QQ 私聊 `memoryBlockFor` 读的是 `qq-<QQ号>`，两边对不上。
  现两个身份都写一份，并由 hub 调 `/api/socialV2/platform-message` 回灌一条 `isSelf` 消息。
- **连发两条以上只看到一条**：8 秒 `batchWindowMs` 合并唤醒后，prompt 只给「最近一条」全文；
  `qq_wait_for_messages` 的 `baseline` 已包含这些消息，`newMessages` 返回空，补不回来。
  现把未读全文直接内嵌进唤醒提示（`context.wakeUnreadInPrompt`，默认 12 条 / 每条 120 字），
  wait 没等到新消息时也会明确提示「开始前已有 N 条未读」。
- **主人回「发 / 不发 / 重写」被当成没说过**：B站动态审核是平台层短路消费的
  （`tryHandleBiliDraftReview` 命中即 `return`，刻意不进 LLM 对话省 token），但那条消息因此
  完全没有入会话流 —— 平台回了「已发到 B站 ✓」，AI 却只看到随后那个呲牙表情，
  于是追问「发不发说句话啊」。现改为：**仍然不额外唤醒**，但把「主人说了什么 + 平台办了什么」
  写成一条 `platformEvents`（2 小时过期、最多注入 3 条）并回灌 `recentMessages`，
  唤醒提示里以【刚刚平台替你处理的事】呈现，明确「别再问发不发」。
  通则：**任何被平台短路消费的消息，都要留一条上下文痕迹**，别让她以为对方没说话。

### 已修故障与对应自动化（2026-10-26）

| 故障 | 症状 | 修复 / 自动化 |
|---|---|---|
| `ensure-running.mjs` 里 `hubUp` / `dshWebOk` 定义在 `ensureQqRunning` 的提前 return 之后，作用域不可见 | QQ 在线时（正常情况）保活脚本必崩 `ReferenceError: hubUp is not defined`，管理平台与桥接**永远不被拉起**；崩溃还会留下 10 分钟僵尸锁 | 函数提到模块级；主流程加 `try/finally` 必清锁、异常写日志；doctor 检查僵尸锁并清理 |
| 开机自启项丢失（注册表 Run 键 + 计划任务都不存在） | 机器重启后整栈无人拉起，只有 SnowLuma/QQ 在跑 | `install-autostart.ps1` 重装；doctor 每次体检都会校验，缺失即自动重装 |
| 计划任务默认「电池上不启动」、错过后不补跑 | 笔记本拔电/休眠后保活静默失效 | 安装脚本用 XML 导出→改设置→导入，强制 `DisallowStartIfOnBatteries=false`、`StartWhenAvailable=true` |
| 保活入口 VBS 用 `CreateObject(...).CurrentDirectory` 与另一个实例 `Run`，工作目录丢失 | 计划任务里 `node scripts\doctor.mjs` 与日志重定向相对路径失效 | VBS 改单实例 + 全绝对路径 |
| DSH 内嵌 web 一次探测失败就 `taskkill` 桌面客户端 | 误杀 DSH，连带桥接/会话中断 | 改为连续 3 次（间隔 5s）都拿不到才重启 |

> 保活任务现在跑的是 `doctor.mjs`：先体检，缺组件才调 `ensure-running`，所以以上任何一项回归，
> 下一轮（≤5 分钟）都会自动修复并在 `logs/doctor.log` 留下记录。

## 生图（ComfyUI · Qwen-Image 2.1）

本地 ComfyUI 接入完成：AI 可用 mcp__comfy__ 工具（gen_image / list_comfy_models / download_model）生图发 QQ；
管理平台「生图」页可视化操作。发送成功即删本地文件；模型下载强制落在 `D:Comfy-DesktopComfyUI-Sharedmodels`（注明位置，不出 D 盘）。
服务端由 scripts/comfy-server.bat 无头拉起（桌面壳不需要开着），配置在 config/suite.json comfy 段 + config/comfy-models.yaml。

## 语音（说 / 听）

**发语音（出站）**：`POST /api/qq/voice {userId, text}` → TTS 出 wav → `record` 段 → 协议端自己转 SILK。
她也可以直接调 MCP 工具 `qq_send_voice`（私聊）。三道保护：45 秒同会话闸门、正文 ≤500 字、三级降级（`file://` → `base64://` → 音频文件 + 文字说明），失败会带原因，不静默。

**听语音（入站）**：收到的 `record` 段不再渲染成 `[语音]`，而是 `get_record(out_format=wav)` → 本地 SenseVoice 转写 → 以 `[语音：…]` 进上下文。转写失败显示 `[语音（转写失败：原因）]`。

**引擎**（改 `config/persona.yaml` 的 `voice.engine` 一行即可换，JS 零改动）：

| engine | 说明 | 依赖 |
|---|---|---|
| `sovits` | GPT-SoVITS 微调音色（自备素材训练的 s2） | `tools/gptsovits/` + 参考音频 |
| `sapi` | Windows 自带，离线、零下载 | pywin32（已装） |
| `edge` | edge-tts，音质好但联网 | `pip install edge-tts` |

`sovits` 的推理服务**不常驻**：合成前自动拉起（冷启动约 64s），空闲 120 分钟后关停，把显存还给 ComfyUI。
起不来或没配参考音频时**自动降级到 sapi**，返回里带 `degraded` 说明原因。
训练脚本见 `tools/gptsovits/train_sovits.sh`（素材与产物不入库）。

> **QQ 语音出站当前是关的。** 音色还没到可用程度（唱腔残留），所以 `tts.qqVoice.enabled` 默认按
> **关闭**处理——配置缺失也不出声。此时 `/api/qq/voice` 返回 403 带原因，能力表里 `private-voice`
> 标成 `support:false`，MCP 工具会明确告诉模型"已关闭，改用文字"。
> **合成不受影响**：`POST /api/tts/speak` 仍可试听对比。要恢复出站：`config/suite.json` →
> `tts.qqVoice.enabled: true`（并确认那一行的音色确实能听）。
>
> 开关只用一个点：`services/hub.js` 的 `qqVoiceOffReason()`，`/api/qq/voice` 与能力表都走它，
> 不存在第二条语音出站路径（`sendPrivateVoice` 全仓只有一处调用）。

**环境与自测**：

```bash
npm run tts                    # 合成一句，打印产物（不发 QQ）
node tools/voice/tts-test.mjs "要说的话"
node tools/voice/inbound-test.mjs          # 入站链路集成测试（stub bot，不发消息）
tools/voice/.venv/Scripts/python.exe tools/voice/tts_cli.py --list   # 看可用音色
tools/voice/.venv/Scripts/python.exe tools/voice/asr_cli.py --check  # 看 ASR 模型就绪没
```

语音环境是独立 venv（`tools/voice/.venv`），**不混进 bili-duty 的 25 工具依赖链**；ASR 模型在 `tools/voice/models/sensevoice/`（约 230MB，纯 CPU，不占显存）。
音色训练环境是**另一个** venv（`tools/gptsovits/.venv`，torch cu128，约 13GB 含权重），与语音合成环境互不影响，删掉也不影响其他功能。

## B站直播弹幕（只收不发）

默认关闭。开启：`config/suite.json` → `live.enabled=true` 并填 `live.roomIds`。

- 采集：`bili-duty/live_sidecar.py`（常驻，单实例锁 + 去重 + 令牌桶 + JSONL 落盘 + 15s 心跳），由 `ensure-running` 复用现有保活任务拉起，**不新建计划任务**。
- 库隔离：`bili-duty/live_adapter.py` 是全仓唯一 `import bilibili_api.live` 的地方（上游已归档，将来换 `blivedm` 只改这一个文件）。
- 读取：`GET /api/bili/live/status`（心跳）、`GET /api/bili/live/events?since=&limit=`（拉取，只读尾部 2MB）。
- **发弹幕默认 403**：`POST /api/bili/live/send` 直接拒绝。这是高可见度写操作，私信轮询已有 `-509` 前科，要开必须先做"建议模式 → 人工确认"。

## 手机端：青鸟·口袋版（mobile/）

骁龙 8+ Gen 1 本地小模型（llama.cpp + GGUF，推荐 Qwen3-1.7B Q4）+ 无障碍读屏/操作 + 联网搜索 + 截图汇报的完整安卓工程，人格为「青鸟」（接收主人与 PC 端下发的任务）。
与 PC 端同人格（Prompt.kt 与 persona.yaml 同源）、同记忆格式（people/*.json 双向拷贝互通）。构建方法见 mobile/README.md：
PC 上跑 tools/fetch-llamacpp.sh → Android Studio 打开 mobile/ → Run。

## 安全注意

- 管理平台只绑定 `127.0.0.1`，且有访问令牌；不要把 3160 端口暴露到公网。
- `qq-bridge/config.json`、`bili-duty/bili_credential.json`、`state/` 都含凭据，不要入库、不要外传。
- B站发布与评论都以**使用者账号**身份发出——发出去的每个字都算在账号上，平台只提供
  开关与记录，发布决策请保持谨慎。
