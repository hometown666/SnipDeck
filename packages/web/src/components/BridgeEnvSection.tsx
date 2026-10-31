import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type BridgeSettingsView } from '../api'

/**
 * 桥的两条目录（PROG_DIR / AHK_DIR）。
 *
 * 为什么不塞进 App.tsx：这两条只在设置弹窗里用，而且自带「读一次 / 存一次」的
 * 生命周期。放进 App 会让那棵树多两个只服务这一个弹窗的 state。
 *
 * 关键约定：**留空 = 不注入**。空串不写进子进程 env，`ahk_cmd.ps1` 就回落到
 * 它自己的默认值（PROG_DIR 缺省桌面、AHK_DIR 缺省没有）。服务端也会拒收
 * 不存在的路径，免得界面上写着「已设」而脚本静默回落。
 */
export function BridgeEnvSection() {
  const [view, setView] = useState<BridgeSettingsView | null>(null)
  const [progDir, setProgDir] = useState('')
  const [ahkDir, setAhkDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const adopt = useCallback((v: BridgeSettingsView) => {
    setView(v)
    setProgDir(v.progDir)
    setAhkDir(v.ahkDir)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const v = await api.settings()
        if (alive) adopt(v)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [adopt])

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      adopt(await api.saveSettings({ progDir: progDir.trim(), ahkDir: ahkDir.trim() }))
      setSaved(true)
    } catch (e) {
      // 400 带的是「哪个目录不对」，原样显示比「保存失败」有用得多
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      adopt(await api.clearSettings())
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const injected = view?.injected ?? {}

  return (
    <div className="env-section">
      <h4>
        桥的目录 <em>改完下一条命令生效，不用重启</em>
      </h4>

      <label className="field">
        <span>
          Program directory <span className="hint">PROG_DIR · 放 .lnk，给 lnk: 用</span>
        </span>
        <input
          value={progDir}
          placeholder="留空 = 默认桌面"
          spellCheck={false}
          onChange={(e) => {
            setProgDir(e.target.value)
            setSaved(false)
          }}
        />
      </label>
      <p className="field-note">
        {injected.PROG_DIR
          ? `生效：${injected.PROG_DIR}${view?.lnkCount !== null ? `（${view?.lnkCount} 个 .lnk）` : '（读不到这个目录）'}`
          : '生效：桌面（由 ahk_cmd.ps1 自己取，跟着系统重定向走）'}
      </p>

      <label className="field">
        <span>
          AHK directory <span className="hint">AHK_DIR · 放 .ahk，给 script: 用</span>
        </span>
        <input
          value={ahkDir}
          placeholder="留空 = 未配置（script: 会明确报错）"
          spellCheck={false}
          onChange={(e) => {
            setAhkDir(e.target.value)
            setSaved(false)
          }}
        />
      </label>
      <p className="field-note">
        {injected.AHK_DIR ? `生效：${injected.AHK_DIR}` : '生效：未配置 —— 只有 script: 子命令需要它'}
      </p>

      {view && (
        <p className="field-note">
          桥目录 <code>{view.bridgeRoot}</code>
          {view.ahkBatExists ? ' · ahk.bat 在' : ' · ahk.bat 不在（npm run install:bridge）'}
        </p>
      )}

      {error && <p className="form-error">{error}</p>}
      {saved && !error && <p className="field-note ok-note">已保存，下一条命令起生效</p>}

      <div className="env-actions">
        <button className="btn ghost" disabled={busy} onClick={() => void clear()}>
          清空（回默认）
        </button>
        <button className="btn" disabled={busy || view === null} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
