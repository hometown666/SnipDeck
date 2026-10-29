#!/usr/bin/env node
/**
 * 队列徽标可见性回归（ISSUE-003）。
 *
 * 问题：`排队 N` 徽标只在 `health.queue > 0` 的那一帧渲染，而桥被占用通常不到 1s；
 * 原来 4s 固定轮询对 0.8s 的短任务命中率约 20%，实测 45 次采样 0 命中。
 *
 * 现在两条路同时兜：
 *   1) 收到 `queued` 事件时立刻刷一次 health（有排队必中，主路径）；
 *   2) 运行期轮询 4s → 1s（兜底，比如别人从手机上跑的命令我们收不到事件）。
 *
 * 本脚本连点两次同一个走桥片段（第二次必然排队），然后在页面里以 100ms 间隔采样 45 次，
 * 断言 `.badge.queue` 至少出现一次、文本匹配 `排队 \d+`，且抽屉里有 `队列等待`。
 *
 * 依赖：服务在线 + AHK listener 在线 + 该片段真走桥。所以**不进 npm test**，手动跑：
 *   npm run ui:queue
 *   npm run ui:queue -- http://100.99.202.54:7878/ "查看实例表"
 *
 * 环境变量：CHROME_PATH 指定浏览器；QUEUE_SNIPPET 指定要点哪个片段（按卡片文本匹配）。
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { profileDir } from './lib/profile.mjs'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const chromePath = CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.error('找不到 Chrome/Edge，可设 CHROME_PATH 指定')
  process.exit(1)
}

const [url = 'http://127.0.0.1:7878/', snippetArg] = process.argv.slice(2)
const SNIPPET = snippetArg ?? process.env.QUEUE_SNIPPET ?? '刷新桌面状态'
const port = 9412

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-queue-profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

function cleanup(code) {
  try {
    chrome.kill()
  } catch {
    // ignore
  }
  // 无头 Chrome 的子进程有时不跟着退出
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${chrome.pid}`, { stdio: 'ignore' })
    }
  } catch {
    // 已经退了就算了
  }
  process.exit(code)
}

async function waitForCdp() {
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) return res.json()
    } catch {
      // 还没起来
    }
  }
  throw new Error(`CDP 端口 ${port} 没起来，检查 CHROME_PATH 或换端口`)
}

const targets = await waitForCdp()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text ?? 'evaluate 失败')
  return r.result?.result?.value
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url })
await sleep(2600)

const cards = await evaluate(`document.querySelectorAll('.card').length`)
if (!cards) {
  console.error('页面上没有卡片：服务没起、或片段库是空的、或还停在 401 提示')
  cleanup(1)
}

// 连点两次同一个片段：第一次占住桥，第二次必然排队。
// 必须挑一条**耗时够长**的（默认 `check-status` 约 0.8s）——`check-instence` 只要 30ms，
// 两下点完第一下早就结束了，根本排不上队，断言会假失败。
const kicked = await evaluate(
  `(() => {
    const target = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    if (!target) return 'missing'
    target.click()
    target.click()
    return 'ok'
  })()`,
)
if (kicked !== 'ok') {
  console.error(`找不到卡片：${SNIPPET}（用 QUEUE_SNIPPET 或第二个参数指定别的片段）`)
  cleanup(1)
}

// 在页面里采样：单次 evaluate 内跑完，避免 CDP 往返抖动
const seen = await evaluate(
  `(async () => {
    const hits = []
    for (let i = 0; i < 45; i++) {
      const el = document.querySelector('.badge.queue')
      if (el) hits.push({ at: i * 100, text: el.textContent.trim() })
      await new Promise((r) => setTimeout(r, 100))
    }
    return hits
  })()`,
  true,
)

const drawer = await evaluate(`document.querySelector('.drawer-body')?.textContent ?? ''`)
const badgeOk = seen.length > 0 && seen.every((h) => /排队\s*\d+/.test(h.text))
const queuedLineOk = drawer.includes('队列等待')

console.log(`采样命中 ${seen.length}/45 次`)
if (seen.length > 0) console.log(`  首次出现于 +${seen[0].at}ms：${seen[0].text}`)
console.log(`抽屉含「队列等待」：${queuedLineOk ? '是' : '否'}`)

let fail = 0
function check(label, cond, extra = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' ' + extra}`)
  if (!cond) fail++
}
check('顶栏出现过 `排队 N` 徽标', badgeOk, JSON.stringify(seen.slice(0, 3)))
check('抽屉里出现 `⏳ 队列等待`（防回退）', queuedLineOk, drawer.slice(-160))

ws.close()
console.log(fail === 0 ? '\n结果: 徽标可见性通过' : '\n结果: 失败')
cleanup(fail === 0 ? 0 : 1)
