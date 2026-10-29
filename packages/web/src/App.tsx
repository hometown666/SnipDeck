import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, getToken, setToken, type HealthView, type RunEvent, type SnippetView } from './api'

type VarDraft = Record<string, string>

/** 输出行带语义：桌面端要按类型上色，不能全拍平成纯文本 */
type LineKind = 'cmd' | 'step' | 'queue' | 'out' | 'err' | 'meta'
type Line = { kind: LineKind; text: string; ok?: boolean }

type Output = {
  id: string
  lines: Line[]
  running: boolean
  ok?: boolean
  startedAt: number
  durationMs?: number
  exitCode?: number
  timedOut?: boolean
  /** 失败但退出码为 0 时的说明（桥 ERR| 前缀） */
  note?: string
}
type Draft = { snippet: SnippetView; vars: VarDraft; confirmed: boolean }

const MAX_LINES = 2000
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function clean(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\n$/, '')
}

function toLines(kind: LineKind, text: string): Line[] {
  return clean(text)
    .split('\n')
    .map((t) => ({
      // 桥用 `ERR|` 前缀报错且退出码为 0，这里直接把行标成错误色，别让人靠读文本找
      kind: kind === 'out' && /^ERR\|/.test(t) ? ('err' as LineKind) : kind,
      text: t,
    }))
}

