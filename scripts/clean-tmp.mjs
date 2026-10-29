#!/usr/bin/env node
/**
 * 清 data/tmp：临时 .cmd 与 CDP profile 目录。
 *
 * 为什么要有：data/tmp 里有两类垃圾会一直长——
 *   1. run-<runId>.cmd  每次走「复杂命令」路径留一份，默认保留 7 天供排查；
 *   2. *-profile/       四个 UI 回归脚本的 Chrome --user-data-dir，各十几 MB。
 * 服务端的 prune 只管 data/runs，管不到这里；实测堆到 64MB。
 *
 * 用法：
 *   npm run clean:tmp            # 删 7 天前的（run-*.cmd 与 *-profile）
 *   npm run clean:tmp -- --dry   # 只看会删什么，不动手
 *   npm run clean:tmp -- --days 1
 *   npm run clean:tmp -- --all   # 忽略年龄，profile 全删（服务运行时别用，
 *                                #   正在跑的 ui 脚本会失去 profile）
 * 只删这两类明确匹配的项，data/tmp 里其他东西（截图、诊断脚本）一律不碰。
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
const isTarget = (name) => name.endsWith('-profile') || /^run-.+\.cmd$/.test(name)

let freed = 0
let count = 0
const kept = []

for (const name of readdirSync(tmpDir)) {
  if (!isTarget(name)) continue
  const path = join(tmpDir, name)
  let st
  try {
    st = statSync(path)
  } catch {
    continue
  }
  const expired = all ? name.endsWith('-profile') : st.mtimeMs < cutoff
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

if (dry) {
  console.log(`\n（dry-run）以上为 ${days} 天内未更新的项，未删除任何文件`)
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
