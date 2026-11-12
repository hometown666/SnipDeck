/**
 * 冒烟测试：用 buildApp() 打**真路由**（不监听端口、不联网）。
 * 之前这里另抄了一份路由实现，结果队列、鉴权、404 的 bug 一个都没测出来。
 *
 * 运行：npm run smoke（在 packages/server 下）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// fixture 落系统临时目录，不落 data/tmp：
// 1) 天然干净，不需要「先删一遍」那种自己给自己挖坑的开场；
// 2) 不会和真实 run 生成的 run-*.cmd 混在一起被 sweepTmp 误清。
const FIXTURE = mkdtempSync(join(tmpdir(), 'snipdeck-smoke-'))
const TOKEN = 'smoke-token'
// 桥目录可换：CI 上没有 listener，指向一个不存在的目录就能覆盖「桥不在线」那条降级路径。
// 本机不设这个变量，照旧打真桥。
const BRIDGE = process.env.SNIPDECK_SMOKE_BRIDGE ?? 'C:\\ahk_trigger'
const BRIDGE_YAML = BRIDGE.replace(/\\/g, '\\\\')

// P7.1 夹具：一个「有实例」的桥目录 + 一个「目录在但文件不在」的桥目录。
// 不碰默认目标，所以 health / run 仍按无桥路径跑。
const BRIDGE_FIXTURE = join(FIXTURE, 'bridge-fixture')
const BRIDGE_EMPTY = join(FIXTURE, 'bridge-empty')
mkdirSync(BRIDGE_FIXTURE, { recursive: true })
mkdirSync(BRIDGE_EMPTY, { recursive: true })

function localTs(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** listener 写的是 UTF-16 LE + BOM；夹具必须同编码，否则测不到 decodeText 那条路 */
function writeUtf16(file: string, text: string): void {
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
}

writeUtf16(
  join(BRIDGE_FIXTURE, 'instances.txt'),
  [
    '# slot|pid|hwnd|exe|pro|ts',
    'wechat#1|999999|5678|WeChat.exe|wechat|2026-11-10 02:00:00',
    '微信#2|999998|6789|WeChat.exe|微信',
    '',
  ].join('\r\n'),
)
writeUtf16(
  join(BRIDGE_FIXTURE, 'status.txt'),
  [
    `ts=${localTs()}`,
    'listener=ok',
    'admin=1',
    'last=OK|2026-11-10 02:16:24|shell|open|pid=34580 slot=shell#1',
    'foreground=WorkBuddy',
    'Cursor=stopped',
    'Weixin=running',
    'instances=2',
    'inst.wechat#1=pid=999999 hwnd=5678 exe=WeChat.exe',
    'inst.微信#2=pid=999998 hwnd=6789 exe=WeChat.exe',
    '',
  ].join('\r\n'),
)

