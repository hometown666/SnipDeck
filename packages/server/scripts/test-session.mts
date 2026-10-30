/**
 * 终端会话回归测试（P5.1）。
 *
 * 钉住四件事：
 * 1. PTY 真起得来、写进去有回显（不是 mock）
 * 2. resize 生效、未知 shell 被拒
 * 3. 删除会话后**进程真的没了**（taskkill /T 而不是只关句柄）
 * 4. WS 鉴权三条：正确 token 通、错误 token 401、服务端没配 token 时 403
 *
 * 第 4 条是 P5 唯一的安全命门（docs/06-terminal.md §25.2）：
 * WS 的 upgrade 不进 Fastify hook，这条测试要是漏了，鉴权写错也没人知道。
 *
 * 运行：npm run test:session（在 packages/server 下）
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { buildApp } from '../src/app'
import { SessionManager } from '../src/sessions'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const problems: string[] = []

function check(name: string, ok: boolean, extra?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    problems.push(name)
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer)
        done(true)
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer)
        done(false)
      }
    }, 40)
  })
}

function pidAlive(pid: number): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'snipdeck-session-'))
  mkdirSync(join(dir, 'snippets'), { recursive: true })
  // buildApp 一启动就 loadHosts，没有这个文件直接 ENOENT
  writeFileSync(
    join(dir, 'hosts.yaml'),
    ['win-desktop:', '  driver: exec', '  default: true', '  shell: cmd', '  bridge: C:\\ahk_trigger', ''].join('\n'),
    'utf8',
  )
  return dir
}

type Conn = {
  ws: WebSocket
  out: string[]
  /** ready 之前到达的 output 数：这才是「抢跑」，ready 之后来多少都正常 */
  outputBeforeReady: number
  closed: boolean
  ready: Promise<boolean>
}

function openWs(url: string): Conn {
  const ws = new WebSocket(url)
  const out: string[] = []
  const conn: Conn = { ws, out, outputBeforeReady: 0, closed: false, ready: Promise.resolve(false) }
  conn.ready = new Promise<boolean>((done) => {
    let sawReady = false
    const timer = setTimeout(() => done(false), 8000)
    ws.on('message', (raw) => {
      const text = String(raw)
      let msg: { t?: string; d?: string; replay?: string } | undefined
      try {
        msg = JSON.parse(text) as { t?: string }
      } catch {
        return
      }
      if (msg?.t === 'ready') {
        sawReady = true
        clearTimeout(timer)
        if (typeof msg.replay === 'string') out.push(msg.replay)
        done(true)
        return
      }
      if (msg?.t === 'output' && typeof msg.d === 'string') {
        if (!sawReady) conn.outputBeforeReady++
        out.push(msg.d)
      }
    })
    ws.on('close', () => {
      conn.closed = true
    })
    ws.on('error', () => {
      /* 握手失败走 unexpected-response 或 close */
    })
  })
  return conn
}

/** 拿握手被拒时的 HTTP 状态码（浏览器 WebSocket 拿不到，服务端的 ws 客户端可以） */
function handshakeStatus(url: string): Promise<number | string> {
  return new Promise((done) => {
    const ws = new WebSocket(url)
    let settled = false
    const finish = (v: number | string) => {
      if (settled) return
      settled = true
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      done(v)
    }
    ws.on('unexpected-response', (_req, res) => finish(res.statusCode ?? 0))
    ws.on('open', () => finish('open（本该被拒）'))
    ws.on('error', () => finish('error'))
    setTimeout(() => finish('timeout'), 6000)
  })
}

const dataDir = makeDataDir()
const built = buildApp({ dataDir, token: 'test-token-abc', logger: false, webDist: join(HERE, 'no-such-dist') })

