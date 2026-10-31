#!/usr/bin/env node
/**
 * bridge/ 的护栏：这里放的是**别人机器上也要能跑**的通用版，
 * 一旦有人把自己的定制版整份拷回来，功能不会立刻坏，但会悄悄带进：
 *   - 私有路径（D:\Users\Desktop\程序 这类）
 *   - 只在某人桌面上成立的工作流（cursor:*）
 *   - 被裁断/空掉的文件
 * 这些东西跑测试是发现不了的（测试不读 ahk 源码），所以单列一道静态检查。
 *
 * 只查代码（.ahk / .bat / .ps1）。README 里提 `cursor:*` 是**说明已移除**，属正常。
 *
 * 用法：npm run check:bridge
 * 退出码：有问题 1
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BRIDGE = join(ROOT, 'bridge')

const FILES = [
  { name: 'listener.ahk', minLines: 1000 },
  { name: 'ahk.bat', minLines: 300 },
  { name: 'ahk_cmd.ps1', minLines: 100 },
]

/** 私人痕迹：仓库是通用件，出现这些就说明有人把定制版拷进来了 */
const PRIVATE = [
  { re: /Kakyo/i, why: '本机用户名' },
  { re: /control test/i, why: '本机定制版目录名' },
  { re: /试炼之地/, why: '本机工作区路径' },
  { re: /Desktop\\\\?程序/, why: '本机常用程序目录' },
]

let pass = 0
const failures = []

function ok(label, detail = '') {
  pass++
  console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
}

function bad(label, detail, hint) {
  failures.push(label)
  console.log(`  ✗ ${label}  ${detail}`)
  if (hint) console.log(`      → ${hint}`)
}

console.log('\nbridge/ 护栏')
console.log('─'.repeat(58))

const texts = new Map()
for (const { name, minLines } of FILES) {
  const file = join(BRIDGE, name)
  if (!existsSync(file)) {
    bad(`${name} 存在`, '缺失', '从 npm run install:bridge 的反向恢复不了：这个文件属于仓库')
    continue
  }
  const buf = readFileSync(file)
  const text = buf.toString('utf8')
  texts.set(name, text)
  const lines = text.split('\n').length
  // 行数是最便宜的完整性检查：空文件、被截断的文件都能通过 existsSync
  if (lines < minLines) bad(`${name} 完整`, `${lines} 行，低于 ${minLines}`, '多半被截断或拷了空壳')
  else ok(`${name} 完整`, `${lines} 行 / ${statSync(file).size} B`)

  for (const { re, why } of PRIVATE) {
    if (re.test(text)) bad(`${name} 不含私人路径`, `命中「${why}」`, '把个人路径改成环境变量或删掉')
  }
}

const listener = texts.get('listener.ahk') ?? ''
const cmd = texts.get('ahk_cmd.ps1') ?? ''
const bat = texts.get('ahk.bat') ?? ''

// 通用版的核心承诺：不含 cursor 工作流
if (/cursor:/i.test(listener)) bad('listener 不含 cursor:*', '发现 cursor: 命令分支', '那是本机工作流，不进通用版')
else ok('listener 不含 cursor:*')
if (/CursorCmd\s*\(/.test(listener)) bad('listener 不含 CursorCmd', '函数没裁干净', '连同调用点一起删')
else ok('listener 不含 CursorCmd')
if (/WatchExes\s*:=\s*\[[^\]]*Cursor\.exe/i.test(listener))
  bad('WatchExes 不含 Cursor.exe', '监控表还留着', '它只影响 status.txt 展示，删掉即可')
else ok('WatchExes 不含 Cursor.exe')

// 桥协议本身不能少
if (!/TriggerDir\s*:=/.test(listener)) bad('listener 声明 TriggerDir', '没找到', '桥靠这个目录收发命令')
else ok('listener 声明 TriggerDir')
if (!/ahk_cmd\.ps1/i.test(bat)) bad('ahk.bat 调 ahk_cmd.ps1', '没找到引用', '中文/路径参数全走那一道')
else ok('ahk.bat 调 ahk_cmd.ps1')

// 目录默认值必须来自环境或系统 API，不能写死某人的盘
const hardcoded = /\$Default(Prog|Ahk)Dir\s*=\s*['"][A-Za-z]:/i.exec(cmd)
if (hardcoded) bad('ahk_cmd.ps1 不含写死目录', hardcoded[0], '默认值用 [Environment]::GetFolderPath 或留空')
else ok('ahk_cmd.ps1 不含写死目录')
if (!/Require-Dir/.test(cmd)) bad('ahk_cmd.ps1 有目录缺失检查', '没找到 Require-Dir', '缺目录要明确报错，不能拼相对路径')
else ok('ahk_cmd.ps1 有目录缺失检查')

// ahk_cmd.ps1 是 .ps1：无 BOM 会被 PS 5.1 按 CP936 读（与 check:ps1 重叠，这里为了单跑也能发现）
const rawCmd = existsSync(join(BRIDGE, 'ahk_cmd.ps1')) ? readFileSync(join(BRIDGE, 'ahk_cmd.ps1')) : null
if (rawCmd && !(rawCmd[0] === 0xef && rawCmd[1] === 0xbb && rawCmd[2] === 0xbf))
  bad('ahk_cmd.ps1 带 UTF-8 BOM', '没有 BOM', 'PS 5.1 会按 CP936 读，中文注释让引号错位')
else if (rawCmd) ok('ahk_cmd.ps1 带 UTF-8 BOM')

console.log('─'.repeat(58))
if (failures.length > 0) {
  console.log(`${pass} 项通过，${failures.length} 项不合格\n`)
  process.exit(1)
}
console.log(`全部通过（${pass} 项）\n`)
