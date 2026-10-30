import { existsSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import {
  RunLog,
  SnippetStore,
  SnippetWriteError,
  deleteSnippet,
  draftOf,
  groupOf,
  loadHosts,
  newRunId,
  renderTolerant,
  resolveTarget,
  resolveVars,
  runSnippet,
  saveSnippet,
  type Hosts,
  type HostTarget,
  type RunEvent,
  type RunMeta,
  type RunPaneResult,
  type Snippet,
  type SnippetDraft,
  type Step,
  type VarSpec,
} from '@snipdeck/core'
import { createDriver, ExecDriver } from '@snipdeck/drivers'
import { isKnownShell, knownShells, SessionManager } from './sessions'
import { attachTerminalWs } from './terminal-ws'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export type BuildAppOptions = {
  /** 数据目录（hosts.yaml / snippets / tmp）；默认 $SNIPDECK_DATA 或仓库 data/ */
  dataDir?: string
  /** 前端构建产物目录；默认 $SNIPDECK_WEB_DIST 或 packages/web/dist */
  webDist?: string
  /** 非 loopback 访问所需的 bearer token；默认 $SNIP_TOKEN */
  token?: string
  logger?: boolean
}

export type BuiltApp = {
  app: FastifyInstance
  store: SnippetStore
  hosts: Hosts
  runs: RunLog
  sessions: SessionManager
  dirs: { data: string; snippets: string; tmp: string; runs: string }
}

/** 一次 run 最多投几个目标：只是防呆，不是产品限制 */
const MAX_TARGETS = 8

/**
 * 解析一次 run 的目标列表。
 * 优先级：显式 `targets[]` > 单个 `target` > 片段自己的 `target` > hosts 的 default。
 *
 * **同一目标允许重复出现**——那正是 P3 的「同目标多开」：只有一台可执行机器时，
 * 想并列跑两次只能这么表达。数组顺序 = 结果并列顺序。
 */
export function resolveTargets(
  hosts: Hosts,
  many: unknown,
  single?: string,
  fallback?: string,
): { name: string; target: HostTarget }[] {
  let names: (string | undefined)[]
  if (many !== undefined) {
    if (!Array.isArray(many)) throw new Error('targets 必须是数组')
    if (many.length === 0) throw new Error('targets 不能是空数组')
    if (many.length > MAX_TARGETS) throw new Error(`targets 最多 ${MAX_TARGETS} 个`)
    for (const t of many) {
      if (typeof t !== 'string' || !t.trim()) throw new Error('targets 的每一项都必须是非空字符串')
    }
    names = (many as string[]).map((t) => t.trim())
  } else {
    names = [single?.trim() || fallback]
  }

  return names.map((n) => {
    // resolveTarget 对未知名字自己会抛「unknown target: x」
    const r = resolveTarget(hosts, n)
    if (r.target.reserved) {
      throw new Error(`目标 ${r.name} 未激活（P5 预留，driver=${r.target.driver}）`)
    }
    return r
  })
}

/**
 * 组装 Fastify 应用（不监听端口）。
 * 抽出来是为了让冒烟测试打的是**真路由**，而不是另抄一份实现——
 * 之前那份复制的路由在 P0 审阅时漏掉了队列、鉴权、404 等全部问题。
 */
export function buildApp(opts: BuildAppOptions = {}): BuiltApp {
  const dataDir = resolve(opts.dataDir ?? resolve(REPO_ROOT, process.env.SNIPDECK_DATA ?? 'data'))
  const snippetsDir = resolve(dataDir, 'snippets')
  const hostsFile = resolve(dataDir, 'hosts.yaml')
  const tmpDir = resolve(dataDir, 'tmp')
  const runsDir = resolve(dataDir, 'runs')
  const webDist = resolve(
    opts.webDist ?? resolve(REPO_ROOT, process.env.SNIPDECK_WEB_DIST ?? 'packages/web/dist'),
  )
  const token = opts.token ?? process.env.SNIP_TOKEN ?? ''

  const app = Fastify({ logger: opts.logger ?? true })
  const store = new SnippetStore(snippetsDir)
  store.watchDir()
  const hosts = loadHosts(hostsFile)
  // 启动清一次：只按时间不够，调试期一天能跑出上百条，500 个文件上限兜底
  const runs = new RunLog(runsDir, { maxFiles: 500, ttlDays: 30 })
  runs.prune()

  // ——— 终端会话（P5.1）———
  // 会话不落库、不进 runs/：服务重启即消失，能留的只有「上一轮残留的子进程」这条线索。
  const sessions = new SessionManager({
    pidDir: resolve(tmpDir, 'sessions'),
    cwd: REPO_ROOT,
    log: (level, msg) => {
      if (level === 'warn') app.log.warn(msg)
      else app.log.info(msg)
    },
  })
  // 不 await：启动不该被 taskkill 拖住，几毫秒后自己跑完
  void sessions.reapOrphans()
  attachTerminalWs({ app, sessions, token })
  app.addHook('onClose', async () => {
    sessions.disposeAll()
  })

  app.addHook('onRequest', async (req, reply) => {
    // 方案 D（2026-10-31）：**不再按来源 IP 豁免**。
    //
    // 旧写法是 `if (!token || isLoopback(req.ip)) return`，两个放行分支。第二个是洞：
    // `tailscale serve` / nginx 会把远程请求从 127.0.0.1 转进来，`req.ip` 就是 loopback，
    // 于是 SNIP_TOKEN 形同虚设——反代背后整个网段都能执行任意命令，而界面上看起来
    // 「token 已经设了」。
    //
    // 现在只保留 `!token` 这一条，它的安全性来自 server.ts 的启动守卫：
    // 无 token 时**只允许绑 loopback**，所以这条分支只可能在本机直连的开发场景成立。
    // 有 token 就一律校验，本机也不例外。
    if (!token) return
    // 静态壳（/、/assets/*、manifest、sw.js、favicon）免 token：它们自身不含任何数据，
    // 数据全在 /api 后面。把首屏也挡成 401 会让手机拿不到 HTML → 没有 ⚙ 按钮 →
    // token 无处填写 → 永远 401，即「要页面先过 token，要 token 先有页面」（ISSUE-001）。
    if (!req.url.startsWith('/api/')) return
    const auth = req.headers.authorization ?? ''
    if (auth === `Bearer ${token}`) return
    return reply.code(401).send({ error: 'unauthorized' })
  })

  app.get('/api/health', async () => {
    const { target } = resolveTarget(hosts, undefined)
    const driver = createDriver(target, { tmpDir })
    const isExec = driver instanceof ExecDriver
    const bridgeUp = isExec ? await driver.health() : false
    return {
      ok: true,
      bridgeUp,
      queue: isExec ? driver.queueLength : 0,
      snippets: store.list().length,
      quarantined: store.errors().length,
    }
  })

  app.get('/api/snippets', async () => store.list().map((s) => publicView(s, snippetsDir)))

  app.get<{ Params: { id: string } }>('/api/snippets/:id', async (req, reply) => {
    const s = store.get(req.params.id)
    if (!s) return reply.code(404).send({ error: 'not found' })
    return publicView(s, snippetsDir)
  })

  // 预览走 POST：GET 会把变量塞进 URL，而 URL 会进访问日志与浏览器历史。
  app.post<{ Params: { id: string }; Body: { vars?: Record<string, string> } }>(
    '/api/snippets/:id/preview',
    async (req, reply) => {
      const s = store.get(req.params.id)
      if (!s) return reply.code(404).send({ error: 'not found' })
      const vars = req.body?.vars ?? {}
      if (typeof vars !== 'object' || vars === null) {
        return reply.code(400).send({ error: 'vars must be an object' })
      }
      const { values, pending, missing } = resolveVars(s, vars)
      // secret 变量的值绝不能回显：预览只显示 `***`
      const shown = { ...values }
      for (const [name, spec] of Object.entries(s.vars ?? {})) {
        if (spec.secret && shown[name] !== undefined) shown[name] = '***'
      }
      const cmds = s.steps
        .filter((st) => st.do === 'run')
        .map((st) => renderTolerant(st.cmd, shown))
      return { cmds, pending, missing, redacted: Object.keys(values).filter((k) => s.vars?.[k]?.secret) }
    },
  )

  // ——— 片段 CRUD（2026-10-31）———
  // 写盘的全部规矩都在 core 的 saveSnippet / deleteSnippet 里：路径守卫、原子写、
  // 序列化后自解析、mtime 冲突。这里只负责把「表单提交的 JSON」变成 draft，
  // 再把 SnippetWriteError 映射成 HTTP 语义。
  app.get<{ Params: { id: string } }>('/api/snippets/:id/detail', async (req, reply) => {
    const s = store.get(req.params.id)
    if (!s) return reply.code(404).send({ error: `片段不存在: ${req.params.id}` })
    return {
      ...draftOf(s),
      relPath: relative(snippetsDir, s.file).replace(/\\/g, '/'),
      // 编辑器把它原样带回来，服务端据此判断「我编辑期间有没有人动过这个文件」
      mtimeMs: statSync(s.file).mtimeMs,
    }
  })

  app.post('/api/snippets', async (req, reply) => {
    const draft = asDraft(req.body)
    if (typeof draft === 'string') return reply.code(400).send({ error: draft })
    try {
      const saved = saveSnippet(snippetsDir, draft)
      // 立刻重建索引：watcher 有 200ms 去抖，不等它——
      // 否则「保存成功」之后马上 GET 列表，可能还是旧的那份。
      store.reindex()
      return reply.code(201).send({ ok: true, id: draft.id, ...saved })
    } catch (e) {
      return sendWriteError(reply, e)
    }
  })

  app.put<{ Params: { id: string }; Body: { mtimeMs?: unknown } }>(
    '/api/snippets/:id',
    async (req, reply) => {
      const current = store.get(req.params.id)
      if (!current) return reply.code(404).send({ error: `片段不存在: ${req.params.id}` })
      const draft = asDraft(req.body)
      if (typeof draft === 'string') return reply.code(400).send({ error: draft })
      const expectedMtimeMs =
        typeof req.body?.mtimeMs === 'number' && Number.isFinite(req.body.mtimeMs)
          ? req.body.mtimeMs
          : undefined
      try {
        const saved = saveSnippet(snippetsDir, draft, {
          currentFile: current.file,
          expectedMtimeMs,
        })
        store.reindex()
        return reply.send({ ok: true, id: draft.id, renamed: draft.id !== current.id, ...saved })
      } catch (e) {
        return sendWriteError(reply, e)
      }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/snippets/:id', async (req, reply) => {
    const s = store.get(req.params.id)
    if (!s) return reply.code(404).send({ error: `片段不存在: ${req.params.id}` })
    try {
      const backup = deleteSnippet(snippetsDir, s.file, s.id)
      store.reindex()
      return { ok: true, id: s.id, backup: relative(snippetsDir, backup).replace(/\\/g, '/') }
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.get('/api/hosts', async () =>
    Object.entries(hosts).map(([name, t]) => ({
      name,
      driver: t.driver,
      reserved: !!t.reserved,
      default: !!t.default,
    })),
  )

  app.post<{
    Body: { id: string; vars?: Record<string, string>; target?: string; targets?: string[]; confirm?: boolean }
  }>('/api/run', async (req, reply) => {
    const { id, vars, target: single, targets: many, confirm } = req.body ?? {}
    const snippet = store.get(id)
    if (!snippet) return reply.code(404).send({ error: `snippet not found: ${id}` })
    if (snippet.danger && !confirm) {
      return reply.code(400).send({ error: 'danger snippet requires confirm: true' })
    }

    let plan: { name: string; target: ReturnType<typeof resolveTarget>['target'] }[]
    try {
      plan = resolveTargets(hosts, many, single, snippet.target)
    } catch (e) {
      // 目标相关错误全部在**开流之前**判定：一旦 200 开了流，前端只能从事件里猜
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 反向代理（tailscale serve / nginx）不要缓冲，否则事件会攒到最后一次性吐出
      'X-Accel-Buffering': 'no',
    })
    let closed = false
    reply.raw.on('error', () => {
      closed = true
    })

    // ——— 运行档案：断开 SSE 之后还能回看这次跑了什么 ———
    // 记「实际生效的变量值」而不是前端传来的原样值：默认值也是参数的一部分，
    // 而 secret 只留键名 + `***`（§5.4 的硬规矩：secret 不落历史）。
    const resolvedVars = resolveVars(snippet, vars ?? {}).values
    const recordedVars: Record<string, string> = {}
    const varsRedacted: string[] = []
    for (const [k, v] of Object.entries(resolvedVars)) {
      if (snippet.vars?.[k]?.secret) {
        recordedVars[k] = '***'
        varsRedacted.push(k)
      } else {
        recordedVars[k] = v
      }
    }
    const runId = newRunId()
    const runT0 = Date.now()
    const meta: RunMeta = {
      runId,
      snippetId: snippet.id,
      title: snippet.title,
      targets: plan.map((p) => p.name),
      startedAt: runT0,
      caller: { ip: req.ip, ua: String(req.headers['user-agent'] ?? '') },
      vars: recordedVars,
      varsRedacted,
    }
    const writer = runs.begin(
      meta,
      Object.entries(resolvedVars)
        .filter(([k]) => snippet.vars?.[k]?.secret)
        .map(([, v]) => v),
    )

    // 每条事件都带 target / targetIndex：一条流里可能有 N 组结果，前端靠它分流
    const send = (ev: RunEvent, name: string, index: number) => {
      const tagged: RunEvent = { ...ev, target: name, targetIndex: index }
      // 首条 start 带上 runId：前端据此知道「这条流对应哪份档案」，抽屉里可回链
      if (tagged.type === 'start' && tagged.stepIndex === -1) tagged.runId = runId
      // 先写盘再发流：客户端断开后事件仍要留档（§6.1：run 是服务端行为）
      writer.event(tagged)
      if (closed || reply.raw.writableEnded) return
      try {
        reply.raw.write(`data: ${JSON.stringify(tagged)}\n\n`)
      } catch {
        closed = true
      }
    }

    // 每个目标的结局：由 exit / error 事件累积，最后写进 summary 行
    const panes: RunPaneResult[] = plan.map(({ name }, index) => ({
      target: name,
      targetIndex: index,
      ok: false,
      note: '未执行',
    }))

    try {
      // 同一目标多开 = 同一个 ExecDriver（按 bridgeRoot 缓存）→ 全局串行队列，
      // 所以这里并发拉起 N 个 runSnippet 是安全的，实际执行仍严格一个接一个。
      // P5 接入 ssh 后，这段不用改就是真并发了。
      await Promise.all(
        plan.map(async ({ name, target }, index) => {
          try {
            const driver = createDriver(target, { tmpDir })
            for await (const ev of runSnippet(snippet, driver, {
              vars,
              defaultTimeout: Number(target.timeout ?? 20),
              defaultShell: typeof target.shell === 'string' ? target.shell : undefined,
            })) {
              if (ev.type === 'exit') {
                panes[index] = {
                  target: name,
                  targetIndex: index,
                  ok: ev.ok,
                  exitCode: ev.exitCode,
                  durationMs: ev.durationMs,
                  timedOut: ev.timedOut,
                  reason: ev.reason,
                  note: ev.note,
                }
              } else if (ev.type === 'error') {
                panes[index] = { target: name, targetIndex: index, ...panes[index], ok: false, note: ev.message }
              }
              send(ev, name, index)
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            panes[index] = { target: name, targetIndex: index, ok: false, note: message }
            send({ type: 'error', message }, name, index)
          }
        }),
      )
    } finally {
      writer.summary({ ok: panes.every((p) => p.ok), durationMs: Date.now() - runT0, panes })
      reply.raw.end()
    }
  })

  app.get<{ Querystring: { limit?: string; snippet?: string } }>('/api/runs', async (req) => {
    const raw = Number(req.query.limit ?? 20)
    const limit = Math.min(100, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 20))
    return runs.list(limit, req.query.snippet)
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const d = runs.read(req.params.runId)
    if (!d) return reply.code(404).send({ error: `run 不存在: ${req.params.runId}` })
    return d
  })

  // ——— P5.1 终端会话 ———
  // 三条路由与 WS 共用一条规矩：**没有 SNIP_TOKEN 就没有终端**。
  // 理由不是洁癖：WS 的 upgrade 没有 loopback 豁免（反代一转手就是 remote shell），
  // 而 REST 若能建会话、WS 又连不上，只会得到一个半残状态。
  const terminalDisabled = {
    error: 'terminal disabled',
    message: '终端需要 SNIP_TOKEN：WS 通道没有 loopback 豁免，没有 token 就无从校验来源。请在 .env 里设置 SNIP_TOKEN 后重启服务。',
  }

  app.get('/api/sessions', async (_req, reply) => {
    if (!token) return reply.code(403).send({ ...terminalDisabled, shells: knownShells() })
    return { enabled: true, shells: knownShells(), sessions: sessions.list() }
  })

  app.post<{ Body: { shell?: string; cols?: number; rows?: number } }>(
    '/api/sessions',
    async (req, reply) => {
      if (!token) return reply.code(403).send(terminalDisabled)
      const shell = String(req.body?.shell ?? 'powershell')
      if (!isKnownShell(shell)) {
        return reply
          .code(400)
          .send({ error: `unknown shell: ${shell}（可用：${knownShells().join(' / ')}）` })
      }
      try {
        return reply.code(201).send(sessions.create({ shell, cols: req.body?.cols, rows: req.body?.rows }).snapshot())
      } catch (e) {
        // PTY 起不来（比如 pwsh 没装）不该 500 到前端就完事，把原因带出去
        return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) })
      }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (!token) return reply.code(403).send(terminalDisabled)
    if (!sessions.remove(req.params.id)) return reply.code(404).send({ error: 'session not found' })
    return { ok: true }
  })

  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist })
    // 只让前端路由回退到 index.html；/api/* 的未知路径必须返回 JSON 404，
    // 否则前端拿到一段 HTML 会当成成功响应去 JSON.parse。
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? req.url
      if (path.startsWith('/api/')) {
        return reply.code(404).send({ error: `no such endpoint: ${path}` })
      }
      // 带扩展名的静态资源找不到就是找不到，别回退成 index.html——
      // 否则 /favicon.ico 会拿到 200 + 一段 HTML，浏览器把 HTML 当图标。
      if (/\.[a-z0-9]+$/i.test(path)) {
        return reply.code(404).type('text/plain; charset=utf-8').send('Not Found')
      }
      return reply.sendFile('index.html')
    })
  }

  return {
    app,
    store,
    hosts,
    runs,
    sessions,
    dirs: { data: dataDir, snippets: snippetsDir, tmp: tmpDir, runs: runsDir },
  }
}

