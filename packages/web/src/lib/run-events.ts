/**
 * 事件 → 面板的纯函数层（无 React，无 DOM）。
 *
 * 这里的东西全都可以单测：ANSI 清理、事件落到哪块面板、档案怎么还原成面板。
 * 之前它们和组件挤在 App.tsx 里，改一个文案都要读 1000 行。
 */
import type { RunDetailView, RunEvent } from '../api'
import { MAX_LINES, type Line, type LineKind, type Output, type Pane } from '../types'

// 用于剥掉输出里的 ANSI 颜色码。控制字符在这里是必须的——别改成「可见字符类」
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g // eslint-disable-line no-control-regex

export function clean(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\n$/, '')
}

export function toLines(kind: LineKind, text: string): Line[] {
  return clean(text)
    .split('\n')
    .map((t) => ({
      // 桥用 `ERR|` 前缀报错且退出码为 0，这里直接把行标成错误色，别让人靠读文本找
      kind: kind === 'out' && /^ERR\|/.test(t) ? ('err' as LineKind) : kind,
      text: t,
    }))
}

/** `2026-10-29 22:48:12`，历史列表与回放头部共用 */
export function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 一条 step 事件怎么显示：expect 步要能看出「在等什么 / 命中了什么」 */
export function stepText(ev: Extract<RunEvent, { type: 'step' }>): string {
  if (ev.expect !== undefined) {
    return ev.ok
      ? `step${ev.stepIndex} match /${ev.expect}/ → ${ev.matched ?? ''}`
      : `step${ev.stepIndex} 未命中 /${ev.expect}/${ev.note ? ` · ${ev.note}` : ''}`
  }
  return `step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms${ev.note ? ' · ERR' : ''}`
}

/** 小于 1s 时显示毫秒：`完成 29ms` 比 `完成 0.0s` 有信息量 */
export function fmtDur(ms: number | undefined): string {
  if (ms == null) return '-'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function paneStatus(p: Pane, now: number): string {
  if (p.running) return `运行中 ${fmtDur(now - p.startedAt)}`
  if (p.ok) return `完成 ${fmtDur(p.durationMs)}`
  if (p.timedOut) return '超时'
  if (p.reason === 'expect') return `失败 · 断言未命中 · ${fmtDur(p.durationMs)}`
  if (p.reason === 'bridge') return `失败 · 桥侧报错 · ${fmtDur(p.durationMs)}`
  return `失败${p.exitCode != null ? ` exit=${p.exitCode}` : ''}${p.durationMs != null ? ` · ${fmtDur(p.durationMs)}` : ''}`
}

/** 同一目标开多次时才加 #序号，否则标题就是目标名 */
export function paneLabel(panes: Pane[], p: Pane): string {
  const same = panes.filter((x) => x.target === p.target)
  return same.length > 1 ? `${p.target} #${same.indexOf(p) + 1}` : p.target
}

/** 一条事件落到哪块面板：优先服务端打的 targetIndex，退回按 target 名找，最后兜底第一块 */
export function paneIndexOf(o: Output, ev: RunEvent): number {
  if (typeof ev.targetIndex === 'number' && o.panes[ev.targetIndex]) return ev.targetIndex
  if (ev.target) {
    const i = o.panes.findIndex((p) => p.target === ev.target)
    if (i >= 0) return i
  }
  return 0
}

export function applyEvent(o: Output, ev: RunEvent): Output {
  const idx = paneIndexOf(o, ev)
  const pane = o.panes[idx]
  if (!pane) return o

  const extra: Line[] = []
  let { running, ok, durationMs, timedOut, exitCode, reason, note } = pane
  switch (ev.type) {
    case 'start':
      if (ev.cmd) extra.push({ kind: 'cmd', text: ev.cmd })
      break
    case 'queued':
      extra.push({ kind: 'queue', text: `队列等待 ${(ev.waitedMs / 1000).toFixed(1)}s` })
      break
    case 'stdout':
      extra.push(...toLines('out', ev.data))
      break
    case 'stderr':
      extra.push(...toLines('err', ev.data))
      break
    case 'step':
      extra.push({ kind: 'step', ok: ev.ok, text: stepText(ev) })
      break
    case 'exit':
      running = false
      ok = ev.ok
      durationMs = ev.durationMs
      timedOut = ev.timedOut
      exitCode = ev.exitCode
      reason = ev.reason
      note = ev.note
      extra.push({
        kind: 'step',
        ok: ev.ok,
        text: ev.ok
          ? `done ${ev.durationMs}ms`
          : ev.timedOut
            ? '超时被终止（命令可能仍在桌面会话里跑）'
            : ev.reason === 'expect'
              ? `断言未命中 · ${ev.note ?? ''}`
              : ev.reason === 'bridge'
                ? `桥侧报错（退出码 ${ev.exitCode ?? 0}）`
                : `failed exit=${ev.exitCode ?? '-'}`,
      })
      break
    case 'error':
      running = false
      ok = false
      extra.push({ kind: 'err', text: `ERROR ${ev.message}` })
      break
  }

  const next: Pane = {
    ...pane,
    lines: [...pane.lines, ...extra].slice(-MAX_LINES),
    running,
    ok,
    durationMs,
    exitCode,
    timedOut,
    reason,
    note,
  }
  return {
    ...o,
    // 首条 start 带的 runId 存住：抽屉关闭后仍能在历史里找到这一次
    runId: ev.type === 'start' ? (ev.runId ?? o.runId) : o.runId,
    panes: o.panes.map((p, i) => (i === idx ? next : p)),
  }
}

/**
 * 把一份档案（meta + 事件流 + summary）还原成抽屉里的多面板结构。
 * 事件是原样存下来的，所以走同一套 `applyEvent` —— 回放和实时看到的排版必须一致，
 * 否则「档案里长这样」就不可信了。
 */
export function replayOutput(d: RunDetailView): Output {
  const targets = d.meta.targets.length > 0 ? d.meta.targets : ['default']
  let o: Output = {
    id: d.meta.snippetId,
    runId: d.meta.runId,
    replayed: true,
    replayedAt: d.meta.startedAt,
    startedAt: d.meta.startedAt,
    panes: targets.map((t, i) => {
      const sum = d.summary?.panes.find((p) => p.targetIndex === i)
      return {
        target: t,
        index: i,
        running: false,
        startedAt: d.meta.startedAt,
        ok: sum?.ok,
        durationMs: sum?.durationMs,
        exitCode: sum?.exitCode,
        timedOut: sum?.timedOut,
        reason: sum?.reason,
        note: sum?.note,
        lines: [],
      }
    }),
  }
  for (const ev of d.events) o = applyEvent(o, ev)
  // 进程被 kill 时档案里没有 exit 事件：用 summary 把状态补回去，
  // 不然历史面板会停在「运行中」——那是回放永远等不到的东西
  o = {
    ...o,
    panes: o.panes.map((p, i) => {
      const sum = d.summary?.panes.find((s) => s.targetIndex === i)
      return {
        ...p,
        running: false,
        ok: p.ok ?? sum?.ok ?? false,
        durationMs: p.durationMs ?? sum?.durationMs,
        exitCode: p.exitCode ?? sum?.exitCode,
        timedOut: p.timedOut ?? sum?.timedOut,
        note: p.note ?? sum?.note,
      }
    }),
  }
  return o
}