// P7.3 夹具：程序扫描的结果。
// 真扫描要跑 PowerShell + 读开始菜单，CI 上完全不可控（runner 装了什么谁也不知道），
// 所以这里把「扫描器交上来的行」当成固定输入，只验分类 / 接口 / only / include。
const PROG_DIR_FIXTURE = join(FIXTURE, '程序')
mkdirSync(PROG_DIR_FIXTURE, { recursive: true })
const LNK_WECHAT = join(PROG_DIR_FIXTURE, 'WeChat.lnk')
const LNK_WEIXIN = join(PROG_DIR_FIXTURE, '微信.lnk')
const LNK_CMD_IN_PROG = join(PROG_DIR_FIXTURE, 'cmd.lnk')
const LNK_CMD_IN_MENU = join(FIXTURE, 'menu', 'Command Prompt.lnk')
const LNK_UNINSTALL = join(FIXTURE, 'menu', 'Uninstall Foo.lnk')
const LNK_BROKEN = join(FIXTURE, 'menu', 'Broken.lnk')
// 只有体检「文件在不在」这一步需要真实文件；内容无所谓，不解析
for (const f of [LNK_WECHAT, LNK_WEIXIN, LNK_CMD_IN_PROG, LNK_CMD_IN_MENU, LNK_UNINSTALL, LNK_BROKEN]) {
  writeFixture(relative(FIXTURE, f), '')
}
const PROGRAMS_FIXTURE = join(FIXTURE, 'programs-scan.json')
writeFileSync(
  PROGRAMS_FIXTURE,
  JSON.stringify({
    roots: [{ source: 'progDir', path: PROG_DIR_FIXTURE, count: 3 }],
    items: [
      {
        path: LNK_WECHAT,
        name: 'WeChat',
        dir: PROG_DIR_FIXTURE,
        source: 'progDir',
        target: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
        args: '',
      },
      {
        path: LNK_WEIXIN,
        name: '微信',
        dir: PROG_DIR_FIXTURE,
        source: 'progDir',
        target: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
        args: '',
      },
      {
        path: LNK_CMD_IN_PROG,
        name: 'cmd',
        dir: PROG_DIR_FIXTURE,
        source: 'progDir',
        target: 'C:\\Windows\\System32\\cmd.exe',
        args: '',
      },
      {
        path: LNK_CMD_IN_MENU,
        name: 'Command Prompt',
        dir: join(FIXTURE, 'menu'),
        source: 'commonMenu',
        // 刻意和 progDir 里的 cmd 用不同的 target：否则会被去重吃掉，
        // 测的就不是「include 能不能把系统工具放回来」了
        target: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: '',
      },
      {
        path: LNK_UNINSTALL,
        name: 'Uninstall Foo',
        dir: join(FIXTURE, 'menu'),
        source: 'commonMenu',
        target: 'C:\\Program Files\\Foo\\unins000.exe',
        args: '',
      },
      {
        path: LNK_BROKEN,
        name: 'Broken',
        dir: join(FIXTURE, 'menu'),
        source: 'commonMenu',
        target: '',
        args: '',
      },
      // 便携 exe：launch 直接给定，避免 CI 里去跑 COM 生成快捷方式（生成链路另有真机验收）
      {
        path: join(PROG_DIR_FIXTURE, 'PortableTool.exe'),
        name: 'PortableTool',
        dir: PROG_DIR_FIXTURE,
        source: 'extra',
        target: '',
        args: '',
        kind: 'exe',
        launch: join(FIXTURE, 'wrap', 'PortableTool.lnk'),
      },
      // 安装器：即使目录被信任也不该出现在列表里
      {
        path: join(PROG_DIR_FIXTURE, 'setup.exe'),
        name: 'setup',
        dir: PROG_DIR_FIXTURE,
        source: 'extra',
        target: '',
        args: '',
        kind: 'exe',
      },
    ],
  }),
  'utf8',
)
// 只对「本进程」生效：扫描器看到这个变量就不碰本机开始菜单
process.env.SNIPDECK_PROGRAMS_FIXTURE = PROGRAMS_FIXTURE


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
    `  bridge: ${BRIDGE_YAML}`,
    '  timeout: 20',
    'legacy-reserved:',
    '  driver: local',
    '  reserved: true',
    'smoke-bridge:',
    '  driver: exec',
    '  shell: cmd',
    `  bridge: ${JSON.stringify(BRIDGE_FIXTURE)}`,
    '  timeout: 20',
    'smoke-empty:',
    '  driver: exec',
    '  shell: cmd',
    `  bridge: ${JSON.stringify(BRIDGE_EMPTY)}`,
    '  timeout: 20',
    'smoke-missing:',
    '  driver: exec',
    '  shell: cmd',
    `  bridge: ${JSON.stringify(join(FIXTURE, 'no-such-bridge'))}`,
    '  timeout: 20',
    '',
  ].join('\n'),
)
writeFixture(
  'snippets/实例控制/pick-demo.yaml',
  [
    'id: pick-demo',
    'title: 实例下拉',
    'target: win-desktop',
    'vars:',
    '  admin: { prompt: 提权, choices: ["", "admin"], default: "" }',
    '  pro: { prompt: 程序, default: wechat }',
    '  n: { prompt: 实例号, default: 1 }',
    'steps:',
    "  - { do: run, cmd: 'call C:\\ahk_trigger\\ahk.bat {{admin}} kill {{pro}}#{{n}}' }",
    '',
  ].join('\n'),
)
writeFixture(
  'snippets/程序启动/lnk-demo.yaml',
  [
    'id: lnk-demo',
    'title: 程序下拉',
    'target: win-desktop',
    'vars:',
    '  pro: { prompt: 程序, default: wechat }',
    'steps:',
    "  - { do: run, cmd: 'call C:\\ahk_trigger\\ahk.bat lnk \"{{pro}}\"' }",
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
    `    cmd: call ${BRIDGE_YAML}\\ahk.bat instances`,
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
// 「同目标多开」的串行验证用：约 2s、走队列、**不打桥**（listener 离线也能跑），
// 有 stdout 才能断言两个目标的事件区间不重叠。
writeFixture(
  'snippets/测试/slow-queued.yaml',
  [
    'id: slow-queued',
    'title: 慢命令',
    'target: win-desktop',
    'steps:',
    "  - { do: run, cmd: 'ping -n 3 127.0.0.1', timeout: 30 }",
    '',
  ].join('\n'),
)
// 断言失败：失败原因（未匹配哪条正则）必须跟在 exit 事件上，而不是只留在上一条 step 里
writeFixture(
  'snippets/测试/expect-miss.yaml',
  [
    'id: expect-miss',
    'title: 断言必失败',
    'target: win-desktop',
    'steps:',
    "  - { do: run, cmd: 'ping -n 1 127.0.0.1' }",
    '  - { do: expect, match: never-appears-\\d+ }',
    '',
  ].join('\n'),
)

// 原文编辑用例的样本：注释、字段顺序、单引号都是「表单保存会抹掉、原文保存要保住」的东西
writeFixture(
  'snippets/状态/raw-probe.yaml',
  [
    '# 这一行注释必须活下来',
    'id: raw-probe',
    'title: 原文用例',
    'group: 状态',
    // 故意把 tags 写在 title 前面：表单保存会按固定顺序重排
    'tags: [raw]',
    'steps:',
    '  - do: run',
    "    cmd: 'echo raw'",
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
// 方案 D（2026-10-31）：这条用例以前断言「loopback 免 token」——它钉住的正是那个洞。
// 反代会把公网请求从 127.0.0.1 转进来，按来源 IP 豁免等于 token 白设。
check('loopback 无 token → 401（方案 D）', loopback.statusCode === 401, String(loopback.statusCode))
const loopbackAuth = await app.inject({ method: 'GET', url: '/api/snippets', headers: auth })
check('loopback 带 token → 200', loopbackAuth.statusCode === 200, String(loopbackAuth.statusCode))
const proxied = await app.inject({
  method: 'GET',
  url: '/api/snippets',
  remoteAddress: '127.0.0.1',
  headers: { 'x-forwarded-for': '100.64.0.9' },
})
check('反代转进来（127.0.0.1 + XFF）无 token → 401', proxied.statusCode === 401, String(proxied.statusCode))

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
check('health.quarantined = 1', hb.quarantined === 1, JSON.stringify(hb))

// 2.1 桥的只读数据（P7.1）：直接读实例表，不写 command.txt
const bi = await app.inject({
  method: 'GET',
  url: '/api/bridge/instances?target=smoke-bridge',
  headers: auth,
})
const bib = bi.json()
check('GET /api/bridge/instances → 200', bi.statusCode === 200, bi.body)
check('实例 2 条', bib.instances?.length === 2, JSON.stringify(bib.instances))
check(
  'UTF-16 中文 pro 读得出来',
  bib.instances?.some((x: { slot: string; pro: string }) => x.slot === '微信#2' && x.pro === '微信'),
  JSON.stringify(bib.instances),
)
check('listener fresh', bib.listener?.state === 'fresh', JSON.stringify(bib.listener))
check(
  'admin / foreground 透传',
  bib.status?.admin === true && bib.status?.foreground === 'WorkBuddy',
  JSON.stringify(bib.status),
)
check(
  'pid 已退 → alive=false',
  bib.instances?.find((x: { slot: string }) => x.slot === 'wechat#1')?.alive === false,
  JSON.stringify(bib.instances),
)
check('读实例表没有写 command.txt', !existsSync(join(BRIDGE_FIXTURE, 'command.txt')))

const biEmpty = await app.inject({
  method: 'GET',
  url: '/api/bridge/instances?target=smoke-empty',
  headers: auth,
})
const bie = biEmpty.json()
check('缺文件仍 200（不是 500）', biEmpty.statusCode === 200, String(biEmpty.statusCode))
check(
  '缺文件时 error 说清楚',
  typeof bie.error === 'string' && bie.error.includes('instances.txt'),
  JSON.stringify(bie.error),
)
check(
  '缺文件时实例为空、listener offline',
  bie.instances?.length === 0 && bie.listener?.state === 'offline',
  JSON.stringify(bie),
)

const biReserved = await app.inject({
  method: 'GET',
  url: '/api/bridge/instances?target=legacy-reserved',
  headers: auth,
})
check('reserved 目标 → 400', biReserved.statusCode === 400, String(biReserved.statusCode))
const biUnknown = await app.inject({
  method: 'GET',
  url: '/api/bridge/instances?target=nope',
  headers: auth,
})
check('未知目标 → 400', biUnknown.statusCode === 400, String(biUnknown.statusCode))

const biMissingDir = await app.inject({
  method: 'GET',
  url: '/api/bridge/instances?target=smoke-missing',
  headers: auth,
})
check(
  'bridge 目录不存在 → 400 且说清楚',
  biMissingDir.statusCode === 400 && String(biMissingDir.body).includes('bridge 目录不存在'),
  `${biMissingDir.statusCode} ${biMissingDir.body}`,
)

const biDup = await app.inject({
  method: 'GET',
  url: '/api/bridge/instances?target=smoke-bridge&target=smoke-empty',
  headers: auth,
})
check('重复 target → 400（不静默挑一个）', biDup.statusCode === 400, `${biDup.statusCode} ${biDup.body}`)

// 2.6 程序发现（P7.3）
const pg = await app.inject({ method: 'GET', url: '/api/bridge/programs', headers: auth })
const pgv = pg.json()
check('程序列表 → 200', pg.statusCode === 200, pg.body.slice(0, 200))
check('扫到 8 条', pgv.total === 8, String(pgv.total))
check(
  '保留 4 条（两条 progDir + 一条中文 + 一条便携 exe）',
  pgv.programs?.length === 4,
  JSON.stringify(pgv.programs?.map((p: { name: string }) => p.name)),
)
check(
  'PROG_DIR 里的 cmd 不套黑名单',
  pgv.programs?.some((p: { name: string }) => p.name === 'cmd'),
  JSON.stringify(pgv.programs?.map((p: { name: string }) => p.name)),
)
check(
  '中文程序名原样带回',
  pgv.programs?.some((p: { name: string }) => p.name === '微信'),
  JSON.stringify(pgv.programs?.map((p: { name: string }) => p.name)),
)
const reasons = new Set((pgv.filtered ?? []).map((f: { reason: string }) => f.reason))
check(
  '过滤原因含 system / uninstall / broken / installer',
  ['system', 'uninstall', 'broken', 'installer'].every((r) => reasons.has(r)),
  JSON.stringify([...reasons]),
)
const portable = (pgv.programs ?? []).find((p: { name: string }) => p.name === 'PortableTool')
check(
  '便携 exe 的值是生成的 .lnk（不是裸 exe）',
  !!portable && portable.kind === 'exe' && /\.lnk$/i.test(portable.value),
  JSON.stringify(portable),
)
check(
  '便携 exe 仍保留原 exe 路径',
  !!portable && /\.exe$/i.test(portable.path),
  JSON.stringify(portable?.path),
)
check(
  '每个程序都带绝对路径当值',
  (pgv.programs ?? []).every((p: { value: string }) => /^[A-Za-z]:\\/.test(p.value)),
  JSON.stringify(pgv.programs?.map((p: { value: string }) => p.value)),
)
check('mode = discover', pgv.mode === 'discover', String(pgv.mode))
check('没有写 command.txt（读列表不该占用串行队列）', !existsSync(join(BRIDGE_FIXTURE, 'command.txt')))

const pgCfg = await app.inject({ method: 'GET', url: '/api/bridge/programs/config', headers: auth })
check('程序配置 → 200 且默认空', pgCfg.statusCode === 200 && pgCfg.json().config.only.length === 0, pgCfg.body)

const pgBad = await app.inject({
  method: 'PUT',
  url: '/api/bridge/programs/config',
  headers: auth,
  payload: { only: ['C:\\definitely\\missing.lnk'] },
})
check(
  'only 写了不存在的路径 → 400 且说清楚',
  pgBad.statusCode === 400 && String(pgBad.body).includes('不存在'),
  `${pgBad.statusCode} ${pgBad.body}`,
)

const pgOnly = await app.inject({
  method: 'PUT',
  url: '/api/bridge/programs/config',
  headers: auth,
  payload: { only: [LNK_WECHAT] },
})
check('only 合法路径 → 200', pgOnly.statusCode === 200, pgOnly.body)
const pgOnlyList = await app.inject({ method: 'GET', url: '/api/bridge/programs', headers: auth })
const pgo = pgOnlyList.json()
check('only 模式生效', pgo.mode === 'only', String(pgo.mode))
check('only 只剩点名的 1 条', pgo.programs?.length === 1, String(pgo.programs?.length))
check('only 的条目来源标成「指定列表」', pgo.programs?.[0]?.source === 'only', pgo.programs?.[0]?.source)

const pgInclude = await app.inject({
  method: 'PUT',
  url: '/api/bridge/programs/config',
  headers: auth,
  payload: { only: [], include: [LNK_CMD_IN_MENU] },
})
check('include 合法 → 200', pgInclude.statusCode === 200, pgInclude.body)
const pgIncList = (await app.inject({ method: 'GET', url: '/api/bridge/programs', headers: auth })).json()
check('include 让被挡的系统工具出现', pgIncList.programs?.length === 5, String(pgIncList.programs?.length))
check(
  'include 后仍是过滤列表少一条',
  pgIncList.filtered?.length === 3,
  String(pgIncList.filtered?.length),
)
await app.inject({
  method: 'PUT',
  url: '/api/bridge/programs/config',
  headers: auth,
  payload: { only: [], include: [] },
})

// 3. 列表与单个
const list = (await app.inject({ method: 'GET', url: '/api/snippets', headers: auth })).json()
// 数量断言不写死：加一条 fixture 就会红。真正要钉的是「health 与列表说的是同一件事」
check('health.snippets 与列表长度一致', hb.snippets === list.length, `${hb.snippets} vs ${list.length}`)
check('列表含 click-instance', list.some((s: { id: string }) => s.id === 'click-instance'))
check('kill-demo 标记 danger', list.find((s: { id: string }) => s.id === 'kill-demo')?.danger === true)
check('列表不泄漏文件路径', list.every((s: Record<string, unknown>) => !('file' in s)))
const pickDemo = list.find((s: { id: string }) => s.id === 'pick-demo')
check(
  'pick-demo 带 proN 实例下拉',
  JSON.stringify(pickDemo?.picks) ===
    JSON.stringify([{ kind: 'instances', mode: 'proN', vars: { pro: 'pro', n: 'n' } }]),
  JSON.stringify(pickDemo?.picks),
)
check(
  '普通片段没有实例下拉',
  !list.find((s: { id: string }) => s.id === 'check-instence')?.picks,
)
const lnkDemo = list.find((s: { id: string }) => s.id === 'lnk-demo')
check(
  'lnk-demo 带程序下拉（kind=programs）',
  JSON.stringify(lnkDemo?.picks) ===
    JSON.stringify([{ kind: 'programs', mode: 'file', vars: { pro: 'pro' } }]),
  JSON.stringify(lnkDemo?.picks),
)
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
check('fixture 里有一条 reserved 目标', hs.filter((t: { reserved: boolean }) => t.reserved).length === 1)

// 5.0 目标管理（hosts.yaml）
const hd0 = (await app.inject({ method: 'GET', url: '/api/hosts/detail', headers: auth })).json()
check('hosts/detail 带 targets 与 mtimeMs', Array.isArray(hd0.targets) && hd0.mtimeMs > 0, JSON.stringify(hd0).slice(0, 120))
check(
  'hosts/detail 带 bridge / shell / timeout',
  hd0.targets.some(
    (t: { name: string; bridge: string; shell: string; timeout: number }) =>
      t.name === 'win-desktop' && t.bridge.length > 3 && t.shell === 'cmd' && t.timeout === 20,
  ),
  JSON.stringify(hd0.targets?.[0]),
)

const hostNew = {
  name: 'smoke-host',
  driver: 'exec',
  bridge: FIXTURE,
  shell: 'cmd',
  timeout: 15,
}
const hPost = await app.inject({ method: 'POST', url: '/api/hosts', headers: auth, payload: hostNew })
check('POST hosts → 201', hPost.statusCode === 201, `${hPost.statusCode} ${hPost.body}`)
check('hosts.yaml 里真的多了这条', readFileSync(join(FIXTURE, 'hosts.yaml'), 'utf8').includes('smoke-host'))

const hDup = await app.inject({ method: 'POST', url: '/api/hosts', headers: auth, payload: hostNew })
check('POST 重名 → 409', hDup.statusCode === 409, String(hDup.statusCode))

const hBadName = await app.inject({
  method: 'POST',
  url: '/api/hosts',
  headers: auth,
  payload: { ...hostNew, name: 'Bad Name' },
})
check('名字不合法 → 400', hBadName.statusCode === 400, hBadName.body)

const hNoBridge = await app.inject({
  method: 'POST',
  url: '/api/hosts',
  headers: auth,
  payload: { name: 'smoke-nobridge', driver: 'exec', shell: 'cmd' },
})
check(
  'exec 不填 bridge → 400 且说清楚',
  hNoBridge.statusCode === 400 && String(hNoBridge.body).includes('bridge'),
  hNoBridge.body,
)

const hBadTimeout = await app.inject({
  method: 'PUT',
  url: '/api/hosts/smoke-host',
  headers: auth,
  payload: { ...hostNew, timeout: 9999, mtimeMs: hd0.mtimeMs },
})
check('timeout 越界 → 400', hBadTimeout.statusCode === 400, hBadTimeout.body)

// 改名：旧键消失、新键在
const hRen = await app.inject({
  method: 'PUT',
  url: '/api/hosts/smoke-host',
  headers: auth,
  payload: { ...hostNew, name: 'smoke-host2' },
})
check('PUT 改名 → 200 且 renamed', hRen.statusCode === 200 && hRen.json().renamed === true, hRen.body)
const hostsYaml = readFileSync(join(FIXTURE, 'hosts.yaml'), 'utf8')
check('改名后旧键消失', !/^smoke-host:/m.test(hostsYaml) && /^smoke-host2:/m.test(hostsYaml))

// mtime 冲突：拿一个过期的时间戳去改
const hStale = await app.inject({
  method: 'PUT',
  url: '/api/hosts/smoke-host2',
  headers: auth,
  payload: { ...hostNew, name: 'smoke-host2', mtimeMs: 1 },
})
check('过期 mtime → 409', hStale.statusCode === 409, `${hStale.statusCode} ${hStale.body}`)
check('409 之后文件没被改', readFileSync(join(FIXTURE, 'hosts.yaml'), 'utf8') === hostsYaml)

// default 排他
const hDefault = await app.inject({
  method: 'PUT',
  url: '/api/hosts/smoke-host2',
  headers: auth,
  payload: { ...hostNew, name: 'smoke-host2', default: true },
})
check('设 default → 200', hDefault.statusCode === 200, hDefault.body)
const defaults = (await app.inject({ method: 'GET', url: '/api/hosts', headers: auth }))
  .json()
  .filter((t: { default: boolean }) => t.default)
check('default 排他：只有一台', defaults.length === 1 && defaults[0].name === 'smoke-host2', JSON.stringify(defaults))

// 还原默认目标，别影响后面的用例
const hRestore = await app.inject({
  method: 'PUT',
  url: '/api/hosts/win-desktop',
  headers: auth,
  payload: {
    name: 'win-desktop',
    driver: 'exec',
    bridge: process.env.SNIPDECK_SMOKE_BRIDGE ?? 'C:\\ahk_trigger',
    shell: 'cmd',
    timeout: 20,
    default: true,
  },
})
check('默认目标能还原', hRestore.statusCode === 200, hRestore.body)

// 有片段引用就不能删
const hUsed = await app.inject({ method: 'DELETE', url: '/api/hosts/win-desktop', headers: auth })
check(
  '被片段引用的目标不能删（409 且点名片段）',
  hUsed.statusCode === 409 && String(hUsed.body).includes('用着这个目标'),
  `${hUsed.statusCode} ${hUsed.body}`,
)

const hDel = await app.inject({ method: 'DELETE', url: '/api/hosts/smoke-host2', headers: auth })
check('DELETE 没人用的目标 → 200', hDel.statusCode === 200, hDel.body)
check('删除后真的没了', !readFileSync(join(FIXTURE, 'hosts.yaml'), 'utf8').includes('smoke-host2'))

const hDel404 = await app.inject({ method: 'DELETE', url: '/api/hosts/nope', headers: auth })
check('DELETE 不存在 → 404', hDel404.statusCode === 404, String(hDel404.statusCode))

// 5.1 桥的目录配置（PROG_DIR / AHK_DIR）
const st0 = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json()
check(
  'settings 初始为空且不注入',
  st0.progDir === '' && st0.ahkDir === '' && Object.keys(st0.injected).length === 0,
  JSON.stringify(st0),
)
check('settings 带桥目录诊断', typeof st0.bridgeRoot === 'string' && st0.bridgeRoot.length > 0)

// 用 FIXTURE 自己当目录：一定存在、是绝对路径、靠谱地跨机器
const putOk = await app.inject({
  method: 'PUT',
  url: '/api/settings',
  headers: auth,
  payload: { progDir: FIXTURE, ahkDir: FIXTURE },
})
const putBody = putOk.json()
check('PUT settings → 200', putOk.statusCode === 200, String(putOk.statusCode))
check(
  '注入值就是填的值',
  putBody.injected?.PROG_DIR === FIXTURE && putBody.injected?.AHK_DIR === FIXTURE,
  JSON.stringify(putBody.injected),
)
check('落盘成 settings.json', existsSync(join(FIXTURE, 'settings.json')))
const settingsOnDisk = JSON.parse(readFileSync(join(FIXTURE, 'settings.json'), 'utf8')) as Record<string, unknown>
check(
  '落盘的是标准 JSON 且两条目录都在',
  settingsOnDisk.progDir === FIXTURE && settingsOnDisk.ahkDir === FIXTURE,
  JSON.stringify(settingsOnDisk),
)
check('lnkCount 是数字（空目录为 0）', putBody.lnkCount === 0, String(putBody.lnkCount))

const st1 = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json()
check('GET 立刻读到刚存的值（不用重启）', st1.progDir === FIXTURE, st1.progDir)

const putMissing = await app.inject({
  method: 'PUT',
  url: '/api/settings',
  headers: auth,
  payload: { progDir: join(FIXTURE, 'no-such-dir') },
})
check(
  '不存在的目录 → 400 且说清楚哪条不对',
  putMissing.statusCode === 400 && String(putMissing.body).includes('不存在'),
  `${putMissing.statusCode} ${putMissing.body}`,
)

const putRelative = await app.inject({
  method: 'PUT',
  url: '/api/settings',
  headers: auth,
  payload: { ahkDir: 'relative\\path' },
})
check(
  '相对路径 → 400',
  putRelative.statusCode === 400 && String(putRelative.body).includes('绝对路径'),
  `${putRelative.statusCode} ${putRelative.body}`,
)

// 400 不能把已存的值改坏：失败后仍是上一次成功的那份
const st2 = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json()
check('校验失败不落盘', st2.progDir === FIXTURE && st2.ahkDir === FIXTURE, JSON.stringify(st2))

// 档案保留策略：0 = 用默认，界面上看到的是换算后的生效值
check(
  'settings 初始档案策略是默认',
  st0.runs?.isDefault === true && st0.runs.ttlDays === 30 && st0.runs.maxFiles === 500,
  JSON.stringify(st0.runs),
)

const putRuns = await app.inject({
  method: 'PUT',
  url: '/api/settings',
  headers: auth,
  payload: { runsTtlDays: 7, runsMaxFiles: 120 },
})
check(
  'PUT 档案策略 → 生效值跟着变',
  putRuns.statusCode === 200 &&
    putRuns.json().runs.ttlDays === 7 &&
    putRuns.json().runs.maxFiles === 120 &&
    putRuns.json().runs.isDefault === false,
  putRuns.body,
)

const putRunsBad = await app.inject({
  method: 'PUT',
  url: '/api/settings',
  headers: auth,
  payload: { runsTtlDays: 0.5 },
})
check('档案天数非整数 → 400', putRunsBad.statusCode === 400, putRunsBad.body)

// 只带 runs 字段的 PUT 不能把两条目录清掉（部分更新）
const stPartial = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json()
check(
  '部分更新不清空别的字段',
  stPartial.progDir === FIXTURE && stPartial.ahkDir === FIXTURE,
  JSON.stringify(stPartial).slice(0, 120),
)

const delSettings = await app.inject({ method: 'DELETE', url: '/api/settings', headers: auth })
check(
  'DELETE settings → 回到空',
  delSettings.json().progDir === '' && delSettings.json().ahkDir === '',
)

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
  payload: { id: 'kill-demo', confirm: true, target: 'legacy-reserved' },
})
check('reserved 目标 → 400', reservedTarget.statusCode === 400, String(reservedTarget.statusCode))

// 8b. 多目标（P3）：targets[] 校验在开流前判定
const targetsBad: [string, unknown][] = [
  ['空数组', []],
  ['未知目标', ['nope']],
  ['含 reserved 目标（整条拒绝）', ['win-desktop', 'legacy-reserved']],
  ['非数组', 'win-desktop'],
  ['空字符串项', ['win-desktop', '  ']],
]
for (const [label, targets] of targetsBad) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/run',
    headers: auth,
    payload: { id: 'slow-queued', targets },
  })
  check(`targets ${label} → 400`, r.statusCode === 400, `${r.statusCode} ${r.body.slice(0, 120)}`)
}

