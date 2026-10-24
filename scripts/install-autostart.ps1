# 注册 / 卸载 SnipDeck 服务为「登录时启动」计划任务
#
# 用法（普通权限即可，不需要管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Uninstall
#
# 说明：
#   - 触发器是「用户登录」，所以服务跑在交互桌面会话里 —— 这是能驱动 GUI 的前提。
#   - 日志：data\logs\server.log
#   - 只注册自己账户下的任务，不需要提权；若要「未登录也运行」需另配凭据（本脚本不做）。
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'SnipDeck-server'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除计划任务 $TaskName"
  } else {
    Write-Host "未安装 $TaskName"
  }
  return
}

$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-server.ps1'
if (-not (Test-Path $startScript)) { throw "找不到 $startScript" }
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '提示：node_modules 不存在，先跑 npm install' -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'SnipDeck 片段坞服务（用户会话，可驱动桌面 GUI）' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Write-Host "已安装。日志：$(Join-Path $root 'data\logs\server.log')"
