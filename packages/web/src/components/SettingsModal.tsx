/** 访问 token 弹窗：粘贴一次存 localStorage，只在这台设备生效 */
export function SettingsModal({
  tokenInput,
  tokenSet,
  error,
  onChange,
  onClear,
  onSave,
  onClose,
}: {
  tokenInput: string
  tokenSet: boolean
  error: string | null
  onChange: (v: string) => void
  onClear: () => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>访问 token</h3>
        <p className="modal-sub">
          服务端设了 <code>SNIP_TOKEN</code> 时，非本机访问需要它。只存在这台设备的 localStorage。
        </p>
        <label className="field">
          <span>SNIP_TOKEN</span>
          <input
            type="password"
            value={tokenInput}
            placeholder={tokenSet ? '已保存（重新输入可覆盖）' : '粘贴 token'}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClear}>
            清除
          </button>
          <button className="btn primary" onClick={onSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
