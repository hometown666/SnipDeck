import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  api,
  getToken,
  setToken,
  type HealthView,
  type HostView,
  type RunEvent,
  type RunListItem,
  type SnippetView,
} from './api'
import { DangerModal } from './components/DangerModal'
import { HistoryModal } from './components/HistoryModal'
import { RunDrawer } from './components/RunDrawer'
import { RunFormModal } from './components/RunFormModal'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { SnippetEditor } from './components/SnippetEditor'
import { SnippetList } from './components/SnippetList'
import { Topbar } from './components/Topbar'
import { applyEvent, fmtDur, paneLabel, paneStatus, replayOutput } from './lib/run-events'
import {
  MAX_LINES,
  MAX_TARGETS,
  type Draft,
  type LineKind,
  type Output,
  type VarDraft,
} from './types'

/**
 * 状态编排层。
 *
 * 约定：这里是唯一持有状态的地方。判定「能不能跑」「错了怎么说」在这里，
 * 「长什么样」在 components/，「事件怎么变面板」在 lib/run-events.ts（纯函数，可单测）。
 * 拆之前这个文件 1096 行，改一句文案得翻 1000 行。
 */
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
  /** 编辑器：null = 关；{ id } = 编辑某条；{} = 新建 */
  const [editor, setEditor] = useState<{ id?: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

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

  // 保存/删除后的回执：只显示一句、2.6s 自动收，不用弹窗（弹窗还得点一下关）
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

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
        if (editor) return setEditor(null)
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
      if (!typing && !draft && !danger && !editor && !showSettings && !needToken && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && flat[active]) {
        e.preventDefault()
        openSnippet(flat[active]!, false, true)
        return
      }

      // `H` = 运行历史（断开页面后回看上一次跑了什么）
      if (
        !typing &&
        !draft &&
        !danger &&
        !editor &&
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

      // `E` = 编辑当前选中的片段；`N` = 新建。
      // 两个都是低频动作，键盘入口只为「不想去右下角点那个 22px 的小图标」而存在。
      if (
        !typing &&
        !draft &&
        !danger &&
        !editor &&
        !showSettings &&
        !needToken &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const k = e.key.toLowerCase()
        if (k === 'n') {
          e.preventDefault()
          setEditor({})
          return
        }
        if (k === 'e' && flat[active]) {
          e.preventDefault()
          setEditor({ id: flat[active]!.id })
          return
        }
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
      <Topbar
        health={health}
        tokenSet={tokenSet}
        replayed={!!output?.replayed}
        onRefresh={() => void refresh()}
        onNew={() => setEditor({})}
        onHistory={() => void openHistory()}
        onSettings={() => {
          setTokenInput(getToken())
          setTokenError(null)
          setShowSettings(true)
        }}
      />

      <div className="layout">
        <Sidebar
          q={q}
          onQuery={setQ}
          onSubmit={() => {
            if (flat[active]) openSnippet(flat[active]!)
          }}
          groups={groups}
        />
        <SnippetList
          q={q}
          onQuery={setQ}
          onSubmit={() => {
            if (flat[active]) openSnippet(flat[active]!)
          }}
          groups={groups}
          activeIndex={activeIndex}
          active={active}
          onOpen={(s) => openSnippet(s)}
          onFan={(s) => openSnippet(s, false, true)}
          onEdit={(s) => setEditor({ id: s.id })}
          needToken={needToken}
          onFillToken={() => setShowSettings(true)}
        />
      </div>

      {editor && (
        <SnippetEditor
          // key：从「编辑 A」直接切到「编辑 B」时要重建内部表单，否则会沿用上一条的状态
          key={editor.id ?? 'new'}
          snippetId={editor.id}
          hosts={hosts}
          groups={groups.map(([g]) => g)}
          onSaved={(message) => {
            setEditor(null)
            setToast(message)
            void refresh()
          }}
          onClose={() => setEditor(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}

      {draft && (
        <RunFormModal
          draft={draft}
          hosts={hosts}
          preview={preview}
          formError={formError}
          onChange={setDraft}
          onError={setFormError}
          onSubmit={submitDraft}
          onPreview={() => void loadPreview()}
          onClose={() => setDraft(null)}
        />
      )}

      {danger && (
        <DangerModal
          snippet={danger}
          onCancel={() => setDanger(null)}
          onConfirm={(s) => {
            setDanger(null)
            openSnippet(s, true)
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          tokenInput={tokenInput}
          tokenSet={tokenSet}
          error={tokenError}
          onChange={setTokenInput}
          onClear={() => {
            setToken('')
            setTokenInput('')
            setShowSettings(false)
            void refresh()
          }}
          onSave={() => void saveToken()}
          onClose={() => setShowSettings(false)}
        />
      )}

      {historyOpen && (
        <HistoryModal
          runs={historyRuns}
          error={historyError}
          replayId={replayId}
          onReplay={(id) => void replayRun(id)}
          onRefresh={() => void openHistory()}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {output && (
        <RunDrawer
          output={output}
          now={now}
          wrap={wrap}
          copied={copied}
          drawerState={drawerState}
          statusText={statusText}
          panesRef={panesRef}
          onToggleWrap={() => setWrap((w) => !w)}
          onCopy={() => void copyOutput()}
          onClose={() => setOutput(null)}
        />
      )}
    </div>
  )
}
