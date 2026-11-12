import type { CSSProperties, RefObject } from 'react'
import { Modal } from './Modal'
import { fmtWhen, paneLabel, paneStatus } from '../lib/run-events'
import type { Output } from '../types'

/**
 * 运行结果弹窗（原「运行抽屉」）。
 *
 * 2026-11-08 改版：以前是贴底固定的全宽抽屉（.drawer，无遮罩），
 * 现在统一走项目的 Modal 外壳——有遮罩、点外部关闭、固定底栏，
 * 桌面居中给日志更大视野，窄屏仍回到底部弹窗。
 *
 * 输出正文仍保持每块 pane 独立滚动：`.modal-scroll` 对 run-modal 不滚动，
 * 由 .panes / .drawer-body 各自承担，多目标并列时才不会整块一起滚。
 * 正文默认 `white-space:pre` 不折行——宁可横向滚，也不让一行断成两截；
 * 长段落由底栏的「自动换行」切到 pre-wrap。
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
    <Modal
      className={`run-modal ${drawerState}${multi ? ' multi' : ''}${wrap ? ' wrap' : ''}`}
      centered
      onClose={onClose}
      footer={
        <>
          <span className="run-modal__hint">Esc 或点击遮罩关闭</span>
          <button
            type="button"
            className={`ui-btn ui-btn--ghost ui-btn--sm${wrap ? ' ui-btn--secondary' : ''}`}
            onClick={onToggleWrap}
            aria-pressed={wrap}
            aria-label="自动换行"
            title="自动换行（长段落用）"
          >
            ↩ 自动换行
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--sm"
            onClick={onCopy}
            aria-label="复制输出"
            title="复制全部输出"
          >
            {copied ? '✓ 已复制' : '⧉ 复制输出'}
          </button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
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
    </Modal>
  )
}
