#!/usr/bin/env node
/**
 * P3 多目标 UI 回归：目标选择器 + 并列结果面板。
 *
 * 验的是「同目标多开」这条唯一在单机上也看得见效果的路径：
 *   点卡片右上角 ⊕ → 弹窗里连点两次 win-desktop → 执行 → 抽屉里两块并列面板。
 *
 * 断言：
 *   1) reserved 目标（home-win / vps）按钮是 disabled（P5 预留灰显）；
 *   2) chip 出现 win-desktop #1 / #2（同名加序号才分得清两块面板）；
 *   3) 抽屉出现 .panes.multi 且 .pane 数量 = 2、两块都完成；
 *   4) 桌面 1366 无横向溢出；手机 390 走堆叠（单列）。
 *
 * 依赖：服务在线（片段用完即走，不要求 listener 在线）。不进 npm test，手动跑：
 *   npm run ui:multi
 *   npm run ui:multi -- http://100.x:7878/ "刷新桌面状态"
 */
import { spawn, execSync } from 'node:child_process'
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

const [url = 'http://127.0.0.1:7878/', snippetArg] = process.argv.slice(2)
const SNIPPET = snippetArg ?? process.env.MULTI_SNIPPET ?? '查看实例表'
const TARGET = process.env.MULTI_TARGET ?? 'win-desktop'
const port = 9413

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(process.cwd(), 'data/tmp/ui-multi-profile')}`,
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

let fail = 0
function check(label, cond, extra = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' ' + extra}`)
  if (!cond) fail++
}

await send('Page.enable')

