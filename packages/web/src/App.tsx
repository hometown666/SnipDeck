import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ApiError,
  api,
  getToken,
  setToken,
  type HealthView,
  type HostView,
  type RunDetailView,
  type RunEvent,
  type RunListItem,
  type SnippetView,
} from './api'

type VarDraft = Record<string, string>

/** 输出行带语义：桌面端要按类型上色，不能全拍平成纯文本 */
type LineKind = 'cmd' | 'step' | 'queue' | 'out' | 'err' | 'meta'
type Line = { kind: LineKind; text: string; ok?: boolean }

/** 一个目标一块面板。多目标时并列展示，单目标时只渲染它、不显示面板头 */
type Pane = {
  target: string
  index: number
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
type Output = {
  id: string
  panes: Pane[]
  startedAt: number
  /** 服务端档案编号：首条 start 事件带回来，断开后能凭它回看 */
  runId?: string
  /** 从档案回放出来的（不是本次真跑的）：不跑计时、头部显示历史时间 */
  replayed?: boolean
  replayedAt?: number
}
type Draft = { snippet: SnippetView; vars: VarDraft; confirmed: boolean; targets: string[] }

const MAX_LINES = 2000
/** 与服务端 packages/server/src/app.ts 的 MAX_TARGETS 对齐（那边只是防呆，前端也拦一道才有好体验） */
const MAX_TARGETS = 8
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

/** `2026-10-29 22:48:12`，历史列表与回放头部共用 */
function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 一条 step 事件怎么显示：expect 步要能看出「在等什么 / 命中了什么」 */
function stepText(ev: Extract<RunEvent, { type: 'step' }>): string {
  if (ev.expect !== undefined) {
    return ev.ok
      ? `step${ev.stepIndex} match /${ev.expect}/ → ${ev.matched ?? ''}`
      : `step${ev.stepIndex} 未命中 /${ev.expect}/${ev.note ? ` · ${ev.note}` : ''}`
  }
  return `step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms${ev.note ? ' · ERR' : ''}`
}

/** 小于 1s 时显示毫秒：`完成 29ms` 比 `完成 0.0s` 有信息量 */
function fmtDur(ms: number | undefined): string {
  if (ms == null) return '-'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function paneStatus(p: Pane, now: number): string {
  if (p.running) return `运行中 ${fmtDur(now - p.startedAt)}`
  if (p.ok) return `完成 ${fmtDur(p.durationMs)}`
  if (p.timedOut) return '超时'
  if (p.note) return `失败 · 桥侧报错 · ${fmtDur(p.durationMs)}`
  return `失败${p.exitCode != null ? ` exit=${p.exitCode}` : ''}${p.durationMs != null ? ` · ${fmtDur(p.durationMs)}` : ''}`
}

/** 同一目标开多次时才加 #序号，否则标题就是目标名 */
function paneLabel(panes: Pane[], p: Pane): string {
  const same = panes.filter((x) => x.target === p.target)
  return same.length > 1 ? `${p.target} #${same.indexOf(p) + 1}` : p.target
}

/** 一条事件落到哪块面板：优先服务端打的 targetIndex，退回按 target 名找，最后兜底第一块 */
function paneIndexOf(o: Output, ev: RunEvent): number {
  if (typeof ev.targetIndex === 'number' && o.panes[ev.targetIndex]) return ev.targetIndex
  if (ev.target) {
    const i = o.panes.findIndex((p) => p.target === ev.target)
    if (i >= 0) return i
  }
  return 0
}

function applyEvent(o: Output, ev: RunEvent): Output {
  const idx = paneIndexOf(o, ev)
  const pane = o.panes[idx]
  if (!pane) return o

  const extra: Line[] = []
  let { running, ok, durationMs, timedOut, exitCode, note } = pane
  switch (ev.type) {
    case 'start':
      if (ev.cmd) extra.push({ kind: 'cmd', text: ev.cmd })
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
      extra.push({ kind: 'step', ok: ev.ok, text: stepText(ev) })
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

  const next: Pane = {
    ...pane,
    lines: [...pane.lines, ...extra].slice(-MAX_LINES),
    running,
    ok,
    durationMs,
    exitCode,
    timedOut,
    note,
  }
  return {
    ...o,
    // 首条 start 带的 runId 存住：抽屉关闭后仍能在历史里找到这一次
    runId: ev.type === 'start' ? (ev.runId ?? o.runId) : o.runId,
    panes: o.panes.map((p, i) => (i === idx ? next : p)),
  }
}

/**
 * 把一份档案（meta + 事件流 + summary）还原成抽屉里的多面板结构。
 * 事件是原样存下来的，所以走同一套 `applyEvent` —— 回放和实时看到的排版必须一致，
 * 否则「档案里长这样」就不可信了。
 */
function replayOutput(d: RunDetailView): Output {
  const targets = d.meta.targets.length > 0 ? d.meta.targets : ['default']
  let o: Output = {
    id: d.meta.snippetId,
    runId: d.meta.runId,
    replayed: true,
    replayedAt: d.meta.startedAt,
    startedAt: d.meta.startedAt,
    panes: targets.map((t, i) => {
      const sum = d.summary?.panes.find((p) => p.targetIndex === i)
      return {
        target: t,
        index: i,
        running: false,
        startedAt: d.meta.startedAt,
        ok: sum?.ok,
        durationMs: sum?.durationMs,
        exitCode: sum?.exitCode,
        timedOut: sum?.timedOut,
        note: sum?.note,
        lines: [],
      }
    }),
  }
  for (const ev of d.events) o = applyEvent(o, ev)
  // 进程被 kill 时档案里没有 exit 事件：用 summary 把状态补回去，
  // 不然历史面板会停在「运行中」——那是回放永远等不到的东西
  o = {
    ...o,
    panes: o.panes.map((p, i) => {
      const sum = d.summary?.panes.find((s) => s.targetIndex === i)
      return {
        ...p,
        running: false,
        ok: p.ok ?? sum?.ok ?? false,
        durationMs: p.durationMs ?? sum?.durationMs,
        exitCode: p.exitCode ?? sum?.exitCode,
        timedOut: p.timedOut ?? sum?.timedOut,
        note: p.note ?? sum?.note,
      }
    }),
  }
  return o
}

export function App() {
  const [snippets, setSnippets] = useState<SnippetView[]>([])
  const [hosts, setHosts] = useState<HostView[]>([])
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRuns, setHistoryRuns] = useState<RunListItem[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [replayId, setReplayId] = useState<string | null>(null)

  const panesRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, h, hs] = await Promise.all([api.snippets(), api.health(), api.hosts()])
      setSnippets(list)
      setHealth(h)
      setHosts(hs)
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
  const running = !!output?.panes.some((p) => p.running)
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
    if (!running) return
    const t = setInterval(() => setTick((n) => n + 1), 200)
    return () => clearInterval(t)
  }, [running])

  // 自动滚动：实时运行滚到底（看最新输出），历史回放回到顶部（从头读）
  useEffect(() => {
    const root = panesRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('.drawer-body').forEach((el) => {
      el.scrollTop = output?.replayed ? 0 : el.scrollHeight
    })
  }, [output])

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
        if (historyOpen) return setHistoryOpen(false)
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

      // `T` = 对当前选中的卡片打开目标选择器（Enter 是直接执行）。
      // 多开入口在指针设备上是隐藏的，键盘用户需要一个不靠鼠标的入口（ISSUE-008）。
      if (!typing && !draft && !danger && !showSettings && !needToken && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && flat[active]) {
        e.preventDefault()
        openSnippet(flat[active]!, false, true)
        return
      }

      // `H` = 运行历史（断开页面后回看上一次跑了什么）
      if (
        !typing &&
        !draft &&
        !danger &&
        !showSettings &&
        !needToken &&
        e.key.toLowerCase() === 'h' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault()
        void openHistory()
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

  // 片段没写 target 时，服务端会挑 default 或第一个非 reserved 目标；前端只需要一个显示名
  const fallbackTarget = useMemo(() => {
    const usable = hosts.filter((h) => !h.reserved)
    return (usable.find((h) => h.default) ?? usable[0])?.name
  }, [hosts])

  function openSnippet(s: SnippetView, confirmed = false, forceForm = false) {
    // 点过的卡片同步成键盘选中项，↑↓ 继续在这一行附近走
    const i = activeIndex.get(s.id)
    if (i != null) setActive(i)
    if (s.danger && !confirmed) {
      setDanger(s)
      return
    }
    const names = Object.keys(s.vars)
    if (names.length > 0 || forceForm) {
      const vars: VarDraft = {}
      for (const k of names) {
        const v = s.vars[k]!
        vars[k] = v.default != null ? String(v.default) : ''
      }
      setFormError(null)
      setDraft({
        snippet: s,
        vars,
        confirmed,
        targets: [s.target ?? fallbackTarget].filter((t): t is string => !!t),
      })
      setPreview(null)
    } else {
      void doRun(s, {}, confirmed, [])
    }
  }

  async function doRun(
    s: SnippetView,
    vars: VarDraft,
    confirmed: boolean,
    targets: string[],
    fromDraft: Draft | null = null,
  ) {
    // 空数组 = 交给服务端按片段/默认目标决定；但面板要有标题，所以前端补一个显示名
    const formTargets =
      targets.length > 0 ? targets : [s.target ?? fallbackTarget].filter((t): t is string => !!t)
    const shown = formTargets.length > 0 ? formTargets : ['default']

    // 抽屉要等 200 才开：被 400 拒掉的请求不该先长出 N 块空面板，再把同一句错误重复 N 遍（ISSUE-007）
    let opened = false
    const openOutput = () => {
      opened = true
      const now = Date.now()
      setOutput({
        id: s.id,
        panes: shown.map((t, i) => ({
          target: t,
          index: i,
          running: true,
          startedAt: now,
          lines: shown.length === 1 ? [{ kind: 'meta' as LineKind, text: `${s.id} · ${t} · 开始` }] : [],
        })),
        startedAt: now,
      })
      setWrap(false)
      setDraft(null)
      setDanger(null)
      setFormError(null)
      setCopied(false)
    }

    try {
      await api.run(
        s.id,
        vars,
        confirmed,
        targets,
        (ev: RunEvent) => {
          setOutput((o) => (o ? applyEvent(o, ev) : o))
          // 徽标的主路径：收到 queued 事件的那一刻服务端 queue 必然 > 0，一刷必中；
          // 收尾（exit/error）也刷一次，把徽标清回去。
          if (ev.type === 'queued' || ev.type === 'exit' || ev.type === 'error') refreshHealth()
        },
        openOutput,
      )
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true)
      const message = e instanceof ApiError ? e.message : String(e)
      if (!opened) {
        // 请求被拒（400/404…）：错误回到表单里，面板一个都不开，用户填的东西也还留着
        setDraft(fromDraft ?? { snippet: s, vars, confirmed, targets: formTargets })
        setFormError(message)
        return
      }
      setOutput((o) =>
        o
          ? {
              ...o,
              panes: o.panes.map((p) =>
                p.running
                  ? {
                      ...p,
                      running: false,
                      ok: false,
                      lines: [...p.lines, { kind: 'err' as const, text: `ERROR ${message}` }].slice(
                        -MAX_LINES,
                      ),
                    }
                  : p,
              ),
            }
          : o,
      )
    }
  }

  function submitDraft() {
    if (!draft) return
    if (draft.targets.length === 0) {
      setFormError('至少选一个目标')
      return
    }
    if (draft.targets.length > MAX_TARGETS) {
      // 服务端会 400，但等它回来才拦就已经太晚了：先把话说在前面
      setFormError(`最多 ${MAX_TARGETS} 个目标，当前 ${draft.targets.length} 个`)
      return
    }
    const missing = Object.entries(draft.snippet.vars)
      .filter(([k, v]) => v.required && !String(draft.vars[k] ?? '').trim())
      .map(([, v]) => v.prompt ?? '未命名参数')
    if (missing.length > 0) {
      setFormError(`请填写：${missing.join('、')}`)
      return
    }
    void doRun(draft.snippet, draft.vars, draft.confirmed, draft.targets, draft)
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
    const text =
      output.panes.length > 1
        ? output.panes
            .map(
              (p) => `=== ${paneLabel(output.panes, p)} ===\n${p.lines.map((l) => l.text).join('\n')}`,
            )
            .join('\n\n')
        : (output.panes[0]?.lines ?? []).map((l) => l.text).join('\n')
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

  async function openHistory() {
    setHistoryOpen(true)
    setHistoryError(null)
    setHistoryRuns(null)
    try {
      setHistoryRuns(await api.runs(30))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true)
      setHistoryError(e instanceof Error ? e.message : String(e))
    }
  }

  async function replayRun(runId: string) {
    setReplayId(runId)
    setHistoryError(null)
    try {
      const d = await api.runDetail(runId)
      setOutput(replayOutput(d))
      setHistoryOpen(false)
      setWrap(false)
      setCopied(false)
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e))
    } finally {
      setReplayId(null)
    }
  }

  async function saveToken() {    setToken(tokenInput.trim())
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

  const panes = output?.panes ?? []
  const multi = panes.length > 1
  const now = Date.now()
  const doneCount = panes.filter((p) => !p.running).length
  const okCount = panes.filter((p) => p.ok).length
  const elapsed = !output
    ? 0
    : running
      ? now - output.startedAt
      : panes.reduce((m, p) => Math.max(m, p.durationMs ?? 0), 0)
  void tick
  const tokenSet = !!getToken()
  const settingsOpen = showSettings || needToken
  const statusText = !output
    ? ''
    : multi
      ? running
        ? `${doneCount}/${panes.length} 完成 · ${fmtDur(elapsed)}`
        : `${okCount}/${panes.length} 成功 · ${fmtDur(elapsed)}`
      : panes[0]
        ? paneStatus(panes[0], now)
        : ''
  const drawerState = running ? 'running' : panes.length > 0 && panes.every((p) => p.ok) ? 'ok' : 'fail'

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
            className={`icon-btn${output?.replayed ? ' on' : ''}`}
            onClick={() => void openHistory()}
            aria-label="运行历史"
            title="运行历史（H）"
          >
            🕘
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
          <p className="nav-hint">/ 搜索 · ↑↓ 选择 · Enter 执行 · T 选目标 · H 历史 · Esc 关闭</p>
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
                        {/* 多开入口：卡片本身是 button，不能嵌 button，用 span 承担点击。
                            隐形时 pointer-events:none，键盘走 `T`（见快捷键）——要塞进 Tab 序列就得嵌
                            交互控件，读屏体验更差（ISSUE-008） */}
                        <span
                          className="card-fan"
                          role="button"
                          tabIndex={-1}
                          aria-label="选择执行目标"
                          title="选目标 / 同目标多开（选中卡片后按 T）"
                          onClick={(e) => {
                            e.stopPropagation()
                            openSnippet(s, false, true)
                          }}
                        >
                          ⊕
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
              {draft.snippet.target ? ` · ${draft.snippet.target}` : ''} · {draft.snippet.steps} 步 ·{' '}
              {draft.targets.length} 目标
            </p>
            <div className="field">
              <span>
                目标 <em className="hint">点一次加一个；同一目标可重复 = 同目标多开</em>
              </span>
              <div className="chips">
                {draft.targets.map((t, i) => {
                  const same = draft.targets.filter((x) => x === t)
                  return (
                    <span className="chip" key={`${t}-${i}`}>
                      {t}
                      {same.length > 1
                        ? ` #${draft.targets.slice(0, i + 1).filter((x) => x === t).length}`
                        : ''}
                      <button
                        type="button"
                        className="chip-x"
                        aria-label={`移除 ${t}`}
                        onClick={() =>
                          setDraft({ ...draft, targets: draft.targets.filter((_, k) => k !== i) })
                        }
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
                {draft.targets.length === 0 && <span className="chip-empty">未选目标</span>}
              </div>
              <div className="target-add">
                {hosts.map((h) => {
                  const full = draft.targets.length >= MAX_TARGETS
                  return (
                    <button
                      key={h.name}
                      type="button"
                      className="target-btn"
                      disabled={h.reserved || full}
                      title={
                        full
                          ? `最多 ${MAX_TARGETS} 个目标`
                          : h.reserved
                            ? `P5 预留（driver=${h.driver}）`
                            : `driver=${h.driver}`
                      }
                      onClick={() => {
                        // disabled 已经拦住常规点击；这里再判一次，避免键盘/脚本绕过属性直接触发
                        if (draft.targets.length >= MAX_TARGETS) {
                          setFormError(`最多 ${MAX_TARGETS} 个目标`)
                          return
                        }
                        setDraft({ ...draft, targets: [...draft.targets, h.name] })
                      }}
                    >
                      {h.name}
                      <em>{h.reserved ? 'P5' : '+'}</em>
                    </button>
                  )
                })}
              </div>
              {draft.targets.length >= MAX_TARGETS && (
                <p className="field-note">最多 {MAX_TARGETS} 个目标（服务端上限）</p>
              )}
            </div>
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

      {historyOpen && (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
            <h3>运行历史</h3>
            <p className="modal-sub">
              每次执行服务端都会落一份档案（<code>data/runs/&lt;runId&gt;.jsonl</code>）；断网、关页面之后也能回看。
              secret 变量的值在档案里已抹成 <code>***</code>。
            </p>
            {historyError && <p className="form-error">{historyError}</p>}
            {historyRuns === null && !historyError && <p className="empty">读取中…</p>}
            {historyRuns?.length === 0 && <p className="empty">还没有运行记录</p>}
            <div className="run-list">
              {historyRuns?.map((r) => (
                <button
                  key={r.runId}
                  type="button"
                  className={`run-row${r.ok ? ' ok' : ' fail'}`}
                  onClick={() => void replayRun(r.runId)}
                  disabled={replayId === r.runId}
                  title={`${r.runId}${r.vars && Object.keys(r.vars).length > 0 ? ` · ${Object.entries(r.vars).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`}
                >
                  <span className="run-when">{fmtWhen(r.startedAt)}</span>
                  <span className="run-id">{r.snippetId}</span>
                  <span className="run-meta">
                    {r.targets.length > 1 ? `${r.targets.length} 目标` : (r.targets[0] ?? '-')}
                    {' · '}
                    {fmtDur(r.durationMs)}
                  </span>
                  <span className={`run-state ${r.ok ? 'ok' : 'fail'}`}>{r.ok ? '✓' : '✗'}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <span className="modal-hint">{historyRuns ? `${historyRuns.length} 条` : ''}</span>
              <button className="btn ghost" onClick={() => setHistoryOpen(false)}>
                关闭
              </button>
              <button className="btn" onClick={() => void openHistory()}>
                刷新
              </button>
            </div>
          </div>
        </div>
      )}

      {output && (
        <div className={`drawer ${drawerState}${multi ? ' multi' : ''}${wrap ? ' wrap' : ''}`}>
          <div className="drawer-head">
            <span className="drawer-id">{output.id}</span>
            {output.replayed && output.replayedAt ? (
              <span className="drawer-badge" title={`档案 ${output.runId ?? ''} · ${fmtWhen(output.replayedAt)}`}>
                <span className="badge-ico">🕘</span>
                <span className="badge-when">{fmtWhen(output.replayedAt)}</span>
              </span>
            ) : null}
            <span className={`drawer-status ${drawerState === 'running' ? 'run' : drawerState}`}>
              {statusText}
            </span>
            {multi && <span className="drawer-count">{panes.length} 目标</span>}
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
          <div
            className={`panes${multi ? ' multi' : ''}`}
            ref={panesRef}
            style={multi ? ({ '--cols': Math.min(panes.length, 3) } as CSSProperties) : undefined}
          >
            {panes.map((p) => (
              <section className="pane" key={`${p.target}-${p.index}`}>
                {multi && (
                  <div className="pane-head">
                    <span className="pane-target">{paneLabel(panes, p)}</span>
                    <span
                      className={`pane-status ${p.running ? 'run' : p.ok ? 'ok' : 'fail'}`}
                      data-ok={p.ok ? '1' : '0'}
                    >
                      {paneStatus(p, now)}
                    </span>
                  </div>
                )}
                <pre className="drawer-body">
                  {p.lines.map((l, i) => (
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
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
