import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Session, SessionManager } from './sessions'

/**
 * 终端 WS 通道（P5.1）。
 *
 * **这里的鉴权不走 Fastify 的 `onRequest` hook**：WS 握手是 HTTP server 的
 * `upgrade` 事件，hook 完全不参与。而且这条通道**没有 loopback 豁免**——
 * 反代把请求从 127.0.0.1 转进来时，豁免等于把 remote shell 送给整个网段
 * （docs/06-terminal.md §25.2）。
 *
 * token 走 query 是唯一可行的选择：浏览器的 WebSocket 构造函数不能设自定义 header。
 * 代价是 token 可能进反代的访问日志，部署时要留意。
 */

const WS_PREFIX = '/ws/session/'

export type TerminalWsOptions = {
  app: FastifyInstance
  sessions: SessionManager
  /** 空字符串 = 终端未启用（没有凭据就没有可校验的东西） */
  token: string
}

type ClientMessage =
  | { t: 'input'; d: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'ping' }

export function attachTerminalWs(opts: TerminalWsOptions): WebSocketServer {
  const { app, sessions, token } = opts
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', (req: { url?: string }, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://placeholder.local')
    if (!url.pathname.startsWith(WS_PREFIX)) {
      // 没有别的 upgrade 消费者，直接断掉，别让连接悬着
      socket.destroy()
      return
    }

    if (!token) {
      reject(socket, 403, 'terminal disabled: SNIP_TOKEN is not set')
      return
    }
    if (!sameToken(url.searchParams.get('token') ?? '', token)) {
      reject(socket, 401, 'unauthorized')
      return
    }

    const id = decodeURIComponent(url.pathname.slice(WS_PREFIX.length))
    const session = sessions.get(id)
    if (!session) {
      reject(socket, 404, 'session not found')
      return
    }

    wss.handleUpgrade(req as never, socket as never, head, (ws) => {
      bind(ws, session)
    })
  })

  app.addHook('onClose', async () => {
    for (const client of wss.clients) client.terminate()
    wss.close()
  })

  return wss
}

function bind(ws: WebSocket, session: Session): void {
  // ready 必须**先于**任何 output 到达，否则前端会先用增量、再用 replay 覆盖，屏幕顺序就乱了。
  // 做法：先同步取快照 → attach（同一轮事件循环内，pty 的回调不会插进来）→ 发 ready
  // → 再把 attach 之后缓冲下来的增量补发。三行代码，但顺序错一步就是「输出跑到提示符上面」。
  const replay = session.replay
  let ready = false
  const pending: string[] = []

  const detach = session.attach({
    onData: (d) => {
      if (!ready) pending.push(d)
      else send(ws, { t: 'output', d })
    },
    onExit: (code) => {
      send(ws, { t: 'exit', code })
      ws.close()
    },
  })

  send(ws, {
    t: 'ready',
    id: session.id,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    replay,
  })
  ready = true
  for (const d of pending) send(ws, { t: 'output', d })
  pending.length = 0

  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'input':
        if (typeof msg.d === 'string' && msg.d.length <= 64 * 1024) session.write(msg.d)
        break
      case 'resize':
        session.resize(msg.cols, msg.rows)
        break
      case 'ping':
        send(ws, { t: 'pong' })
        break
      default:
        break
    }
  })

  ws.on('close', () => {
    detach()
  })
  // 不加这个监听，socket 错误会冒成 uncaughtException
  ws.on('error', () => {
    detach()
  })
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    /* 对端已断，close 事件会负责清理 */
  }
}

/** 定长比较，避免拿 token 长度做时序侧信道 */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function reject(socket: Duplex, code: number, message: string): void {
  const body = JSON.stringify({ error: message })
  const reason = code === 401 ? 'Unauthorized' : code === 404 ? 'Not Found' : 'Forbidden'
  socket.write(
    `HTTP/1.1 ${code} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  )
  socket.destroy()
}
