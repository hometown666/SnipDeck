#!/usr/bin/env node
/**
 * 环境自检：**只读**，不改任何东西。跟 `flutter doctor` 一个意思。
 *
 * 为什么需要它：这个项目的执行端在仓库外面（AutoHotkey + C:\ahk_trigger 里的
 * listener），新机器上最常见的失败不是代码错，而是「缺一个不在仓库里的东西」。
 * 那些失败在读代码时看不出来，跑起来才报一句 bridge down。
 *
 * 每条失败都必须带一条「怎么办」——只报错不给出路的自检等于没做。
 *
 * 用法：npm run doctor
 * 退出码：有 ✗ 时 1（可以当部署前置检查用）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath 而不是 url.pathname：仓库路径含中文，pathname 是百分号编码的
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BRIDGE_DIR = 'C:\\ahk_trigger'
const BRIDGE_FILES = [
  ['listener.ahk', '收命令、执行、回传（要常驻，见 bridge/README.md）'],
  ['ahk.bat', 'CMD 侧客户端，SnipDeck 的 exec 驱动直接 call 它'],
  ['ahk_cmd.ps1', 'ahk.bat 的辅助，负责写 UTF-8 / 中文路径'],
]
const AHK_CANDIDATES = [
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey32.exe',
]

let pass = 0
const failures = []

// padEnd 按字符数算，中文占两个显示宽 —— 不折算的话中文标签那几行会整体右移
const dispWidth = (s) =>
  [...s].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0)
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - dispWidth(s)))

function ok(label, detail = '') {
  pass++
  console.log(`  ✓ ${pad(label, 18)}${detail}`)
}

function bad(label, detail, hint) {
  failures.push({ label, hint })
  console.log(`  ✗ ${pad(label, 18)}${detail}`)
  if (hint) console.log(`    ${' '.repeat(18)}→ ${hint}`)
}

function warn(label, detail, hint) {
  console.log(`  ~ ${pad(label, 18)}${detail}`)
  if (hint) console.log(`    ${' '.repeat(18)}→ ${hint}`)
}

/** 读 .env（不引依赖，格式就那几行） */
function readEnv() {
  const file = join(REPO_ROOT, '.env')
  const out = {}
  if (!existsSync(file)) return { out, exists: false }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return { out, exists: true }
}

function lineCount(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').length
  } catch {
    return 0
  }
}

