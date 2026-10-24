#!/usr/bin/env node
/**
 * 无头 Chrome 截图 + 关键布局测量（验 UI 用，不依赖 Playwright）。
 *
 * 为什么需要它：`chrome --window-size=390,844` 的窗口最小宽度约 500px，
 * 直接截图会把 478px 的视口裁成 390 的图，看起来像「按钮被挤出屏幕」——
 * 实测踩过。这里用 CDP 的 Emulation.setDeviceMetricsOverride 做真移动端仿真。
 *
 * 用法：
 *   npm run ui:shot -- http://127.0.0.1:7878/ 390 844 data/tmp/ui.png
 * 环境变量：
 *   CHROME_PATH 指定浏览器路径（默认从常见位置自动找 Chrome/Edge）
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

const [url = 'http://127.0.0.1:7878/', w = '390', h = '844', out = 'data/tmp/ui.png'] = process.argv.slice(2)
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
    `--user-data-dir=${resolve(process.cwd(), 'data/tmp/ui-shot-profile')}`,
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

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url })
await sleep(2600)

const probe = `(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null
    const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) } }
  return {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    topbarRight: r('.topbar-right'),
    iconsRight: [...document.querySelectorAll('.topbar-right .icon-btn')].map((el) => Math.round(el.getBoundingClientRect().right)),
    card: r('.card'),
    cards: document.querySelectorAll('.card').length,
  }
})()`
const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log(JSON.stringify(res.result.result.value, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`wrote ${out} (${width}x${height} @2x)`)

ws.close()
chrome.kill()
