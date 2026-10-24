import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type RunEvent, type SnippetView } from './api'

type VarDraft = Record<string, string>
type Output = { id: string; lines: string[]; running: boolean; ok?: boolean }
type Draft = { snippet: SnippetView; vars: VarDraft; confirmed: boolean }

export function App() {
  const [snippets, setSnippets] = useState<SnippetView[]>([])
  const [health, setHealth] = useState<{ bridgeUp: boolean; queue: number } | null>(null)
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [danger, setDanger] = useState<SnippetView | null>(null)
  const [output, setOutput] = useState<Output | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, h] = await Promise.all([api.snippets(), api.health()])
      setSnippets(list)
      setHealth({ bridgeUp: h.bridgeUp, queue: h.queue })
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = needle
      ? snippets.filter((s) =>
          `${s.id} ${s.title} ${s.group} ${s.tags.join(' ')}`.toLowerCase().includes(needle),
        )
      : snippets
    const map = new Map<string, SnippetView[]>()
    for (const s of filtered) {
      if (!map.has(s.group)) map.set(s.group, [])
      map.get(s.group)!.push(s)
    }
    return [...map.entries()]
  }, [snippets, q])

  function openSnippet(s: SnippetView, confirmed = false) {
    if (s.danger && !confirmed) {
      setDanger(s)
      return
    }
    const names = Object.keys(s.vars)
    if (names.length > 0) {
      const vars: VarDraft = {}
      for (const k of names) {
        const v = s.vars[k]!
        vars[k] = v.default != null ? String(v.default) : ''
      }
      setFormError(null)
      setDraft({ snippet: s, vars, confirmed })
      setPreview(null)
    } else {
      void doRun(s, {}, confirmed)
    }
  }

  async function doRun(s: SnippetView, vars: VarDraft, confirmed: boolean) {
    setOutput({ id: s.id, lines: [`→ ${s.id}`], running: true })
    setDraft(null)
    setDanger(null)
    setFormError(null)
    try {
      await api.run(s.id, vars, confirmed, (ev: RunEvent) => {
        setOutput((o) => {
          if (!o) return o
          const lines = [...o.lines]
          switch (ev.type) {
            case 'start':
              if (ev.cmd && !ev.cmd.startsWith('[')) lines.push(`$ ${ev.cmd}`)
              break
            case 'queued':
              lines.push(`⏳ 队列等待 ${(ev.waitedMs / 1000).toFixed(1)}s`)
              break
            case 'stdout':
              lines.push(ev.data.replace(/\n$/, ''))
              break
            case 'stderr':
              lines.push(`[stderr] ${ev.data.replace(/\n$/, '')}`)
              break
            case 'step':
              lines.push(`✓ step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms`)
              break
            case 'exit':
              lines.push(
                ev.ok
                  ? `✓ done ${ev.durationMs}ms`
                  : ev.timedOut
                    ? '✗ 超时被终止（命令可能仍在桌面会话里跑）'
                    : `✗ failed exit=${ev.exitCode ?? '-'}`,
              )
              break
            case 'error':
              lines.push(`ERROR ${ev.message}`)
              break
          }
          return {
            ...o,
            lines,
            running: ev.type !== 'exit' && ev.type !== 'error',
            ok: ev.type === 'exit' ? ev.ok : o.ok,
          }
        })
      })
    } catch (e) {
      setOutput((o) => (o ? { ...o, lines: [...o.lines, `ERROR ${String(e)}`], running: false, ok: false } : o))
    }
  }

  function submitDraft() {
    if (!draft) return
    const missing = Object.entries(draft.snippet.vars)
      .filter(([k, v]) => v.required && !String(draft.vars[k] ?? '').trim())
      .map(([, v]) => v.prompt ?? '未命名参数')
    if (missing.length > 0) {
      setFormError(`请填写：${missing.join('、')}`)
      return
    }
    void doRun(draft.snippet, draft.vars, draft.confirmed)
  }

  async function loadPreview() {
    if (!draft) return
    try {
      const p = await api.preview(draft.snippet.id, draft.vars)
      setPreview(p.cmds)
    } catch {
      setPreview(null)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">{'{}'}</span>
          <span className="name">SnipDeck</span>
        </div>
        <div className="topbar-right">
          <span className={`badge ${health?.bridgeUp ? 'up' : 'down'}`}>
            {health === null ? '…' : health.bridgeUp ? 'bridge up' : 'bridge down'}
            {health && health.queue > 0 ? ` · q${health.queue}` : ''}
          </span>
          <button className="icon-btn" onClick={() => void refresh()} aria-label="refresh">
            ⟳
          </button>
        </div>
      </header>

      <div className="searchbar">
        <input
          type="search"
          placeholder="搜索片段…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <main className="groups">
        {groups.map(([g, items]) => (
          <section key={g} className="group">
            <h2>{g}</h2>
            <div className="cards">
              {items.map((s) => (
                <button key={s.id} className={`card${s.danger ? ' danger' : ''}`} onClick={() => openSnippet(s)}>
                  <span className="card-title">{s.title}</span>
                  <span className="card-meta">
                    {s.id}
                    {Object.keys(s.vars).length > 0 ? ' · 有变量' : ''}
                    {s.danger ? ' · danger' : ''}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="empty">没有匹配的片段</p>}
      </main>

      {draft && (
        <div className="modal-mask" onClick={() => setDraft(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{draft.snippet.title}</h3>
            <p className="modal-sub">{draft.snippet.id}</p>
            {Object.entries(draft.snippet.vars).map(([k, v]) => (
              <label key={k} className="field">
                <span>
                  {v.prompt ?? k}
                  {v.required ? <em className="req"> *</em> : null}
                </span>
                {v.choices ? (
                  <select value={draft.vars[k] ?? ''} onChange={(e) => setDraft({ ...draft, vars: { ...draft.vars, [k]: e.target.value } })}>
                    {v.choices.map((c) => (
                      <option key={String(c)} value={String(c)}>{String(c) || '(空)'}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={v.secret ? 'password' : 'text'}
                    value={draft.vars[k] ?? ''}
                    placeholder={v.default != null ? String(v.default) : ''}
                    onChange={(e) => setDraft({ ...draft, vars: { ...draft.vars, [k]: e.target.value } })}
                  />
                )}
              </label>
            ))}
            {preview && (
              <pre className="preview">{preview.map((c) => `$ ${c}`).join('\n')}</pre>
            )}
            {formError && <p className="form-error">{formError}</p>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => void loadPreview()}>预览命令</button>
              <button className="btn primary" onClick={submitDraft}>执行</button>
            </div>
          </div>
        </div>
      )}

      {danger && (
        <div className="modal-mask" onClick={() => setDanger(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="danger-title">危险动作确认</h3>
            <p className="modal-sub">{danger.title}（{danger.id}）</p>
            <p className="warn">该片段标记了 danger，执行后可能不可撤销。</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDanger(null)}>取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  const s = danger
                  setDanger(null)
                  if (s) openSnippet(s, true)
                }}
              >
                仍然执行
              </button>
            </div>
          </div>
        </div>
      )}

      {output && (
        <div className={`drawer${output.running ? ' running' : output.ok ? ' ok' : ' fail'}`}>
          <div className="drawer-head">
            <span>{output.id}</span>
            <span className="drawer-status">
              {output.running ? '运行中…' : output.ok ? '完成' : '失败'}
            </span>
            <button className="icon-btn" onClick={() => setOutput(null)} aria-label="close">×</button>
          </div>
          <pre className="drawer-body">{output.lines.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
