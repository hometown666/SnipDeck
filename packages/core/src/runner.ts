import type { Driver, RunEvent } from './types'
import { renderString, resolveVars } from './vars'
import type { Snippet } from './types'

export type RunOpts = {
  vars?: Record<string, string>
  defaultTimeout?: number
  /** 目标主机声明的默认 shell；片段自己的 shell 优先 */
  defaultShell?: string
}

export async function* runSnippet(
  snippet: Snippet,
  driver: Driver,
  opts: RunOpts = {},
): AsyncGenerator<RunEvent> {
  const { values, pending, missing } = resolveVars(snippet, opts.vars ?? {})
  if (missing.length > 0) {
    yield { type: 'error', message: `缺少必填变量: ${missing.join(', ')}` }
    return
  }
  if (pending.length > 0) {
    yield { type: 'error', message: `等待输入: ${pending.join(', ')}` }
    return
  }

  const defaultTimeout = opts.defaultTimeout ?? 20
  const shell = snippet.shell ?? opts.defaultShell ?? 'cmd'
  const t0 = Date.now()
  yield { type: 'start', stepIndex: -1 }

  for (let i = 0; i < snippet.steps.length; i++) {
    const step = snippet.steps[i]!
    const s0 = Date.now()

    if (step.do === 'sleep') {
      await new Promise((r) => setTimeout(r, step.ms))
      yield { type: 'step', stepIndex: i, ok: true, durationMs: Date.now() - s0 }
      continue
    }

    let ok = false
    let exitCode: number | undefined
    let timedOut = false
    try {
      const cmd = renderString(step.cmd, values)
      for await (const ev of driver.run({
        shell,
        cmd,
        timeout: step.timeout ?? defaultTimeout,
        queue: step.queue !== false,
        stepIndex: i,
      })) {
        if (ev.type === 'exit') {
          ok = ev.ok
          exitCode = ev.exitCode
          timedOut = !!ev.timedOut
        } else {
          yield ev
        }
      }
    } catch (e) {
      yield { type: 'error', stepIndex: i, message: e instanceof Error ? e.message : String(e) }
    }

    yield { type: 'step', stepIndex: i, ok, exitCode, durationMs: Date.now() - s0 }
    if (!ok && !step.optional) {
      yield { type: 'exit', ok: false, exitCode, durationMs: Date.now() - t0, timedOut }
      return
    }
  }

  yield { type: 'exit', ok: true, durationMs: Date.now() - t0 }
}
