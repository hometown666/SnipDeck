import type { SnippetView } from '../api'

/** danger 片段的二次确认。点「仍然执行」才带上 confirmed=true 再走一遍 openSnippet */
export function DangerModal({
  snippet,
  onCancel,
  onConfirm,
}: {
  snippet: SnippetView
  onCancel: () => void
  onConfirm: (s: SnippetView) => void
}) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="danger-title">危险动作确认</h3>
        <p className="modal-sub">
          {snippet.title}（{snippet.id}）
        </p>
        <p className="warn">该片段标记了 danger，执行后可能不可撤销。</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn danger" onClick={() => onConfirm(snippet)}>
            仍然执行
          </button>
        </div>
      </div>
    </div>
  )
}