/**
 * 把表单提交的 JSON 收敛成 `SnippetDraft`。
 *
 * 返回 string 表示「为什么不行」——比抛异常好读，也不会把校验错误和非预期异常混在一起
 * （后者回 500，前者回 400）。
 *
 * 收敛而不是直接 cast：写盘是**覆盖用户文件**，多带一个 `file` 字段进来就可能
 * 把路径指向别处；而 `shell: "bash"` 这种值不该被静默存成一条跑不动的片段。
 */
function asDraft(body: unknown): SnippetDraft | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '请求体必须是片段对象'
  const b = body as Record<string, unknown>

  const id = typeof b.id === 'string' ? b.id.trim() : ''
  if (!id) return 'id 不能为空'
  if (!Array.isArray(b.steps) || b.steps.length === 0) return 'steps 至少要有一项'
  for (const [i, st] of b.steps.entries()) {
    if (!st || typeof st !== 'object' || Array.isArray(st)) return `steps[${i}] 必须是对象`
  }

  const rawShell = typeof b.shell === 'string' ? b.shell.trim() : ''
  if (rawShell && rawShell !== 'cmd' && rawShell !== 'powershell') {
    return `shell 只能是 cmd 或 powershell（收到 ${rawShell}）`
  }

  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined

  let tags: string[] | undefined
  if (typeof b.tags === 'string') {
    tags = b.tags.split(',').map((t) => t.trim()).filter(Boolean)
  } else if (Array.isArray(b.tags)) {
    tags = b.tags.map((t) => String(t).trim()).filter(Boolean)
  } else if (b.tags !== undefined && b.tags !== null) {
    return 'tags 必须是数组或逗号分隔的字符串'
  }

  let meta: Record<string, unknown> | undefined
  if (b.meta !== undefined && b.meta !== null) {
    if (typeof b.meta !== 'object' || Array.isArray(b.meta)) return 'meta 必须是对象'
    meta = Object.keys(b.meta as object).length > 0 ? (b.meta as Record<string, unknown>) : undefined
  }

  let vars: Record<string, VarSpec> | undefined
  if (b.vars !== undefined && b.vars !== null) {
    if (typeof b.vars !== 'object' || Array.isArray(b.vars)) return 'vars 必须是对象'
    const out: Record<string, VarSpec> = {}
    for (const [rawName, rawSpec] of Object.entries(b.vars as Record<string, unknown>)) {
      const name = rawName.trim()
      if (!name) return 'vars 里不能有空变量名'
      if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
        return `vars.${name} 必须是对象`
      }
      const s = rawSpec as Record<string, unknown>
      const spec: VarSpec = {}
      if (typeof s.prompt === 'string' && s.prompt) spec.prompt = s.prompt
      if (typeof s.default === 'string' || typeof s.default === 'number') spec.default = s.default
      if (Array.isArray(s.choices)) {
        spec.choices = s.choices.map((c) => (typeof c === 'number' ? c : String(c)))
      }
      if (s.secret === true) spec.secret = true
      if (typeof s.from === 'string' && s.from) spec.from = s.from
      out[name] = spec
    }
    vars = Object.keys(out).length > 0 ? out : undefined
  }

  return {
    id,
    title: text(b.title),
    group: text(b.group),
    target: text(b.target),
    shell: rawShell === 'cmd' || rawShell === 'powershell' ? rawShell : undefined,
    tags: tags?.length ? tags : undefined,
    danger: b.danger === true ? true : undefined,
    meta,
    vars,
    steps: b.steps as Step[],
  }
}

function sendWriteError(reply: FastifyReply, e: unknown) {
  if (e instanceof SnippetWriteError) {
    // conflict / exists 是 409：客户端拿到它应该刷新或换 id，而不是改内容重试
    const status = e.kind === 'conflict' || e.kind === 'exists' ? 409 : 400
    return reply
      .code(status)
      .send({ error: e.problems.join('；'), kind: e.kind, problems: e.problems })
  }
  return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) })
}

function publicView(s: Snippet, snippetsDir: string) {
  return {
    id: s.id,
    title: s.title ?? s.id,
    group: groupOf(s, snippetsDir),
    tags: s.tags ?? [],
    danger: !!s.danger,
    shell: s.shell,
    target: s.target,
    steps: s.steps.length,
    vars: Object.fromEntries(
      Object.entries(s.vars ?? {}).map(([k, v]) => [
        k,
        {
          prompt: v.prompt,
          choices: v.choices,
          default: v.default,
          secret: !!v.secret,
          // 没默认值、也不能留空的变量，前端必须拦住，否则渲染出缺参数的命令照样会执行
          required: v.default === undefined && !v.choices?.some((c) => String(c) === ''),
        },
      ]),
    ),
  }
}
