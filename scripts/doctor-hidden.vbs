' bloom-hub 保活入口：隐藏窗口跑 doctor.mjs（体检 + 自愈 + 拉起缺失组件）
' 注意：WshShell 的 CurrentDirectory 只对同一个实例生效，且这里一律用绝对路径，
'       避免计划任务把工作目录落到 System32 导致 node / 日志相对路径失效。
Dim sh, fso, root
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))   ' 本文件在 scripts\，上一级才是项目根
sh.CurrentDirectory = root
sh.Run "cmd /c node """ & root & "\scripts\doctor.mjs"" >> """ & root & "\logs\doctor-console.log"" 2>&1", 0, False