/** 走一遍完整流程，返回观察到的 DOM 事实；viewport 决定并列还是堆叠 */
async function drive(width, height, label) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: width < 640,
  })
  await send('Page.navigate', { url })
  await sleep(2600)

  const cards = await evaluate(`document.querySelectorAll('.card').length`)
  if (!cards) throw new Error('页面上没有卡片：服务没起 / 片段库空 / 停在 401')

  const opened = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    if (!card) return 'missing'
    const fan = card.querySelector('.card-fan')
    if (!fan) return 'no-fan'
    fan.click()
    return 'ok'
  })()`)
  if (opened !== 'ok') throw new Error(`找不到卡片或其 ⊕ 入口：${SNIPPET}（${opened}）`)
  await sleep(400)

  const hostButtons = await evaluate(
    `[...document.querySelectorAll('.target-btn')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`,
  )
  // ⊕ 入口会预选一个目标（片段的 target，或 hosts 的 default），再点一次就是「多开」
  const chipsInitial = await evaluate(
    `[...document.querySelectorAll('.chip')].map((c) => c.textContent.trim())`,
  )

  // 点一次同一目标：点击后 React 会重渲染，节点会被换掉，所以重新查一次再点
  const clickTarget = `(() => {
    const b = [...document.querySelectorAll('.target-btn')].find((x) => x.textContent.includes(${JSON.stringify(TARGET)}) && !x.disabled)
    if (!b) return 'missing'
    b.click()
    return 'ok'
  })()`
  const clicked = await evaluate(clickTarget)
  await sleep(200)

  const chips = await evaluate(`[...document.querySelectorAll('.chip')].map((c) => c.textContent.trim())`)

  const ran = await evaluate(`(() => {
    const b = document.querySelector('.modal .btn.primary')
    if (!b) return 'missing'
    b.click()
    return 'ok'
  })()`)

  const paneStatus = await evaluate(
    `(async () => {
      for (let i = 0; i < 120; i++) {
        const st = [...document.querySelectorAll('.pane-status')].map((e) => e.textContent.trim())
        if (st.length >= 2 && st.every((t) => !t.includes('运行中'))) return st
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    })()`,
    true,
  )

  const geom = await evaluate(`(() => {
    const drawer = document.querySelector('.drawer')
    const panes = document.querySelector('.panes')
    const cols = panes ? getComputedStyle(panes).gridTemplateColumns.split(' ').length : 0
    const idEl = document.querySelector('.drawer-id')
    const headEl = document.querySelector('.drawer-head')
    let idLines = 0
    if (idEl) {
      const r = document.createRange()
      r.selectNodeContents(idEl)
      // 注意：不能直接数 getClientRects().length —— 被 text-overflow:ellipsis 截断时
      // Chrome 会给出「可见段 + 被裁掉段」两个矩形，top 相同但仍是单行。
      // 判「是否折行」要看不同的 top 有几个。
      idLines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
    }
    return {
      multi: !!document.querySelector('.panes.multi'),
      panes: document.querySelectorAll('.pane').length,
      labels: [...document.querySelectorAll('.pane-target')].map((e) => e.textContent.trim()),
      cols,
      drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      count: document.querySelector('.drawer-count')?.textContent?.trim() ?? '',
      // ISSUE-005：头部换行
      idLines,
      idText: idEl?.textContent ?? '',
      headHeight: headEl ? Math.round(headEl.getBoundingClientRect().height) : 0,
      // ISSUE-006：并列时每块 pane 的横向可滚空间
      bodies: [...document.querySelectorAll('.drawer-body')].map((b) => ({
        client: Math.round(b.clientWidth),
        scroll: Math.round(b.scrollWidth),
      })),
    }
  })()`)

  // 留一张图给验收记录看（不进 git，data/tmp 不进仓库）
  if (process.env.MULTI_SHOT !== '0') {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot?.result?.data) {
      const file = resolve(process.cwd(), `data/tmp/ui-multi-${width}.png`)
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      console.log(`  截图 ${file}`)
    }
  }

  check(`[${label}] reserved 目标灰显（home-win / vps disabled）`,
    hostButtons.filter((b) => /home-win|vps/.test(b.text) && b.disabled).length === 2,
    JSON.stringify(hostButtons))
  check(`[${label}] ⊕ 入口预选片段目标（1 个 chip）`,
    chipsInitial.length === 1 && chipsInitial[0]?.includes(TARGET), JSON.stringify(chipsInitial))
  check(`[${label}] 再点一次同一目标 → 两个 chip 带序号`,
    clicked === 'ok' && chips.length === 2 &&
      chips[0]?.includes('#1') && chips[1]?.includes('#2'),
    `${clicked} ${JSON.stringify(chips)}`)
  check(`[${label}] 执行按钮可点`, ran === 'ok', String(ran))
  check(`[${label}] 两块面板都跑完`, Array.isArray(paneStatus) && paneStatus.length === 2,
    JSON.stringify(paneStatus))
  check(`[${label}] 抽屉是并列态（.panes.multi，2 块）`, geom.multi && geom.panes === 2, JSON.stringify(geom))
  check(`[${label}] 面板标题为 ${TARGET} #1 / #2`,
    geom.labels.length === 2 && geom.labels[0].endsWith('#1') && geom.labels[1].endsWith('#2'),
    JSON.stringify(geom.labels))
  check(`[${label}] 页面无横向溢出`, geom.overflow <= 0, `overflow=${geom.overflow}px`)
  check(`[${label}] 抽屉头部标了目标数`, geom.count.includes('2'), geom.count)
  // ISSUE-005：390 双目标下 id 不能被 flex 压成两行
  check(`[${label}] 头部 id 单行（未折行）`, geom.idLines === 1, `idLines=${geom.idLines} "${geom.idText}"`)
  // 桌面头部是定高 48；手机上图标按钮 34 + 上下 padding 10*2 ≈ 55，这才是单行的正常高度
  // （修之前两行时是 63）。阈值按档给，别用一个数字套两档。
  check(
    `[${label}] 头部高度 ≤ ${width >= 1024 ? 50 : 56}px`,
    geom.headHeight > 0 && geom.headHeight <= (width >= 1024 ? 50 : 56),
    `h=${geom.headHeight}`,
  )
  if (width >= 1024) {
    check(`[${label}] 桌面并列成 2 列`, geom.cols === 2, `cols=${geom.cols}`)
    // ISSUE-006：两列时每块 pane 的行尾不能被切（长行本来就该整行可见）
    const cut = geom.bodies.filter((b) => b.scroll > b.client + 1)
    check(
      `[${label}] 每块 pane 无横向滚动`,
      geom.bodies.length === 2 && cut.length === 0,
      JSON.stringify(geom.bodies),
    )
  } else {
    check(`[${label}] 手机堆叠成 1 列`, geom.cols === 1, `cols=${geom.cols}`)
  }
  return geom
}

const desk = await drive(1366, 768, '1366')
console.log(`  桌面抽屉宽 ${desk.drawerWidth}px`)
const wide = await drive(1920, 1080, '1920')
console.log(`  1920 抽屉宽 ${wide.drawerWidth}px`)
await drive(390, 844, '390')

