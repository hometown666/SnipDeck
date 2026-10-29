/**
 * 冒烟测试：用 buildApp() 打**真路由**（不监听端口、不联网）。
 * 之前这里另抄了一份路由实现，结果队列、鉴权、404 的 bug 一个都没测出来。
 *
 * 运行：npm run smoke（在 packages/server 下）
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// fixture 落系统临时目录，不落 data/tmp：
// 1) 天然干净，不需要「先删一遍」那种自己给自己挖坑的开场；
// 2) 不会和真实 run 生成的 run-*.cmd 混在一起被 sweepTmp 误清。
const FIXTURE = mkdtempSync(join(tmpdir(), 'snipdeck-smoke-'))
const TOKEN = 'smoke-token'

function writeFixture(rel: string, content: string): void {
  const file = join(FIXTURE, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

/**
 * 清理临时目录，失败只 warn。
 * 本机 Node 被注入了 safe-delete shim（批量删除要二次确认），
 * 收尾清理被拦时曾让「28 项断言全绿」的测试以退出码 1 结束——
 * 清理是收尾动作，不该决定测试成败；更不许它改 process.exitCode。
 */
function tryRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn(`  ~ 清理失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
    console.warn(`  ~ 可手动删除：${dir}`)
  }
}

writeFixture(
  'hosts.yaml',
  [
    'win-desktop:',
    '  driver: exec',
    '  default: true',
    '  shell: cmd',
    '  bridge: C:\\ahk_trigger',
    '  timeout: 20',
    'home-win:',
    '  driver: local',
    '  reserved: true',
    'vps:',
    '  driver: ssh',
    '  reserved: true',
    '',
  ].join('\n'),
)
writeFixture(
  'snippets/状态/check-instence.yaml',
  [
    'id: check-instence',
    'title: 查看实例表',
    'target: win-desktop',
    'shell: cmd',
    'steps:',
    '  - do: run',
    '    cmd: call C:\\ahk_trigger\\ahk.bat instances',
    '    queue: false',
    '',
  ].join('\n'),
)
writeFixture(
  'snippets/实例控制/click-instance.yaml',
  [
    'id: click-instance',
    'title: 点击实例',
    'target: win-desktop',
    'vars:',
    '  pro: { prompt: 程序, default: wechat }',
    '  n:   { prompt: 实例号, default: 1 }',
    '  x:   { prompt: X 坐标 }',
    '  y:   { prompt: Y 坐标 }',
    'steps:',
    "  - { do: run, cmd: 'echo click {{pro}}#{{n}} {{x}} {{y}}' }",
    '',
  ].join('\n'),
)
writeFixture(
  'snippets/测试/secret.yaml',
  [
    'id: secret-demo',
    'title: 密钥片段',
    'target: win-desktop',
    'vars:',
    "  token: { secret: true, default: 's3cr3t-value' }",
    'steps:',
    "  - { do: run, cmd: 'echo {{token}}' }",
    '',
  ].join('\n'),
)
writeFixture(
  'snippets/测试/kill.yaml',
  [
    'id: kill-demo',
    'title: 危险片段',
    'target: win-desktop',
    'danger: true',
    'steps:',
    "  - { do: run, cmd: 'echo kill' }",
    '',
  ].join('\n'),
)
// 重复 id：应被 quarantine，而不是静默覆盖
writeFixture(
  'snippets/测试/dup.yaml',
  ['id: click-instance', 'steps:', "  - { do: run, cmd: 'echo dup' }", ''].join('\n'),
)
// 桥侧失败：ahk.bat 打 ERR| 但退出码仍是 0，runner 必须判成失败
writeFixture(
  'snippets/测试/bridge-err.yaml',
  [
    'id: bridge-err',
    'title: 桥报错',
    'target: win-desktop',
    'steps:',
    "  - { do: run, cmd: 'call C:\\\\ahk_trigger\\\\ahk.bat click nosuch#9 1 1' }",
    '',
  ].join('\n'),
)

const { app, store } = buildApp({
  dataDir: FIXTURE,
  webDist: join(REPO_ROOT, 'packages/web/dist'),
  token: TOKEN,
  logger: false,
})

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
const auth = { authorization: `Bearer ${TOKEN}` }

// 0. 加载与 quarantine
check('重复 id 被 quarantine', store.errors().some((e) => e.error.includes('duplicate id')), JSON.stringify(store.errors()))
check('合法片段仍可用', store.get('click-instance') !== undefined)

// 1. 鉴权（模拟 Tailscale 来源地址）
const noAuth = await app.inject({ method: 'GET', url: '/api/snippets', remoteAddress: '100.64.0.9' })
check('远端无 token → 401', noAuth.statusCode === 401, String(noAuth.statusCode))
const withAuth = await app.inject({
  method: 'GET',
  url: '/api/snippets',
  remoteAddress: '100.64.0.9',
  headers: auth,
})
check('远端带 token → 200', withAuth.statusCode === 200, String(withAuth.statusCode))
const loopback = await app.inject({ method: 'GET', url: '/api/snippets' })
check('loopback 免 token', loopback.statusCode === 200)

// 1b. 静态壳免 token（ISSUE-001：首屏被挡 = 手机没有入口填 token，死锁）
const WEB_DIST = join(REPO_ROOT, 'packages/web/dist')
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.log('  ~ 跳过静态壳用例：packages/web/dist 未构建（先 npm run build:web）')
} else {
  const root = await app.inject({ method: 'GET', url: '/', remoteAddress: '100.64.0.9' })
  check(
    '远端 GET / → 200 且是 HTML',
    root.statusCode === 200 && String(root.headers['content-type']).includes('text/html'),
    `${root.statusCode} ${root.headers['content-type']}`,
  )
  const asset = readdirSync(join(WEB_DIST, 'assets')).find((f) => f.endsWith('.js'))
  if (asset) {
    const a = await app.inject({ method: 'GET', url: `/assets/${asset}`, remoteAddress: '100.64.0.9' })
    check('远端 GET /assets/*.js → 200', a.statusCode === 200, `${a.statusCode} ${asset}`)
  }
  const fav = await app.inject({ method: 'GET', url: '/favicon.ico', remoteAddress: '100.64.0.9' })
  check(
    '远端 GET /favicon.ico → 404 且不是 HTML',
    fav.statusCode === 404 && !String(fav.headers['content-type']).includes('html'),
    `${fav.statusCode} ${fav.headers['content-type']}`,
  )
  const spaLoop = await app.inject({ method: 'GET', url: '/some/spa/route', remoteAddress: '100.64.0.9' })
  check('远端 GET /some/spa/route → 200 HTML（SPA 回退）', spaLoop.statusCode === 200, String(spaLoop.statusCode))
  const apiStill = await app.inject({ method: 'GET', url: '/api/snippets', remoteAddress: '100.64.0.9' })
  check('静态放行没有顺带放行 /api（防回退）', apiStill.statusCode === 401, String(apiStill.statusCode))
}

// 2. health
const h = await app.inject({ method: 'GET', url: '/api/health', headers: auth })
const hb = h.json()
check('GET /api/health → 200', h.statusCode === 200)
check('health.ok === true', hb.ok === true)
check('health.bridgeUp 是布尔值', typeof hb.bridgeUp === 'boolean', JSON.stringify(hb))
check('health.snippets = 5（6 条里 1 条重复）', hb.snippets === 5, JSON.stringify(hb))
check('health.quarantined = 1', hb.quarantined === 1, JSON.stringify(hb))

// 3. 列表与单个
const list = (await app.inject({ method: 'GET', url: '/api/snippets', headers: auth })).json()
check('列表含 click-instance', list.some((s: { id: string }) => s.id === 'click-instance'))
check('kill-demo 标记 danger', list.find((s: { id: string }) => s.id === 'kill-demo')?.danger === true)
check('列表不泄漏文件路径', list.every((s: Record<string, unknown>) => !('file' in s)))
const nf = await app.inject({ method: 'GET', url: '/api/snippets/no-such', headers: auth })
check('不存在的 id → 404', nf.statusCode === 404)

// 4. preview（POST + 容错渲染 + secret 脱敏）
const pv = await app.inject({
  method: 'POST',
  url: '/api/snippets/click-instance/preview',
  headers: auth,
  payload: { vars: { pro: 'wechat', n: '2', x: '100', y: '200' } },
})
const pvb = pv.json()
check('preview POST → 200', pv.statusCode === 200, String(pv.statusCode))
check('preview 渲染出坐标', pvb.cmds?.[0]?.includes('wechat#2 100 200'), JSON.stringify(pvb.cmds))
const pvMissing = await app.inject({
  method: 'POST',
  url: '/api/snippets/click-instance/preview',
  headers: auth,
  payload: { vars: { pro: 'wechat', n: '1' } },
})
const pvmb = pvMissing.json()
check('缺变量时保留 {{x}} 占位', pvmb.cmds?.[0]?.includes('{{x}}'), JSON.stringify(pvmb))
check('缺变量时报 pending', pvmb.pending?.includes('x') && pvmb.pending?.includes('y'), JSON.stringify(pvmb.pending))
const pvSecret = await app.inject({
  method: 'POST',
  url: '/api/snippets/secret-demo/preview',
  headers: auth,
  payload: { vars: {} },
})
const pvsb = pvSecret.json()
check('secret 变量在预览里脱敏', pvsb.cmds?.[0]?.includes('***') && !pvsb.cmds?.[0]?.includes('s3cr3t'), JSON.stringify(pvsb))
const pvBad = await app.inject({
  method: 'POST',
  url: '/api/snippets/click-instance/preview',
  headers: auth,
  payload: { vars: 'nope' },
})
check('preview vars 非对象 → 400', pvBad.statusCode === 400, String(pvBad.statusCode))

// 5. hosts
const hs = (await app.inject({ method: 'GET', url: '/api/hosts', headers: auth })).json()
check(
  'hosts 含 win-desktop(exec) 且标记 default',
  hs.some(
    (t: { name: string; driver: string; default: boolean }) =>
      t.name === 'win-desktop' && t.driver === 'exec' && t.default,
  ),
)
check('home-win / vps 标记 reserved', hs.filter((t: { reserved: boolean }) => t.reserved).length === 2)

// 6. 未知 /api 路径 → JSON 404（不是 SPA 的 index.html）
const unknown = await app.inject({ method: 'GET', url: '/api/nope', headers: auth })
check(
  '未知 /api → 404 JSON',
  unknown.statusCode === 404 && String(unknown.headers['content-type']).includes('json'),
  `${unknown.statusCode} ${unknown.headers['content-type']}`,
)

// 7. danger 未确认 → 400
const danger = await app.inject({ method: 'POST', url: '/api/run', headers: auth, payload: { id: 'kill-demo' } })
check('danger 未确认 → 400', danger.statusCode === 400, String(danger.statusCode))

// 8. 目标未激活 → 400（开流前就判定）
const reservedTarget = await app.inject({
  method: 'POST',
  url: '/api/run',
  headers: auth,
  payload: { id: 'kill-demo', confirm: true, target: 'vps' },
})
check('reserved 目标 → 400', reservedTarget.statusCode === 400, String(reservedTarget.statusCode))

// 9. 真跑一条（SSE 事件流；inject 会等到 reply 结束）
const bridgeUp = hb.bridgeUp === true
if (!bridgeUp) {
  console.log('  ~ 跳过 /api/run 实跑：listener 不在线（bridgeUp=false）')
} else {
  const run = await app.inject({
    method: 'POST',
    url: '/api/run',
    headers: auth,
    payload: { id: 'check-instence' },
  })
  const body = run.body
  check('run → 200 + event-stream', run.statusCode === 200 && body.includes('"type":"start"'), String(run.statusCode))
  check('run 回传了实例表', body.includes('slot|pid'), body.slice(0, 160))
  check('run 以 exit 事件收尾', body.includes('"type":"exit"'), body.slice(-160))

  // 桥报错但退出码 0：不能显示成「完成」
  const errRun = await app.inject({
    method: 'POST',
    url: '/api/run',
    headers: auth,
    payload: { id: 'bridge-err' },
  })
  const errBody = errRun.body
  check('ERR| 输出被判为失败', errBody.includes('"ok":false'), errBody.slice(-200))
  check('失败原因带 note', errBody.includes('ERR| 开头'), errBody.slice(-200))
}

await app.close()
tryRemove(FIXTURE)
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
