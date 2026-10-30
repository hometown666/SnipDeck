import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { ApiError, api, getToken, sessionWsUrl, setToken, type SessionView, type SnippetView } from './api'
import { MacroPanel } from './components/MacroPanel'
import { Tabs } from './components/Tabs'

/**
 * 终端页（P5.2）。
 *
 * 与片段页共享的只有顶栏和 token；这里不碰片段状态，也不做前端路由。
 * 协议与服务端 `terminal-ws.ts` 一一对应：ready / output / exit / error ↔ input / resize / ping。
 *
 * P5.2 加的四件韧性：
 * 1. 断线自动重连（800/1600/3200ms 退避，三次不成才认输）
 * 2. 刷新后接回**同一个**会话（sessionStorage 记住 activeId，不是「随便挑一个 running」）
 * 3. 心跳：手机上切后台时 close 事件可能永远不来（半开连接），靠 ping/pong 超时自救
 * 4. 快捷键盘：Esc / Tab / 粘滞 Ctrl / 方向键 / ^C ^D ^Z，点完自动唤回软键盘
 */

const TERM_FONT =
  'ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei", monospace'

/** 记住「当前看的是哪个会话」：刷新页面靠它接回原来的那一个 */
const ACTIVE_KEY = 'snipdeck.term.active'
/** 退避重连：三次还不成就认输，免得断网时无限重试 */
const RECONNECT_DELAYS = [800, 1600, 3200]
const HEARTBEAT_MS = 20_000
/** 超过这个时间没收到 pong 就认为连接已死（半开） */
const DEAD_AFTER_MS = 45_000

type LinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

type ServerMsg =
  | { t: 'ready'; id: string; shell: string; cols: number; rows: number; replay: string }
  | { t: 'output'; d: string }
  | { t: 'exit'; code: number }
  | { t: 'error'; message: string }
  | { t: 'pong' }

type KeyDef = { label: string; data?: string; ctrl?: boolean; title: string }

/**
 * 快捷键盘只放 8 个键。
 *
 * 少两个不是偷懒：390 宽的手机上 10 个键会被挤出屏幕（实测 ^D / ^Z 看不见），
 * 而这两个完全可以由「粘滞 Ctrl + 字母」得到，^C 因为太常用才单独留一个。
 */
const KEYS: KeyDef[] = [
  { label: 'Esc', data: '\x1b', title: 'Esc' },
  { label: 'Tab', data: '\t', title: 'Tab 补全' },
  { label: 'Ctrl', ctrl: true, title: '粘滞 Ctrl：点亮后按一个字母等于 Ctrl+该字母' },
  { label: '↑', data: '\x1b[A', title: '上一条命令' },
  { label: '↓', data: '\x1b[B', title: '下一条命令' },
  { label: '←', data: '\x1b[D', title: '左移一格' },
  { label: '→', data: '\x1b[C', title: '右移一格' },
  { label: '^C', data: '\x03', title: 'Ctrl+C 中断' },
]

const LINK_TEXT: Record<LinkState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '已连接',
  reconnecting: '重连中…',
  closed: '已断开',
}

