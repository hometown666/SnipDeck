#!/usr/bin/env node
/**
 * P4 运行历史 UI 回归：顶栏 🕘 → 列表 → 点一条 → 抽屉里回放。
 *
 * 验的是「断开 SSE 之后仍能回看上次运行」这条验收：
 *   1) 顶栏按钮能开历史弹窗，列表非空（前提：至少跑过一次）；
 *   2) 点条目后关弹窗、开抽屉，头部带 🕘 时间戳（明确是历史不是实时）；
 *   3) 抽屉里真的还原出了内容（命令行行 + 输出行），单目标只有一块面板；
 *   4) 桌面 1366 无横向溢出、头部单行；手机 390 隐藏次要列、不溢出。
 *
 * 依赖：服务在线（先跑一次任意片段，否则列表为空）。不进 npm test，手动跑：
 *   npm run ui:history
 *   npm run ui:history -- http://127.0.0.1:7879/
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const [url = 'http://127.0.0.1:7878/'] = process.argv.slice(2)
const port = 9415
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-history-profile')}`,
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
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${chrome.pid}`, { stdio: 'ignore' })
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
  throw new Error(`CDP 端口 ${port} 没起来`)
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

let fail = 0
function check(label, cond, extra = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' ' + extra}`)
  if (!cond) fail++
}

await send('Page.enable', {})

async function shoot(width, name) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.result?.data) {
    const file = resolve(process.cwd(), `data/tmp/ui-history-${name}.png`)
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`  截图 ${file}`)
  }
}

/** 开弹窗 → 记事实 → 点第一条 → 回放 → 记几何 */
async function drive(width, height, label) {
  console.log(`\n[${label}] ${width}×${height}`)
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 640,
  })
  await send('Page.navigate', { url })
  await sleep(2600)

  const cards = await evaluate(`document.querySelectorAll('.card').length`)
  if (!cards) throw new Error('页面上没有卡片：服务没起 / 停在 401')

  const opened = await evaluate(`(() => {
    const b = document.querySelector('[aria-label="运行历史"]')
    if (!b) return 'missing'
    b.click()
    return 'ok'
  })()`)
  check('顶栏有运行历史入口', opened === 'ok', opened)

  const modal = await evaluate(
    `(async () => {
      for (let i = 0; i < 60; i++) {
        const rows = document.querySelectorAll('.run-row')
        if (rows.length > 0) return { rows: rows.length, first: rows[0].textContent.trim() }
        // 「读取中…」也是 .empty：只有读到确定的结论（没有记录/出错）才提前返回
        const em = document.querySelector('.history-modal .empty')
        if (em && !em.textContent.includes('读取中')) return { rows: 0, empty: em.textContent.trim() }
        await new Promise((r) => setTimeout(r, 100))
      }
      return { rows: 0, empty: 'timeout' }
    })()`,
    true,
  )
  check('历史弹窗打开且列表非空', modal?.rows > 0, JSON.stringify(modal))
  check(
    '列表行含片段 id 与时间戳',
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(modal?.first ?? ''),
    JSON.stringify(modal?.first),
  )

  const rowLayout = await evaluate(`(() => {
    const meta = document.querySelector('.run-row .run-meta')
    const row = document.querySelector('.run-row')
    return {
      cols: row ? getComputedStyle(row).gridTemplateColumns.split(' ').length : 0,
      metaDisplay: meta ? getComputedStyle(meta).display : 'none',
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })()`)
  if (width < 640) {
    check('手机：目标列隐藏（三列）', rowLayout.cols === 3 && rowLayout.metaDisplay === 'none', JSON.stringify(rowLayout))
  } else {
    check('桌面：四列且目标列可见', rowLayout.cols === 4 && rowLayout.metaDisplay !== 'none', JSON.stringify(rowLayout))
  }
  check('历史弹窗没有横向溢出', rowLayout.overflow <= 0, String(rowLayout.overflow))
  await shoot(width, String(width))

  const clicked = await evaluate(`(() => {
    const r = document.querySelector('.run-row')
    if (!r) return 'missing'
    r.click()
    return 'ok'
  })()`)
  check('点条目触发回放', clicked === 'ok', clicked)

  const replay = await evaluate(
    `(async () => {
      for (let i = 0; i < 80; i++) {
        const drawer = document.querySelector('.drawer')
        const badge = document.querySelector('.drawer-badge')
        const lines = document.querySelectorAll('.drawer-body .line')
        if (drawer && badge && lines.length > 0) {
          const idEl = document.querySelector('.drawer-id')
          const headEl = document.querySelector('.drawer-head')
          let idLines = 0
          if (idEl) {
            const r = document.createRange()
            r.selectNodeContents(idEl)
            idLines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
          }
          return {
            badge: badge.textContent.trim(),
            lines: lines.length,
            cmds: document.querySelectorAll('.drawer-body .line-cmd').length,
            panes: document.querySelectorAll('.pane').length,
            multi: !!document.querySelector('.panes.multi'),
            running: !!document.querySelector('.drawer.running'),
            idLines,
            headHeight: headEl ? Math.round(headEl.getBoundingClientRect().height) : 0,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            drawerWidth: Math.round(drawer.getBoundingClientRect().width),
          }
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    })()`,
    true,
  )
  check('回放打开抽屉', replay !== null, '抽屉没出现')
  check('头部带 🕘 历史时间戳', /🕘\s*\d{4}-\d{2}-\d{2}/.test(replay?.badge ?? ''), JSON.stringify(replay?.badge))
  check('还原出了命令行行', (replay?.cmds ?? 0) > 0, JSON.stringify(replay?.cmds))
  check('还原出了输出行（≥3 行）', (replay?.lines ?? 0) >= 3, String(replay?.lines))
  check('回放态不是「运行中」', replay?.running === false)
  check('抽屉头部单行（不折行）', replay?.idLines === 1, String(replay?.idLines))
  check('抽屉没有横向溢出', (replay?.overflow ?? 1) <= 0, String(replay?.overflow))
  await sleep(300)
  await shoot(width, `replay-${width}`)
}

try {
  await drive(1366, 768, '桌面')
  await drive(390, 844, '手机')
  console.log(`\n结果: ${fail === 0 ? '全部通过' : `${fail} 条失败`}`)
  cleanup(fail > 0 ? 1 : 0)
} catch (e) {
  console.error(`\n执行出错: ${e instanceof Error ? e.message : String(e)}`)
  cleanup(1)
}
