import type { RunListItem } from '../api'
import { fmtDur, fmtWhen } from '../lib/run-events'

/** 运行历史：每次执行落一份档案，断开页面后仍能回看（P4） */
export function HistoryModal({
  runs,
  error,
  replayId,
  onReplay,
  onRefresh,
  onClose,
}: {
  /** null = 还没读完（初次加载中） */
  runs: RunListItem[] | null
  error: string | null
  /** 正在回放的 runId，按钮置灰防重复点 */
  replayId: string | null
  onReplay: (runId: string) => void
  onRefresh: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <h3>运行历史</h3>
        <p className="modal-sub">
          每次执行服务端都会落一份档案（<code>data/runs/&lt;runId&gt;.jsonl</code>）；断网、关页面之后也能回看。
          secret 变量的值在档案里已抹成 <code>***</code>。
        </p>
        {error && <p className="form-error">{error}</p>}
        {runs === null && !error && <p className="empty">读取中…</p>}
        {runs?.length === 0 && <p className="empty">还没有运行记录</p>}
        <div className="run-list">
          {runs?.map((r) => (
            <button
              key={r.runId}
              type="button"
              className={`run-row${r.ok ? ' ok' : ' fail'}`}
              onClick={() => onReplay(r.runId)}
              disabled={replayId === r.runId}
              title={`${r.runId}${r.vars && Object.keys(r.vars).length > 0 ? ` · ${Object.entries(r.vars).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`}
            >
              <span className="run-when">{fmtWhen(r.startedAt)}</span>
              <span className="run-id">{r.snippetId}</span>
              <span className="run-meta">
                {r.targets.length > 1 ? `${r.targets.length} 目标` : (r.targets[0] ?? '-')}
                {' · '}
                {fmtDur(r.durationMs)}
              </span>
              <span className={`run-state ${r.ok ? 'ok' : 'fail'}`}>{r.ok ? '✓' : '✗'}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <span className="modal-hint">{runs ? `${runs.length} 条` : ''}</span>
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </div>
    </div>
  )
}
