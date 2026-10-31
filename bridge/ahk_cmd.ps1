#Requires -Version 5.1
<#
.SYNOPSIS
  Write C:\ahk_trigger\command.txt as UTF-8 (BOM).
  Builds lnk/script paths in PowerShell so Chinese defaults are not parsed by CMD.

.NOTES
  Save this file as UTF-8 with BOM. CMD .bat cannot hold Chinese defaults safely
  (UTF-8 bytes misread as GBK → 程序 becomes 绋嬪簭).
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet(
        'raw', 'lnk', 'admin-lnk', 'script', 'shell-type',
        'slot-focus', 'slot-close', 'slot-kill', 'slot-click', 'slot-admin-kill'
    )]
    [string]$Action,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$Trigger = 'C:\ahk_trigger'
$CommandFile = Join-Path $Trigger 'command.txt'
$PasteFile = Join-Path $Trigger 'paste.txt'

# 快捷方式目录（lnk / admin-lnk 用）。Windows 没有「通用」的常用程序目录，这里缺省用桌面：
# 人人都有，而且是平铺的 —— `lnk:wechat` 直接 Join-Path 就能命中，不需要递归遍历。
# 你的程序不放在桌面，就设环境变量 PROG_DIR 指过去（你自己的那份就是这么用的）。
# 刻意不默认到「开始菜单\Programs」：那里面的 .lnk 散在子目录，单层拼接基本找不到。
$DefaultProgDir = [Environment]::GetFolderPath('Desktop')

# 跑 .ahk 脚本的目录（script 子命令用）。不是所有人都有这个东西 —— 不设就明确报错，不猜。
$DefaultAhkDir = ''
function Resolve-Dir {
    param(
        [string]$EnvValue,
        [string]$DefaultPath
    )
    $cand = if ($EnvValue) { $EnvValue.Trim() } else { '' }
    # Prefer env only if the folder actually exists (rejects CMD-mojibake 绋嬪簭)
    if ($cand -and (Test-Path -LiteralPath $cand)) {
        return $cand
    }
    # 空串不能直接丢给 Test-Path：PS 会抛「参数为空字符串」的绑定异常，
    # 而 $ErrorActionPreference='Stop' 会让它变成脚本级失败（AHK_DIR 默认就是空）
    if ($DefaultPath -and (Test-Path -LiteralPath $DefaultPath)) {
        return $DefaultPath
    }
    if ($cand) { return $cand }
    return $DefaultPath
}

# 目录没配就明确报错，别让 Join-Path 拿空字符串拼出相对路径、再让 listener 去猜
function Require-Dir([string]$Path, [string]$EnvName, [string]$What) {
    if (-not $Path) {
        throw "$EnvName 未设置：$What 需要一个目录（设环境变量 $EnvName 指向它）"
    }
    return $Path
}

function Write-CommandFile([string]$Text) {
    Set-Content -LiteralPath $CommandFile -Value $Text -Encoding utf8
}

function Write-PasteFile([string]$Text) {
    # UTF-16 LE matches listener FileEnc; listener also accepts UTF-8 fallback
    Set-Content -LiteralPath $PasteFile -Value $Text -Encoding Unicode
}

function Get-RestParts {
    @($Rest | Where-Object { $null -ne $_ -and "$_".Length -gt 0 })
}

# Termius often inserts spaces between CJK chars; CMD then splits on spaces.
function Compact-AhkSlot([string]$Slot) {
    if (-not $Slot) { return '' }
    return (($Slot -replace '[\s\u00A0]+', '').Trim())
}

function Join-AhkSlot([string[]]$Parts) {
    Compact-AhkSlot (($Parts | ForEach-Object { "$_" }) -join '')
}

$progDir = Resolve-Dir -EnvValue $env:PROG_DIR -DefaultPath $DefaultProgDir
$ahkDir = Resolve-Dir -EnvValue $env:AHK_DIR -DefaultPath $DefaultAhkDir

