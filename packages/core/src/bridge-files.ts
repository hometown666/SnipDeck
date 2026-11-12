/**
 * 桥的两个只读文件：`instances.txt` / `status.txt`。
 *
 * 为什么不解析 `ahk.bat instances` 的输出：那要经过 `command.txt` 单车道，
 * 读一次表就和用户命令排一次队；而且 listener 不在线时它直接失败。
 * 文件就在桥目录里，读文件更简单，也不会和写通道抢锁。
 *
 * 编码不在这里处理：两个文件都是 UTF-16 LE + BOM，调用方先用 `decodeText()`
 * 解成字符串再进来。这里只做纯文本解析，方便单测。
 */
import type { InstanceRow, StatusFile } from './types'

/** 与 listener.ahk 的 `LoadInstances` 同一套：slot 不能带空白、`|`、路径符号 */
const SLOT_RE = /^[^|\\/:*?"<>\s]+#\d+$/

/** `wechat#12` → 12；不是槽位格式 → null */
export function slotNumber(slot: string): number | null {
  const m = /#(\d+)$/.exec(slot)
  const raw = m?.[1]
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

/** 稳定顺序：先按 pro，再按数字 n（`wechat#2` 在 `wechat#10` 前），最后按 slot */
export function sortInstances(rows: InstanceRow[]): InstanceRow[] {
  return [...rows].sort((a, b) => {
    const byPro = a.pro.localeCompare(b.pro, 'zh')
    if (byPro !== 0) return byPro
    const an = a.n ?? Number.MAX_SAFE_INTEGER
    const bn = b.n ?? Number.MAX_SAFE_INTEGER
    if (an !== bn) return an - bn
    return a.slot.localeCompare(b.slot)
  })
}

/**
 * `# slot|pid|hwnd|exe|pro|ts` 的表体。
 * 坏行一律跳过而不是抛错：这张表由 listener 边跑边写，读到半行/旧格式时
 * 不能让整个「实例」功能变成 500。
 */
export function parseInstancesText(text: string): InstanceRow[] {
  const rows = new Map<string, InstanceRow>()
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const parts = line.split('|')
    if (parts.length < 5) continue

    const slot = (parts[0] ?? '').trim()
    if (!SLOT_RE.test(slot)) continue

    const pid = Number((parts[1] ?? '').trim())
    const hwnd = Number((parts[2] ?? '').trim())
    if (!Number.isInteger(pid) || pid < 0) continue
    if (!Number.isInteger(hwnd) || hwnd < 0) continue

    const exe = (parts[3] ?? '').trim()
    const pro = (parts[4] ?? '').trim() || slot.replace(/#\d+$/, '')
    const ts = (parts[5] ?? '').trim()

    // 同一 slot 出现两次时后一条为准（listener 的 LoadInstances 也是覆盖语义）
    rows.set(slot, { slot, pid, hwnd, exe, pro, ts, n: slotNumber(slot) })
  }
  return sortInstances([...rows.values()])
}

/**
 * `status.txt`：`ts` / `listener` / `admin` / `last` / `foreground` / 固定探测项 / `instances=N`。
 *
 * `inst.<slot>=...` 是实例表的摘要副本，跳过——实例从 `instances.txt` 读，
 * 不从 status 里抠，否则两份数据不一致时不知道该信谁。
 */
export function parseStatusText(text: string): StatusFile {
  const out: StatusFile = {
    ts: '',
    listener: false,
    admin: false,
    last: '',
    foreground: '',
    instancesCount: null,
    watched: [],
  }
  const watched = new Map<string, boolean>()

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key || key.startsWith('inst.')) continue

    const lower = key.toLowerCase()
    if (lower === 'ts') out.ts = value
    else if (lower === 'listener') out.listener = value.toLowerCase() === 'ok'
    else if (lower === 'admin') out.admin = value === '1'
    else if (lower === 'last') out.last = value
    else if (lower === 'foreground') out.foreground = value
    else if (lower === 'instances') {
      const n = Number(value)
      out.instancesCount = Number.isInteger(n) ? n : null
    } else if (value === 'running' || value === 'stopped') {
      // listener 的 WatchExes 是写死的（仓库版与本机定制版还不一样），
      // 这里只按格式解析，不假定有哪几个名字。
      watched.set(key, value === 'running')
    }
  }

  out.watched = [...watched.entries()].map(([name, running]) => ({ name, running }))
  return out
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/

/**
 * status.txt 的 ts 是本地时间（`yyyy-MM-dd HH:mm:ss`，没有时区）。
 * 显式按本地时间构造，别交给 `new Date('2026-11-10 02:20:30')` 的实现相关解析。
 */
export function parseLocalTs(ts: string): number | null {
  const m = TS_RE.exec(ts.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null
  }
  const ms = new Date(year, month - 1, day, hour, minute, second).getTime()
  return Number.isFinite(ms) ? ms : null
}
