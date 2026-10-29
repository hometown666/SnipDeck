import { readFileSync } from 'node:fs'
import type { StepExpect } from './types'

/**
 * `expect` 步的输出来源。
 * 解析成判别联合，是为了让「写错一个字」在**加载时**就变成 quarantine，
 * 而不是等真跑起来才在 UI 里报一句看不懂的话。
 */
export type ExpectSource = { kind: 'last' } | { kind: 'all' } | { kind: 'file'; path: string }

export function parseExpectFrom(
  from: string | undefined,
): ExpectSource | { kind: 'invalid'; error: string } {
  const f = (from ?? 'last').trim()
  if (f === '' || f === 'last') return { kind: 'last' }
  if (f === 'all') return { kind: 'all' }
  if (f.startsWith('file:')) {
    const path = f.slice('file:'.length).trim()
    if (!path) return { kind: 'invalid', error: 'expect.from 的 file: 后面缺路径' }
    return { kind: 'file', path }
  }
  return {
    kind: 'invalid',
    error: `expect.from 只能是 last / all / file:<路径>，收到 ${JSON.stringify(from)}`,
  }
}

/**
 * 只放行 i / m / s。`g` 必须去掉：`RegExp.test()` 在 `g` 下带 lastIndex 状态，
 * 同一个正则连测两次会一真一假——这种 bug 在片段里极难查。
 */
export function compileExpect(step: StepExpect): RegExp {
  const flags = [...new Set((step.flags ?? '').toLowerCase().split(''))]
    .filter((f) => f === 'i' || f === 'm' || f === 's')
    .join('')
  return new RegExp(step.match, flags)
}

export type ExpectResult = { ok: boolean; note?: string; matched?: string }

const HIT_MAX = 120

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > HIT_MAX ? `${one.slice(0, HIT_MAX)}…` : one
}

function test(re: RegExp, text: string): ExpectResult | null {
  const m = re.exec(text)
  if (!m) return null
  return { ok: true, matched: clip(m[0]) }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 判定一个 `expect` 步。
 *
 * - `last` / `all`：**立即**判定（exec 驱动整段返回输出，没有「还没到」的状态）
 * - `file:<path>`：轮询到 `timeout` 秒；文件不存在不算错（服务刚起、日志还没写）
 */
export async function runExpect(
  step: StepExpect,
  from: string | undefined,
  outputs: (string | undefined)[],
  stepIndex: number,
): Promise<ExpectResult> {
  let re: RegExp
  try {
    re = compileExpect(step)
  } catch (e) {
    return { ok: false, note: `正则无效: ${e instanceof Error ? e.message : String(e)}` }
  }

  const src = parseExpectFrom(from)
  if (src.kind === 'invalid') return { ok: false, note: src.error }

  const label = `/${step.match}/`
  if (src.kind === 'file') {
    const timeoutMs = Math.max(0, (step.timeout ?? 10) * 1000)
    const interval = Math.max(50, step.interval ?? 200)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let text = ''
      try {
        text = readFileSync(src.path, 'utf8')
      } catch {
        // 文件还没生成本身就是「再等等」，不是失败
      }
      const hit = test(re, text)
      if (hit) return hit
      if (Date.now() >= deadline) {
        return {
          ok: false,
          note: `等待 ${(timeoutMs / 1000).toFixed(0)}s 未匹配 ${label}（${src.path}）`,
        }
      }
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
    }
  }

  let text: string
  if (src.kind === 'all') {
    text = outputs.filter((o): o is string => typeof o === 'string').join('\n')
    if (!text) return { ok: false, note: `前面没有可检查的命令输出（${label}）` }
  } else {
    let last: string | undefined
    for (let i = stepIndex - 1; i >= 0; i--) {
      if (typeof outputs[i] === 'string') {
        last = outputs[i]
        break
      }
    }
    if (last === undefined) {
      return { ok: false, note: `前面没有可检查的命令输出（${label}）` }
    }
    text = last
  }

  return test(re, text) ?? { ok: false, note: `未匹配 ${label}` }
}
