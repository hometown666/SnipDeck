#!/usr/bin/env node
/**
 * 清 data/tmp：临时 .cmd 与 CDP profile 目录。
 *
 * 为什么要有：data/tmp 里有四类垃圾会一直长——
 *   1. run-<runId>.cmd  每次走「复杂命令」路径留一份，默认保留 7 天供排查；
 *   2. *-profile/       各 UI 回归脚本的 Chrome --user-data-dir，各十几 MB；
 *   3. probe-<名字>/     同上，只是名字没带 `-profile`（`probe-vp` 之类的视口探测副本）。
 *      它们同样是 Chrome --user-data-dir，12MB 一份，一开始漏在匹配规则外，永远清不掉。
 *      注意：**只认目录**。同级的 `probe*.cjs` 是文档引用的复现脚本，不能被当成 profile 删掉。
 *   4. pty-probe/node_modules/  P5 前置验证时装过 node-pty，64MB。
 *      同目录的 probe*.cjs 与 RESULT.md 是文档引用的复现材料，**不删**。
 *   5. *.png             各次 UI 回归的截图，一张几百 KB，累积起来比 profile 还多。
 *      截图只在排查当下有用，过期就没价值了——按天删，`--all` 也**不**碰它
 *      （有人会把某张留着当对比图）。
 * 服务端的 prune 只管 data/runs，管不到这里；实测堆到 174MB。
 *
 * 用法：
 *   npm run clean:tmp            # 删 7 天前的（run-*.cmd、*-profile、probe-<名字>、*.png）
 *   npm run clean:tmp -- --dry   # 只看会删什么，不动手
 *   npm run clean:tmp -- --days 1
 *   npm run clean:tmp -- --all   # 忽略年龄，profile 目录全删（服务运行时别用，
 *                                #   正在跑的 ui 脚本会失去 profile）
 * 只删这几类明确匹配的项，data/tmp 里其他东西（诊断脚本、RESULT.md）一律不碰。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { removeQuietly } from './lib/profile.mjs'

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const all = argv.includes('--all')
const daysArg = argv.indexOf('--days')
const days = daysArg >= 0 ? Number(argv[daysArg + 1]) : 7
if (!Number.isFinite(days) || days < 0) {
  console.error('--days 需要一个 ≥ 0 的数字')
  process.exit(2)
}

const tmpDir = resolve(process.cwd(), 'data/tmp')
if (!existsSync(tmpDir)) {
  console.log('data/tmp 不存在，没什么可清')
  process.exit(0)
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

// profile 目录有两条命名：`*-profile` 是现在 UI 脚本用的，`probe-*` 是早期视口探测留下的
// （同样是 Chrome --user-data-dir，12MB 一份）。必须同时要求「是目录」——
// 同级的 `probe*.cjs` 是文档引用的复现脚本，光看前缀会把它一起删掉。
const isProfileDir = (name, st) =>
  st.isDirectory() && (name.endsWith('-profile') || name.startsWith('probe-'))
const isRunCmd = (name) => /^run-.+\.cmd$/.test(name)
const isShot = (name) => /\.png$/i.test(name)

let freed = 0
let count = 0
const kept = []

for (const name of readdirSync(tmpDir)) {
  const path = join(tmpDir, name)
  let st
  try {
    st = statSync(path)
  } catch {
    continue
  }
  const profile = isProfileDir(name, st)
  if (!profile && !isRunCmd(name) && !isShot(name)) continue
  const expired = all ? profile : st.mtimeMs < cutoff
  if (!expired) {
    kept.push(name)
    continue
  }
  const size = dirSize(path)
  if (dry) {
    console.log(`  · 会删 ${name}  ${mb(size)}`)
  } else if (removeQuietly(path)) {
    console.log(`  ✓ 删除 ${name}  ${mb(size)}`)
    freed += size
    count++
  }
}

// 探针目录里的依赖：`probe*.cjs` 与 `RESULT.md` 是文档引用的复现材料，留着；
// 但 `node-pty` 装出来的 64MB `node_modules` 不该常驻——需要时 `npm install` 重装即可。
const probeDeps = join(tmpDir, 'pty-probe', 'node_modules')
if (existsSync(probeDeps)) {
  let expired = all
  try {
    expired = expired || statSync(probeDeps).mtimeMs < cutoff
  } catch {
    expired = false
  }
  if (!expired) {
    kept.push('pty-probe/node_modules')
  } else {
    const size = dirSize(probeDeps)
    if (dry) {
      console.log(`  · 会删 pty-probe/node_modules  ${mb(size)}`)
    } else if (removeQuietly(probeDeps)) {
      console.log(`  ✓ 删除 pty-probe/node_modules  ${mb(size)}`)
      freed += size
      count++
    }
  }
}

if (dry) {
  console.log(`\n（dry-run）以上为 ${days} 天前就没再更新过的项，未删除任何文件`)
} else {
  console.log(`\n删除 ${count} 项，释放 ${mb(freed)}${kept.length ? `；保留 ${kept.length} 项未过期` : ''}`)
}

function dirSize(path) {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const name of readdirSync(path)) total += dirSize(join(path, name))
    return total
  } catch {
    return 0
  }
}

function mb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`
}