/** 小于 1s 时显示毫秒：`完成 29ms` 比 `完成 0.0s` 有信息量 */
function fmtDur(ms: number | undefined): string {
  if (ms == null) return '-'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function App() {
  const [snippets, setSnippets] = useState<SnippetView[]>([])
  const [health, setHealth] = useState<HealthView | null>(null)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [danger, setDanger] = useState<SnippetView | null>(null)
  const [output, setOutput] = useState<Output | null>(null)
  const [wrap, setWrap] = useState(false)
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

  // 只刷 health（不重拉片段列表）：队列状态随时会变，但片段不会
  const refreshHealth = useCallback(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 队列/桥状态轮询：页面隐藏时停掉，回来立刻刷一次。
  // 间隔跟着运行态走——空闲 4s 足够，跑起来时降到 **500ms**：桥被占用通常 0.3~1s，
  // 1s 采样仍然可能整段漏掉（ISSUE-003 实测）。500ms < 最短可观测的排队窗口，才是稳态兜底。
  // health 有 30s TTL + 单飞去重，密采样不打桥。
  // 另有一个辅助触发点在 doRun 里：收到 `queued` 事件时刷一次（注意它是在**等待结束**时才发的，
  // 所以不能当主路径，只用来收尾）。
  const running = !!output?.running
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (document.hidden) return
        refreshHealth()
      },
      running ? 500 : 4000,
    )
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh, refreshHealth, running])

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

  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups])
  const activeIndex = useMemo(() => {
    const idx = new Map<string, number>()
    flat.forEach((s, i) => idx.set(s.id, i))
    return idx
  }, [flat])

  useEffect(() => setActive(0), [q])

  // 快捷键：/ 聚焦搜索、Esc 关最上层、↑↓ 选、Enter 打开、Ctrl/Cmd+Enter 直接执行
  useEffect(() => {
    const searchInput = () =>
      [...document.querySelectorAll<HTMLInputElement>('[data-search]')].find(
        (el) => el.offsetParent !== null,
      )

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)

      if (e.key === 'Escape') {
        if (showSettings || needToken) return setShowSettings(false)
        if (draft) return setDraft(null)
        if (danger) return setDanger(null)
        if (output) return setOutput(null)
        if (typing) (target as HTMLInputElement).blur()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && draft) {
        e.preventDefault()
        submitDraft()
        return
      }

      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchInput()?.focus()
        return
      }

      if (typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        setActive((i) => Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
        return
      }

      if (typing && e.key === 'Enter' && flat[active]) {
        e.preventDefault()
        openSnippet(flat[active]!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function openSnippet(s: SnippetView, confirmed = false) {
    // 点过的卡片同步成键盘选中项，↑↓ 继续在这一行附近走
    const i = activeIndex.get(s.id)
    if (i != null) setActive(i)
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
    setOutput({
      id: s.id,
      lines: [{ kind: 'meta', text: `${s.id}${s.target ? ' · ' + s.target : ''} · 开始` }],
      running: true,
      startedAt: Date.now(),
    })
    setWrap(false)
    setDraft(null)
    setDanger(null)
    setFormError(null)
    setCopied(false)
    try {
      await api.run(s.id, vars, confirmed, (ev: RunEvent) => {
        setOutput((o) => {
          if (!o) return o
          const extra: Line[] = []
          let { running, ok, durationMs, timedOut, exitCode, note } = o
          switch (ev.type) {
            case 'start':
              if (ev.cmd && !ev.cmd.startsWith('[')) extra.push({ kind: 'cmd', text: ev.cmd })
              break
            case 'queued':
              extra.push({ kind: 'queue', text: `队列等待 ${(ev.waitedMs / 1000).toFixed(1)}s` })
              break
            case 'stdout':
              extra.push(...toLines('out', ev.data))
              break
            case 'stderr':
              extra.push(...toLines('err', ev.data))
              break
            case 'step':
              extra.push({
                kind: 'step',
                ok: ev.ok,
                text: `step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms${ev.note ? ' · ERR' : ''}`,
              })
              break
            case 'exit':
              running = false
              ok = ev.ok
              durationMs = ev.durationMs
              timedOut = ev.timedOut
              exitCode = ev.exitCode
              note = ev.note
              extra.push({
                kind: 'step',
                ok: ev.ok,
                text: ev.ok
                  ? `done ${ev.durationMs}ms`
                  : ev.timedOut
                    ? '超时被终止（命令可能仍在桌面会话里跑）'
                    : ev.note
                      ? `桥侧报错（退出码 ${ev.exitCode ?? 0}）`
                      : `failed exit=${ev.exitCode ?? '-'}`,
              })
              break
            case 'error':
              running = false
              ok = false
              extra.push({ kind: 'err', text: `ERROR ${ev.message}` })
              break
          }
          return {
            ...o,
            lines: [...o.lines, ...extra].slice(-MAX_LINES),
            running,
            ok,
            durationMs,
            exitCode,
            timedOut,
            note,
          }
        })
        // 徽标的主路径：收到 queued 事件的那一刻服务端 queue 必然 > 0，一刷必中；
        // 收尾（exit/error）也刷一次，把徽标清回去。
        if (ev.type === 'queued' || ev.type === 'exit' || ev.type === 'error') refreshHealth()
      })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true)
      setOutput((o) =>
        o
          ? {
              ...o,
              lines: [...o.lines, { kind: 'err' as const, text: `ERROR ${String(e)}` }].slice(-MAX_LINES),
              running: false,
              ok: false,
            }
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
    const text = output.lines.map((l) => l.text).join('\n')
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
  const statusText = !output
    ? ''
    : output.running
      ? `运行中 ${fmtDur(elapsed)}`
      : output.ok
        ? `完成 ${fmtDur(output.durationMs)}`
        : output.timedOut
        ? '超时'
        : output.note
          ? `失败 · 桥侧报错 · ${fmtDur(output.durationMs)}`
          : `失败${output.exitCode != null ? ` exit=${output.exitCode}` : ''}${output.durationMs != null ? ` · ${fmtDur(output.durationMs)}` : ''}`

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
          <button className="icon-btn" onClick={() => void refresh()} aria-label="刷新" title="刷新（R）">
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
            title="访问 token"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-search">
            <input
              data-search
              type="search"
              placeholder="搜索（/）"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && flat[active]) openSnippet(flat[active]!)
              }}
            />
          </div>
          <nav className="nav">
            {groups.map(([g, items], i) => (
              <button
                key={g}
                className="nav-item"
                onClick={() => document.getElementById(`grp-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
              >
                <span className="nav-name">{g}</span>
                <em>{items.length}</em>
              </button>
            ))}
          </nav>
          <p className="nav-hint">/ 搜索 · ↑↓ 选择 · Enter 执行 · Esc 关闭</p>
        </aside>

        <div className="content">
          <div className="searchbar">
            <input
              data-search
              type="search"
              placeholder="搜索片段（id / 标题 / 分组 / 标签）…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && flat[active]) openSnippet(flat[active]!)
              }}
            />
          </div>

          {needToken && (
            <div className="banner">
              这台设备还没有 token，先填一次才能执行片段。
              <button className="link" onClick={() => setShowSettings(true)}>
                去填写
              </button>
            </div>
          )}

          <main className="groups">
            {groups.map(([g, items], gi) => (
              <section key={g} className="group" id={`grp-${gi}`}>
                <h2>
                  {g} <em>{items.length}</em>
                </h2>
                <div className="cards">
                  {items.map((s) => {
                    const idx = activeIndex.get(s.id)
                    return (
                      <button
                        key={s.id}
                        className={`card${s.danger ? ' danger' : ''}${idx === active ? ' active' : ''}`}
                        onClick={() => openSnippet(s)}
                        title={`${s.title} · ${s.id}`}
                      >
                        <span className="card-title">{s.title}</span>
                        <span className="card-meta">
                          {s.id}
                          {Object.keys(s.vars).length > 0 ? ` · ${Object.keys(s.vars).length} 变量` : ''}
                          {s.danger ? ' · danger' : ''}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
            {groups.length === 0 && <p className="empty">没有匹配的片段</p>}
          </main>
        </div>
      </div>

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
              <span className="modal-hint">Ctrl/⌘+Enter 直接执行</span>
              <button className="btn ghost" onClick={() => void loadPreview()}>
                预览命令
              </button>
              <button className="btn primary" onClick={submitDraft}>
                执行
              </button>
            </div>
          </div>
        </div>
      )}

      {danger && (
        <div className="modal-mask" onClick={() => setDanger(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="danger-title">危险动作确认</h3>
            <p className="modal-sub">
              {danger.title}（{danger.id}）
            </p>
            <p className="warn">该片段标记了 danger，执行后可能不可撤销。</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDanger(null)}>
                取消
              </button>
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
              <button className="btn primary" onClick={() => void saveToken()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {output && (
        <div className={`drawer${output.running ? ' running' : output.ok ? ' ok' : ' fail'}${wrap ? ' wrap' : ''}`}>
          <div className="drawer-head">
            <span className="drawer-id">{output.id}</span>
            <span className={`drawer-status ${output.running ? 'run' : output.ok ? 'ok' : 'fail'}`}>
              {statusText}
            </span>
            <span className="drawer-tools">
              <button
                className={`icon-btn${wrap ? ' on' : ''}`}
                onClick={() => setWrap((w) => !w)}
                aria-label="自动换行"
                title="自动换行（长段落用）"
              >
                ↩
              </button>
              <button className="icon-btn" onClick={() => void copyOutput()} aria-label="复制输出" title="复制">
                {copied ? '✓' : '⧉'}
              </button>
              <button className="icon-btn" onClick={() => setOutput(null)} aria-label="关闭" title="关闭（Esc）">
                ×
              </button>
            </span>
          </div>
          <pre className="drawer-body" ref={bodyRef}>
            {output.lines.map((l, i) => (
              <span
                key={i}
                className={`line line-${l.kind}${l.kind === 'step' ? (l.ok ? ' ok' : ' bad') : ''}`}
              >
                {l.kind === 'cmd' ? <span className="line-mark">$ </span> : null}
                {l.kind === 'step' ? <span className="line-mark">{l.ok ? '✓ ' : '✗ '}</span> : null}
                {l.kind === 'queue' ? <span className="line-mark">⏳ </span> : null}
                {l.kind === 'err' ? <span className="line-mark">! </span> : null}
                {l.text}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