async function getJson(url, token) {
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      // 走 globalThis：eslint 的 node globals 白名单里没有 AbortSignal
      signal: globalThis.AbortSignal.timeout(2500),
    })
    if (!res.ok) return { status: res.status }
    return { status: res.status, body: await res.json() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

console.log('\nSnipDeck 环境自检')
console.log('─'.repeat(62))

// 1. Node
const major = Number(process.versions.node.split('.')[0])
if (major >= 22) ok('Node', `v${process.versions.node}（要求 ≥22）`)
else bad('Node', `v${process.versions.node}`, '装 Node 22+：https://nodejs.org')

// 2. 仓库路径
if (REPO_ROOT.includes(' ')) ok('仓库路径', `${REPO_ROOT}（含空格，脚本里记得加引号）`)
else ok('仓库路径', REPO_ROOT)

// 3. AutoHotkey 运行时
const ahk = AHK_CANDIDATES.find((p) => existsSync(p))
if (ahk) ok('AutoHotkey v2', ahk)
else
  bad(
    'AutoHotkey v2',
    '未找到 v2\\AutoHotkey64.exe',
    'winget install AutoHotkey.AutoHotkey（装完重开终端）',
  )

// 4. 桥目录 + 三个文件
const repoBridge = join(REPO_ROOT, 'bridge')
if (existsSync(BRIDGE_DIR)) {
  ok('桥目录', BRIDGE_DIR)
  for (const [name, why] of BRIDGE_FILES) {
    const file = join(BRIDGE_DIR, name)
    if (!existsSync(file)) {
      bad(`  ${name}`, '缺失', `npm run install:bridge（${why}）`)
      continue
    }
    const lines = lineCount(file)
    // 行数是廉价的完整性检查：空文件/被截断的文件也能 existsSync 通过
    if (lines < 10) bad(`  ${name}`, `${lines} 行，像是空文件或被截断`, 'npm run install:bridge')
    else ok(`  ${name}`, `${lines} 行`)

    // 仓库版本 vs 已装版本。这个项目必然会出现「本机那份被改过」的情况
    // （加自己的命令、改监控列表），所以只提示不判错——但必须提示：
    // 两份长期不一致时，谁也不知道线上跑的到底是哪一版。
    const src = join(repoBridge, name)
    if (existsSync(src) && !readFileSync(src).equals(readFileSync(file))) {
      warn(
        '  版本',
        `${name} 与仓库 bridge/${name} 不一致（本机改过，或仓库更新了）`,
        '以仓库为准就 npm run install:bridge（会先 .bak）；只在本机改过就当没这条',
      )
    }
  }
} else {
  bad('桥目录', `${BRIDGE_DIR} 不存在`, 'npm run install:bridge')
}

// 5. launchers
const launcherDir = join(BRIDGE_DIR, 'launchers')
if (existsSync(launcherDir)) {
  const n = readdirSync(launcherDir).filter((f) => f.endsWith('.bat')).length
  if (n > 0) ok('launchers', `${n} 个 .bat`)
  else warn('launchers', '目录空的 —— 跑 hexo / txttunnel / backtrans 那几条前先 npm run sync:launchers')
} else {
  warn('launchers', '还没生成 —— 只有走 launcher 的片段才需要（npm run sync:launchers）')
}

// 6. .env 与 token 组合
const { out: env, exists: envExists } = readEnv()
const token = process.env.SNIP_TOKEN || env.SNIP_TOKEN || ''
const host = process.env.SNIPDECK_HOST || env.SNIPDECK_HOST || '127.0.0.1'
const port = process.env.SNIPDECK_PORT || env.SNIPDECK_PORT || '7878'
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host)

if (!envExists) warn('.env', '不存在 —— 只在本机用可以不管，要让手机访问必须配')
else ok('.env', '存在')

if (!loopback && !token) {
  bad(
    'token',
    `HOST=${host} 但 SNIP_TOKEN 为空`,
    '服务会拒绝启动：这就是「任意命令执行」，对外监听必须设 token',
  )
} else if (token) {
  // token 已设就一律校验（方案 D），本机也一样
  ok('token', `HOST=${host}，已设（本机访问也要带 Bearer）`)
} else {
  ok('token', `HOST=${host}，未设（只能绑 loopback）`)
}

// 7. 服务与桥
const base = `http://${loopback ? '127.0.0.1' : host}:${port}`
const health = await getJson(`${base}/api/health`, token)
if (health.error) {
  bad('服务', `${base} 连不上`, 'npm run dev:server（或用 start-server.ps1 常驻）')
} else if (health.status === 401) {
  bad('服务', '401 —— 服务在跑但 token 不对', '顶栏 ⚙ 填的 token 要和 .env 里的一致')
} else if (health.body) {
  ok('服务', `${base} 在跑，${health.body.snippets} 条片段`)
  if (health.body.quarantined > 0) {
    warn('  隔离区', `${health.body.quarantined} 条片段有错 —— npm run snip -- reindex 看原因`)
  }
  if (health.body.bridgeUp) ok('桥', `bridge up${health.body.queue ? `，队列 ${health.body.queue}` : ''}`)
  else
    bad(
      '桥',
      'bridge down —— listener 没在跑',
      '启动 listener.ahk（默认装在 C:\\ahk_trigger；你用计划任务/快捷方式起在哪份都行，见 bridge/README.md）',
    )
} else {
  bad('服务', `HTTP ${health.status}`, `检查 ${base}/api/health`)
}

console.log('─'.repeat(62))
if (failures.length === 0) {
  console.log(`全部通过（${pass} 项）\n`)
  process.exit(0)
}
console.log(`${pass} 项通过，${failures.length} 项待处理：`)
for (const f of failures) console.log(`  · ${f.label.trim()} —— ${f.hint}`)
console.log('')
process.exit(1)
