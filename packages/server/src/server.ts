import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import {
  SnippetStore,
  groupOf,
  loadHosts,
  renderString,
  resolveTarget,
  resolveVars,
  runSnippet,
  type RunEvent,
  type Snippet,
} from '@snipdeck/core'
import { createDriver, ExecDriver } from '@snipdeck/drivers'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DATA_DIR = resolve(REPO_ROOT, process.env.SNIPDECK_DATA ?? 'data')
const SNIPPETS_DIR = resolve(DATA_DIR, 'snippets')
const HOSTS_FILE = resolve(DATA_DIR, 'hosts.yaml')
const TMP_DIR = resolve(DATA_DIR, 'tmp')
const WEB_DIST = resolve(REPO_ROOT, process.env.SNIPDECK_WEB_DIST ?? 'packages/web/dist')
const PORT = Number(process.env.SNIPDECK_PORT ?? 8787)
const HOST = process.env.SNIPDECK_HOST ?? '127.0.0.1'
const TOKEN = process.env.SNIP_TOKEN ?? ''

// 这是一个「任意命令执行」服务：对外监听却没有 token，等于把机器交给整个网络。
// 与其发一条容易被忽略的警告，不如直接拒绝启动。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
if (!LOOPBACK_HOSTS.has(HOST) && !TOKEN) {
  console.error(`[snipdeck] 拒绝启动：SNIPDECK_HOST=${HOST} 对外监听，但未设置 SNIP_TOKEN。`)
  console.error('  请先设置 SNIP_TOKEN（例如 32 位随机串）再启动，否则任何能连到该地址的人都能执行命令。')
  process.exit(1)
}

const app = Fastify({ logger: true })
const store = new SnippetStore(SNIPPETS_DIR)
store.watchDir()
const hosts = loadHosts(HOSTS_FILE)

function isLoopback(ip: string | undefined): boolean {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

app.addHook('onRequest', async (req, reply) => {
  if (!TOKEN || isLoopback(req.ip)) return
  const auth = req.headers.authorization ?? ''
  if (auth === `Bearer ${TOKEN}`) return
  reply.code(401).send({ error: 'unauthorized' })
})

app.get('/api/health', async () => {
  const { target } = resolveTarget(hosts, undefined)
  const driver = createDriver(target, { tmpDir: TMP_DIR })
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
app.get('/api/snippets', async () => store.list().map(publicView))

app.get<{ Params: { id: string } }>('/api/snippets/:id', async (req, reply) => {
  const s = store.get(req.params.id)
  if (!s) return reply.code(404).send({ error: 'not found' })
  return publicView(s)
})

app.get<{ Params: { id: string }; Querystring: { vars?: string } }>(
  '/api/snippets/:id/preview',
  async (req, reply) => {
    const s = store.get(req.params.id)
    if (!s) return reply.code(404).send({ error: 'not found' })
    let vars: Record<string, string> = {}
    try {
      vars = req.query.vars ? JSON.parse(req.query.vars) : {}
    } catch {
      return reply.code(400).send({ error: 'vars must be JSON' })
    }
    const { values, pending, missing } = resolveVars(s, vars)
    const cmds = s.steps.filter((st) => st.do === 'run').map((st) => renderString(st.cmd, values))
    return { cmds, pending, missing }
  },
)

app.get('/api/hosts', async () =>
  Object.entries(hosts).map(([name, t]) => ({
    name,
    driver: t.driver,
    reserved: !!t.reserved,
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
      const { name, target } = resolveTarget(hosts, targetName ?? snippet.target)
      const driver = createDriver(target, { tmpDir: TMP_DIR })
      send({ type: 'start', stepIndex: -1, cmd: `[target ${name}]` })
      for await (const ev of runSnippet(snippet, driver, {
        vars,
        defaultTimeout: Number(target.timeout ?? 20),
        defaultShell: typeof target.shell === 'string' ? target.shell : undefined,
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

function publicView(s: Snippet) {
  return {
    id: s.id,
    title: s.title ?? s.id,
    group: groupOf(s, SNIPPETS_DIR),
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

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST })
  // 只让前端路由回退到 index.html；/api/* 的未知路径必须返回 JSON 404，
  // 否则前端拿到一段 HTML 会当成成功响应去 JSON.parse。
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: `no such endpoint: ${req.url}` })
    }
    return reply.sendFile('index.html')
  })
}

await app.listen({ port: PORT, host: HOST })
console.log(`snipdeck server on http://${HOST}:${PORT}`)