/** 打开某个片段的 ⊕（目标选择器），返回是否成功 */
async function openFan(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(2400)
  return evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    const fan = card?.querySelector('.card-fan')
    if (!fan) return 'missing'
    fan.click()
    return 'ok'
  })()`)
}

// ---------------- ISSUE-007：8 个目标的上限要当场拦 ----------------
{
  const opened = await openFan(1366, 768)
  await sleep(400)
  const res = await evaluate(
    `(async () => {
      const usable = () => [...document.querySelectorAll('.target-btn')].filter((b) => !b.title.includes('P5'))
      let guard = 0
      while (guard++ < 20) {
        const b = usable().find((x) => !x.disabled)
        if (!b) break
        b.click()
        await new Promise((r) => setTimeout(r, 60))
      }
      const btns = usable()
      return {
        chips: document.querySelectorAll('.chip').length,
        allDisabled: btns.length > 0 && btns.every((b) => b.disabled),
        note: document.querySelector('.field-note')?.textContent?.trim() ?? '',
      }
    })()`,
    true,
  )
  check('[007] 连点到底 chips 恰好 8 个', opened === 'ok' && res.chips === 8, `${opened} chips=${res.chips}`)
  check('[007] 满额后目标按钮全部 disabled', res.allDisabled === true, JSON.stringify(res))
  check('[007] 满额后出现「最多 8 个目标」提示', /最多 8 个目标/.test(res.note), res.note)

  // 前端 400 的呈现：把 /api/run 拦成 400，走一遍真实提交流程
  // （UI 已经拦住第 9 个目标，所以真实 400 从界面不可达——这恰好就是要修的效果）
  const errUi = await evaluate(
    `(async () => {
      const orig = window.fetch
      window.fetch = (u, init) =>
        String(u).startsWith('/api/run')
          ? Promise.resolve(new Response(JSON.stringify({ error: 'targets 最多 8 个' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }))
          : orig(u, init)
      // 收掉多出来的目标，只留一个，再提交
      for (let i = 0; i < 20; i++) {
        const x = document.querySelector('.chip .chip-x')
        const chips = document.querySelectorAll('.chip').length
        if (chips <= 1) break
        x?.click()
        await new Promise((r) => setTimeout(r, 40))
      }
      document.querySelector('.modal .btn.primary')?.click()
      await new Promise((r) => setTimeout(r, 600))
      const out = {
        drawer: !!document.querySelector('.drawer'),
        modal: !!document.querySelector('.modal'),
        err: document.querySelector('.form-error')?.textContent?.trim() ?? '',
      }
      window.fetch = orig
      return out
    })()`,
    true,
  )
  check('[007] 400 不开抽屉', errUi.drawer === false && errUi.modal === true, JSON.stringify(errUi))
  check(
    '[007] 错误是人话（无 {"error" / ApiError 前缀）',
    errUi.err === 'targets 最多 8 个',
    JSON.stringify(errUi.err),
  )
}

// ---------------- ISSUE-008：隐形的 ⊕ 不许吃点击，键盘要能开 ----------------
{
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(2400)

  const fan = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    // 目标卡片可能在首屏之外（片段库变大后就会）：不滚进视口，
    // 后面 dispatchMouseEvent 的坐标落在视口外，:hover 永远不成立 → 假失败（ISSUE-016）
    card.scrollIntoView({ block: 'center' })
    const f = card.querySelector('.card-fan')
    const r = f.getBoundingClientRect()
    const s = getComputedStyle(f)
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), opacity: s.opacity, pe: s.pointerEvents }
  })()`)
  check('[008] 未悬停时 ⊕ 不可见且不吃点击', fan.opacity === '0' && fan.pe === 'none', JSON.stringify(fan))

  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await click(fan.x, fan.y)
  await sleep(500)
  const afterBlind = await evaluate(`!!document.querySelector('.target-btn')`)
  check('[008] 未悬停点右上角 → 不弹目标选择器', afterBlind === false, String(afterBlind))

  // 收掉这次执行开出来的抽屉，再悬停后重试
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)

  const center = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    card.scrollIntoView({ block: 'center' })
    const r = card.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y })
  await sleep(200)
  const hovered = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    const s = getComputedStyle(card.querySelector('.card-fan'))
    return { opacity: s.opacity, pe: s.pointerEvents }
  })()`)
  check('[008] 悬停后 ⊕ 显形且可点', Number(hovered.opacity) >= 0.7 && hovered.pe === 'auto', JSON.stringify(hovered))
  await click(fan.x, fan.y)
  await sleep(500)
  const afterHover = await evaluate(`!!document.querySelector('.target-btn')`)
  check('[008] 悬停后点同一坐标 → 目标选择器出现', afterHover === true, String(afterHover))

  // 键盘入口：Esc 关掉，选中卡片后按 T
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', text: 't', windowsVirtualKeyCode: 84 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 })
  await sleep(500)
  const byKey = await evaluate(`!!document.querySelector('.target-btn')`)
  check('[008] 按 T 打开目标选择器（键盘可达）', byKey === true, String(byKey))

  // 触屏设备：⊕ 必须常显（hover 媒体查询不生效）
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await send('Page.navigate', { url })
  await sleep(2400)
  const touch = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(${JSON.stringify(SNIPPET)}))
    const s = getComputedStyle(card.querySelector('.card-fan'))
    return { hoverHover: matchMedia('(hover: hover)').matches, opacity: Number(s.opacity), pe: s.pointerEvents }
  })()`)
  check(
    '[008] 触屏下 ⊕ 常显（opacity ≥ .5）',
    touch.hoverHover === false && touch.opacity >= 0.5 && touch.pe !== 'none',
    JSON.stringify(touch),
  )
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
}

ws.close()
console.log(fail === 0 ? '\n结果: 多目标 UI 通过' : `\n结果: ${fail} 项失败`)
cleanup(fail === 0 ? 0 : 1)
