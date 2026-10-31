import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type BridgeSettingsView } from '../api'

/**
 * 运行档案（`data/runs/*.jsonl`）的保留策略。
 *
 * 以前写死 30 天 / 500 份：跑得多的人磁盘一直长，跑得少的人 30 天就把半年前的排障线索删了。
 * 这两个数字没有「正确答案」，只能让用的人自己定。
 *
 * 0 = 用默认（30 天 / 500 份）。界面上留空等价于 0，比填 "0" 自然。
 */
export function RunsSection() {
  const [view, setView] = useState<BridgeSettingsView | null>(null)
  const [ttl, setTtl] = useState('')
  const [max, setMax] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const adopt = useCallback((v: BridgeSettingsView) => {
    setView(v)
    // isDefault 时留空，让人一眼看出「现在用的是默认」
    setTtl(v.runs.isDefault ? '' : String(v.runs.ttlDays))
    setMax(v.runs.isDefault ? '' : String(v.runs.maxFiles))
    setSaved(false)
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

  async function save(next?: { ttl: string; max: string }) {
    const t = (next?.ttl ?? ttl).trim()
    const m = (next?.max ?? max).trim()
    setBusy(true)
    setError(null)
    try {
      adopt(await api.saveSettings({ runsTtlDays: t ? Number(t) : 0, runsMaxFiles: m ? Number(m) : 0 }))
      setSaved(true)
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="env-section">
      <h4>
        运行档案 <em>data/runs · 超出就按最旧的删</em>
      </h4>

      <div className="editor-row tight">
        <label className="field">
          <span>保留天数</span>
          <input
            value={ttl}
            inputMode="numeric"
            placeholder={view ? String(view.runs.ttlDays) : '30'}
            onChange={(e) => {
              setTtl(e.target.value)
              setSaved(false)
            }}
          />
        </label>
        <label className="field">
          <span>最多份数</span>
          <input
            value={max}
            inputMode="numeric"
            placeholder={view ? String(view.runs.maxFiles) : '500'}
            onChange={(e) => {
              setMax(e.target.value)
              setSaved(false)
            }}
          />
        </label>
      </div>

      <p className="field-note">
        {view?.runs.isDefault
          ? `生效中：默认（${view.runs.ttlDays} 天 / ${view.runs.maxFiles} 份）`
          : `生效中：${view?.runs.ttlDays} 天 / 最多 ${view?.runs.maxFiles} 份`}
        {' · '}保存后立刻按新策略清一次
      </p>

      {error && <p className="form-error">{error}</p>}
      {saved && !error && <p className="field-note ok-note">已保存</p>}

      <div className="env-actions">
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => {
            setTtl('')
            setMax('')
            void save({ ttl: '', max: '' })
          }}
        >
          恢复默认
        </button>
        <button className="btn" disabled={busy || !view} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
