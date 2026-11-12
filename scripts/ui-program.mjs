#!/usr/bin/env node
/**
 * 运行表单的程序下拉回归（P7.3c）。
 *
 * 走真实路径：打开 `open-program` → 表单里出现「程序」区 → 搜索过滤 → 选中 →
 * 预览命令里必须是 `lnk "<绝对路径>"`。**不执行**，不启动任何程序。
 *
 * 用法：
 *   npm run ui:program -- http://100.99.202.54:7878/ 1366 900 data/tmp/ui-program.png
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

const [url = 'http://127.0.0.1:7878/', w = '1366', h = '900', out = 'data/tmp/ui-program.png'] =
  process.argv.slice(2)
const width = Number(w)
const height = Number(h)
const port = 9417

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-program-profile')}`,
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

/** 轮询到表达式为真：程序列表第一次要真扫一遍（0.7s 起，机器忙时更久），固定 sleep 会飘 */
async function waitFor(expression, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(expression)) return true
    await sleep(300)
  }
  return false
}

/** React 接管过的 input：必须走原生 setter + input 事件，直接赋 value 不会触发 onChange */
const typeInto = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

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
  `(() => { const b = [...document.querySelectorAll('button.card')].find((x) => x.textContent.includes('启动程序')); if (!b) return false; b.click(); return true })()`,
)
check('点「启动程序」卡片', card === true)

// 扫描有 60s 缓存，但第一次要真扫一遍：等下拉出现，别用固定 sleep 赌
const ready = await waitFor(`!!document.querySelector('.instance-picker select')`)
check('程序列表已就绪', ready === true)

const info = await evalJs(`(() => {
  const picker = document.querySelector('.instance-picker')
  const select = picker ? picker.querySelector('select') : null
  const search = picker ? picker.querySelector('.picker-row input') : null
  const options = select ? [...select.options].map((o) => ({ value: o.value, text: o.textContent.trim() })) : []
  const lnk = options.filter((o) => /\\.lnk$/i.test(o.value))
  const filterBtn = picker ? [...picker.querySelectorAll('.picker-toggle')].find((b) => b.textContent.includes('已过滤')) : null
  return {
    hasPicker: !!picker,
    hasSelect: !!select,
    hasSearch: !!search,
    searchPlaceholder: search ? search.placeholder : '',
    optionCount: lnk.length,
    options: lnk.slice(0, 6),
    groups: select ? [...select.querySelectorAll('optgroup')].map((g) => g.label) : [],
    hasFilterToggle: !!filterBtn,
    filterText: filterBtn ? filterBtn.textContent.trim() : '',
    modalTitle: document.querySelector('.modal h3')?.textContent ?? '',
  }
})()`)
console.log(JSON.stringify(info, null, 2))

check('运行表单出现程序区', info.hasPicker === true)
check('有程序下拉', info.hasSelect === true)
check('有搜索框', info.hasSearch === true)
check('列表按来源分组', Array.isArray(info.groups) && info.groups.length >= 1, JSON.stringify(info.groups))
check('程序数量可观（>= 20）', info.optionCount >= 20, String(info.optionCount))
check('有「已过滤 N 项」入口', info.hasFilterToggle === true, info.filterText)

// 搜索：用选中项名字的前两个字，断言选项变少
const sample = info.options.find((o) => !o.text.includes('不在列表里'))
check('拿到第一个候选项', !!sample, JSON.stringify(info.options))
const needle = (sample?.text ?? '').replace(/（.*$/, '').slice(0, 2)
if (needle) {
  const ok = await evalJs(typeInto('.instance-picker .picker-row input', needle))
  check('搜索框写入成功', ok === true)
  await sleep(700)
}
const filtered = await evalJs(`(() => {
  const s = document.querySelector('.instance-picker select')
  return s ? [...s.options].filter((o) => /\\.lnk$/i.test(o.value)).length : -1
})()`)
check(
  `搜索「${needle}」后选项变少`,
  filtered > 0 && filtered < info.optionCount,
  `${filtered} vs ${info.optionCount}`,
)

// 清空搜索，确认回到全量
await evalJs(typeInto('.instance-picker .picker-row input', ''))
await sleep(700)
const restored = await evalJs(`(() => {
  const s = document.querySelector('.instance-picker select')
  return s ? [...s.options].filter((o) => /\\.lnk$/i.test(o.value)).length : -1
})()`)
check('清空搜索恢复全量', restored === info.optionCount, `${restored} vs ${info.optionCount}`)

// 选中第一个真候选（跳过「当前：…（不在列表里）」那条）
const target = await evalJs(`(() => {
  const s = document.querySelector('.instance-picker select')
  if (!s) return null
  const opt = [...s.options].find((o) => /\\.lnk$/i.test(o.value))
  if (!opt) return null
  s.value = opt.value
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return { value: opt.value, text: opt.textContent.trim() }
})()`)
check('选中一个程序', !!target, JSON.stringify(target))

await sleep(300)
await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '预览命令'); if (b) b.click() })()`)
await sleep(900)
const previewText = await evalJs(`document.querySelector('.preview')?.textContent ?? ''`)
check(
  '预览命令带引号包住的绝对路径',
  !!target && previewText.includes(`lnk "${target.value}"`),
  previewText.slice(0, 300),
)
check(
  '预览里是 .lnk 绝对路径',
  !!target && /^[A-Za-z]:\\.+\.lnk$/i.test(target.value),
  target?.value,
)

// 过滤项开关
await evalJs(`(() => { const b = [...document.querySelectorAll('.instance-picker .picker-toggle')].find((x) => x.textContent.includes('已过滤')); if (b) b.click() })()`)
await sleep(400)
const filteredInfo = await evalJs(`(() => {
  const box = document.querySelector('.program-filtered')
  return { visible: !!box, rows: box ? box.querySelectorAll('.program-filtered__row').length : 0, text: box ? box.textContent.slice(0, 160) : '' }
})()`)
check('「已过滤」能展开原因列表', filteredInfo.visible === true && filteredInfo.rows > 0, JSON.stringify(filteredInfo))

// 截图落在程序区
await evalJs(`document.querySelector('.instance-picker')?.scrollIntoView({ block: 'center' })`)
await sleep(300)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`wrote ${out} (${width}x${height} @2x)`)

// 不横向溢出（390 上最容易出）
const overflow = await evalJs(`(() => {
  const p = document.querySelector('.instance-picker')
  if (!p) return null
  return { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth, docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 }
})()`)
check(
  '程序区不横向溢出',
  overflow && overflow.scrollWidth <= overflow.clientWidth + 1 && overflow.docOverflow === false,
  JSON.stringify(overflow),
)

ws.close()
chrome.kill()
if (problems.length > 0) {
  console.log(`\n结果: ${problems.length} 项失败`)
  process.exit(1)
}
console.log('\n结果: 全部通过')
