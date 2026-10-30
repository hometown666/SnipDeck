#!/usr/bin/env node
/**
 * 片段编辑器 UI 回归（P6）：开 / 填 / 存 / 删，全程用一条**临时片段**。
 *
 * 为什么不用现成片段试：保存会重排整份 YAML。拿 `run-backtrans` 验一次，
 * 它就从「带注释的手写片段」变成「stringify 的输出」——验一次毁一条。
 * 所以脚本自己通过 API 建一条 `zz-ui-editor-*`，验完删掉。
 *
 * **量布局用 `mobile: false`**：`mobile: true` 时 Chrome 会把 layout viewport
 * 落在真实窗口宽（427），只有 `visualViewport` 是 390，等于在测 427 的布局
 * （ISSUE-024）。`mobile: false` 下 `innerWidth` 与传入宽度一致。
 * 代价是 `@media (hover: hover)` 会成立，所以这里的可见性断言不涉及悬停态。
 *
 * 用法：
 *   npm run ui:editor -- http://100.99.202.54:7878/ 1366 900 data/tmp/ui-editor.png
 * 环境变量：
 *   CHROME_PATH 指定浏览器；SNIP_TOKEN 覆盖 .env 里的 token
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
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

const [url = 'http://127.0.0.1:7878/', w = '1366', h = '900', out = 'data/tmp/ui-editor.png'] =
  process.argv.slice(2)
const width = Number(w)
const height = Number(h)
const port = 9414
const token = readToken()
const apiBase = new URL(url).origin
const probeId = `zz-ui-editor-${Date.now().toString(36)}`

const problems = []
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    problems.push(name)
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function apiCall(method, path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text }
}

const created = await apiCall('POST', '/api/snippets', {
  id: probeId,
  title: 'UI 编辑器自检',
  group: '状态',
  tags: ['selfcheck'],
  vars: { n: { prompt: '编号', default: 1, choices: [1, 2, 3] } },
  steps: [
    { do: 'run', cmd: 'echo probe {{n}}' },
    { do: 'sleep', ms: 300 },
  ],
})
if (created.status !== 201) {
  console.error(`建临时片段失败（${created.status}）：${created.body.slice(0, 200)}`)
  console.error('检查 url / SNIP_TOKEN 是否对得上')
  process.exit(1)
}
console.log(`临时片段 ${probeId}（分组 状态）\n`)

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir('ui-editor-profile')}`,
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
  // 鉴权：设了 token 就连本机也要 Bearer，不注入只会截到 401 横幅
  if (token) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('sniptoken', ${JSON.stringify(token)}) } catch (e) {}`,
    })
  }
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(2600)

  console.log(`[${width}×${height}]`)
  const opened = await evalJs(`(() => {
    const card = [...document.querySelectorAll('button.card')].find((b) => b.textContent.includes(${JSON.stringify(probeId)}))
    if (!card) return 'no-card'
    const edit = card.querySelector('.card-edit')
    if (!edit) return 'no-edit-icon'
    edit.click()
    return 'clicked'
  })()`)
  check('卡片上有 ✎ 且能打开编辑器', opened === 'clicked', opened)
  await sleep(1400)

  const geo = await evalJs(`(() => {
    const modal = document.querySelector('.modal.editor')
    if (!modal) return null
    const mb = modal.getBoundingClientRect()
    const inputs = [...modal.querySelectorAll('input, textarea, select')]
    const overflow = inputs.filter((el) => {
      const b = el.getBoundingClientRect()
      return b.right > mb.right + 1 || b.left < mb.left - 1
    }).length
    const actions = modal.querySelector('.modal-actions')
    const ab = actions ? actions.getBoundingClientRect() : null
    return {
      w: Math.round(mb.width),
      h: Math.round(mb.height),
      right: Math.round(mb.right),
      inputs: inputs.length,
      overflow,
      steps: modal.querySelectorAll('.editor-step').length,
      vars: modal.querySelectorAll('.editor-row').length,
      idValue: modal.querySelector('.editor-grid input')?.value ?? null,
      docNoHScroll: document.documentElement.scrollWidth === window.innerWidth,
      actionsVisible: ab ? ab.bottom <= mb.bottom + 1 && ab.top >= mb.top - 1 : false,
    }
  })()`)

  check('编辑器打开了且有内容', geo !== null && geo.inputs > 0, JSON.stringify(geo))
  if (geo) {
    check('id 字段确实读到了', geo.idValue === probeId, String(geo.idValue))
    check('宽度不超过视口', geo.w <= width, `${geo.w} > ${width}`)
    check('没有输入控件溢出弹窗', geo.overflow === 0, `${geo.overflow} 个`)
    check('变量行与步骤都渲染出来了', geo.vars >= 3 && geo.steps === 2, JSON.stringify(geo))
    check('页面没有横向溢出', geo.docNoHScroll === true)
    check('底部按钮在视野内（sticky）', geo.actionsVisible === true)
  }

  // 滚到顶再量一次：底部按钮不该被滚走
  await evalJs(`(() => { const m = document.querySelector('.modal.editor'); if (m) m.scrollTop = 0; return 'ok' })()`)
  await sleep(300)
  const stickyAtTop = await evalJs(`(() => {
    const m = document.querySelector('.modal.editor')
    const a = m?.querySelector('.modal-actions')
    if (!m || !a) return false
    const mb = m.getBoundingClientRect()
    const ab = a.getBoundingClientRect()
    return ab.bottom <= mb.bottom + 1 && ab.top >= mb.top - 1
  })()`)
  check('滚到顶时底部按钮仍可见', stickyAtTop === true)

  const shot1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(out, Buffer.from(shot1.result.data, 'base64'))

  // 改一个字段再保存：验的是「写回真的生效」，不是「按钮点了没报错」。
  // React 的受控 input 不能直接赋 value——得走原型上的原生 setter 再派发 input 事件。
  const newTitle = `UI 编辑器自检 ${Date.now().toString(36)}`
  const typed = await evalJs(`(() => {
    const inputs = [...document.querySelectorAll('.editor-grid input')]
    const title = inputs[1]
    if (!title) return 'no-title-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(title, ${JSON.stringify(newTitle)})
    title.dispatchEvent(new Event('input', { bubbles: true }))
    return title.value
  })()`)
  check('能把标题改掉（受控输入生效）', typed === newTitle, String(typed))

  const saved = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent.includes('保存'))
    if (!btn) return 'no-save'
    btn.click()
    return 'clicked'
  })()`)
  await sleep(1600)
  const afterSave = await evalJs(`(() => ({
    toast: document.querySelector('.toast')?.textContent ?? null,
    editorOpen: !!document.querySelector('.modal.editor'),
    error: document.querySelector('.editor .form-error')?.textContent ?? null,
  }))()`)
  check('保存成功且有回执', saved === 'clicked' && afterSave.toast === '已保存', JSON.stringify(afterSave))
  check('保存后编辑器关闭', afterSave.editorOpen === false)

  // 落盘验证：读回来的是不是刚才改的那个标题
  const readBack = await apiCall('GET', `/api/snippets/${encodeURIComponent(probeId)}/detail`)
  let readTitle = null
  try {
    readTitle = JSON.parse(readBack.body).title
  } catch {
    // 404 / 非 JSON 时留 null，下面的断言会报出来
  }
  check('保存的内容真的落盘了', readTitle === newTitle, `${readBack.status} ${String(readTitle)}`)

  // 删除要连点两次：第一次只换文案
  await evalJs(`(() => {
    const card = [...document.querySelectorAll('button.card')].find((b) => b.textContent.includes(${JSON.stringify(probeId)}))
    card?.querySelector('.card-edit')?.click()
    return 'ok'
  })()`)
  await sleep(1400)
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.modal-actions .btn')].find((x) => x.textContent.trim() === '删除')
    b?.click()
    return 'ok'
  })()`)
  await sleep(400)
  const confirmLabel = await evalJs(
    `[...document.querySelectorAll('.modal-actions .btn')].map((x) => x.textContent.trim()).join('|')`,
  )
  check('删除第一次点击只换文案', String(confirmLabel).includes('确认删除'), String(confirmLabel))
  const delShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(out.replace(/\.png$/, '-delconfirm.png'), Buffer.from(delShot.result.data, 'base64'))

  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.modal-actions .btn')].find((x) => x.textContent.includes('确认删除'))
    b?.click()
    return 'ok'
  })()`)
  await sleep(1600)
  const afterDelete = await evalJs(`(() => ({
    toast: document.querySelector('.toast')?.textContent ?? null,
    editorOpen: !!document.querySelector('.modal.editor'),
    cardStillThere: [...document.querySelectorAll('button.card')].some((b) => b.textContent.includes(${JSON.stringify(probeId)})),
  }))()`)
  check('第二次点击真删了', String(afterDelete.toast ?? '').includes('已删除'), JSON.stringify(afterDelete))
  check('删除后卡片消失', afterDelete.cardStillThere === false)

  console.log(`\n截图 ${out}（+ -delconfirm.png）`)
} finally {
  try {
    ws?.close()
  } catch {
    // 关不掉也无所谓，进程要退了
  }
  chrome.kill()
  // 收尾：不管前面成没成，临时片段都不该留在库里
  const leftover = await apiCall('DELETE', `/api/snippets/${encodeURIComponent(probeId)}`)
  if (leftover.status === 200) console.log('临时片段已清理')
  else if (leftover.status !== 404) console.warn(`临时片段清理失败（${leftover.status}）`)
}

console.log(`\n结果: ${problems.length === 0 ? '编辑器 UI 通过' : `${problems.length} 项失败`}`)
process.exit(problems.length === 0 ? 0 : 1)
