import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pty, { type IPty } from 'node-pty'

/**
 * 终端会话（P5.1）。
 *
 * 与驱动层的区别是本文件存在的全部理由：
 * - 驱动 = 一次性、整段返回、有退出码（`packages/drivers`）
 * - 会话 = 长驻、流式、双向、没有退出码（这里）
 *
 * 所以它不实现 `Driver` 接口，也不进 `RunRequest` / `RunEvent`。
 * 设计与验收见 docs/06-terminal.md §24。
 */

/** 回滚缓冲上限。按字节算，因为 ANSI 转义序列会跨行。 */
const RING_BYTES = 200 * 1024
/** 无订阅者后多久杀掉会话：给「刷新页面」留一口气，别一断就死。 */
const DEFAULT_GRACE_MS = 60 * 1000
/** 长时间没人碰（且无人附加）就回收。 */
const DEFAULT_IDLE_MS = 30 * 60 * 1000
/** 退出后多久从列表里消失，留给前端看 exit 事件。 */
const EXITED_KEEP_MS = 60 * 1000

export type SessionState = 'running' | 'exited'

export interface SessionSnapshot {
  id: string
  kind: 'local'
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  lastActiveAt: number
  state: SessionState
  exitCode?: number
  attached: number
}

export interface CreateSessionOptions {
  shell: string
  cwd?: string
  cols?: number
  rows?: number
}

export type SessionLogger = (level: 'info' | 'warn', msg: string) => void

export interface SessionListener {
  onData: (chunk: string) => void
  onExit: (code: number) => void
}

/** 允许的 shell 白名单：不给「随便传个 exe 路径」的口子。 */
const SHELLS: Record<string, { file: string; args: string[] }> = {
  powershell: { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] },
  cmd: { file: 'cmd.exe', args: [] },
  pwsh: { file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile'] },
}

export function isKnownShell(shell: string): boolean {
  return Object.hasOwn(SHELLS, shell)
}

export function knownShells(): string[] {
  return Object.keys(SHELLS)
}

/**
 * 传给子进程的环境变量。
 * **必须摘掉 `SNIP_TOKEN`**：终端里 `echo $env:SNIP_TOKEN` 能直接把服务凭据打出来，
 * 而这个凭据同时是别的设备进 /api 的钥匙。
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'SNIP_TOKEN') continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

/** 环形缓冲：超出上限就从最旧的整块丢掉，不切半个转义序列。 */
class Ring {
  private chunks: string[] = []
  private bytes = 0

  push(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.bytes += Buffer.byteLength(chunk)
    // 丢到只剩 80%，避免每来一小段就 shift 一次
    while (this.bytes > RING_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped === undefined) break
      this.bytes -= Buffer.byteLength(dropped)
    }
    // 单块就超上限（一次吐出几百 KB）：只留尾部
    const only = this.chunks[0]
    if (this.chunks.length === 1 && only !== undefined && this.bytes > RING_BYTES) {
      const buf = Buffer.from(only, 'utf8')
      const tail = buf.subarray(buf.length - RING_BYTES).toString('utf8')
      this.chunks = [tail]
      this.bytes = Buffer.byteLength(tail)
    }
  }

  text(): string {
    return this.chunks.join('')
  }

  get size(): number {
    return this.bytes
  }
}

export class Session {
  readonly id: string
  readonly kind = 'local' as const
  readonly shell: string
  readonly cwd: string
  readonly createdAt = Date.now()
  cols: number
  rows: number
  lastActiveAt = Date.now()
  state: SessionState = 'running'
  exitCode?: number

  private readonly proc: IPty
  private readonly ring = new Ring()
  private readonly listeners = new Set<SessionListener>()
  private graceTimer?: NodeJS.Timeout
  private exitedTimer?: NodeJS.Timeout