function parseEvents(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>)
}

// 同一目标开两次：事件要带 target/targetIndex，且两次执行必须**严格串行**
// （桥的 command.txt 是单车道；这条片段不打桥，所以 listener 离线也能验）
const multiT0 = Date.now()
const multi = await app.inject({
  method: 'POST',
  url: '/api/run',
  headers: auth,
  payload: { id: 'slow-queued', targets: ['win-desktop', 'win-desktop'] },
})
const multiWall = Date.now() - multiT0
const evs = parseEvents(multi.body)
check('多目标 run → 200 + event-stream', multi.statusCode === 200 && evs.length > 0, String(multi.statusCode))
check('每条事件都带 target', evs.every((e) => e.target === 'win-desktop'), JSON.stringify(evs.slice(0, 2)))
check(
  'targetIndex 覆盖 0 与 1（同目标多开）',
  [...new Set(evs.map((e) => e.targetIndex))].sort().join(',') === '0,1',
  JSON.stringify([...new Set(evs.map((e) => e.targetIndex))]),
)
check(
  '两个目标各自收尾',
  [0, 1].every((t) =>
    evs.some((e) => e.targetIndex === t && e.type === 'exit' && e.ok === true),
  ),
  JSON.stringify(evs.filter((e) => e.type === 'exit')),
)
// 串行判定：两组的「stdout/step 事件区间」不能重叠
const span = (t: number) => {
  const idx = evs
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.targetIndex === t && (e.type === 'stdout' || e.type === 'step'))
    .map(({ i }) => i)
  return idx.length === 0 ? null : [Math.min(...idx), Math.max(...idx)]
}
const sp0 = span(0)
const sp1 = span(1)
check(
  '同目标多开严格串行（区间不重叠）',
  !!sp0 && !!sp1 && (sp0[1]! < sp1[0]! || sp1[1]! < sp0[0]!),
  `span0=${JSON.stringify(sp0)} span1=${JSON.stringify(sp1)}`,
)
// ping -n 3 约 2s，两条串行应 ≥ 3.5s（并行会接近 2s）
check('多目标总耗时 ≈ 单条 × 2（确实没并发）', multiWall >= 3500, `${multiWall}ms`)

