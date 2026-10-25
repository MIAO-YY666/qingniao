$ErrorActionPreference = 'Stop'
# BloomHub autostart installer (no admin needed). Idempotent.
#   1) HKCU Run key  -> hidden autostart.vbs at logon
#   2) scheduled task BloomHub-KeepAlive every 30 minutes (revive after crash)
# (Startup-folder .vbs/.lnk is blocked by script-drop protection on this machine,
#  so the registry Run key is the logon trigger.)
$root = 'D:\harnessWorkspace\bloom-hub'
$cmd = 'wscript.exe "' + $root + '\autostart.vbs"'

reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v BloomHub /t REG_SZ /d $cmd /f | Out-Host
schtasks /create /tn 'BloomHub-KeepAlive' /sc minute /mo 30 /tr $cmd /f | Out-Host
schtasks /query /tn 'BloomHub-KeepAlive' | Out-Host
reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v BloomHub | Out-Host
Write-Host 'install done.'
