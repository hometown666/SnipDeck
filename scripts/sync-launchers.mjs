#!/usr/bin/env node
/**
 * 生成桌面侧「服务启动器」.bat 到 %AHK_ROOT%\launchers（默认 C:\ahk_trigger\launchers）。
 *
 * 为什么需要这一层：
 *   `ahk.bat shell shell#N "cd /d D:\a b && python run.py"` 里的嵌套引号会被 cmd 在空格处截断，
 *   更糟的是 `&&` 后面的命令会泄漏到调用方（我们的临时 .bat）里本地执行 —— 已实测。
 *   把 cd 收进一个**路径无空格**的 launcher，片段里就只剩单个路径参数，不再有引号嵌套。
 *
 * 文件按 GBK 写：cmd 读 .bat 用的是 ANSI 代码页，UTF-8 会让中文路径变乱码。
 *
 * 用法：npm run sync:launchers（改了下面的路径就重跑一次）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import iconv from 'iconv-lite'

const bridgeRoot = process.env.AHK_ROOT ?? 'C:\\ahk_trigger'
const outDir = join(bridgeRoot, 'launchers')

const LAUNCHERS = {
  'hexo.bat': {
    cwd: 'D:\\试炼之地\\hexo-pages',
    run: 'hexo server',
    note: 'hexo 博客本地预览',
  },
  'txttunnel.bat': {
    cwd: 'D:\\试炼之地\\Temp\\control test\\TxtTunnel\\gateway',
    run: 'call npm start',
    note: 'TxtTunnel 网关（已停做，仅保留启动方式）',
  },
  'backtrans.bat': {
    cwd: 'D:\\试炼之地\\English translating\\backtrans-coach',
    run: 'python run.py',
    note: '回译教练，默认 8642',
  },
  'snipdeck.bat': {
    cwd: 'D:\\试炼之地\\remote text control',
    run: 'call npm run dev:server',
    note: 'SnipDeck 服务（前台，日志直接打在窗口里；默认 127.0.0.1:7878）',
  },
}

mkdirSync(outDir, { recursive: true })

for (const [name, spec] of Object.entries(LAUNCHERS)) {
  const lines = [
    '@echo off',
    `rem ${spec.note}`,
    `title snipdeck: ${name.replace(/\.bat$/, '')}`,
    `cd /d "${spec.cwd}"`,
    'if errorlevel 1 (',
    '  echo [snipdeck] cd 失败，检查路径是否存在',
    '  timeout /t 10 >nul',
    '  exit /b 1',
    ')',
    spec.run,
    'echo.',
    `echo [snipdeck] ${name.replace(/\.bat$/, '')} 已退出，errorlevel=%errorlevel%`,
    'timeout /t 10 >nul',
  ]
  const target = join(outDir, name)
  writeFileSync(target, iconv.encode(lines.join('\r\n') + '\r\n', 'gbk'))
  console.log(`wrote ${target}`)
}
