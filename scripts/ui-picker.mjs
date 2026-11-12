#!/usr/bin/env node
/**
 * 运行表单的实例下拉回归（P7.2）。
 *
 * 走真实路径：打开 `close-program`（danger）→ 仍然执行 → 表单里出现实例下拉 →
 * 选一个槽位 → 预览命令里必须出现 `close <slot>`。**不执行**，不动真实窗口。
 *
 * 用法：
 *   npm run ui:picker -- http://100.99.202.54:7878/ 1366 900 data/tmp/ui-picker.png
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

const [url = 'http://127.0.0.1:7878/', w = '1366', h = '900', out = 'data/tmp/ui-picker.png'] =
  process.argv.slice(2)
const width = Number(w)
const height = Number(h)
const port = 9416

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-picker-profile')}`,
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
  // 量布局用 mobile:false（ISSUE-024）
  mobile: false,
  screenWidth: width,
  screenHeight: height,
})
await send('Page.navigate', { url })
await sleep(2600)

const card = await evalJs(
  `(() => { const b = [...document.querySelectorAll('button.card')].find((x) => x.textContent.includes('关闭实例')); if (!b) return false; b.click(); return true })()`,
)
check('点「关闭实例（软关）」卡片', card === true)

await sleep(400)
const danger = await evalJs(
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '仍然执行'); if (!b) return false; b.click(); return true })()`,
)
check('通过危险确认', danger === true)

await sleep(1200)
const info = await evalJs(`(() => {
  const picker = document.querySelector('.instance-picker')
  const select = picker ? picker.querySelector('select') : null
  const options = select ? [...select.options].map((o) => ({ value: o.value, text: o.textContent.trim() })) : []
  return {
    hasPicker: !!picker,
    hasSelect: !!select,
    hasManualInput: picker ? !!picker.querySelector('input') : null,
    options: options.filter((o) => o.value),
    modalTitle: document.querySelector('.modal h3')?.textContent ?? '',
    pickerText: picker ? picker.textContent.slice(0, 200) : '',
  }
})()`)
console.log(JSON.stringify(info, null, 2))

check('运行表单出现实例区', info.hasPicker === true)
check('有实例下拉', info.hasSelect === true)
check('列表里至少 2 个实例', info.options.length >= 2, String(info.options.length))
check('pro / n 没有重复成输入框', info.hasManualInput === false)

const target =
  info.options.find((o) => o.value === 'notepad#1') ??
  info.options.find((o) => !o.text.includes('不在表里')) ??
  info.options[0]
check('选中一个实例', target !== undefined, JSON.stringify(info.options))
const selected = await evalJs(
  `(() => { const s = document.querySelector('.instance-picker select'); if (!s) return null; s.value = ${JSON.stringify(target?.value ?? '')}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value })()`,
)
check('下拉值已写回', selected === target?.value, `${selected} vs ${target?.value}`)

await sleep(300)
await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '预览命令'); if (b) b.click() })()`)
await sleep(800)
const previewText = await evalJs(`document.querySelector('.preview')?.textContent ?? ''`)
check(
  `预览命令含 close ${target?.value ?? '?'}`,
  target ? previewText.includes(`close ${target.value}`) : false,
  previewText.slice(0, 240),
)

// 让截图落在实例区上（手机上表单会往下滚）
await evalJs(`document.querySelector('.instance-picker')?.scrollIntoView({ block: 'center' })`)
await sleep(300)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`wrote ${out} (${width}x${height} @2x)`)

// 第二段：kill-program 的 {{admin}} 前缀——实例 pick 只该吃 pro/n，admin 必须还是独立下拉
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
await sleep(400)
const killCard = await evalJs(
  `(() => { const b = [...document.querySelectorAll('button.card')].find((x) => x.textContent.includes('结束程序')); if (!b) return false; b.click(); return true })()`,
)
check('点「结束程序」卡片', killCard === true)
await sleep(400)
const killDanger = await evalJs(
  `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '仍然执行'); if (!b) return false; b.click(); return true })()`,
)
check('kill 通过危险确认', killDanger === true)
await sleep(1200)
const killInfo = await evalJs(`(() => {
  const picker = document.querySelector('.instance-picker')
  const adminField = [...document.querySelectorAll('.modal .field')].find((f) => f.textContent.includes('提权'))
  return {
    hasPicker: !!picker,
    adminSelect: adminField ? !!adminField.querySelector('select') : false,
    adminOptions: adminField ? [...adminField.querySelectorAll('option')].map((o) => o.value) : [],
  }
})()`)
check('kill 表单也有实例下拉', killInfo?.hasPicker === true)
check(
  'admin 变量仍是独立下拉（没被 pick 吞掉）',
  killInfo?.adminSelect === true && killInfo?.adminOptions.includes('admin'),
  JSON.stringify(killInfo),
)

ws.close()
chrome.kill()
if (problems.length > 0) {
  console.log(`\n结果: ${problems.length} 项失败`)
  process.exit(1)
}
console.log('\n结果: 全部通过')
