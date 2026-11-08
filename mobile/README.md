# 青鸟·口袋版（qingniao/mobile）

> 手机端的青鸟：本地小模型 + 无障碍读屏操作 + 联网搜索 + 截图汇报。
> 与 PC 端 [qingniao](https://github.com/MIAO-YY666/qingniao) 同人格体系、同记忆格式（people/*.json 双向拷贝互通）。

## 功能

- **本地大脑**：llama.cpp 跑 GGUF 量化模型（默认推荐 Qwen3-1.7B Q4），可选云端模式
- **读屏与操作**：无障碍 UI 树读取 + 点击/滑动/输入/打开 App（JSON 动作协议 Agent 循环）
- **联网搜索**：Bing/百度兜底，搜到的资料自动进上下文
- **截图汇报**：任务完成自动截屏、QQ 分享发送、发完即删
- **App 用法学习**：每个 App 一份经验手册，越用越顺手
- **人向记忆**：与 PC 端同构的 people json 文件，双向拷贝互通
- **新手向导**：检测手机配置 → 推荐最优模型 → 一键下载自动配置 → 权限教学

## 快速上手

1. ① 权限：无障碍（青鸟读屏）+ 通知权限 + 电池白名单（**国产 ROM 必做**：
   允许自启动 / 后台运行 / 关联启动）。
2. ② 模型：新手向导选一个下载（约 1.2~2.5GB），完成后自动加载。
3. ③ 启动青鸟（前台服务常驻通知栏），在输入框下第一个任务试试。

## 构建

```bash
bash tools/fetch-llamacpp.sh   # 拉取 llama.cpp 源码（一次性）
# 用 Android Studio 打开 mobile/ 目录，或命令行：
tools/gradle-build.bat         # 需自备 JDK17+/Android SDK/NDK/CMake
```

模型下载（ModelScope，国内直连）：App 内新手向导可一键下载。

## 声明

- QQ 自动化依赖无障碍服务，仅供个人自用；请遵守各 App 用户协议
- 本项目不收集任何数据；所有记忆/日志仅存于本机
- `AdbSetupReceiver` 是给 adb 配置用的开发通道；第三方应用无法触发它（需在
  App 内查看本机随机令牌并随广播携带，详见 `AdbSetupReceiver.kt`）

## License

MIT
