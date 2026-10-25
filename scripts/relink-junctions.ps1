$ErrorActionPreference = 'Stop'
# Remove old junctions (link only, target content untouched)
foreach ($p in 'D:\harnessWorkspace\qq-bridge', 'D:\harnessWorkspace\.dsh\bili-duty') {
    $item = Get-Item $p -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq 'Junction') {
        [System.IO.Directory]::Delete($p, $false)
        Write-Host "removed junction: $p"
    } elseif (-not $item) {
        Write-Host "already missing: $p"
    } else {
        throw "refusing to touch non-junction path: $p"
    }
}
# Recreate junctions pointing at the renamed folders
New-Item -ItemType Junction -Path 'D:\harnessWorkspace\qq-bridge' -Value 'D:\harnessWorkspace\bloom-hub\qq-bridge' | Out-Null
New-Item -ItemType Junction -Path 'D:\harnessWorkspace\.dsh\bili-duty' -Value 'D:\harnessWorkspace\bloom-hub\bili-duty' | Out-Null
Get-Item 'D:\harnessWorkspace\qq-bridge', 'D:\harnessWorkspace\.dsh\bili-duty' | Select-Object FullName, LinkType, Target | Format-List
Write-Host ("bridge via old path: " + (Test-Path 'D:\harnessWorkspace\qq-bridge\src\bridge.js'))
Write-Host ("duty via home junction: " + (Test-Path 'D:\harnessWorkspace\.dsh\bili-duty\mcp_server.py'))
