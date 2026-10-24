import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import {
  SnippetStore,
  groupOf,
  loadHosts,
  renderTolerant,
  resolveTarget,
  resolveVars,
  runSnippet,
  type Hosts,
  type RunEvent,
  type Snippet,
} from '@snipdeck/core'
import { createDriver, ExecDriver } from '@snipdeck/drivers'

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
  dirs: { data: string; snippets: string; tmp: string }
}

function isLoopback(ip: string | undefined): boolean {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
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
  const webDist = resolve(
    opts.webDist ?? resolve(REPO_ROOT, process.env.SNIPDECK_WEB_DIST ?? 'packages/web/dist'),
  )
  const token = opts.token ?? process.env.SNIP_TOKEN ?? ''

  const app = Fastify({ logger: opts.logger ?? true })
  const store = new SnippetStore(snippetsDir)
  store.watchDir()
  const hosts = loadHosts(hostsFile)

  app.addHook('onRequest', async (req, reply) => {
    if (!token || isLoopback(req.ip)) return
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

  app.get('/api/hosts', async () =>
    Object.entries(hosts).map(([name, t]) => ({
      name,
      driver: t.driver,
      reserved: !!t.reserved,
      default: !!t.default,
    })),
  )

  app.post<{ Body: { id: string; vars?: Record<string, string>; target?: string; confirm?: boolean } }>(
    '/api/run',
    async (req, reply) => {
      const { id, vars, target: targetName, confirm } = req.body ?? {}
      const snippet = store.get(id)
      if (!snippet) return reply.code(404).send({ error: `snippet not found: ${id}` })
      if (snippet.danger && !confirm) {
        return reply.code(400).send({ error: 'danger snippet requires confirm: true' })
      }
      let target: ReturnType<typeof resolveTarget>
      try {
        target = resolveTarget(hosts, targetName ?? snippet.target)
      } catch (e) {
        // 目标不存在：在开流之前就能判定的错误，直接给 400
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
      if (target.target.reserved) {
        return reply.code(400).send({ error: `目标 ${target.name} 未激活（P5 预留，driver=${target.target.driver}）` })
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // 反向代理（tailscale serve / nginx）不要缓冲，否则事件会攒到最后一次性吐出
        'X-Accel-Buffering': 'no',
      })
      const send = (ev: RunEvent) => {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
      }
      try {
        const driver = createDriver(target.target, { tmpDir })
        send({ type: 'start', stepIndex: -1, cmd: `[target ${target.name}]` })
        for await (const ev of runSnippet(snippet, driver, {
          vars,
          defaultTimeout: Number(target.target.timeout ?? 20),
          defaultShell:
            typeof target.target.shell === 'string' ? target.target.shell : undefined,
        })) {
          send(ev)
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
      } finally {
        reply.raw.end()
      }
    },
  )

  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist })
    // 只让前端路由回退到 index.html；/api/* 的未知路径必须返回 JSON 404，
    // 否则前端拿到一段 HTML 会当成成功响应去 JSON.parse。
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: `no such endpoint: ${req.url}` })
      }
      return reply.sendFile('index.html')
    })
  }

  return { app, store, hosts, dirs: { data: dataDir, snippets: snippetsDir, tmp: tmpDir } }
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