// 8c. 断言失败的结局要带原因（ISSUE-013）
{
  const r = await app.inject({ method: 'POST', url: '/api/run', headers: auth, payload: { id: 'expect-miss' } })
  const evs2 = parseEvents(r.body)
  const ex = evs2.find((e) => e.type === 'exit')
  check(
    'expect 失败 → exit.reason = expect',
    ex?.reason === 'expect',
    JSON.stringify(ex),
  )
  check(
    'expect 失败 → exit.note 带未匹配的正则',
    typeof ex?.note === 'string' && /未匹配/.test(ex.note),
    JSON.stringify(ex?.note),
  )
  check(
    'expect 失败 → exit.stepIndex 指向断言步',
    ex?.stepIndex === 1,
    JSON.stringify(ex?.stepIndex),
  )
}

// 8d. 运行档案（P4）：断开 SSE 之后还能回看这次跑了什么
// 先跑一条带 secret 的片段，用来验「secret 值不进档案」
await app.inject({ method: 'POST', url: '/api/run', headers: auth, payload: { id: 'secret-demo' } })

type RunItem = {
  runId: string
  snippetId: string
  targets: string[]
  vars?: Record<string, string>
  varsRedacted?: string[]
  ok: boolean
  durationMs?: number
  panes: { target: string; ok: boolean; reason?: string; note?: string }[]
  eventCount: number
}
const runsList = (
  await app.inject({ method: 'GET', url: '/api/runs?limit=10', headers: auth })
).json() as RunItem[]
check('GET /api/runs → 非空数组', Array.isArray(runsList) && runsList.length > 0, JSON.stringify(runsList).slice(0, 200))

