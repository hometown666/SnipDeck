/** 访问 token 弹窗：粘贴一次存 localStorage，只在这台设备生效 */
import { useEffect, useState } from 'react'
import { BridgeEnvSection } from './BridgeEnvSection'
import { HostsSection } from './HostsSection'
import { ProgramsSection } from './ProgramsSection'
import { RunsSection } from './RunsSection'
import { Modal } from './Modal'
import { getToken } from '../api'

export function SettingsModal({
  tokenInput,
  tokenSet,
  error,
  showEnv,
  onChange,
  onClear,
  onSave,
  onClose,
  onHostsChanged,
  onProgramsChanged,
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
  /** 目标增删改之后让外层重拉一次（目标选择器要跟着变） */
  onHostsChanged?: () => void
  /** 程序范围改了：外层把缓存的程序列表丢掉，下次打开表单重扫 */
  onProgramsChanged?: () => void
}) {
  // 阶段 C3（HTTPS 计划，docs/08-https.md）：把「当前会用的 token」编成配对链接 → 二维码，
  // 手机扫一下直接带 token 进，免手填 SNIP_TOKEN。
  // 优先用输入框里正在填的值（实时预览即将保存的 token），其次才是已存的那份。
  const qrToken = (tokenInput ?? '').trim() || getToken()
  const qrUrl = qrToken ? `${location.origin}/?token=${encodeURIComponent(qrToken)}` : ''
  const [qrDataUrl, setQrDataUrl] = useState('')
  useEffect(() => {
    let alive = true
    if (!qrUrl) {
      setQrDataUrl('')
      return
    }
    // 动态 import：qrcode 只在打开设置弹窗时才进 bundle，不拖累首屏。
    import('qrcode')
      .then((mod) => mod.default.toDataURL(qrUrl, { width: 200, margin: 1 }))
      .then((url) => {
        if (alive) setQrDataUrl(url)
      })
      .catch(() => {
        if (alive) setQrDataUrl('')
      })
    return () => {
      alive = false
    }
  }, [qrUrl])

  return (
    <Modal
      className="settings"
      onClose={onClose}
      // 各段自己带保存按钮（改了才生效），底栏只负责关窗：
      // 手机上没有它就只能点遮罩，误触一次就白填
      footer={
        <button className="btn" onClick={onClose}>
          完成
        </button>
      }
    >
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
        {qrUrl && (
          <div className="qr-pairing">
            <h3>配对二维码</h3>
            <p className="modal-sub">
              手机扫这个码，直接带着 token 打开本机地址，免手填 <code>SNIP_TOKEN</code>。
            </p>
            {qrDataUrl ? (
              <img className="qr-img" src={qrDataUrl} alt="配对二维码" />
            ) : (
              <p className="form-error">二维码生成中…</p>
            )}
            <p className="qr-url" title={qrUrl}>
              {qrUrl}
            </p>
          </div>
        )}
        {showEnv && <BridgeEnvSection />}
        {showEnv && <ProgramsSection onChanged={onProgramsChanged} />}
        {showEnv && <HostsSection onChanged={onHostsChanged} />}
        {showEnv && <RunsSection />}
    </Modal>
  )
}