  constructor(
    id: string,
    opts: CreateSessionOptions,
    private readonly graceMs: number,
    private readonly log: SessionLogger = () => {},
  ) {
    const shell = SHELLS[opts.shell]
    if (!shell) throw new Error(`unknown shell: ${opts.shell}（可用：${knownShells().join(' / ')}）`)

    this.id = id
    this.shell = opts.shell
    this.cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : process.cwd()
    this.cols = clampInt(opts.cols, 20, 500, 80)
    this.rows = clampInt(opts.rows, 5, 300, 24)

    this.proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: childEnv(),
      // 计划任务会话里不能弹窗；node-pty 的 win32 后端默认就是 hidden
      useConpty: true,
    })

    this.proc.onData((d) => {
      this.ring.push(d)
      this.lastActiveAt = Date.now()
      for (const l of this.listeners) {
        try {
          l.onData(d)
        } catch {
          /* 单个订阅者出错不该影响其他订阅者 */
        }
      }
    })

    this.proc.onExit(({ exitCode }) => {
      this.state = 'exited'
      this.exitCode = exitCode
      this.clearGrace()
      this.log('info', `session exit id=${this.id} code=${exitCode}`)
      for (const l of this.listeners) {
        try {
          l.onExit(exitCode)
        } catch {
          /* 同上 */
        }
      }
    })

    // 创建后 60s 内没人连上就回收：避免「点了新建又关页面」留下孤儿
    this.log('info', `session create id=${id} shell=${this.shell} pid=${this.proc.pid} ${this.cols}x${this.rows}`)
    this.armGrace()
  }

  get pid(): number {
    return this.proc.pid
  }

  get attached(): number {
    return this.listeners.size
  }

  /** attach 时一次性灌进去的历史 */
  get replay(): string {
    return this.ring.text()
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      shell: this.shell,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      state: this.state,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      attached: this.listeners.size,
    }
  }

  attach(l: SessionListener): () => void {
    this.listeners.add(l)
    this.lastActiveAt = Date.now()
    this.clearGrace()
    this.log('info', `session attach id=${this.id} attached=${this.listeners.size}`)
    let done = false
    return () => {
      // close 和 error 都会调 detach，同一个订阅者只该结算一次，
      // 否则第一次 armGrace 之后第二次又会 clear+重设，宽限期被无限推后。
      if (done) return
      done = true
      this.listeners.delete(l)
      this.log('info', `session detach id=${this.id} attached=${this.listeners.size} state=${this.state}`)
      if (this.listeners.size === 0 && this.state === 'running') this.armGrace()
    }
  }

  write(data: string): void {
    if (this.state !== 'running') return
    this.lastActiveAt = Date.now()
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.state !== 'running') return
    const c = clampInt(cols, 20, 500, this.cols)
    const r = clampInt(rows, 5, 300, this.rows)
    if (c === this.cols && r === this.rows) return
    this.cols = c
    this.rows = r
    try {
      this.proc.resize(c, r)
    } catch {
      /* ConPTY 在进程刚退出时会抛，忽略即可 */
    }
  }

  /**
   * 杀进程树。
   * **不用 `proc.kill()`**：它内部会 fork `conpty_console_list_agent` 去 AttachConsole，
   * 服务把 stdout 重定向到日志文件时父进程没有控制台，必然抛
   * `Error: AttachConsole failed` 并脏日志（docs/06-terminal.md §25.4）。
   */
  kill(reason = 'manual'): void {
    if (this.state === 'exited') return
    this.clearGrace()
    const pid = this.proc.pid
    this.log('info', `session kill id=${this.id} pid=${pid} reason=${reason}`)
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => {
      /* 失败说明进程已自己退出，正常 */
    })
    // 兜底：taskkill 没报错但句柄迟迟不回收时，别让状态永远停在 running
    this.exitedTimer = setTimeout(() => {
      if (this.state === 'running') {
        this.state = 'exited'
        this.exitCode = -1
        this.log('warn', `session kill-timeout id=${this.id} pid=${pid} 3s 内没等到 exit，强制标 exited`)
        for (const l of this.listeners) {
          try {
            l.onExit(-1)
          } catch {
            /* ignore */
          }
        }
      }
    }, 3000)
    this.exitedTimer.unref()
  }

  private armGrace(): void {
    this.clearGrace()
    if (this.graceMs <= 0) return
    this.log('info', `session grace-arm id=${this.id} in=${this.graceMs}ms`)
    this.graceTimer = setTimeout(() => {
      const will = this.listeners.size === 0 && this.state === 'running'
      this.log(
        'info',
        `session grace-fire id=${this.id} listeners=${this.listeners.size} state=${this.state} kill=${will}`,
      )
      if (will) this.kill('grace')
    }, this.graceMs)
    this.graceTimer.unref()
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = undefined
    }
  }

  dispose(): void {
    this.clearGrace()
    if (this.exitedTimer) clearTimeout(this.exitedTimer)
    this.listeners.clear()
  }
}

type PidRecord = { id: string; pid: number; shell: string; createdAt: number }