const multiRun = runsList.find((r) => r.snippetId === 'slow-queued')
check('多目标 run 已落盘', multiRun !== undefined, JSON.stringify(runsList.map((r) => r.snippetId)))
check(
  '档案记了 2 个目标 + 2 条目标结论',
  multiRun?.targets.length === 2 && multiRun?.panes.length === 2,
  JSON.stringify(multiRun?.targets),
)
check(
  '列表带 ok / durationMs / eventCount',
  typeof multiRun?.ok === 'boolean' && (multiRun?.durationMs ?? 0) > 0 && (multiRun?.eventCount ?? 0) > 0,
  JSON.stringify({ ok: multiRun?.ok, dur: multiRun?.durationMs, n: multiRun?.eventCount }),
)
// ISSUE-014：行里的 `kind` 是存储标记，不属于 RunMeta，整行 spread 会把它漏进接口
check(
  '列表项不带存储用的 kind 字段',
  runsList.every((r) => !('kind' in (r as unknown as Record<string, unknown>))),
  JSON.stringify(Object.keys(runsList[0] ?? {})),
)
check(
  '列表项带的是 RunMeta 的字段（snippetId / startedAt / caller）',
  !!multiRun?.snippetId && typeof multiRun?.startedAt === 'number' && !!multiRun?.caller,
  JSON.stringify(Object.keys(multiRun ?? {})),
)

