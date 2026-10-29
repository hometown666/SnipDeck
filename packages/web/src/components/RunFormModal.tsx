import type { HostView } from '../api'
import { MAX_TARGETS, type Draft } from '../types'

/**
 * 执行表单：目标选择器（chips + 可选目标按钮）+ 变量表单 + 命令预览。
 *
 * 这里只管「把当前 draft 改对」，不判断能不能跑——提交校验在 App.submitDraft，
 * 因为它还要处理必填变量与服务端 400 的回填。
 */
export function RunFormModal({
  draft,
  hosts,
  preview,
  formError,
  onChange,
  onError,
  onSubmit,
  onPreview,
  onClose,
}: {
  draft: Draft
  hosts: HostView[]
  preview: string[] | null
  formError: string | null
  onChange: (d: Draft) => void
  onError: (msg: string) => void
  onSubmit: () => void
  onPreview: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{draft.snippet.title}</h3>
        <p className="modal-sub">
          {draft.snippet.id}
          {draft.snippet.target ? ` · ${draft.snippet.target}` : ''} · {draft.snippet.steps} 步 ·{' '}
          {draft.targets.length} 目标
        </p>
        <div className="field">
          <span>
            目标 <em className="hint">点一次加一个；同一目标可重复 = 同目标多开</em>
          </span>
          <div className="chips">
            {draft.targets.map((t, i) => {
              const same = draft.targets.filter((x) => x === t)
              return (
                <span className="chip" key={`${t}-${i}`}>
                  {t}
                  {same.length > 1
                    ? ` #${draft.targets.slice(0, i + 1).filter((x) => x === t).length}`
                    : ''}
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`移除 ${t}`}
                    onClick={() => onChange({ ...draft, targets: draft.targets.filter((_, k) => k !== i) })}
                  >
                    ×
                  </button>
                </span>
              )
            })}
            {draft.targets.length === 0 && <span className="chip-empty">未选目标</span>}
          </div>
          <div className="target-add">
            {hosts.map((h) => {
              const full = draft.targets.length >= MAX_TARGETS
              return (
                <button
                  key={h.name}
                  type="button"
                  className="target-btn"
                  disabled={h.reserved || full}
                  title={
                    full
                      ? `最多 ${MAX_TARGETS} 个目标`
                      : h.reserved
                        ? `P5 预留（driver=${h.driver}）`
                        : `driver=${h.driver}`
                  }
                  onClick={() => {
                    // disabled 已经拦住常规点击；这里再判一次，避免键盘/脚本绕过属性直接触发
                    if (draft.targets.length >= MAX_TARGETS) {
                      onError(`最多 ${MAX_TARGETS} 个目标`)
                      return
                    }
                    onChange({ ...draft, targets: [...draft.targets, h.name] })
                  }}
                >
                  {h.name}
                  <em>{h.reserved ? 'P5' : '+'}</em>
                </button>
              )
            })}
          </div>
          {draft.targets.length >= MAX_TARGETS && (
            <p className="field-note">最多 {MAX_TARGETS} 个目标（服务端上限）</p>
          )}
        </div>
        {Object.entries(draft.snippet.vars).map(([k, v]) => (
          <label key={k} className="field">
            <span>
              {v.prompt ?? k}
              {v.required ? <em className="req"> *</em> : null}
            </span>
            {v.choices ? (
              <select
                value={draft.vars[k] ?? ''}
                onChange={(e) => onChange({ ...draft, vars: { ...draft.vars, [k]: e.target.value } })}
              >
                {v.choices.map((c) => (
                  <option key={String(c)} value={String(c)}>
                    {String(c) || '(空)'}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={v.secret ? 'password' : 'text'}
                value={draft.vars[k] ?? ''}
                placeholder={v.default != null ? String(v.default) : ''}
                onChange={(e) => onChange({ ...draft, vars: { ...draft.vars, [k]: e.target.value } })}
              />
            )}
          </label>
        ))}
        {preview && <pre className="preview">{preview.map((c) => `$ ${c}`).join('\n')}</pre>}
        {formError && <p className="form-error">{formError}</p>}
        <div className="modal-actions">
          <span className="modal-hint">Ctrl/⌘+Enter 直接执行</span>
          <button className="btn ghost" onClick={onPreview}>
            预览命令
          </button>
          <button className="btn primary" onClick={onSubmit}>
            执行
          </button>
        </div>
      </div>
    </div>
  )
}
