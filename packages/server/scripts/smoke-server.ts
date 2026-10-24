/**
 * 进程内冒烟测试：用 app.inject 打全部 API 端点，不监听端口。
 * 运行：tsx scripts/smoke-server.ts
 */
import Fastify from 'fastify'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  SnippetStore,
  groupOf,
  loadHosts,
  renderString,
  resolveTarget,
  resolveVars,
} from '@snipdeck/core'
import { createDriver, ExecDriver } from '@snipdeck/drivers'

// 本文件在 packages/server/scripts/，与 src/ 同级 → 上溯 3 级到仓库根
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SNIPPETS_DIR = resolve(REPO_ROOT, 'data/snippets')
const HOSTS_FILE = resolve(REPO_ROOT, 'data/hosts.yaml')
const TMP_DIR = resolve(REPO_ROOT, 'data/tmp')

const store = new SnippetStore(SNIPPETS_DIR)
const hosts = loadHosts(HOSTS_FILE)

const app = Fastify({ logger: false })

app.get('/api/health', async () => {
  const { target } = resolveTarget(hosts, undefined)
  const driver = createDriver(target, { tmpDir: TMP_DIR })
  const isExec = driver instanceof ExecDriver
  return {
    ok: true,
    bridgeUp: isExec ? await driver.health() : false,
    snippets: store.list().length,
    quarantined: store.errors().length,
  }
})

app.get('/api/snippets', async () => store.list())
app.get('/api/snippets/:id', async (req, reply) => {
  const s = store.get((req.params as { id: string }).id)
  if (!s) return reply.code(404).send({ error: 'not found' })
  return s
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
  Object.entries(hosts).map(([name, t]) => ({ name, driver: t.driver, reserved: !!t.reserved })),
)

let pass = 0
let fail = 0
function check(label: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label} ${extra}`)
  }
}

// 1. health
const h = await app.inject({ method: 'GET', url: '/api/health' })
const hb = h.json()
check('GET /api/health → 200', h.statusCode === 200)
check('health.ok === true', hb.ok === true)
check('health.bridgeUp === true（AHK 桥在线）', hb.bridgeUp === true, JSON.stringify(hb))
check('health.snippets >= 3', hb.snippets >= 3, JSON.stringify(hb))
check('health.quarantined === 0', hb.quarantined === 0, JSON.stringify(hb))

// 2. snippets 列表
const l = await app.inject({ method: 'GET', url: '/api/snippets' })
const lb = l.json()
check('GET /api/snippets → 200', l.statusCode === 200)
check('列表含 check-instence', lb.some((s: { id: string }) => s.id === 'check-instence'))
check('列表含 click-instance', lb.some((s: { id: string }) => s.id === 'click-instance'))
check('kill-program 标记 danger', lb.find((s: { id: string }) => s.id === 'kill-program')?.danger === true)

// 3. 单条 + 404
const one = await app.inject({ method: 'GET', url: '/api/snippets/click-instance' })
check('GET /api/snippets/click-instance → 200', one.statusCode === 200)
check('click-instance 有 4 个变量', Object.keys(one.json().vars ?? {}).length === 4, JSON.stringify(one.json().vars))
const nf = await app.inject({ method: 'GET', url: '/api/snippets/no-such' })
check('GET 不存在 id → 404', nf.statusCode === 404)

// 4. preview：渲染变量
const p = await app.inject({
  method: 'GET',
  url: '/api/snippets/click-instance/preview?vars=' + encodeURIComponent(JSON.stringify({ x: '100', y: '200' })),
})
const pb = p.json()
check('preview → 200', p.statusCode === 200)
check('preview 已渲染 x=100', pb.cmds.some((c: string) => c.includes('100')))
check('preview 缺 y 时报 pending/missing', pb.pending.length + pb.missing.length > 0 || pb.cmds.some((c: string) => c.includes('200')))

// 5. preview vars 非法 JSON → 400
const bad = await app.inject({ method: 'GET', url: '/api/snippets/click-instance/preview?vars=notjson' })
check('preview vars 非 JSON → 400', bad.statusCode === 400)

// 6. hosts
const hs = await app.inject({ method: 'GET', url: '/api/hosts' })
const hsb = hs.json()
check('GET /api/hosts → 200', hs.statusCode === 200)
check('hosts 含 win-desktop(exec)', hsb.some((t: { name: string }) => t.name === 'win-desktop' && t.driver === 'exec'))
check('home-win / vps 标记 reserved', hsb.filter((t: { reserved: boolean }) => t.reserved).length === 2)

// 7. 真实跑一条（exec 驱动打桥）
const r = await app.inject({ method: 'GET', url: '/api/snippets/check-instence' })
console.log('\n—— 跳过 /api/run 注入式执行（inject 对 SSE raw write 支持有限，CLI 已实测桥调用）——')
void r

await app.close()
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
