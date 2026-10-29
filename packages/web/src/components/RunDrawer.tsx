import type { CSSProperties, RefObject } from 'react'
import { fmtWhen, paneLabel, paneStatus } from '../lib/run-events'
import type { Output } from '../types'

/**
 * 运行抽屉：单目标时一块面板、多目标时按 `--cols` 并列（上限 3 列）。
 *
 * 正文默认 `white-space:pre` 不折行——宁可横向滚，也不让一行断成两截；
 * 长段落场景由头部的 `↩` 切到 pre-wrap。
 */
export function RunDrawer({
  output,
  now,
  wrap,
  copied,
  drawerState,
  statusText,
  panesRef,
  onToggleWrap,
  onCopy,
  onClose,
}: {
  output: Output
  /** 计时用的当前时刻（运行中每 200ms 变一次，由 App 传进来） */
  now: number
  wrap: boolean
  copied: boolean
  drawerState: 'running' | 'ok' | 'fail'
  statusText: string
  /** 自动滚动要直接操作每块 .drawer-body，所以 ref 由 App 持有 */
  panesRef: RefObject<HTMLDivElement>
  onToggleWrap: () => void
  onCopy: () => void
  onClose: () => void
}) {
  const panes = output.panes
  const multi = panes.length > 1

  return (
    <div className={`drawer ${drawerState}${multi ? ' multi' : ''}${wrap ? ' wrap' : ''}`}>
      <div className="drawer-head">
        <span className="drawer-id">{output.id}</span>
        {output.replayed && output.replayedAt ? (
          <span className="drawer-badge" title={`档案 ${output.runId ?? ''} · ${fmtWhen(output.replayedAt)}`}>
            <span className="badge-ico">🕘</span>
            <span className="badge-when">{fmtWhen(output.replayedAt)}</span>
          </span>
        ) : null}
        <span className={`drawer-status ${drawerState === 'running' ? 'run' : drawerState}`}>
          {statusText}
        </span>
        {multi && <span className="drawer-count">{panes.length} 目标</span>}
        <span className="drawer-tools">
          <button
            className={`icon-btn${wrap ? ' on' : ''}`}
            onClick={onToggleWrap}
            aria-label="自动换行"
            title="自动换行（长段落用）"
          >
            ↩
          </button>
          <button className="icon-btn" onClick={onCopy} aria-label="复制输出" title="复制">
            {copied ? '✓' : '⧉'}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="关闭" title="关闭（Esc）">
            ×
          </button>
        </span>
      </div>
      <div
        className={`panes${multi ? ' multi' : ''}`}
        ref={panesRef}
        style={multi ? ({ '--cols': Math.min(panes.length, 3) } as CSSProperties) : undefined}
      >
        {panes.map((p) => (
          <section className="pane" key={`${p.target}-${p.index}`}>
            {multi && (
              <div className="pane-head">
                <span className="pane-target">{paneLabel(panes, p)}</span>
                <span
                  className={`pane-status ${p.running ? 'run' : p.ok ? 'ok' : 'fail'}`}
                  data-ok={p.ok ? '1' : '0'}
                >
                  {paneStatus(p, now)}
                </span>
              </div>
            )}
            <pre className="drawer-body">
              {p.lines.map((l, i) => (
                <span
                  key={i}
                  className={`line line-${l.kind}${l.kind === 'step' ? (l.ok ? ' ok' : ' bad') : ''}`}
                >
                  {l.kind === 'cmd' ? <span className="line-mark">$ </span> : null}
                  {l.kind === 'step' ? <span className="line-mark">{l.ok ? '✓ ' : '✗ '}</span> : null}
                  {l.kind === 'queue' ? <span className="line-mark">⏳ </span> : null}
                  {l.kind === 'err' ? <span className="line-mark">! </span> : null}
                  {l.text}
                </span>
              ))}
            </pre>
          </section>
        ))}
      </div>
    </div>
  )
}
