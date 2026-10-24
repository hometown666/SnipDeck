import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, getToken, setToken, type HealthView, type RunEvent, type SnippetView } from './api'

type VarDraft = Record<string, string>
type Output = {
  id: string
  lines: string[]
  running: boolean
  ok?: boolean
  startedAt: number
  durationMs?: number
  timedOut?: boolean
}
type Draft = { snippet: SnippetView; vars: VarDraft; confirmed: boolean }

const MAX_LINES = 2000
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function clean(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\n$/, '')
}

export function App() {
  const [snippets, setSnippets] = useState<SnippetView[]>([])
  const [health, setHealth] = useState<HealthView | null>(null)
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [danger, setDanger] = useState<SnippetView | null>(null)
  const [output, setOutput] = useState<Output | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [needToken, setNeedToken] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(0)

  const bodyRef = useRef<HTMLPreElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, h] = await Promise.all([api.snippets(), api.health()])
      setSnippets(list)
      setHealth(h)
      setNeedToken(false)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true)
      else console.error(e)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 队列/桥状态轮询：页面隐藏时停掉，回来立刻刷一次
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return
      api
        .health()
        .then(setHealth)
        .catch(() => undefined)
    }, 4000)
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // 运行中的计时
  useEffect(() => {
    if (!output?.running) return
    const t = setInterval(() => setTick((n) => n + 1), 200)
    return () => clearInterval(t)
  }, [output?.running])

  // 输出自动滚到底
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output?.lines.length, output?.running])

  // Esc 关最上层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showSettings || needToken) {
        setShowSettings(false)
        return
      }
      if (draft) return setDraft(null)
      if (danger) return setDanger(null)
      if (output) setOutput(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, danger, output, showSettings, needToken])

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
    setOutput({ id: s.id, lines: [`→ ${s.id}`], running: true, startedAt: Date.now() })
    setDraft(null)
    setDanger(null)
    setFormError(null)
    setCopied(false)
    try {
      await api.run(s.id, vars, confirmed, (ev: RunEvent) => {
        setOutput((o) => {
          if (!o) return o
          const extra: string[] = []
          let { running, ok, durationMs, timedOut } = o
          switch (ev.type) {
            case 'start':
              if (ev.cmd && !ev.cmd.startsWith('[')) extra.push(`$ ${ev.cmd}`)
              break
            case 'queued':
              extra.push(`⏳ 队列等待 ${(ev.waitedMs / 1000).toFixed(1)}s`)
              break
            case 'stdout':
              extra.push(clean(ev.data))
              break
            case 'stderr':
              extra.push(`[stderr] ${clean(ev.data)}`)
              break
            case 'step':
              extra.push(`✓ step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms`)
              break
            case 'exit':
              running = false
              ok = ev.ok
              durationMs = ev.durationMs
              timedOut = ev.timedOut
              extra.push(
                ev.ok
                  ? `✓ done ${ev.durationMs}ms`
                  : ev.timedOut
                    ? '✗ 超时被终止（命令可能仍在桌面会话里跑）'
                    : `✗ failed exit=${ev.exitCode ?? '-'}`,
              )
              break
            case 'error':
              running = false
              ok = false
              extra.push(`ERROR ${ev.message}`)
              break
          }
          return {
            ...o,
            lines: [...o.lines, ...extra].slice(-MAX_LINES),
            running,
            ok,
            durationMs,
            timedOut,
          }
        })
      })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true)
      setOutput((o) =>
        o
          ? { ...o, lines: [...o.lines, `ERROR ${String(e)}`].slice(-MAX_LINES), running: false, ok: false }
          : o,
      )
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

  async function copyOutput() {
    if (!output) return
    const text = output.lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  async function saveToken() {
    setToken(tokenInput.trim())
    try {
      const h = await api.health()
      setHealth(h)
      setNeedToken(false)
      setShowSettings(false)
      setTokenError(null)
      void refresh()
    } catch {
      setTokenError('token 不对，或服务端未设置 SNIP_TOKEN')
    }
  }

  const elapsed = output ? (output.running ? Date.now() - output.startedAt : output.durationMs ?? 0) : 0
  void tick
  const tokenSet = !!getToken()
  const settingsOpen = showSettings || needToken

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">{'{}'}</span>
          <span className="name">SnipDeck</span>
        </div>
        <div className="topbar-right">
          <span className={`badge ${health?.bridgeUp ? 'up' : 'down'}`} title="AHK 桥状态">
            {health === null ? '…' : health.bridgeUp ? 'bridge up' : 'bridge down'}
          </span>
          {health && health.queue > 0 ? (
            <span className="badge queue" title="桥单车道队列长度">
              排队 {health.queue}
            </span>
          ) : null}
          <button className="icon-btn" onClick={() => void refresh()} aria-label="刷新">
            ⟳
          </button>
          <button
            className={`icon-btn${tokenSet ? ' on' : ''}`}
            onClick={() => {
              setTokenInput(getToken())
              setTokenError(null)
              setShowSettings(true)
            }}
            aria-label="设置"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="searchbar">
        <input
          type="search"
          placeholder="搜索片段（id / 标题 / 分组 / 标签）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {needToken && (
        <div className="banner">
          这台设备还没有 token，先填一次才能执行片段。
          <button className="link" onClick={() => setShowSettings(true)}>去填写</button>
        </div>
      )}

      <main className="groups">
        {groups.map(([g, items]) => (
          <section key={g} className="group">
            <h2>
              {g} <em>{items.length}</em>
            </h2>
            <div className="cards">
              {items.map((s) => (
                <button
                  key={s.id}
                  className={`card${s.danger ? ' danger' : ''}`}
                  onClick={() => openSnippet(s)}
                >
                  <span className="card-title">{s.title}</span>
                  <span className="card-meta">
                    {s.id}
                    {Object.keys(s.vars).length > 0 ? ` · ${Object.keys(s.vars).length} 个变量` : ''}
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
            <p className="modal-sub">
              {draft.snippet.id}
              {draft.snippet.target ? ` · ${draft.snippet.target}` : ''} · {draft.snippet.steps} 步
            </p>
            {Object.entries(draft.snippet.vars).map(([k, v]) => (
              <label key={k} className="field">
                <span>
                  {v.prompt ?? k}
                  {v.required ? <em className="req"> *</em> : null}
                </span>
                {v.choices ? (
                  <select
                    value={draft.vars[k] ?? ''}
                    onChange={(e) => setDraft({ ...draft, vars: { ...draft.vars, [k]: e.target.value } })}
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
                    onChange={(e) => setDraft({ ...draft, vars: { ...draft.vars, [k]: e.target.value } })}
                  />
                )}
              </label>
            ))}
            {preview && <pre className="preview">{preview.map((c) => `$ ${c}`).join('\n')}</pre>}
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

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setShowSettings(false)}>
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
                onChange={(e) => setTokenInput(e.target.value)}
              />
            </label>
            {tokenError && <p className="form-error">{tokenError}</p>}
            <div className="modal-actions">
              <button
                className="btn ghost"
                onClick={() => {
                  setToken('')
                  setTokenInput('')
                  setShowSettings(false)
                  void refresh()
                }}
              >
                清除
              </button>
              <button className="btn primary" onClick={() => void saveToken()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {output && (
        <div className={`drawer${output.running ? ' running' : output.ok ? ' ok' : ' fail'}`}>
          <div className="drawer-head">
            <span className="drawer-id">{output.id}</span>
            <span className="drawer-status">
              {output.running ? `运行中 ${(elapsed / 1000).toFixed(1)}s` : output.ok ? `完成 ${((output.durationMs ?? 0) / 1000).toFixed(1)}s` : output.timedOut ? '超时' : '失败'}
            </span>
            <span className="drawer-tools">
              <button className="icon-btn" onClick={() => void copyOutput()} aria-label="复制输出">
                {copied ? '✓' : '⧉'}
              </button>
              <button className="icon-btn" onClick={() => setOutput(null)} aria-label="关闭">×</button>
            </span>
          </div>
          <pre className="drawer-body" ref={bodyRef}>{output.lines.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
