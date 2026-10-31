#!/usr/bin/env node
/**
 * 设置页「桥的目录」UI 回归：改 → 存 → 重载后还在 → 清空。
 *
 * 为什么值得单跑一条：这两个输入框的价值全在「改了真的生效」。
 * 只测 API 证明不了 React 把值送对了；只测 UI 证明不了落盘。
 * 所以这里两边都摸：UI 填 → API 读回 → 再刷新页面看它还在不在。
 *
 * 用法：
 *   npm run ui:settings -- http://100.99.202.54:7878/ 1366 900 data/tmp/ui-settings.png
 * 环境变量：CHROME_PATH、SNIP_TOKEN
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { profileDir } from './lib/profile.mjs'
import { readToken } from './lib/token.mjs'

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

const [url = 'http://127.0.0.1:7878/', w = '1366', h = '900', out = 'data/tmp/ui-settings.png'] =
  process.argv.slice(2)
const width = Number(w)
const height = Number(h)
const port = 9416
const token = readToken()
const apiBase = new URL(url).origin

// 探针目录必须真实存在（服务端会拒收不存在的路径）
const probeDir = resolve(fileURLToPath(new URL('../data/tmp/env-probe', import.meta.url)))
mkdirSync(probeDir, { recursive: true })

const problems = []
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    problems.push(name)
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function apiCall(method, path) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return { status: res.status, body: await res.text() }
}

// 从干净状态开始，跑完也回到干净状态
await apiCall('DELETE', '/api/settings')

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-settings-profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp() {
  for (let i = 0; i < 25; i++) {
    await sleep(400)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) return res.json()
    } catch {
      // 还没起来
    }
  }
  throw new Error(`CDP 端口 ${port} 没起来`)
}

let ws
let send
let evalJs
try {
  const targets = await waitForCdp()
  const page = targets.find((t) => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
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
  send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  evalJs = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      ?.result?.value

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    // 量布局一律 mobile:false（ISSUE-024：mobile:true 会把 layout viewport 顶到真实窗口宽）
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  })
  if (token) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('sniptoken', ${JSON.stringify(token)}) } catch (e) {}`,
    })
  }

  const openSettings = `(() => {
    const btn = [...document.querySelectorAll('button.icon-btn')].find((b) => b.getAttribute('aria-label') === '设置')
    if (!btn) return 'no-btn'
    btn.click()
    return 'clicked'
  })()`

  // React 的受控 input：直接改 value 不触发 onChange，得走原生 setter + input 事件
  const typeInto = (index, value) => `(() => {
    const inputs = [...document.querySelectorAll('.env-section input')]
    const el = inputs[${index}]
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`

  await send('Page.navigate', { url })
  await sleep(2600)

  check('顶栏有设置按钮', (await evalJs(openSettings)) === 'clicked')
  await sleep(400)

  const section = await evalJs(`(() => ({
    hasSection: !!document.querySelector('.env-section'),
    labels: [...document.querySelectorAll('.env-section .field span')].map((n) => n.textContent.trim()),
    inputs: [...document.querySelectorAll('.env-section input')].map((i) => i.placeholder),
  }))()`)
  check('设置里有「桥的目录」', section?.hasSection === true, JSON.stringify(section))
  check(
    '两条目录的标签对得上',
    section?.labels?.some((l) => l.includes('Program directory')) &&
      section?.labels?.some((l) => l.includes('AHK directory')),
    JSON.stringify(section?.labels),
  )
  check(
    '空值给出默认提示',
    section?.inputs?.[0]?.includes('桌面') && section?.inputs?.[1]?.includes('未配置'),
    JSON.stringify(section?.inputs),
  )

  // 1) 填一个不存在的路径：必须被服务端挡住，且错误原样显示
  await evalJs(typeInto(0, 'Z:\\definitely-not-here'))
  await evalJs(`[...document.querySelectorAll('.env-actions .btn')].find((b) => b.textContent.includes('保存'))?.click()`)
  await sleep(900)
  const err = await evalJs(`document.querySelector('.env-section .form-error')?.textContent ?? ''`)
  check('不存在的目录被拒且说明原因', err.includes('不存在'), err)

  // 2) 填合法目录：保存后立刻显示「生效」路径
  await evalJs(typeInto(0, probeDir))
  await evalJs(typeInto(1, probeDir))
  await evalJs(`[...document.querySelectorAll('.env-actions .btn')].find((b) => b.textContent.includes('保存'))?.click()`)
  await sleep(1000)
  const afterSave = await evalJs(`(() => ({
    ok: document.querySelector('.env-section .ok-note')?.textContent ?? '',
    notes: [...document.querySelectorAll('.env-section .field-note')].map((n) => n.textContent.trim()),
    err: document.querySelector('.env-section .form-error')?.textContent ?? '',
  }))()`)
  check('保存有回执', afterSave?.ok.includes('已保存'), JSON.stringify(afterSave))
  check(
    '生效行显示新路径',
    afterSave?.notes?.some((n) => n.includes(probeDir) && n.includes('生效')),
    JSON.stringify(afterSave?.notes),
  )
  check('没有残留错误', afterSave?.err === '', afterSave?.err)

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))

  // 3) 服务端真的落盘了
  const readBack = JSON.parse((await apiCall('GET', '/api/settings')).body)
  check('API 读回同一个值', readBack.progDir === probeDir && readBack.ahkDir === probeDir, JSON.stringify(readBack))
  check(
    '注入值就是它（下一条命令用这个）',
    readBack.injected?.PROG_DIR === probeDir && readBack.injected?.AHK_DIR === probeDir,
    JSON.stringify(readBack.injected),
  )

  // 4) 刷新后还在（证明不是只有前端 state）
  await send('Page.navigate', { url })
  await sleep(2400)
  await evalJs(openSettings)
  await sleep(500)
  const persisted = await evalJs(
    `[...document.querySelectorAll('.env-section input')].map((i) => i.value).join('|')`,
  )
  check('重载后输入框仍是保存的值', persisted === `${probeDir}|${probeDir}`, persisted)

  // 5) 清空 = 回默认
  await evalJs(`[...document.querySelectorAll('.env-actions .btn')].find((b) => b.textContent.includes('清空'))?.click()`)
  await sleep(900)
  const cleared = await evalJs(`(() => ({
    values: [...document.querySelectorAll('.env-section input')].map((i) => i.value),
    notes: [...document.querySelectorAll('.env-section .field-note')].map((n) => n.textContent.trim()),
  }))()`)
  check('清空后输入框为空', cleared?.values?.every((v) => v === ''), JSON.stringify(cleared?.values))
  check(
    '清空后生效行回到默认说明',
    cleared?.notes?.[0]?.includes('桌面'),
    JSON.stringify(cleared?.notes),
  )
  const afterClear = JSON.parse((await apiCall('GET', '/api/settings')).body)
  check('清空也落盘了', afterClear.progDir === '' && afterClear.ahkDir === '', JSON.stringify(afterClear))

  console.log('')
  if (problems.length > 0) {
    console.error(`✗ ${problems.length} 项未通过：${problems.join(' / ')}`)
    process.exitCode = 1
  } else {
    console.log(`设置页 ${out} 全部通过`)
  }
} finally {
  try {
    ws?.close()
  } catch {
    // ignore
  }
  chrome.kill()
  // 收尾：不留配置，免得后面跑别的回归时带着探针路径
  await apiCall('DELETE', '/api/settings')
}
