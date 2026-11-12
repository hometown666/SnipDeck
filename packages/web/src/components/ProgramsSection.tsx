import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type ProgramsConfigView } from '../api'

/**
 * 程序发现的范围（P7.3b）：`only` 与 `extraRoots`。
 *
 * `only` 就是「程序 txt」的结构化版：一行一个绝对路径，非空即**跳过自动发现**、
 * 只显示这些，而且不套黑名单（你点名要的，就是你要的）。
 *
 * 为什么必须校验存在性：服务端扫的是自己的文件系统，路径写错不会报错，
 * 只会得到一张空列表——那比 400 难查得多。
 */
export function ProgramsSection({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<ProgramsConfigView | null>(null)
  const [only, setOnly] = useState('')
  const [extraRoots, setExtraRoots] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const adopt = useCallback((v: ProgramsConfigView) => {
    setView(v)
    setOnly(v.config.only.join('\n'))
    setExtraRoots(v.config.extraRoots.join('\n'))
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const v = await api.programsConfig()
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
      const v = await api.saveProgramsConfig({
        only: splitLines(only),
        extraRoots: splitLines(extraRoots),
        include: view?.config.include ?? [],
      })
      adopt(v)
      setSaved(true)
      onChanged?.()
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onlyCount = splitLines(only).length

  return (
    <div className="env-section">
      <h4>
        程序列表 <em>扫 .lnk 与便携 .exe；改了下次打开运行表单生效</em>
      </h4>

      <label className="field">
        <span>
          只显示这些 <span className="hint">only · 一行一个 .lnk 或 .exe 绝对路径</span>
        </span>
        <textarea
          className="ui-textarea"
          rows={4}
          value={only}
          placeholder={'留空 = 自动发现（PROG_DIR + 开始菜单 + 桌面）\n例如 D:\\Users\\Desktop\\程序\\WeChat.lnk 或 D:\\Tools\\Everything\\Everything.exe'}
          spellCheck={false}
          onChange={(e) => {
            setOnly(e.target.value)
            setSaved(false)
          }}
        />
      </label>
      <p className="field-note">
        {onlyCount > 0
          ? `生效：只显示这 ${onlyCount} 条，不再扫描；这些条目不套黑名单`
          : '生效：自动发现 —— PROG_DIR（不套黑名单）+ 开始菜单 + 桌面 + 额外目录'}
      </p>

      <label className="field">
        <span>
          额外目录 <span className="hint">extraRoots · 一行一个目录（扫 .lnk 与两层内的 .exe）</span>
        </span>
        <textarea
          className="ui-textarea"
          rows={2}
          value={extraRoots}
          placeholder="例如 D:\\Tools\\快捷方式"
          spellCheck={false}
          onChange={(e) => {
            setExtraRoots(e.target.value)
            setSaved(false)
          }}
        />
      </label>

      {view && (
        <p className="field-note">
          配置文件 <code>{view.file}</code>
          {view.exists ? '' : ' · 还没创建（保存后生成）'}
          {view.config.include.length > 0 ? ` · include ${view.config.include.length} 条` : ''}
        </p>
      )}

      {error && <p className="form-error">{error}</p>}
      {saved && !error && <p className="field-note ok-note">已保存</p>}

      <div className="env-actions">
        <button className="btn" disabled={busy || view === null} onClick={() => void save()}>
          {busy ? '保存中…' : '保存程序范围'}
        </button>
      </div>
    </div>
  )
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}
