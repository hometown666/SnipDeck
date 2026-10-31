/**
 * 桥的两条目录配置：`PROG_DIR`（找 .lnk）与 `AHK_DIR`（跑 .ahk）。
 *
 * 为什么存在服务端而不是桥里：`ahk_cmd.ps1` 每次调用都是新进程，读的是**它自己的环境变量**。
 * 服务起 `ahk.bat` 时把这两条注入子进程 env，桥那边一行都不用改，
 * 也不会因为「换了一份 listener」而失效。
 *
 * 落盘 `data/settings.json`（已 gitignore）：这是机器级配置，不该进版本库——
 * 同一个仓库在两台机器上跑，桌面路径本来就不一样。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

export type BridgeSettings = {
  /** 放 .lnk 的目录。空 = 不注入，由 ahk_cmd.ps1 回落到默认（桌面） */
  progDir: string
  /** 放 .ahk 的目录。空 = 不注入，script 子命令会明确报错 */
  ahkDir: string
  /** 运行档案保留天数（默认 30）；0 = 用默认 */
  runsTtlDays: number
  /** 运行档案保留份数（默认 500）；0 = 用默认 */
  runsMaxFiles: number
}

export const EMPTY_SETTINGS: BridgeSettings = { progDir: '', ahkDir: '', runsTtlDays: 0, runsMaxFiles: 0 }

/** 档案保留的默认值：与 RunLog 的缺省保持一致 */
export const RUNS_DEFAULTS = { ttlDays: 30, maxFiles: 500 }

export class SettingsError extends Error {
  problems: string[]
  constructor(problems: string[]) {
    super(problems.join('；'))
    this.name = 'SettingsError'
    this.problems = problems
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 读：文件不存在 / 坏 JSON 都当空配置，不阻塞启动（一份坏配置不该让服务起不来） */
export function loadSettings(file: string): BridgeSettings {
  if (!existsSync(file)) return { ...EMPTY_SETTINGS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      progDir: str(raw.progDir),
      ahkDir: str(raw.ahkDir),
      runsTtlDays: num(raw.runsTtlDays),
      runsMaxFiles: num(raw.runsMaxFiles),
    }
  } catch {
    return { ...EMPTY_SETTINGS }
  }
}

/**
 * 校验：只收绝对路径 + 必须真实存在的目录。
 *
 * 为什么非要在存的时候挡住：`ahk_cmd.ps1` 的 `Resolve-Dir` 会在目录不存在时**静默回落**到
 * 默认值。界面上写着「已设为 D:\工具」，实际跑的是桌面 —— 这种「设了但没生效」
 * 比报错难查得多。空字符串是合法值，表示「用默认」。
 */
export function validateSettings(next: BridgeSettings): string[] {
  const problems: string[] = []
  const check = (value: string, label: string) => {
    if (!value) return
    if (!isAbsolute(value)) {
      problems.push(`${label} 必须是绝对路径：${value}`)
      return
    }
    if (!existsSync(value)) {
      problems.push(`${label} 不存在：${value}`)
      return
    }
    try {
      if (!statSync(value).isDirectory()) problems.push(`${label} 不是目录：${value}`)
    } catch {
      problems.push(`${label} 读不到：${value}`)
    }
  }
  check(next.progDir, 'PROG_DIR')
  check(next.ahkDir, 'AHK_DIR')

  // 0 = 用默认。给个上下界，免得填 0 天把档案全删了或者填 999999 份等于没上限
  const int = (v: number, label: string, min: number, max: number) => {
    if (v === 0) return
    if (!Number.isInteger(v) || v < min || v > max)
      problems.push(`${label} 是 ${min}–${max} 的整数（0 = 用默认）：${String(v)}`)
  }
  int(next.runsTtlDays, '档案保留天数', 1, 3650)
  int(next.runsMaxFiles, '档案保留份数', 10, 100000)
  return problems
}

/** 写：原子（同目录 .tmp → rename），避免半份 JSON 被下一次 load 读到 */
export function saveSettings(file: string, input: BridgeSettings): BridgeSettings {
  const next: BridgeSettings = {
    progDir: str(input.progDir),
    ahkDir: str(input.ahkDir),
    runsTtlDays: Number.isFinite(input.runsTtlDays) ? input.runsTtlDays : 0,
    runsMaxFiles: Number.isFinite(input.runsMaxFiles) ? input.runsMaxFiles : 0,
  }
  const problems = validateSettings(next)
  if (problems.length > 0) throw new SettingsError(problems)

  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

/**
 * 注入给子进程的 env。**空值不注入**：让用户在系统里设的 PROG_DIR 继续生效，
 * 而不是被我们用一个空串覆盖掉。
 */
export function envOf(s: BridgeSettings): Record<string, string> {
  const env: Record<string, string> = {}
  if (s.progDir) env.PROG_DIR = s.progDir
  if (s.ahkDir) env.AHK_DIR = s.ahkDir
  return env
}

/** 目录里有多少个 .lnk —— 给设置页做「这个目录看起来对不对」的即时反馈。null = 读不到 */
export function countLnks(dir: string): number | null {
  if (!dir) return null
  try {
    // 只数一层：桌面是平的，递归到子目录既慢又会把「开始菜单」那种结构算成可用
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk')).length
  } catch {
    return null
  }
}