// 断言失败的档案：结局里要能看出是「断言未命中」，不是「桥报错」
const missRuns = (
  await app.inject({ method: 'GET', url: '/api/runs?snippet=expect-miss', headers: auth })
).json() as RunItem[]
check(
  '档案 summary 记下 reason=expect 与未匹配原因',
  missRuns[0]?.panes[0]?.reason === 'expect' && /未匹配/.test(missRuns[0]?.panes[0]?.note ?? ''),
  JSON.stringify(missRuns[0]?.panes[0]),
)

const detail = (
  await app.inject({ method: 'GET', url: `/api/runs/${multiRun?.runId}`, headers: auth })
).json() as {
  meta: { runId: string; snippetId: string }
  events: Record<string, unknown>[]
  summary: { ok: boolean; panes: unknown[] }
}
check('GET /api/runs/:runId → meta + events + summary', detail.meta.runId === multiRun?.runId && detail.events.length > 0 && !!detail.summary, JSON.stringify(Object.keys(detail)))
check('详情事件数与列表一致', detail.events.length === multiRun?.eventCount, `${detail.events.length} vs ${multiRun?.eventCount}`)
check(
  '详情 meta 不带存储用的 kind 字段',
  !('kind' in (detail.meta as unknown as Record<string, unknown>)) &&
    !('kind' in ((detail.summary ?? {}) as unknown as Record<string, unknown>)),
  JSON.stringify(Object.keys(detail.meta)),
)
check(
  'start 事件带 runId（前端据此回链档案）',
  detail.events.find((e) => e.type === 'start')?.runId === multiRun?.runId,
  JSON.stringify(detail.events[0]),
)
check('档案末条事件是 exit（顺序保真）', detail.events.at(-1)?.type === 'exit', String(detail.events.at(-1)?.type))

