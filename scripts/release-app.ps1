# 一键发布手机 App
#   1) 读 app/build.gradle.kts 里的 versionName / versionCode
#   2) 编译 debug APK
#   3) 生成 public/app/latest.json（App 内「检查更新」读这个文件）
#   4) 上传 APK + latest.json 到中转服务器并放进 relay 容器
#
# 用法：
#   pwsh -File .\scripts\release-app.ps1 -Notes "本次更新说明"
# 版本号请先在 app/build.gradle.kts 里手动改大（versionCode 必须递增）。

param(
    [string]$Notes = "",
    [string]$Server = '',
    [string]$SshKey = ''
)

$ErrorActionPreference = "Stop"
if (-not $Server -or -not $SshKey) {
    $sf = Join-Path (Split-Path $PSScriptRoot -Parent) '.secrets.local.json'
    if (Test-Path $sf) {
        $s = Get-Content $sf -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $Server) { $Server = ($s.server -replace '^https?://', '') }
        if (-not $SshKey) { $SshKey = $s.sshKey }
    }
}
if (-not $Server -or -not $SshKey) { throw '缺少服务器地址或 SSH 私钥：请在 .secrets.local.json 里配置 server / sshKey，或用 -Server / -SshKey 传入。' }
$root = Split-Path $PSScriptRoot -Parent
$proj = Join-Path (Split-Path $PSScriptRoot -Parent) "android"

# ---- 1. 版本号 ----
$gradle = Get-Content -Raw -Encoding UTF8 "$proj\app\build.gradle.kts"
$versionName = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
$versionCode = [regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value
if (-not $versionName -or -not $versionCode) { throw "没能从 build.gradle.kts 读到版本号" }
Write-Host "发布版本：$versionName (versionCode=$versionCode)"

# ---- 2. 编译 ----
Push-Location $proj
try {
    cmd /c "gradlew.bat assembleDebug > release-build.log 2>&1"
    if ($LASTEXITCODE -ne 0) {
        Get-Content release-build.log -Tail 20
        throw "编译失败"
    }
} finally { Pop-Location }

$srcApk = "$proj\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $srcApk)) { throw "没找到编译产物：$srcApk" }
$apkName = "dsh-console-app-$versionName.apk"
$apk = "$root\$apkName"
Copy-Item $srcApk $apk -Force

# ---- 3. latest.json ----
$json = [ordered]@{
    versionName = $versionName
    versionCode = [int]$versionCode
    url         = "/$apkName"
    size        = (Get-Item $apk).Length
    sha256      = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
    notes       = $Notes
    publishedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
} | ConvertTo-Json
$manifestDir = "$root\relay\public\app"
New-Item -ItemType Directory -Force $manifestDir | Out-Null
[System.IO.File]::WriteAllText("$manifestDir\latest.json", $json, (New-Object System.Text.UTF8Encoding($false)))

# ---- 4. 上传 ----
# 服务器目录与容器名可用环境变量覆盖（历史部署叫 dsh-remote，新部署叫 dsh-console）
$remoteDir = if ($env:RELAY_DIR) { $env:RELAY_DIR } else { '/opt/dsh-remote' }
$container = if ($env:RELAY_CONTAINER) { $env:RELAY_CONTAINER } else { 'dsh-remote-relay-1' }
scp -o StrictHostKeyChecking=no -i $SshKey $apk "root@${Server}:$remoteDir/relay/public/" | Out-Null
scp -o StrictHostKeyChecking=no -i $SshKey "$manifestDir\latest.json" "root@${Server}:$remoteDir/relay/public/app/" | Out-Null
ssh -o StrictHostKeyChecking=no -i $SshKey "root@$Server" "docker cp $remoteDir/relay/public/$apkName ${container}:/app/public/ ; docker exec $container mkdir -p /app/public/app ; docker cp $remoteDir/relay/public/app/latest.json ${container}:/app/public/app/latest.json ; echo PUBLISHED"

Write-Host "完成：http://$Server/$apkName"
Write-Host "手机上打开 App → 设置 → 应用更新 → 检查更新，即可安装。"