switch ($Action) {
    'raw' {
        if (-not $Rest -or -not ($Rest -join ' ').Trim()) {
            throw 'ahk_cmd.ps1 raw: empty command'
        }
        Write-CommandFile ($Rest -join ' ')
    }
    'lnk' {
        $name = if ($Rest -and $Rest.Count -ge 1) { $Rest[0].Trim() } else { '' }
        if (-not $name) { throw 'ahk_cmd.ps1 lnk: name required' }
        if ($name -notmatch '\.lnk$') { $name = "$name.lnk" }
        $lnk = if ($name -match '^[A-Za-z]:') { $name } else { Join-Path $progDir $name }
        if (-not (Test-Path -LiteralPath $lnk)) {
            throw "找不到快捷方式：$lnk`n（放 .lnk 的目录不是桌面的话，设环境变量 PROG_DIR 指过去）"
        }
        Write-CommandFile $lnk
    }
    'admin-lnk' {
        $name = if ($Rest -and $Rest.Count -ge 1) { $Rest[0].Trim() } else { '' }
        if (-not $name) { throw 'ahk_cmd.ps1 admin-lnk: name required' }
        if ($name -notmatch '\.lnk$') { $name = "$name.lnk" }
        $lnk = if ($name -match '^[A-Za-z]:') { $name } else { Join-Path $progDir $name }
        if (-not (Test-Path -LiteralPath $lnk)) {
            throw "找不到快捷方式：$lnk`n（放 .lnk 的目录不是桌面的话，设环境变量 PROG_DIR 指过去）"
        }
        Write-CommandFile ('admin:' + $lnk)
    }
    'script' {
        $ahkDir = Require-Dir $ahkDir 'AHK_DIR' 'script'
        $name = if ($Rest -and $Rest.Count -ge 1) { $Rest[0].Trim() } else { '' }
        if (-not $name) { throw 'ahk_cmd.ps1 script: name required' }
        if ($name -notmatch '\.ahk$') { $name = "$name.ahk" }
        Write-CommandFile (Join-Path $ahkDir $name)
    }
    'shell-type' {
        # shell-type <slot> <command...>  → paste.txt + command.txt "shell:<slot>"
        if (-not $Rest -or $Rest.Count -lt 2) {
            throw 'ahk_cmd.ps1 shell-type: slot and command required'
        }
        $slot = Compact-AhkSlot $Rest[0]
        $cmdText = ($Rest[1..($Rest.Count - 1)] -join ' ').Trim()
        if (-not $slot) { throw 'ahk_cmd.ps1 shell-type: empty slot' }
        if (-not $cmdText) { throw 'ahk_cmd.ps1 shell-type: empty command' }
        Write-PasteFile $cmdText
        Write-CommandFile ("shell:" + $slot)
    }
    'slot-focus' {
        $slot = Join-AhkSlot (Get-RestParts)
        if (-not $slot) { throw 'ahk_cmd.ps1 slot-focus: slot required' }
        Write-CommandFile ("focus:" + $slot)
    }
    'slot-close' {
        $slot = Join-AhkSlot (Get-RestParts)
        if (-not $slot) { throw 'ahk_cmd.ps1 slot-close: slot required' }
        Write-CommandFile ("close:" + $slot)
    }
    'slot-kill' {
        $slot = Join-AhkSlot (Get-RestParts)
        if (-not $slot) { throw 'ahk_cmd.ps1 slot-kill: slot required' }
        Write-CommandFile ("kill:" + $slot)
    }
    'slot-admin-kill' {
        $slot = Join-AhkSlot (Get-RestParts)
        if (-not $slot) { throw 'ahk_cmd.ps1 slot-admin-kill: slot required' }
        Write-CommandFile ("admin:kill:" + $slot)
    }
    'slot-click' {
        $parts = @(Get-RestParts)
        if ($parts.Count -lt 3) {
            throw 'ahk_cmd.ps1 slot-click: need <slot...> <x> <y>'
        }
        $y = $parts[-1]
        $x = $parts[-2]
        if ($x -notmatch '^-?\d+$' -or $y -notmatch '^-?\d+$') {
            throw "ahk_cmd.ps1 slot-click: x/y must be integers (got x=$x y=$y)"
        }
        $slot = Join-AhkSlot @($parts[0..($parts.Count - 3)])
        if (-not $slot) { throw 'ahk_cmd.ps1 slot-click: empty slot' }
        Write-CommandFile ("click:${slot}|$x|$y")
    }
}