const secretRuns = (
  await app.inject({ method: 'GET', url: '/api/runs?snippet=secret-demo', headers: auth })
).json() as RunItem[]
const secretRun = secretRuns[0]
check('按 snippet 过滤可用', secretRun?.snippetId === 'secret-demo', JSON.stringify(secretRuns.map((r) => r.snippetId)))
const rawRunFile = readFileSync(join(FIXTURE, 'runs', `${secretRun?.runId}.jsonl`), 'utf8')
check(
  'secret 的实际值没有落盘（命令回显 + 输出都抹掉）',
  !rawRunFile.includes('s3cr3t-value'),
  rawRunFile.slice(0, 240),
)
check('meta.vars 里 secret 打码', secretRun?.vars?.token === '***', JSON.stringify(secretRun?.vars))
check('varsRedacted 记下 token', secretRun?.varsRedacted?.includes('token') === true, JSON.stringify(secretRun?.varsRedacted))

const badRunId = await app.inject({ method: 'GET', url: '/api/runs/..%2Fhosts', headers: auth })
check('非法 runId → 404（不能读穿目录）', badRunId.statusCode === 404, String(badRunId.statusCode))

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

// 10. 片段 CRUD（P6）—— 放在最后，因为它真的会改 FIXTURE 里的文件
const rawGet = await app.inject({
  method: 'GET',
  url: '/api/snippets/raw-probe/raw',
  headers: auth,
})
const rawBody = rawGet.json() as { yaml?: string; mtimeMs?: number }
check(
  'GET raw → 读到原文且带注释',
  rawGet.statusCode === 200 && String(rawBody.yaml).includes('# 这一行注释必须活下来'),
  rawGet.body.slice(0, 120),
)

const RAW_FILE = join(FIXTURE, 'snippets', '状态', 'raw-probe.yaml')
const editedYaml = [
  '# 这一行注释必须活下来',
  '# 第二行注释：表单保存会把它抹掉，原文保存必须留住',
  'id: raw-probe',
  'title: 改过的标题',
  'group: 状态',
  'tags: [raw]',
  'steps:',
  '  - do: run',
  "    cmd: 'echo raw2'",
  '',
].join('\n')

const rawPut = await app.inject({
  method: 'PUT',
  url: '/api/snippets/raw-probe/raw',
  headers: auth,
  payload: { yaml: editedYaml, mtimeMs: rawBody.mtimeMs },
})
const rawPutBody = rawPut.json() as { mtimeMs?: number }
check('PUT raw → 200', rawPut.statusCode === 200, rawPut.body)
const onDisk = readFileSync(RAW_FILE, 'utf8')
check('原文保存后注释还在', onDisk.includes('# 第二行注释'), onDisk.slice(0, 160))
// 这条是本期最关键的断言：原文路径不能走 stringify
check('原文保存后逐字一致（没被重排）', onDisk.trim() === editedYaml.trim(), JSON.stringify(onDisk.slice(0, 200)))
check('原文保存后索引立刻更新', store.get('raw-probe')?.title === '改过的标题')

const badYaml = await app.inject({
  method: 'PUT',
  url: '/api/snippets/raw-probe/raw',
  headers: auth,
  payload: { yaml: 'id: [unclosed\nsteps: []\n' },
})
check(
  '坏 YAML → 400 且带行号',
  badYaml.statusCode === 400 && /第 \d+ 行/.test(badYaml.body),
  badYaml.body,
)
check('坏 YAML 没有被写盘', readFileSync(RAW_FILE, 'utf8').includes('# 第二行注释'))

const rawRenamed = await app.inject({
  method: 'PUT',
  url: '/api/snippets/raw-probe/raw',
  headers: auth,
  payload: {
    yaml: editedYaml.replace('id: raw-probe', 'id: raw-probe2'),
    mtimeMs: rawPutBody.mtimeMs,
  },
})
check(
  '原文里改 id → 文件搬家',
  rawRenamed.statusCode === 200 && (rawRenamed.json() as { renamed?: boolean }).renamed === true,
  rawRenamed.body,
)
check('搬家后旧文件消失', !existsSync(RAW_FILE))
await app.inject({ method: 'DELETE', url: '/api/snippets/raw-probe2', headers: auth })

const crudDetail = await app.inject({
  method: 'GET',
  url: '/api/snippets/check-instence/detail',
  headers: auth,
})
const detailBody = crudDetail.json() as {
  id?: string
  steps?: unknown
  mtimeMs?: number
  relPath?: string
  file?: unknown
}
check(
  'detail → 200 且带 steps / mtimeMs / relPath',
  crudDetail.statusCode === 200 &&
    Array.isArray(detailBody.steps) &&
    typeof detailBody.mtimeMs === 'number' &&
    typeof detailBody.relPath === 'string',
  crudDetail.body.slice(0, 200),
)
check('detail 不把服务端 file 绝对路径送出去', detailBody.file === undefined)

