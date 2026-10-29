#!/usr/bin/env node
/**
 * 无头 Chrome 截图 + 布局测量（验 UI 用，不依赖 Playwright）。
 *
 * 为什么需要它：`chrome --window-size=390,844` 的窗口最小宽度约 500px，
 * 直接截图会把 478px 的视口裁成 390 的图，看起来像「按钮被挤出屏幕」——
 * 实测踩过。这里用 CDP 的 Emulation.setDeviceMetricsOverride 做真仿真。
 *
 * 用法：
 *   npm run ui:shot -- http://127.0.0.1:7878/ 1920 1080 data/tmp/ui.png [卡片文字]
 *   给了第 5 个参数就点那张卡片（会真的执行该片段），等 2.8s 再量抽屉。
 * 环境变量：
 *   CHROME_PATH 指定浏览器路径（默认从常见位置自动找 Chrome/Edge）
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
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

const [url = 'http://127.0.0.1:7878/', w = '390', h = '844', out = 'data/tmp/ui.png', clickText] =
  process.argv.slice(2)
const width = Number(w)
const height = Number(h)
const port = 9411

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-shot-profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: width < 700,
})
await send('Page.navigate', { url })
await sleep(2600)

if (clickText) {
  const clicked = await evalJs(`(() => {
    const el = [...document.querySelectorAll('button.card')].find((b) => b.textContent.includes(${JSON.stringify(clickText)}))
    if (!el) return 'not-found'
    el.click()
    return 'clicked'
  })()`)
  console.log(`click(${clickText}): ${clicked}`)
  await sleep(2800)
}

const probe = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }
  }
  const grid = document.querySelector('.cards')
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0
  const titles = [...document.querySelectorAll('.card-title')]
  const truncated = titles.filter((el) => el.scrollWidth > el.clientWidth).length
  const body = document.querySelector('.drawer-body')
  const counts = {}
  for (const k of ['cmd', 'step', 'queue', 'out', 'err', 'meta']) {
    counts[k] = document.querySelectorAll('.line-' + k).length
  }
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    noHScroll: document.documentElement.scrollWidth === window.innerWidth,
    sidebar: (() => { const el = document.querySelector('.sidebar'); return el ? getComputedStyle(el).display : 'absent' })(),
    cards: document.querySelectorAll('.card').length,
    columns: cols,
    cardTitle: {
      whiteSpace: titles[0] ? getComputedStyle(titles[0]).whiteSpace : null,
      truncatedCount: truncated,
      maxScrollOverflow: titles.length ? Math.max(...titles.map((el) => el.scrollWidth - el.clientWidth)) : 0,
    },
    drawer: rect('.drawer'),
    drawerWhiteSpace: body ? getComputedStyle(body).whiteSpace : null,
    drawerScrollsX: body ? body.scrollWidth > body.clientWidth : null,
    lineCounts: counts,
  }
})()`
console.log(JSON.stringify(await evalJs(probe), null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`wrote ${out} (${width}x${height} @2x)`)

ws.close()
chrome.kill()
