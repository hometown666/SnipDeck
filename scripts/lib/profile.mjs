/**
 * CDP 脚本共用的 Chrome profile 目录管理。
 *
 * 为什么需要：四个 UI 回归脚本各自用一个固定的 --user-data-dir
 * （data/tmp/ui-shot-profile 等），Chrome 一次就写进去十几 MB，且脚本
 * 从来不清——实测 6 个目录堆到 64MB。复用同一个目录是必要的（换名字会让
 * 每次跑都新建），但必须给它们一个回收机制。
 *
 * 策略：启动前看一眼目录的最后修改时间，超过 maxAgeMs 没用过就整个删掉重建。
 * 删除失败不致命（ISSUE-004 的教训：清理动作不该决定脚本成败），只 warn。
 */
import { existsSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

/** 删除目录/文件，失败只 warn，永不抛。 */
export function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch (e) {
    console.warn(`  ~ 清理失败（忽略）：${path} — ${e instanceof Error ? e.message : e}`)
    return false
  }
}

/** 超过 maxAgeMs 没用过的目录直接删掉，返回可以安全使用的路径。 */
export function profileDir(name, { maxAgeMs = DAY_MS } = {}) {
  const dir = resolve(process.cwd(), 'data/tmp', name)
  try {
    if (existsSync(dir) && Date.now() - statSync(dir).mtimeMs > maxAgeMs) {
      removeQuietly(dir)
    }
  } catch (e) {
    console.warn(`  ~ profile 检查失败（忽略）：${e instanceof Error ? e.message : e}`)
  }
  return dir
}
