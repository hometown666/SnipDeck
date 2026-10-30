import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { ApiError, api, getToken, sessionWsUrl, setToken, type SessionView } from './api'
import { Tabs } from './components/Tabs'

/**
 * 终端页（P5.1）。
 *
 * 与片段页共享的只有顶栏和 token；这里不碰片段状态，也不做前端路由。
 * 协议与服务端 `terminal-ws.ts` 一一对应：ready / output / exit / error ↔ input / resize。
 */

const TERM_FONT =
  'ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei", monospace'

type ServerMsg =
  | { t: 'ready'; id: string; shell: string; cols: number; rows: number; replay: string }
  | { t: 'output'; d: string }
  | { t: 'exit'; code: number }
  | { t: 'error'; message: string }
  | { t: 'pong' }

export function TerminalApp() {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [shells, setShells] = useState<string[]>(['powershell', 'cmd'])
  const [shell, setShell] = useState('powershell')
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needToken, setNeedToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [size, setSize] = useState({ cols: 80, rows: 24 })

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const bootedRef = useRef(false)
  // 被主动关掉的会话别弹「已断开」：socket 的 close 事件分不清是谁关的
  const closingRef = useRef(false)

  /** 把后端错误变成一句能看的提示；403 单独处理（token 问题，不是功能坏了） */
  const explain = useCallback((e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 403) {
        try {
          const j = JSON.parse(e.detail ?? '{}') as { message?: string }
          if (j.message) return j.message
        } catch {
          /* 不是 JSON 就用 error 字段 */
        }
      }
      return e.message
    }
    return e instanceof Error ? e.message : String(e)
  }, [])

  const connect = useCallback((id: string) => {
    const term = termRef.current
    if (!term) return
    closingRef.current = true
    wsRef.current?.close()
    closingRef.current = false

    term.reset()
    const ws = new WebSocket(sessionWsUrl(id))
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setError(null)
    }

    ws.onmessage = (ev) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg
      } catch {
        return
      }
      switch (msg.t) {
        case 'ready':
          // ready 的 replay 是权威内容：先清屏再灌，避免上一次会话的残影
          term.reset()
          if (msg.replay) term.write(msg.replay)
          setSize({ cols: msg.cols, rows: msg.rows })
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
          break
        case 'output':
          term.write(msg.d)
          break
        case 'exit':
          term.write(`\r\n\x1b[90m[进程已退出 code=${msg.code}]\x1b[0m\r\n`)
          setConnected(false)
          break
        case 'error':
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`)
          break
        default:
          break
      }
    }

    ws.onclose = () => {
      setConnected(false)
      if (closingRef.current) return
      term.write('\r\n\x1b[90m[连接已断开]\x1b[0m\r\n')
    }

    // 握手失败（401/403/404）浏览器只给一个空 error 事件，原因在服务端的 HTTP 响应里
    ws.onerror = () => {
      setError('WebSocket 握手失败：token 不对、会话已消失，或服务端未启用终端')
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await api.sessions()
      setShells(data.shells.length > 0 ? data.shells : ['powershell'])
      setSessions(data.sessions)
      setNeedToken(false)
      return data
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setNeedToken(true)
        setError(explain(e))
        return null
      }
      setError(explain(e))
      return null
    }
  }, [explain])

  const create = useCallback(
    async (sh: string) => {
      setBusy(true)
      try {
        const term = termRef.current
        const s = await api.createSession(sh, term?.cols ?? 80, term?.rows ?? 24)
        setSessions((prev) => [...prev, s])
        setActiveId(s.id)
        connect(s.id)
        setError(null)
      } catch (e) {
        setError(explain(e))
      } finally {
        setBusy(false)
      }
    },
    [connect, explain],
  )

  const close = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id)
      } catch {
        /* 会话可能已经被服务端回收，不影响本地清理 */
      }
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (activeId === id) {
        closingRef.current = true
        wsRef.current?.close()
        closingRef.current = false
        wsRef.current = null
        setActiveId(null)
        setConnected(false)
        termRef.current?.reset()
      }
    },
    [activeId],
  )

  // ——— xterm 只建一次，切会话靠 reset + 重连（服务端有 200KB 回滚，切回来不丢内容）———
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13.5,
      lineHeight: 1.25,
      fontFamily: TERM_FONT,
      scrollback: 5000,
      // 深色终端 + 浅色站点：像一个「嵌在页面里的窗口」，比强行套站点配色更清楚
      theme: {
        background: '#12141a',
        foreground: '#e4e6eb',
        cursor: '#9fe1cb',
        selectionBackground: '#2c3f4a',
        black: '#1a1c22',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#dcdfe4',
        brightBlack: '#5c6370',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#e5c07b',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    termRef.current = term
    fitRef.current = fit

    term.onData((d) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', d }))
    })

    // ResizeObserver 而不是 window.resize：桌面抽屉展开时窗口尺寸没变，容器变了
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* 容器还没布局完时 fit 会抛，忽略 */
      }
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
      }
      setSize({ cols: term.cols, rows: term.rows })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      closingRef.current = true
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // ——— 首屏：优先接已有会话，没有才新建 ———
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void (async () => {
      if (!getToken()) {
        setNeedToken(true)
        return
      }
      const data = await refresh()
      if (!data) return
      const alive = data.sessions.find((s) => s.state === 'running')
      if (alive) {
        setActiveId(alive.id)
        connect(alive.id)
      } else {
        await create(data.shells[0] ?? 'powershell')
      }
    })()
  }, [connect, create, refresh])

  // 离开页面只断 WS，不删会话：服务端有 60s 宽限，刷新回来还能接上
  useEffect(() => {
    return () => {
      closingRef.current = true
      wsRef.current?.close()
    }
  }, [])

  const saveToken = () => {
    const t = tokenInput.trim()
    if (!t) return
    setToken(t)
    setTokenInput('')
    setNeedToken(false)
    setError(null)
    void (async () => {
      const data = await refresh()
      if (!data) return
      const alive = data.sessions.find((s) => s.state === 'running')
      if (alive) {
        setActiveId(alive.id)
        connect(alive.id)
      } else {
        await create(data.shells[0] ?? 'powershell')
      }
    })()
  }

  const active = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div className="term-app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">{'{}'}</span>
          <span className="name">SnipDeck</span>
        </div>
        <Tabs active="terminal" />
        <div className="topbar-right">
          <span className={`badge ${connected ? 'up' : 'down'}`}>
            {connected ? '已连接' : '未连接'}
          </span>
          <button
            className={`icon-btn${needToken ? ' on' : ''}`}
            onClick={() => setNeedToken(true)}
            aria-label="设置 token"
            title="访问 token"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="term-bar">
        {sessions.map((s) => (
          <span key={s.id} className={`term-chip${s.id === activeId ? ' on' : ''}`}>
            <button
              className="term-chip-label"
              onClick={() => {
                setActiveId(s.id)
                connect(s.id)
              }}
              title={`${s.shell} · ${s.cwd}`}
            >
              {s.shell}
            </button>
            <button className="term-chip-x" onClick={() => void close(s.id)} aria-label="关闭会话">
              ×
            </button>
          </span>
        ))}
        <select
          className="term-shell"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          aria-label="新建会话的 shell"
        >
          {shells.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="term-new" disabled={busy} onClick={() => void create(shell)}>
          {busy ? '创建中…' : '+ 新建'}
        </button>
        <span className="term-meta">
          {active ? `${size.cols}×${size.rows} · ${active.cwd}` : `${size.cols}×${size.rows}`}
        </span>
      </div>

      {error ? (
        <div className="term-alert">
          <span>{error}</span>
          <button className="icon-btn" onClick={() => setError(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      <div className="term-host-wrap">
        <div className="term-host" ref={hostRef} />
        {needToken ? (
          <div className="term-gate">
            <h2>终端需要访问 token</h2>
            <p>
              WS 通道不走 loopback 豁免——反代一旦放行就等于把 remote shell 送出去。
              所以这里比片段页严格：没 token 连不上。
            </p>
            <div className="term-gate-row">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveToken()
                }}
                placeholder="粘贴 SNIP_TOKEN"
                autoFocus
              />
              <button onClick={saveToken}>保存并连接</button>
            </div>
            <p className="term-gate-hint">
              服务端的 `.env` 里也要有同一个 `SNIP_TOKEN`，否则终端整体关闭（403）。
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