export type SessionManagerOptions = {
  /** 放 `*.json`（pid 记录）的目录，一般是 data/tmp/sessions */
  pidDir: string
  graceMs?: number
  idleMs?: number
  cwd?: string
  /**
   * 会话生命周期日志。终端的一切原先在日志里都不可见——
   * 连上了没、断了没、谁回收的，全靠猜（2026-10-30 排查「宽限期不回收」时就吃了这个亏）。
   */
  log?: SessionLogger
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly pidDir: string
  private readonly graceMs: number
  private readonly idleMs: number
  private readonly cwd: string
  private readonly log: SessionLogger
  private idleTimer?: NodeJS.Timeout

  constructor(opts: SessionManagerOptions) {
    this.pidDir = opts.pidDir
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.cwd = opts.cwd ?? process.cwd()
    this.log = opts.log ?? (() => {})
  }

  create(opts: CreateSessionOptions): Session {
    const id = randomBytes(16).toString('hex')
    const s = new Session(id, { ...opts, cwd: opts.cwd ?? this.cwd }, this.graceMs, this.log)
    this.sessions.set(id, s)
    this.writePidRecord(s)
    this.ensureIdleTimer()
    return s
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((s) => s.state === 'running' || s.attached > 0)
      .map((s) => s.snapshot())
  }

  remove(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    this.log('info', `session remove id=${id} pid=${s.pid}`)
    s.kill('remove')
    s.dispose()
    this.sessions.delete(id)
    this.removePidRecord(id)
    return true
  }

  /** 服务退出时调用（正常路径）。强杀路径靠 reapOrphans。 */
  disposeAll(): void {
    for (const [id, s] of this.sessions) {
      s.kill()
      s.dispose()
      this.removePidRecord(id)
    }
    this.sessions.clear()
    if (this.idleTimer) clearTimeout(this.idleTimer)
  }

  /**
   * 启动时清理上一轮的残留。
   * 服务被强杀时 ConPTY 的子进程不一定跟着死，而它已经没有父进程可以回收它了。
   * 判据是「pid 还活着 且 映像名是我们起的那三种 shell」，避免 PID 被复用后误杀别人。
   */
  async reapOrphans(): Promise<number> {
    if (!existsSync(this.pidDir)) return 0
    let files: string[]
    try {
      files = readdirSync(this.pidDir).filter((f) => f.endsWith('.json'))
    } catch {
      return 0
    }
    let killed = 0
    for (const f of files) {
      const full = join(this.pidDir, f)
      let rec: PidRecord | undefined
      try {
        rec = JSON.parse(readFileSync(full, 'utf8')) as PidRecord
      } catch {
        safeUnlink(full)
        continue
      }
      if (!rec?.pid || !Number.isInteger(rec.pid)) {
        safeUnlink(full)
        continue
      }
      const image = await imageNameOf(rec.pid)
      if (image && /^(powershell|pwsh|cmd)\.exe$/i.test(image)) {
        await new Promise<void>((done) => {
          execFile('taskkill', ['/F', '/T', '/PID', String(rec!.pid)], { windowsHide: true }, () => done())
        })
        killed++
      }
      safeUnlink(full)
    }
    return killed
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer) return
    // 1 分钟一巡足够：空闲阈值是三十分钟的量级
    this.idleTimer = setInterval(() => {
      // 整块包住：这个回调抛任何东西都是 uncaughtException，服务会直接退出。
      // 一次回收失败最多留下一个孤儿会话，不该拿整个服务去赔。
      try {
        const now = Date.now()
        for (const [id, s] of this.sessions) {
          if (s.state === 'exited') {
            if (now - s.lastActiveAt > EXITED_KEEP_MS) {
              s.dispose()
              this.sessions.delete(id)
              this.removePidRecord(id)
            }
            continue
          }
          if (s.attached === 0 && now - s.lastActiveAt > this.idleMs) {
            this.log('info', `session idle-reap id=${id} 空闲 ${Math.round((now - s.lastActiveAt) / 60000)}min`)
            s.kill('idle')
            s.dispose()
            this.sessions.delete(id)
            this.removePidRecord(id)
          }
        }
        if (this.sessions.size === 0 && this.idleTimer) {
          clearInterval(this.idleTimer)
          this.idleTimer = undefined
        }
      } catch {
        /* 见上 */
      }
    }, 60_000)
    this.idleTimer.unref()
  }

  private writePidRecord(s: Session): void {
    try {
      mkdirSync(this.pidDir, { recursive: true })
      const rec: PidRecord = { id: s.id, pid: s.pid, shell: s.shell, createdAt: s.createdAt }
      writeFileSync(join(this.pidDir, `${s.id}.json`), JSON.stringify(rec), 'utf8')
    } catch {
      /* 落盘失败不影响会话本身，只是丢了崩溃后的回收能力 */
    }
  }

  /**
   * 删 pid 记录。**一定不能抛**：
   * 这个函数会被定时器调用，抛出来就是 uncaughtException，整个服务跟着死
   * （2026-10-30 实测：环境的删除守卫拦了一次 `rmSync`，服务直接退出）。
   * pid 记录删不掉最坏只是下次启动多扫一个文件，远比服务挂掉便宜。
   */
  private removePidRecord(id: string): void {
    safeUnlink(join(this.pidDir, `${id}.json`))
  }
}

/** 删文件但不抛。定时器里抛出来就是 uncaughtException，会直接杀死服务。 */
function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* 不在 / 被安全策略拦 / 权限不足：都不值得让服务停 */
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 查 pid 的映像名；查不到（进程已死）返回 undefined */
function imageNameOf(pid: number): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return done(undefined)
        // "powershell.exe","1234","Console","1","88,000 K"
        const m = /^"([^"]+)"/.exec(stdout.trim())
        done(m?.[1])
      },
    )
  })
}
