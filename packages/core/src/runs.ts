import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { RunEvent } from './types'

/**
 * 运行档案（`data/runs/<runId>.jsonl`）。
 *
 * 一行一件事，三种行：
 *   `{"kind":"meta",...}`    首行：谁、在什么目标上、跑了哪条片段、带了什么变量
 *   `{"kind":"event",...}`   中间：SSE 发出去的每一条事件（顺序即时间序）
 *   `{"kind":"summary",...}` 末行：每个目标的结局
 *
 * 为什么不存成一个 JSON 大文件：run 中途被 kill 时，jsonl 天然只丢最后一行，
 * 而 JSON 会整份解析失败——排障档案最怕的正是「出事那次读不出来」。
 */

export type RunCaller = { ip?: string; ua?: string }

export type RunMeta = {
  runId: string
  snippetId: string
  title?: string
  /** 本次请求的 targets，顺序 = 结果面板顺序 */
  targets: string[]
  startedAt: number
  caller?: RunCaller
  /** 已脱敏：secret 变量的值永远不落盘，只留键名与 `***` */
  vars?: Record<string, string>
  varsRedacted?: string[]
}

export type RunPaneResult = {
  target: string
  targetIndex: number
  ok: boolean
  exitCode?: number
  durationMs?: number
  timedOut?: boolean
  note?: string
}

export type RunSummary = {
  ok: boolean
  durationMs?: number
  panes: RunPaneResult[]
}

export type RunListItem = RunMeta & {
  ok: boolean
  durationMs?: number
  panes: RunPaneResult[]
  eventCount: number
}

export type RunDetail = { meta: RunMeta; events: RunEvent[]; summary: RunSummary | null }

const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/

/** `20261029-224812-a1b2`：按文件名排序就是按时间排序，不用 stat */
export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `${date}-${time}-${rand}`
}

export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id)
}

export class RunLog {
  constructor(
    private dir: string,
    private opts: { maxFiles?: number; ttlDays?: number } = {},
  ) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // 目录建不出来就退化成「不记录」，不影响 run 本身
    }
  }

  /** 新 run 的写句柄。落盘失败只 warn，绝不让排障功能反过来搞挂执行 */
  begin(meta: RunMeta, redact: string[] = []): RunWriter {
    return new RunWriter(this.dir, meta, redact)
  }

  /** 只要文件名合法（= 我们自己写的），按名字倒序 = 按时间倒序 */
  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((n) => n.endsWith('.jsonl') && isValidRunId(n.slice(0, -6)))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  list(limit = 20, snippetId?: string): RunListItem[] {
    const out: RunListItem[] = []
    for (const name of this.files()) {
      const d = this.read(name.slice(0, -6))
      if (!d) continue
      if (snippetId && d.meta.snippetId !== snippetId) continue
      out.push({
        ...d.meta,
        ok: d.summary?.ok ?? false,
        durationMs: d.summary?.durationMs,
        panes: d.summary?.panes ?? [],
        eventCount: d.events.length,
      })
      if (out.length >= limit) break
    }
    return out
  }

  read(runId: string): RunDetail | null {
    if (!isValidRunId(runId)) return null
    const file = join(this.dir, `${runId}.jsonl`)
    if (!existsSync(file)) return null
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    let meta: RunMeta | null = null
    const events: RunEvent[] = []
    let summary: RunSummary | null = null
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        // 半行（进程被 kill 时最后一行没写完）直接跳过，前面的照读
        continue
      }
      if (row.kind === 'meta') meta = row as unknown as RunMeta
      else if (row.kind === 'event') events.push(row.ev as RunEvent)
      else if (row.kind === 'summary') summary = row as unknown as RunSummary
    }
    if (!meta) return null
    return { meta, events, summary }
  }

  /** 只留最近 `maxFiles` 个、且不超过 `ttlDays`；启动时调一次 */
  prune(): number {
    const maxFiles = this.opts.maxFiles ?? 500
    const ttlMs = (this.opts.ttlDays ?? 30) * 24 * 60 * 60 * 1000
    const now = Date.now()
    const files = this.files()
    let removed = 0
    files.forEach((name, i) => {
      const full = join(this.dir, name)
      let tooOld = false
      try {
        tooOld = now - statSync(full).mtimeMs > ttlMs
      } catch {
        return
      }
      if (i < maxFiles && !tooOld) return
      try {
        unlinkSync(full)
        removed++
      } catch {
        // 删不掉就算了
      }
    })
    return removed
  }
}

export class RunWriter {
  private fd: number | null = null
  private readonly file: string
  private readonly t0 = Date.now()
  /** 需要从档案里抹掉的字面量（secret 变量的实际值） */
  private readonly redact: string[]

  constructor(
    dir: string,
    private readonly meta: RunMeta,
    redact: string[] = [],
  ) {
    this.file = join(dir, `${meta.runId}.jsonl`)
    // 太短的值（1~2 字）替换起来会误伤正常输出，宁可不抹
    this.redact = redact.filter((v) => v.length >= 4)
    try {
      mkdirSync(dir, { recursive: true })
      this.fd = openSync(this.file, 'w')
      this.write({ kind: 'meta', ...meta })
    } catch (e) {
      this.fd = null
      console.warn(`  ~ run 档案写入失败（不影响执行）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private scrub(text: string): string {
    if (this.redact.length === 0) return text
    let s = text
    for (const v of this.redact) s = s.split(v).join('***')
    return s
  }

  /**
   * secret 变量的值可能出现在任何地方：渲染后的命令行、命令输出、错误信息。
   * 实时 SSE 照原样发（人就在屏幕前，看的是自己填的东西），但**落盘必须抹掉**——
   * 档案是要长期留着、还可能被翻出来分享的（§5.4：secret 不落历史）。
   */
  private scrubEvent(ev: RunEvent): RunEvent {
    if (this.redact.length === 0) return ev
    const out: RunEvent = { ...ev }
    if ('cmd' in out && typeof out.cmd === 'string') out.cmd = this.scrub(out.cmd)
    if ('data' in out && typeof out.data === 'string') out.data = this.scrub(out.data)
    if ('message' in out && typeof out.message === 'string') out.message = this.scrub(out.message)
    if ('note' in out && typeof out.note === 'string') out.note = this.scrub(out.note)
    if ('matched' in out && typeof out.matched === 'string') out.matched = this.scrub(out.matched)
    return out
  }

  private write(row: unknown): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, `${JSON.stringify(row)}\n`)
    } catch {
      this.closeQuietly()
    }
  }

  event(ev: RunEvent): void {
    this.write({ kind: 'event', t: Date.now() - this.t0, ev: this.scrubEvent(ev) })
  }

  summary(sum: RunSummary): void {
    this.write({ kind: 'summary', ...sum })
    this.closeQuietly()
  }

  /** 异常退出也要收尾：不写 summary 的档案会被当成「跑飞了」，本身就说明问题 */
  private closeQuietly(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      // ignore
    }
    this.fd = null
  }

  get path(): string {
    return this.file
  }
}
