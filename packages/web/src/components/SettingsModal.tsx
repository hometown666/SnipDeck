/** 访问 token 弹窗：粘贴一次存 localStorage，只在这台设备生效 */
import { BridgeEnvSection } from './BridgeEnvSection'

export function SettingsModal({
  tokenInput,
  tokenSet,
  error,
  showEnv,
  onChange,
  onClear,
  onSave,
  onClose,
}: {
  tokenInput: string
  tokenSet: boolean
  error: string | null
  /** 需要 token 时这是个「填了才能用」的闸门，别在里面塞别的设置 */
  showEnv: boolean
  onChange: (v: string) => void
  onClear: () => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
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
          {/* 两组按钮并存时，「保存」必须说清保存的是什么 */}
          <button className="btn ghost" onClick={onClear}>
            清除 token
          </button>
          <button className="btn primary" onClick={onSave}>
            保存 token
          </button>
        </div>
        {showEnv && <BridgeEnvSection />}
      </div>
    </div>
  )
}