try {
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = built.app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const base = `http://127.0.0.1:${port}`
  const wsBase = `ws://127.0.0.1:${port}`
  const auth = { Authorization: 'Bearer test-token-abc' }

  console.log('\n—— REST ——')
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: 'cmd', cols: 100, rows: 30 }),
  })
  const session = (await created.json()) as {
    id?: string
    cols?: number
    rows?: number
    state?: string
    shell?: string
  }
  check('POST /api/sessions → 201', created.status === 201, `status=${created.status}`)
  check('返回了 32 hex 的 id', typeof session.id === 'string' && /^[0-9a-f]{32}$/.test(session.id))
  check('cols/rows 按请求生效', session.cols === 100 && session.rows === 30, `${session.cols}x${session.rows}`)
  check('state=running', session.state === 'running')

  const id = session.id ?? ''

  const listed = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    enabled?: boolean
    shells?: string[]
    sessions?: { id: string }[]
  }
  check('GET /api/sessions 里有它', !!listed.sessions?.some((s) => s.id === id))
  check('shells 白名单给到前端', Array.isArray(listed.shells) && listed.shells.includes('powershell'))

  const badShell = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell: 'bash' }),
  })
  check('未知 shell → 400', badShell.status === 400, `status=${badShell.status}`)

  console.log('\n—— WS 收发 ——')
  const conn = openWs(`${wsBase}/ws/session/${id}?token=test-token-abc`)
  const ready = await conn.ready
  check('ready 帧到达', ready)
  check('ready 之前没有 output 抢跑', ready && conn.outputBeforeReady === 0, `outputBeforeReady=${conn.outputBeforeReady}`)

  conn.ws.send(JSON.stringify({ t: 'input', d: 'echo SESSION_PROBE\r\n' }))
  const echoed = await waitFor(() => conn.out.join('').includes('SESSION_PROBE'), 6000)
  check('写入后收到回显', echoed, JSON.stringify(conn.out.join('').slice(-120)))

  conn.ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }))
  conn.ws.send(JSON.stringify({ t: 'ping' }))
  await new Promise((r) => setTimeout(r, 300))
  const afterResize = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions?: { id: string; cols: number; rows: number; attached: number }[]
  }
  const mine = afterResize.sessions?.find((s) => s.id === id)
  check('resize 落到会话上', mine?.cols === 120 && mine?.rows === 40, `${mine?.cols}x${mine?.rows}`)
  check('attached 计到 1', mine?.attached === 1, `attached=${mine?.attached}`)

  console.log('\n—— 鉴权（WS 不走 loopback 豁免）——')
  const wrong = await handshakeStatus(`${wsBase}/ws/session/${id}?token=wrong-token`)
  check('错误 token 被拒 401', wrong === 401, `got=${wrong}`)
  const none = await handshakeStatus(`${wsBase}/ws/session/${id}`)
  check('不带 token 被拒 401', none === 401, `got=${none}`)

  console.log('\n—— 回收 ——')
  const pidFile = join(dataDir, 'tmp', 'sessions', `${id}.json`)
  const processPid = (JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number }).pid
  check('pid 记录落盘', typeof processPid === 'number' && processPid > 0, String(processPid))

  const del = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: auth })
  check('DELETE → 200', del.status === 200, `status=${del.status}`)
  const gone = await waitFor(() => !pidAlive(processPid), 6000)
  check('进程真的没了（taskkill /T）', gone, `pid=${processPid} 仍在`)
  conn.ws.close()

  const missing = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: auth })
  check('删不存在的会话 → 404', missing.status === 404, `status=${missing.status}`)

  console.log('\n—— 宽限期回收（创建了但没人连）——')
  const shortMgr = new SessionManager({
    pidDir: join(dataDir, 'tmp', 'sessions-grace'),
    graceMs: 800,
    idleMs: 60_000,
    cwd: dataDir,
  })
  const orphan = shortMgr.create({ shell: 'cmd' })
  const orphanPid = orphan.pid
  check('会话起得来', pidAlive(orphanPid), `pid=${orphanPid}`)
  const reaped = await waitFor(() => !pidAlive(orphanPid), 9000)
  check('没人连就自杀（60s 宽限的短版）', reaped, `pid=${orphanPid} 仍在`)
  shortMgr.disposeAll()

  console.log('\n—— 启动清残留（服务被强杀后的补救）——')
  // 造一个「上一轮留下的」shell 进程 + 它的 pid 记录，再让 reapOrphans 收拾
  const fake = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep 60'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  const fakePid = fake.pid ?? 0
  const reapDir = join(dataDir, 'tmp', 'sessions-reap')
  mkdirSync(reapDir, { recursive: true })
  const reapFile = join(reapDir, 'orphan.json')
  writeFileSync(
    reapFile,
    JSON.stringify({ id: 'orphan', pid: fakePid, shell: 'powershell', createdAt: Date.now() }),
    'utf8',
  )
  check('假孤儿进程起得来', fakePid > 0 && pidAlive(fakePid), `pid=${fakePid}`)

  const reapMgr = new SessionManager({ pidDir: reapDir, graceMs: 0, idleMs: 60_000 })
  const killedCount = await reapMgr.reapOrphans()
  check('reapOrphans 报了 1 个', killedCount === 1, `killed=${killedCount}`)
  const fakeGone = await waitFor(() => !pidAlive(fakePid), 6000)
  check('孤儿进程被 taskkill 掉', fakeGone, `pid=${fakePid} 仍在`)
  check('pid 记录被清掉', !existsSync(reapFile))

  console.log('\n—— 未配置 token 时终端整体关闭 ——')
  const closedApp = buildApp({
    dataDir,
    token: '',
    logger: false,
    webDist: join(HERE, 'no-such-dist'),
  })
  await closedApp.app.listen({ port: 0, host: '127.0.0.1' })
  const addr2 = closedApp.app.server.address()
  const port2 = typeof addr2 === 'object' && addr2 ? addr2.port : 0
  const noToken = await fetch(`http://127.0.0.1:${port2}/api/sessions`)
  const body = (await noToken.json()) as { message?: string }
  check('未配 token → GET /api/sessions 403', noToken.status === 403, `status=${noToken.status}`)
  check('403 带人话说明', typeof body.message === 'string' && body.message.includes('SNIP_TOKEN'))
  const noTokenWs = await handshakeStatus(`ws://127.0.0.1:${port2}/ws/session/whatever?token=x`)
  check('未配 token → WS 403', noTokenWs === 403, `got=${noTokenWs}`)
  await closedApp.app.close()
} finally {
  await built.app.close()
  rmSync(dataDir, { recursive: true, force: true })
}

console.log('')
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`)
  console.error(`\n结果: ${problems.length} 条失败`)
  process.exit(1)
}
console.log('✓ 终端会话全部通过')
// 必须显式退出：ws 客户端即使 close 过也会留一个 handle，
// 靠事件循环自然清空会让 `npm test` 挂在这里不动（实测卡了 11 分钟）。
process.exit(0)