export function TerminalApp() {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [shells, setShells] = useState<string[]>(['powershell', 'cmd'])
  const [shell, setShell] = useState('powershell')
  const [link, setLink] = useState<LinkState>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needToken, setNeedToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [size, setSize] = useState({ cols: 80, rows: 24 })
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [macroOpen, setMacroOpen] = useState(false)
  const [snippets, setSnippets] = useState<SnippetView[] | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const bootedRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)
  const ctrlArmedRef = useRef(false)
  const retryRef = useRef(0)
  const reconnectTimerRef = useRef<number | undefined>(undefined)
  const hbTimerRef = useRef<number | undefined>(undefined)
  const pongAtRef = useRef(0)
  /** 服务端说「进程退了」就别重连了——再连上也是一个死会话 */
  const endedRef = useRef(false)
  const openRef = useRef<(id: string) => void>(() => {})

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])
  useEffect(() => {
    ctrlArmedRef.current = ctrlArmed
  }, [ctrlArmed])

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

  const sendInput = useCallback((d: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', d }))
  }, [])

  const stopHeartbeat = useCallback(() => {
    if (hbTimerRef.current !== undefined) {
      window.clearInterval(hbTimerRef.current)
      hbTimerRef.current = undefined
    }
  }, [])

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = undefined
    }
  }, [])

  const startHeartbeat = useCallback(
    (ws: WebSocket) => {
      stopHeartbeat()
      pongAtRef.current = Date.now()
      hbTimerRef.current = window.setInterval(() => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
        if (Date.now() - pongAtRef.current > DEAD_AFTER_MS) {
          // 半开连接：手机上切后台、WiFi 换 4G 时很常见，close 事件可能永远不来。
          // 主动关一下，让 onclose 走重连。
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          return
        }
        ws.send(JSON.stringify({ t: 'ping' }))
      }, HEARTBEAT_MS)
    },
    [stopHeartbeat],
  )

  const disconnect = useCallback(() => {
    const ws = wsRef.current
    // 先把 ref 清掉：旧 socket 的 onclose 会看到 `wsRef.current !== ws` 而静默退出，
    // 这样「主动断开」和「意外掉线」就分得开，不用额外的 closing 标志。
    wsRef.current = null
    stopHeartbeat()
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }, [stopHeartbeat])

  const open = useCallback(
    (id: string) => {
      const term = termRef.current
      if (!term) return
      const ws = new WebSocket(sessionWsUrl(id))
      wsRef.current = ws
      endedRef.current = false

      ws.onmessage = (ev) => {
        let msg: ServerMsg
        try {
          msg = JSON.parse(String(ev.data)) as ServerMsg
        } catch {
          return
        }
        switch (msg.t) {
          case 'ready':
            // replay 是权威内容：先清屏再灌。重连时走同一条路径，屏幕内容不会和增量打架。
            term.reset()
            if (msg.replay) term.write(msg.replay)
            setSize({ cols: msg.cols, rows: msg.rows })
            ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
            setLink('open')
            retryRef.current = 0
            startHeartbeat(ws)
            break
          case 'output':
            term.write(msg.d)
            break
          case 'exit':
            endedRef.current = true
            term.write(`\r\n\x1b[90m[进程已退出 code=${msg.code}]\x1b[0m\r\n`)
            break
          case 'error':
            term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`)
            break
          case 'pong':
            pongAtRef.current = Date.now()
            break
          default:
            break
        }
      }

      ws.onclose = () => {
        // 已被新连接取代 / 主动断开：静默
        if (wsRef.current !== ws) return
        wsRef.current = null
        stopHeartbeat()
        if (endedRef.current) {
          setLink('closed')
          return
        }
        const delay = RECONNECT_DELAYS[retryRef.current]
        if (delay === undefined) {
          setLink('closed')
          term.write(
            '\r\n\x1b[90m[连接已断开，重试 3 次仍失败。会话可能已被回收，用「+ 新建」重开一个]\x1b[0m\r\n',
          )
          return
        }
        retryRef.current += 1
        setLink('reconnecting')
        reconnectTimerRef.current = window.setTimeout(() => openRef.current(id), delay)
      }

      // 握手失败（401/403/404）浏览器只给一个空 error 事件；具体原因看 onclose 后的重试结果
      ws.onerror = () => {
        /* onclose 一定会跟着来，不在这里重复报错 */
      }
    },
    [startHeartbeat, stopHeartbeat],
  )

  useEffect(() => {
    openRef.current = open
  }, [open])

  const connect = useCallback(
    (id: string) => {
      disconnect()
      clearReconnect()
      retryRef.current = 0
      setLink('connecting')
      setActiveId(id)
      try {
        sessionStorage.setItem(ACTIVE_KEY, id)
      } catch {
        /* 隐私模式 */
      }
      open(id)
    },
    [disconnect, clearReconnect, open],
  )

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

  /** 首屏 / 换 token 之后都走它：先接回记忆里的那个，再退而求其次，最后才新建 */
  const adopt = useCallback(
    async (data: { sessions: SessionView[]; shells: string[] }) => {
      let want: string | null = null
      try {
        want = sessionStorage.getItem(ACTIVE_KEY)
      } catch {
        /* 隐私模式 */
      }
      const remembered = want ? data.sessions.find((s) => s.id === want && s.state === 'running') : undefined
      const pick = remembered ?? data.sessions.find((s) => s.state === 'running')
      if (pick) {
        connect(pick.id)
      } else {
        await create(data.shells[0] ?? 'powershell')
      }
    },
    [connect, create],
  )

  const close = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id)
      } catch (e) {
        // 404 说明服务端已经回收了，本地照常清理；
        // 其他错误必须**停下来报**——之前这里吞掉一切，DELETE 全 400 的情况下
        // 界面照样把 chip 抹掉，看起来「删成功」，实际服务端一个都没删（ISSUE-019）。
        if (!(e instanceof ApiError && e.status === 404)) {
          setError(`关闭会话失败：${explain(e)}`)
          return
        }
      }
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (activeIdRef.current === id) {
        disconnect()
        clearReconnect()
        setActiveId(null)
        setLink('idle')
        termRef.current?.reset()
        try {
          sessionStorage.removeItem(ACTIVE_KEY)
        } catch {
          /* ignore */
        }
      }
    },
    [disconnect, clearReconnect, explain],
  )

  // ——— xterm 只建一次；切会话靠 reset + 重连（服务端有 200KB 回滚）———
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13.5,
      lineHeight: 1.25,
      fontFamily: TERM_FONT,
      scrollback: 5000,
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
      // 粘滞 Ctrl：点亮后按一个字母 → 控制码（a→\x01 … z→\x1a）
      if (ctrlArmedRef.current && d.length === 1) {
        const code = d.toUpperCase().charCodeAt(0)
        if (code >= 65 && code <= 90) {
          sendInput(String.fromCharCode(code - 64))
          setCtrlArmed(false)
          return
        }
      }
      sendInput(d)
    })

    const fitAndResize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
      }
      setSize({ cols: term.cols, rows: term.rows })
    }

    // ResizeObserver 看容器（桌面抽屉、窗口缩放）；visualViewport 看软键盘——
    // 手机上键盘弹起时 visualViewport 先变，`100dvh` 未必跟得上。
    const ro = new ResizeObserver(fitAndResize)
    ro.observe(host)
    const vv = window.visualViewport
    vv?.addEventListener('resize', fitAndResize)

    return () => {
      ro.disconnect()
      vv?.removeEventListener('resize', fitAndResize)
      disconnect()
      clearReconnect()
      stopHeartbeat()
      term.dispose()
      termRef.current = null
    }
  }, [disconnect, clearReconnect, sendInput, stopHeartbeat])

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
      await adopt(data)
    })()
  }, [adopt, refresh])

  // 离开页面只断 WS，不删会话：服务端有 60s 宽限，刷新回来还能接上
  useEffect(() => {
    return () => {
      disconnect()
      clearReconnect()
    }
  }, [disconnect, clearReconnect])

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
      await adopt(data)
    })()
  }

  const pressKey = (k: KeyDef) => {
    if (k.ctrl) {
      setCtrlArmed((v) => !v)
    } else if (k.data) {
      sendInput(k.data)
    }
    // 点完把焦点还给终端，否则手机上软键盘会收起来
    termRef.current?.focus()
  }

  /** 片段库只在第一次打开面板时拉，之后复用 */
  const openMacro = useCallback(async () => {
    setMacroOpen(true)
    if (snippets) return
    try {
      setSnippets(await api.snippets())
    } catch (e) {
      setError(explain(e))
    }
  }, [snippets, explain])

  /** 插入只写输入行；execute 才补一个回车（默认不执行，见 MacroPanel 的注释） */
  const insertMacro = useCallback(
    (cmd: string, execute: boolean) => {
      sendInput(execute ? `${cmd}\r` : cmd)
      setMacroOpen(false)
      termRef.current?.focus()
    },
    [sendInput],
  )

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
          <span className={`badge link-${link}`} title="WebSocket 连接状态">
            {LINK_TEXT[link]}
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
            <span className={`term-dot ${s.state}`} title={s.state === 'running' ? '运行中' : '已退出'} />
            <button
              className="term-chip-label"
              onClick={() => connect(s.id)}
              title={`${s.shell} · ${s.cwd}`}
              data-session-id={s.id}
            >
              {s.shell}
              {s.attached > 1 ? <em className="term-chip-n">·{s.attached}</em> : null}
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
        <button
          className="term-new"
          onClick={() => void openMacro()}
          title="从片段库插入一条命令到当前终端"
          data-open-macro="1"
        >
          片段…
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

      <div className="term-keys" aria-label="快捷按键">
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            className={`term-key${k.ctrl && ctrlArmed ? ' on' : ''}`}
            title={k.title}
            // 别让按钮抢焦点：一抢，手机软键盘就收起来了
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pressKey(k)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {macroOpen ? (
        <MacroPanel
          snippets={snippets ?? []}
          onInsert={insertMacro}
          onClose={() => {
            setMacroOpen(false)
            termRef.current?.focus()
          }}
        />
      ) : null}
    </div>
  )
}
