' BloomHub 开机自启入口：隐藏窗口运行 doctor.mjs
' （体检 + 自愈：QQ 客户端 → SnowLuma → DSH → 管理平台 → QQ 桥接，缺哪个拉哪个；
'   doctor 检测到组件缺失时会调 ensure-running.mjs，日志在 logs/doctor.log）
Dim sh, fso, root
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)   ' 本文件位于项目根目录，按自身位置推导（换盘/换目录不用改）
sh.CurrentDirectory = root
sh.Run "cmd /c node """ & root & "\scripts\doctor.mjs"" >> """ & root & "\logs\doctor-console.log"" 2>&1", 0, False
