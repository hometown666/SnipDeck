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

# 启动前轮转：单文件超 5MB 就挪成 server.log.1，只留一份。
# 只在这里轮转是够的——服务靠 `cmd >>` 独占句柄追加，运行中动它会失败；
# 而启动前这一刻要么没有实例，要么旧实例还占着句柄（那就跳过，下次再说）。
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
  try {
    Move-Item -Force $log (Join-Path $logDir 'server.log.1')
    Write-Host "[snipdeck] 日志已轮转：server.log → server.log.1"
  } catch {
    Write-Host "[snipdeck] 日志轮转失败（可能另一实例正占用），继续启动"
  }
}

Write-Host "[snipdeck] $($env:SNIPDECK_HOST):$($env:SNIPDECK_PORT)  log -> $log"

$inner = 'node --import tsx packages/server/src/server.ts >> "' + $log + '" 2>&1'
& cmd.exe /d /s /c $inner
