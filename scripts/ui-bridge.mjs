#!/usr/bin/env node
/**
 * 实例表 UI 回归（P7.1）。
 *
 * 验的是入口和只读弹窗，不依赖具体有几条实例：
 *  1) 桌面走顶栏 `bridge up · N` 徽标，窄屏走左栏「实例」；
 *  2) 弹窗打开后 `.bridge-card` 条数 === 徽标上的 N；
 *  3) 弹窗内不横向溢出，页面也不被撑宽（390 宽）；
 *  4) 截图落盘，供人眼复核。
 *
 * 用法：
 *   npm run ui:bridge -- http://100.99.202.54:7878/ 1366 900 data/tmp/ui-bridge.png
 *
 * 环境变量：CHROME_PATH 指定浏览器；SNIP_TOKEN 覆盖 .env 里的 token。
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { profileDir } from './lib/profile.mjs'
import { primeToken } from './lib/token.mjs'

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

const [url = 'http://127.0.0.1:7878/', w = '1366', h = '900', out = 'data/tmp/ui-bridge.png'] =
  process.argv.slice(2)
const width = Number(w)
const height = Number(h)
const port = 9415

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-bridge-profile')}`,
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

const problems = []
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    problems.push(name)
    console.log(`  ✗ ${name} ${extra}`)
  }
}

await send('Page.enable')
await primeToken(send, url)
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 2,
  // 量布局用 mobile:false，原因见 scripts/ui-editor.mjs 顶部（ISSUE-024）
  mobile: false,
  screenWidth: width,
  screenHeight: height,
})
await send('Page.navigate', { url })
await sleep(2600)

// 入口：桌面点徽标；窄屏徽标被 CSS 藏掉，走左栏抽屉
if (width >= 1024) {
  const clicked = await evalJs(
    `(() => { const b = document.querySelector('button.badge'); if (!b) return false; b.click(); return true })()`,
  )
  check('点顶栏 bridge 徽标', clicked === true)
} else {
  const opened = await evalJs(
    `(() => { const b = document.querySelector('.site-menu-btn'); if (!b) return false; b.click(); return true })()`,
  )
  check('窄屏打开左栏', opened === true)
  await sleep(400)
  const nav = await evalJs(
    `(() => { const b = [...document.querySelectorAll('.site-nav__item')].find((x) => x.textContent.includes('实例')); if (!b) return false; b.click(); return true })()`,
  )
  check('点左栏「实例」', nav === true)
}
await sleep(900)

const info = await evalJs(`(() => {
  const modal = document.querySelector('.bridge-modal')
  const scroll = modal ? modal.querySelector('.modal-scroll') : null
  const badge = document.querySelector('button.badge')
  const text = badge ? badge.textContent.trim() : ''
  const m = /(\\d+)\\s*$/.exec(text)
  return {
    hasModal: !!modal,
    title: modal ? (modal.querySelector('h3')?.textContent ?? '') : '',
    cards: modal ? modal.querySelectorAll('.bridge-card').length : -1,
    badgeText: text,
    badgeCount: m ? Number(m[1]) : null,
    modalOverflowX: scroll ? scroll.scrollWidth > scroll.clientWidth : null,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    emptyText: modal ? modal.textContent.includes('实例表为空') : false,
    stateText: modal ? (modal.querySelector('.badge')?.textContent.trim() ?? '') : '',
  }
})()`)
console.log(JSON.stringify(info, null, 2))

check('弹窗打开', info.hasModal === true)
check('标题是实例表', info.title === '实例表', info.title)
check('徽标带实例数', info.badgeCount !== null, info.badgeText)
check(
  '弹窗条数与徽标一致',
  info.badgeCount !== null && info.cards === info.badgeCount,
  `${info.cards} vs ${info.badgeCount}`,
)
check('弹窗内不横向溢出', info.modalOverflowX !== true, String(info.modalOverflowX))
check('页面没被撑宽', info.docOverflowX === false, String(info.docOverflowX))
if (info.badgeCount === 0) check('空表有文案', info.emptyText === true)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`wrote ${out} (${width}x${height} @2x)`)

ws.close()
chrome.kill()
if (problems.length > 0) {
  console.log(`\n结果: ${problems.length} 项失败`)
  process.exit(1)
}
console.log('\n结果: 全部通过')
