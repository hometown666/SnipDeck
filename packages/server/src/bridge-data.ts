/**
 * 读桥的只读文件（P7.1）。
 *
 * **只读，不写 `command.txt`。** 读实例表如果走 `ahk.bat instances`，就和用户命令、
 * 健康检查抢同一条单车道；listener 不在线时还会失败。文件就在桥目录里，
 * 直接读既快又没有队列副作用。
 *
 * 这套实现只适用于「服务与桥同机」的 exec 目标。`hosts.yaml` 里没有 bridge 的
 * exec 目标、或 driver 不是 exec 的预留目标，一律 400——不猜路径。
 */
import { existsSync, readFileSync, statSync as statFile } from 'node:fs'
import { resolve } from 'node:path'
import {
  decodeText,
  parseInstancesText,
  parseLocalTs,
  parseStatusText,
  resolveTarget,
  type HostTarget,
  type Hosts,
  type InstanceRow,
} from '@snipdeck/core'

export class BridgeDataError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeDataError'
  }
}

export type BridgeTarget = { name: string; bridge: string }

/** 把 `?target=` / 片段目标解析成可读的桥目录；不可读的原因说清楚，不猜。 */
export function resolveBridgeTarget(hosts: Hosts, name?: string): BridgeTarget {
  let picked: { name: string; target: HostTarget }
  try {
    picked = resolveTarget(hosts, name?.trim() || undefined)
  } catch (e) {
    // unknown target / no host target configured 都是请求参数问题，不是 500
    throw new BridgeDataError(400, e instanceof Error ? e.message : String(e))
  }

  const { target } = picked
  if (target.reserved) {
    throw new BridgeDataError(400, `目标 ${picked.name} 未激活（reserved）`)
  }
  if (target.driver !== 'exec') {
    throw new BridgeDataError(
      400,
      `目标 ${picked.name} 不是 exec 驱动（driver=${target.driver}），读不到桥文件`,
    )
  }
  const bridge = typeof target.bridge === 'string' ? target.bridge.trim() : ''
  if (!bridge) {
    throw new BridgeDataError(400, `目标 ${picked.name} 没有配置 bridge 目录`)
  }
  const dir = resolve(bridge)
  // 目录本身不在：这是配置问题，别退化成「instances.txt 不存在」让用户去猜
  if (!existsSync(dir)) {
    throw new BridgeDataError(400, `bridge 目录不存在：${dir}`)
  }
  try {
    if (!statFile(dir).isDirectory()) {
      throw new BridgeDataError(400, `bridge 不是目录：${dir}`)
    }
  } catch (e) {
    if (e instanceof BridgeDataError) throw e
    throw new BridgeDataError(400, `bridge 目录读不到：${dir}`)
  }
  return { name: picked.name, bridge: dir }
}

export type ListenerState = 'fresh' | 'stale' | 'offline'

export type InstanceView = InstanceRow & {
  /** true / false = 按 pid 探测；null = 状态不够新，没探测（不冒充活着） */
  alive: boolean | null
}

export type InstancesSnapshot = {
  instances: InstanceView[]
  status: {
    ts: string
    ageMs: number | null
    admin: boolean
    foreground: string
    /** listener 自己报告的条数；和文件读到的条数不一致时 UI 可以提示 */
    count: number | null
  }
  listener: { state: ListenerState }
  watched: { name: string; running: boolean }[]
  files: { instancesMtimeMs: number; statusMtimeMs: number }
  error?: string
}

type TextFile = { text: string | null; mtimeMs: number; error?: 'missing' | string }

/**
 * listener 用「.tmp → 原子替换」写文件，正常情况下读不到半份。
 * 但替换的瞬间 Windows 仍可能给一个 sharing violation；隔 50ms 重试一次，
 * 不值得为这个把整个接口变成 500。
 */
async function readTextFile(file: string): Promise<TextFile> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = statFile(file)
      return { text: decodeText(readFileSync(file)), mtimeMs: st.mtimeMs }
    } catch (e) {
      lastError = e
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { text: null, mtimeMs: 0, error: 'missing' }
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 50))
    }
  }
  return {
    text: null,
    mtimeMs: 0,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  }
}

/**
 * pid 存活探测只作辅助：
 * - 正常退出 → ESRCH；
 * - 提权进程（listener 跑 elevated 时很常见）→ EPERM，它其实活着；
 * - 其它错误 → 不知道，返回 null。
 *
 * 真正的删行交给 listener 的 GcInstances：pid 可能被复用，这里只敢说"看起来还活着"。
 */
export function pidAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return null
  }
}

/** status.txt 每 10s 重写；30s 内算新鲜，3 分钟内算可能正在跑长命令，再久算离线。 */
function listenerState(ageMs: number | null): ListenerState {
  if (ageMs == null) return 'offline'
  if (ageMs <= 30_000) return 'fresh'
  if (ageMs <= 180_000) return 'stale'
  return 'offline'
}

export async function readInstancesSnapshot(bridge: string): Promise<InstancesSnapshot> {
  const [instFile, statusFile] = await Promise.all([
    readTextFile(resolve(bridge, 'instances.txt')),
    readTextFile(resolve(bridge, 'status.txt')),
  ])

  const rows = instFile.text ? parseInstancesText(instFile.text) : []
  const status = statusFile.text ? parseStatusText(statusFile.text) : null

  const tsMs = status?.ts ? parseLocalTs(status.ts) : null
  const ageMs = tsMs == null ? null : Math.max(0, Date.now() - tsMs)
  const state = listenerState(ageMs)

  const instances: InstanceView[] = rows.map((row) => ({
    ...row,
    // 表本身可能已经过期；这种情况下不拿 pid 去冒充"活着"
    alive: state === 'fresh' ? pidAlive(row.pid) : null,
  }))

  const errors: string[] = []
  if (instFile.error === 'missing') errors.push('instances.txt 不存在')
  else if (instFile.error) errors.push(`instances.txt 读不到：${instFile.error}`)
  if (statusFile.error === 'missing') errors.push('status.txt 不存在')
  else if (statusFile.error) errors.push(`status.txt 读不到：${statusFile.error}`)

  return {
    instances,
    status: {
      ts: status?.ts ?? '',
      ageMs,
      admin: status?.admin ?? false,
      foreground: status?.foreground ?? '',
      count: status?.instancesCount ?? null,
    },
    listener: { state },
    watched: status?.watched ?? [],
    files: {
      instancesMtimeMs: instFile.mtimeMs,
      statusMtimeMs: statusFile.mtimeMs,
    },
    ...(errors.length > 0 ? { error: errors.join('；') } : {}),
  }
}
