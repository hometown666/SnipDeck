import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type HostDetailView, type HostInput, type HostsDetail } from '../api'

/**
 * 目标（hosts.yaml）管理。
 *
 * 之前加一台机器要开编辑器改 YAML：查字段名、小心 default 只能有一个、别把 bridge 写成相对路径。
 * 这里把这三件事变成表单校验 + 排他处理。
 *
 * 用**内联展开**而不是嵌套弹窗：设置弹窗本身已经是一个 modal，
 * 再套一层在手机上会出现「滚动到底部才能关」的双层遮罩。
 */
type Draft = {
  name: string
  driver: 'exec' | 'local' | 'ssh'
  bridge: string
  shell: string
  timeout: string
  default: boolean
}

const EMPTY: Draft = { name: '', driver: 'exec', bridge: '', shell: 'cmd', timeout: '20', default: false }

const draftOf = (h: HostDetailView): Draft => ({
  name: h.name,
  driver: (h.driver as Draft['driver']) ?? 'exec',
  bridge: h.bridge,
  shell: h.shell || 'cmd',
  timeout: h.timeout === null ? '' : String(h.timeout),
  default: h.default,
})

export function HostsSection({ onChanged }: { onChanged?: () => void }) {
  const [detail, setDetail] = useState<HostsDetail | null>(null)
  const [editing, setEditing] = useState<{ original: string | null; draft: Draft } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDetail(await api.hostsDetail())
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = (p: Partial<Draft>) =>
    setEditing((s) => (s ? { ...s, draft: { ...s.draft, ...p } } : s))

  async function save() {
    if (!editing) return
    const d = editing.draft
    const payload: HostInput = {
      name: d.name.trim(),
      driver: d.driver,
      bridge: d.driver === 'exec' ? d.bridge.trim() : undefined,
      shell: d.driver === 'exec' ? d.shell : undefined,
      timeout: d.driver === 'exec' && d.timeout.trim() ? Number(d.timeout) : undefined,
      default: d.default,
      mtimeMs: detail?.mtimeMs,
    }
    setBusy(true)
    setError(null)
    try {
      if (editing.original) await api.updateHost(editing.original, payload)
      else await api.createHost(payload)
      setEditing(null)
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string) {
    setBusy(true)
    setError(null)
    try {
      await api.deleteHost(name, detail?.mtimeMs)
      setConfirm(null)
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const targets = detail?.targets ?? []

  return (
    <div className="env-section hosts-section">
      <h4>
        目标 <em>hosts.yaml · 片段执行落在哪台</em>
      </h4>

      {targets.map((h) => (
        <div className="host-row" key={h.name}>
          <div className="host-main">
            <code className="host-name">{h.name}</code>
            <span className={`host-tag driver-${h.driver}`}>{h.driver}</span>
            {h.default && <span className="host-tag is-default">默认</span>}
            {h.reserved && <span className="host-tag">占位</span>}
          </div>
          <div className="host-sub">
            {h.driver === 'exec'
              ? `${h.bridge || '（没填 bridge）'} · ${h.shell || 'cmd'} · ${h.timeout ?? '-'}s`
              : '这个 driver 还没接（P5.3 砍掉 SSH 后只留作样例）'}
          </div>
          <div className="host-acts">
            <button
              className="btn tiny ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                setEditing({ original: h.name, draft: draftOf(h) })
              }}
            >
              编辑
            </button>
            <button
              className={`btn tiny${confirm === h.name ? ' danger' : ' ghost'}`}
              disabled={busy}
              onBlur={() => setConfirm(null)}
              onClick={() => (confirm === h.name ? void remove(h.name) : setConfirm(h.name))}
            >
              {confirm === h.name ? '确认删除？' : '删除'}
            </button>
          </div>
        </div>
      ))}

      {editing ? (
        <div className="host-form">
          <div className="editor-row tight">
            <label className="field">
              <span>名字</span>
              <input
                value={editing.draft.name}
                placeholder="win-desktop"
                spellCheck={false}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>driver</span>
              <select
                value={editing.draft.driver}
                onChange={(e) => patch({ driver: e.target.value as Draft['driver'] })}
              >
                <option value="exec">exec（走桥）</option>
                <option value="local">local（占位）</option>
                <option value="ssh">ssh（占位）</option>
              </select>
            </label>
          </div>

          {editing.draft.driver === 'exec' ? (
            <>
              <label className="field">
                <span>
                  bridge 目录 <span className="hint">ahk.bat 所在的绝对路径</span>
                </span>
                <input
                  value={editing.draft.bridge}
                  placeholder="C:\ahk_trigger"
                  spellCheck={false}
                  onChange={(e) => patch({ bridge: e.target.value })}
                />
              </label>
              <div className="editor-row tight">
                <label className="field">
                  <span>shell</span>
                  <select value={editing.draft.shell} onChange={(e) => patch({ shell: e.target.value })}>
                    <option value="cmd">cmd</option>
                    <option value="powershell">powershell</option>
                  </select>
                </label>
                <label className="field">
                  <span>timeout（秒）</span>
                  <input
                    value={editing.draft.timeout}
                    inputMode="numeric"
                    placeholder="20"
                    onChange={(e) => patch({ timeout: e.target.value })}
                  />
                </label>
              </div>
            </>
          ) : (
            <p className="field-note">
              这个 driver 还没实现（P5.3 砍掉 SSH）。存下来只会是个占位目标，跑不了。
            </p>
          )}

          <label className="mini-check">
            <input
              type="checkbox"
              checked={editing.draft.default}
              onChange={(e) => patch({ default: e.target.checked })}
            />
            <span>设为默认目标（片段没写 target 时落在这台；只能有一台）</span>
          </label>

          {error && <p className="form-error">{error}</p>}

          <div className="env-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="btn" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : editing.original ? '保存目标' : '新建目标'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {error && <p className="form-error">{error}</p>}
          <div className="env-actions">
            <button
              className="btn ghost"
              disabled={busy || !detail}
              onClick={() => {
                setError(null)
                setEditing({ original: null, draft: { ...EMPTY, bridge: detail?.targets.find((t) => t.driver === 'exec')?.bridge ?? '' } })
              }}
            >
              新增目标
            </button>
          </div>
        </>
      )}
    </div>
  )
}
