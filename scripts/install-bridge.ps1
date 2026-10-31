#Requires -Version 5.1
<#
.SYNOPSIS
  把仓库 bridge/ 里的三个桥文件装到本机 C:\ahk_trigger。

.DESCRIPTION
  这个项目的执行端不在仓库里（AutoHotkey 运行时 + C:\ahk_trigger 下的脚本），
  新机器上光 npm install 是跑不起来的。这个脚本负责把「能进版本库的那部分」装到位。

  三条规矩：
  1. **不静默覆盖**：目标已存在且内容不同 → 先改名成 *.bak.<时间戳>，再写新的。
     本机那份可能被你改过（比如加了监控的进程），覆盖前必须留退路。
  2. **不装软件**：AutoHotkey 没装时只打印安装命令，不替你执行。
  3. **幂等**：内容相同就跳过，重复跑不会产生一堆 .bak。

.PARAMETER DryRun
  只说会做什么，不动任何文件。

.PARAMETER Start
  装完顺便启动 listener（会以当前权限运行；驱动桌面 GUI 需要它在桌面会话里）。

.PARAMETER Target
  桥目录，默认 C:\ahk_trigger。**改它之前先确认 ahk.bat 与 listener.ahk 里的
  TriggerDir 也改了**，否则两边对不上。

.EXAMPLE
  npm run install:bridge
  npm run install:bridge -- -DryRun
  npm run install:bridge -- -Start
#>
param(
    [switch]$DryRun,
    [switch]$Start,
    [string]$Target = 'C:\ahk_trigger'
)

$ErrorActionPreference = 'Stop'

# Write-Host 走 console host，不吃管道的 UTF-8 默认值：不显式设的话，
# 中文在 Git Bash / 重定向里会变成乱码。只影响本进程，退出即恢复。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BridgeSrc = Join-Path $RepoRoot 'bridge'
$Files = @('listener.ahk', 'ahk.bat', 'ahk_cmd.ps1')

Write-Host ''
Write-Host "SnipDeck 桥安装"
Write-Host ("-" * 58)
Write-Host "  源   $BridgeSrc"
Write-Host "  目标 $Target"
if ($DryRun) { Write-Host "  模式 只说不做（-DryRun）" -ForegroundColor Yellow }
Write-Host ''

if (-not (Test-Path -LiteralPath $BridgeSrc)) {
    throw "找不到 $BridgeSrc —— 这个脚本要在仓库里的 scripts/ 目录下运行"
}

# ---- 1. AutoHotkey v2 ------------------------------------------------------
$AhkExe = @(
    'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe',
    'C:\Program Files\AutoHotkey\v2\AutoHotkey32.exe',
    'C:\Program Files (x86)\AutoHotkey\v2\AutoHotkey32.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($AhkExe) {
    Write-Host "  OK  AutoHotkey v2：$AhkExe" -ForegroundColor Green
} else {
    Write-Host "  缺  AutoHotkey v2 没装 —— listener.ahk 是 .ahk 脚本，没有它跑不起来" -ForegroundColor Red
    Write-Host "      装：winget install AutoHotkey.AutoHotkey" -ForegroundColor Yellow
    Write-Host "      （装完重开终端再跑一次这个脚本）"
    if (-not $DryRun) { exit 1 }
}

# ---- 2. 目标目录 -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $Target)) {
    if ($DryRun) {
        Write-Host "  新  目录不存在，会创建 $Target"
    } else {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        Write-Host "  +   创建 $Target" -ForegroundColor Green
    }
}

# ---- 3. 三个文件 -----------------------------------------------------------
$copied = 0
$skipped = 0
$backedUp = 0

foreach ($name in $Files) {
    $src = Join-Path $BridgeSrc $name
    $dst = Join-Path $Target $name

    if (-not (Test-Path -LiteralPath $src)) {
        Write-Host "  !   $name 在 bridge/ 里不存在，跳过" -ForegroundColor Yellow
        continue
    }

    if (-not (Test-Path -LiteralPath $dst)) {
        if ($DryRun) {
            Write-Host "  +   $name（新建）"
        } else {
            Copy-Item -LiteralPath $src -Destination $dst
            Write-Host "  +   $name" -ForegroundColor Green
        }
        $copied++
        continue
    }

    $same = (Get-FileHash -LiteralPath $src).Hash -eq (Get-FileHash -LiteralPath $dst).Hash
    if ($same) {
        Write-Host "  =   $name（内容相同，跳过）"
        $skipped++
        continue
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$dst.bak.$stamp"
    if ($DryRun) {
        Write-Host "  ~   $name（内容不同：会备份成 $(Split-Path -Leaf $bak) 再覆盖）"
    } else {
        try {
            Move-Item -LiteralPath $dst -Destination $bak
            Copy-Item -LiteralPath $src -Destination $dst
            Write-Host "  !   $name（旧的已备份为 $(Split-Path -Leaf $bak)）" -ForegroundColor Yellow
            $backedUp++
        } catch {
            Write-Host "  x   $name 覆盖失败：$($_.Exception.Message)" -ForegroundColor Red
            Write-Host "      如果 listener 正在跑，先把它退出再试" -ForegroundColor Yellow
        }
    }
}

Write-Host ''
Write-Host ("-" * 58)
if ($DryRun) {
    Write-Host "（-DryRun）没有改动任何文件"
    exit 0
}
Write-Host "新建 $copied / 跳过 $skipped / 备份并覆盖 $backedUp"

# ---- 4. 下一步 -------------------------------------------------------------
$listener = Join-Path $Target 'listener.ahk'
if ($Start -and $AhkExe -and (Test-Path -LiteralPath $listener)) {
    Write-Host ''
    Write-Host "  启动 listener：$listener"
    Start-Process -FilePath $AhkExe -ArgumentList "`"$listener`""
    Start-Sleep -Seconds 2
    Write-Host "  已启动。用 npm run doctor 确认 bridge up" -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "下一步："
    Write-Host "  1. 运行 $listener（要常驻；它需要在桌面会话里，才能操作窗口）"
    Write-Host "     或者重跑本脚本加 -Start 让它替你启动"
    Write-Host "  2. npm run doctor 确认 bridge up"
}
Write-Host ''
