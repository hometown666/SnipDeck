# SnipDeck 令牌与监听地址配置助手
#
# 用途：
#   1) 生成（或指定）远端准入 token，写入 .env，供 scripts/start-server.ps1 读取；
#   2) 设置 SNIPDECK_HOST（监听地址）。配合 tailscale serve 时应用绑 127.0.0.1，
#      由 serve 做 TLS 终结与对外暴露（见 docs/08-https.md 阶段 A）。
#
# 用法（普通运行，只持久化到 .env）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-token.ps1 [-Token <str>] [-HostAddress <str>] [-Rotate] [-Show]
#
# 用法（点源，同时写入当前 shell，便于立刻 npm run dev:server 测试）：
#   . .\scripts\set-token.ps1 -Rotate
#
# 参数：
#   -Token       直接指定 token（不指定时保留 .env 现有值；不存在则生成）
#   -HostAddress SNIPDECK_HOST，默认 127.0.0.1（tailscale serve 模型）。
#                注意：勿与 PowerShell 自动变量 $Host 混淆，故取名 HostAddress。
#   -Rotate      强制重新生成 token（即使 .env 里已有）
#   -Show        只打印当前 .env 的 token/host，不改写文件

param(
  [string]$Token,
  [string]$HostAddress,
  [switch]$Rotate,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root '.env'

# 读现有 .env（保留全部行：注释、顺序、其它键）
$lines = @()
if (Test-Path $envFile) {
  $lines = Get-Content $envFile -Encoding UTF8
}

function Get-EnvValue($key) {
  foreach ($l in $lines) {
    if ($l -match "^$key\s*=\s*(.*)$") {
      return $matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Set-EnvLine($key, $value) {
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^$key\s*=") {
      $lines[$i] = "$key=$value"
      $found = $true
      break
    }
  }
  if (-not $found) { $lines += "$key=$value" }
}

function New-Token {
  # 24 字节随机 → base64url（URL 安全，适合放进 WS query 的 token 参数）
  # RandomNumberGenerator 是抽象类，必须 Create() 出实例再 GetBytes
  $b = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [System.Convert]::ToBase64String($b) -replace '\+', '-' -replace '/', '_' -replace '='
}

if ($Show) {
  Write-Host "SNIPDECK_HOST = $(Get-EnvValue 'SNIPDECK_HOST')"
  Write-Host "SNIP_TOKEN    = $(Get-EnvValue 'SNIP_TOKEN')"
  return
}

# —— 决定 token ——
$newToken = $Token
if (-not $newToken) {
  if ($Rotate) {
    $newToken = New-Token
  }
  else {
    $existing = Get-EnvValue 'SNIP_TOKEN'
    $newToken = if ($existing) { $existing } else { New-Token }
  }
}

# —— 决定 host ——
$newHost = if ($HostAddress) { $HostAddress } else { '127.0.0.1' }

# —— 基本校验 ——
if (-not $newToken -or $newToken.Length -lt 8) {
  Write-Error "token 太短或为空（至少 8 位）"
  exit 1
}
if ($newHost -notmatch '^[A-Za-z0-9._:-]+$') {
  Write-Error "host 地址不合法：$newHost"
  exit 1
}

Set-EnvLine 'SNIP_TOKEN' $newToken
Set-EnvLine 'SNIPDECK_HOST' $newHost

# 写回 .env（UTF-8 含 BOM，保留注释与顺序；start-server.ps1 用 -Encoding UTF8 读取）
Set-Content $envFile -Encoding UTF8 -Value $lines

# 同时导出到当前 shell（点源时生效；普通 -File 运行只影响子进程，但 .env 已持久化）
$env:SNIP_TOKEN = $newToken
$env:SNIPDECK_HOST = $newHost

Write-Host "[snipdeck] SNIPDECK_HOST = $newHost"
Write-Host "[snipdeck] SNIP_TOKEN 已写入 .env（并导出到当前 shell）:"
Write-Host "  $newToken"
Write-Host "[snipdeck] 手机端可用此 token 生成配对链接/二维码（见 docs/08-https.md 阶段 C2）。"
Write-Host "[snipdeck] 要让当前 shell 立即生效（不重开终端），请点源运行：. .\scripts\set-token.ps1 ..."



