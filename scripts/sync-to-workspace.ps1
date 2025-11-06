# Copies the current repo's index.html and renderer app.js into the app workspace used by the running Electron app.
# Run this in PowerShell as an administrator or a normal user.

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$repoRoot = Resolve-Path "$repoRoot\.."   # scripts/ is under repo root

$sourceIndex = "$repoRoot\index.html"
$sourceAppJs  = "$repoRoot\src\renderer\app.js"

$workspaceRoot = "$env:APPDATA\ink-doodle\workspace"
$destIndex = "$workspaceRoot\index.html"
$destAppJs  = "$workspaceRoot\src\renderer\app.js"

Write-Host "Repo root: $repoRoot"
Write-Host "Workspace: $workspaceRoot"

if (!(Test-Path $workspaceRoot)) {
    Write-Host "Workspace folder does not exist: $workspaceRoot" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $workspaceRoot -Force | Out-Null
}

# Ensure dest subfolders exist
$destRendererDir = Split-Path $destAppJs -Parent
if (!(Test-Path $destRendererDir)) { New-Item -ItemType Directory -Path $destRendererDir -Force | Out-Null }

Copy-Item -Path $sourceIndex -Destination $destIndex -Force
Copy-Item -Path $sourceAppJs -Destination $destAppJs -Force

Write-Host "Copied index.html -> $destIndex"
Write-Host "Copied app.js -> $destAppJs"

# Optionally tail debug log
$debugLog = "$workspaceRoot\debug.log"
if (Test-Path $debugLog) {
    Write-Host "Tailing debug log: $debugLog (press Ctrl+C to stop)"
    Get-Content -Path $debugLog -Tail 50 -Wait
} else {
    Write-Host "No debug log found at $debugLog"
}
