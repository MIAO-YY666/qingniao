' BloomHub 开机自启入口：隐藏窗口运行 ensure-running.mjs
' （QQ 客户端 → SnowLuma → 管理平台 → QQ 桥接，缺哪个拉哪个，幂等可重复执行）
CreateObject("Wscript.Shell").CurrentDirectory = "D:\harnessWorkspace\bloom-hub"
CreateObject("Wscript.Shell").Run "cmd /c node scripts\ensure-running.mjs >> logs\ensure-running.log 2>&1", 0, False
