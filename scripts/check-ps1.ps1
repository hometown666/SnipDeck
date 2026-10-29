# 校验仓库里所有 .ps1：必须 UTF-8 with BOM，且能通过 PowerShell 自己的语法解析。
#
# 为什么要这个门禁：PowerShell 5.1 在没有 BOM 时按 CP936 解码 .ps1，中文注释里的
# 三字节字符会被拆成「GBK 汉字 + 孤字节」，孤字节吞掉后面的 ASCII（通常是引号），
# 字符串终止符消失 → 解析失败 → 脚本一行都不执行。install-autostart.ps1 就这样
# 从 2026-10 一直坏到 2026-10-30，谁都没发现，因为「跑不起来」和「跑起来没效果」
# 在现象上差不多（详见 docs/00-issues.md §0.9 ISSUE-017）。
#
# 用法：npm run check:ps1（已串进 npm test）
$ErrorActionPreference = 'Stop'
# 输出被重定向时（npm/CI 管道）PowerShell 5.1 默认按 ANSI 写 stdout，中文提示会变乱码。
# 只在重定向时切 UTF-8：直接开窗口跑仍用控制台默认，不会反过来乱。
if ([Console]::IsOutputRedirected) {
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
}
$root = Split-Path -Parent $PSScriptRoot

$files = Get-ChildItem -Path $root -Filter *.ps1 -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' }

if (-not $files -or $files.Count -eq 0) {
  Write-Host '没有找到 .ps1，跳过'
  exit 0
}

$fail = 0
foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $hasBom = ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)

  $errs = $null
  $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
  $parseOk = (-not $errs) -or ($errs.Count -eq 0)

  if ($hasBom -and $parseOk) {
    Write-Host "  OK   $rel"
    continue
  }

  $fail++
  $why = @()
  if (-not $hasBom) { $why += '缺 UTF-8 BOM（编辑器保存时别关「带 BOM」）' }
  if (-not $parseOk) {
    $first = $errs[0]
    $why += "语法错误 $($errs.Count) 条，首个在行 $($first.Extent.StartLineNumber)：$($first.Message)"
  }
  Write-Host "  FAIL $rel —— $($why -join '；')"
}

Write-Host ''
if ($fail -gt 0) {
  Write-Host "结果: $fail 个脚本不合格（共 $($files.Count) 个）"
  exit 1
}
Write-Host "结果: $($files.Count) 个脚本全部合格"
exit 0
