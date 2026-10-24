# SnipDeck 服务启动脚本（手动 / 计划任务都走这里）
#
# 为什么要跑在「登录时的用户会话」而不是 Session 0：
# exec 驱动最终由桌面上的 listener.ahk 执行 GUI 动作，服务必须看得见那个桌面。
#
# 日志重定向交给 cmd：PowerShell 的 `*>>` 会用当前代码页转码原生进程输出，
# 中文路径与中文日志会变成 `璇曠偧涔嬪湴` 这种乱码；cmd 是原样追加字节。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 读 .env（KEY=VALUE，允许 # 注释与引号）
if (Test-Path '.env') {
  Get-Content '.env' -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $key = $matches[1]
      $value = $matches[2].Trim().Trim('"').Trim("'")
      Set-Item -Path "env:$key" -Value $value
    }
  }
}

if (-not $env:SNIPDECK_HOST) { $env:SNIPDECK_HOST = '127.0.0.1' }
if (-not $env:SNIPDECK_PORT) { $env:SNIPDECK_PORT = '7878' }

$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'server.log'

Write-Host "[snipdeck] $($env:SNIPDECK_HOST):$($env:SNIPDECK_PORT)  log -> $log"

$inner = 'node --import tsx packages/server/src/server.ts >> "' + $log + '" 2>&1'
& cmd.exe /d /s /c $inner