const NEW_FILE = join(FIXTURE, 'snippets', '状态', 'smoke-new.yaml')
const created = await app.inject({
  method: 'POST',
  url: '/api/snippets',
  headers: auth,
  payload: {
    id: 'smoke-new',
    title: '冒烟新建',
    group: '状态',
    target: 'win-desktop',
    shell: 'cmd',
    tags: 'smoke, crud',
    vars: { n: { prompt: '编号', default: 1 } },
    steps: [{ do: 'run', cmd: 'echo {{n}}' }],
  },
})
check('POST 新建 → 201', created.statusCode === 201, created.body)
check('新建后文件落盘', existsSync(NEW_FILE))
check('新建后索引里立刻就有（不等 watcher 去抖）', store.get('smoke-new') !== undefined)
const newYaml = existsSync(NEW_FILE) ? readFileSync(NEW_FILE, 'utf8') : ''
check('落盘内容不含 file 字段', !newYaml.includes('file:'), newYaml.slice(0, 120))
check('tags 字符串被拆成数组', newYaml.includes('- smoke') && newYaml.includes('- crud'), newYaml.slice(0, 200))

const dup = await app.inject({
  method: 'POST',
  url: '/api/snippets',
  headers: auth,
  payload: { id: 'smoke-new', steps: [{ do: 'run', cmd: 'echo x' }] },
})
check('POST 重复 id → 409', dup.statusCode === 409, dup.body)

const noSteps = await app.inject({
  method: 'POST',
  url: '/api/snippets',
  headers: auth,
  payload: { id: 'bad-one', steps: [] },
})
check('POST 空 steps → 400', noSteps.statusCode === 400, noSteps.body)

const badShell = await app.inject({
  method: 'POST',
  url: '/api/snippets',
  headers: auth,
  payload: { id: 'bad-shell', shell: 'bash', steps: [{ do: 'run', cmd: 'echo x' }] },
})
check('POST 非法 shell → 400', badShell.statusCode === 400, badShell.body)

const badStep = await app.inject({
  method: 'POST',
  url: '/api/snippets',
  headers: auth,
  payload: { id: 'bad-step', steps: [{ do: 'run' }] },
})
check('POST step 缺 cmd → 400 且指出第几步', badStep.statusCode === 400 && badStep.body.includes('steps[0]'), badStep.body)

const traversal = await app.inject({
  method: 'POST',
  url: '/api/snippets',
  headers: auth,
  payload: { id: '../../evil', group: '../..', steps: [{ do: 'run', cmd: 'echo x' }] },
})
const traversalRel = (traversal.json() as { relPath?: string }).relPath ?? ''
check(
  '穿越型 id 落点仍在 snippets 内',
  traversal.statusCode === 201 && !traversalRel.startsWith('..') && !existsSync(join(tmpdir(), 'evil.yaml')),
  `${traversal.statusCode} ${traversalRel}`,
)

const renamed = await app.inject({
  method: 'PUT',
  url: '/api/snippets/smoke-new',
  headers: auth,
  payload: { id: 'smoke-renamed', title: '改过名', group: '状态', steps: [{ do: 'run', cmd: 'echo hi' }] },
})
const renamedBody = renamed.json() as { renamed?: boolean; mtimeMs?: number }
check(
  'PUT 改名 → 200 且 renamed=true',
  renamed.statusCode === 200 && renamedBody.renamed === true,
  renamed.body,
)
check('改名后旧文件消失', !existsSync(NEW_FILE))
check('改名后新文件在', existsSync(join(FIXTURE, 'snippets', '状态', 'smoke-renamed.yaml')))
check(
  '改名后索引里没有旧 id 残留',
  store.get('smoke-new') === undefined && store.get('smoke-renamed') !== undefined,
)

const conflicted = await app.inject({
  method: 'PUT',
  url: '/api/snippets/smoke-renamed',
  headers: auth,
  payload: {
    id: 'smoke-renamed',
    mtimeMs: (renamedBody.mtimeMs ?? 0) - 5000,
    steps: [{ do: 'run', cmd: 'echo should-not-land' }],
  },
})
check('mtime 对不上 → 409（不静默覆盖别人的改动）', conflicted.statusCode === 409, conflicted.body)
const afterConflict = readFileSync(join(FIXTURE, 'snippets', '状态', 'smoke-renamed.yaml'), 'utf8')
check('409 之后文件内容没被改', !afterConflict.includes('should-not-land'), afterConflict.slice(0, 120))

// 同路径覆盖也要先留 .bak：手滑保存一次就没有退路了，代价只是一个文件
const updated = await app.inject({
  method: 'PUT',
  url: '/api/snippets/smoke-renamed',
  headers: auth,
  payload: {
    id: 'smoke-renamed',
    title: '再改一次',
    group: '状态',
    steps: [{ do: 'run', cmd: 'echo again' }],
    mtimeMs: renamedBody.mtimeMs,
  },
})
check('PUT 同路径覆盖 → 200', updated.statusCode === 200, updated.body)
check(
  '覆盖前留了 .bak',
  existsSync(join(FIXTURE, 'snippets', '状态', 'smoke-renamed.yaml.bak')),
)
check(
  '覆盖后内容真的变了',
  readFileSync(join(FIXTURE, 'snippets', '状态', 'smoke-renamed.yaml'), 'utf8').includes('echo again'),
)

const del = await app.inject({ method: 'DELETE', url: '/api/snippets/smoke-renamed', headers: auth })
check('DELETE → 200', del.statusCode === 200, del.body)
check('删除后文件消失', !existsSync(join(FIXTURE, 'snippets', '状态', 'smoke-renamed.yaml')))
const trashDir = join(FIXTURE, 'snippets', '.trash')
check(
  '删除留了回收站副本',
  existsSync(trashDir) && readdirSync(trashDir).some((f) => f.startsWith('smoke-renamed-')),
)
check(
  '删除时顺手清掉 .bak（否则每跑一轮回归就多一条看不见的垃圾）',
  !existsSync(join(FIXTURE, 'snippets', '状态', 'smoke-renamed.yaml.bak')),
)
check(
  '回收站副本不会被当成片段加载',
  store.list().every((s) => !s.file.includes('.trash')),
  JSON.stringify(store.list().map((s) => s.id)),
)
const delAgain = await app.inject({ method: 'DELETE', url: '/api/snippets/smoke-renamed', headers: auth })
check('DELETE 不存在 → 404', delAgain.statusCode === 404, String(delAgain.statusCode))

await app.close()
tryRemove(FIXTURE)
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
