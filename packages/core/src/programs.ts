/**
 * 程序发现（P7.3）：把「.lnk 从哪儿来、哪些不该出现在列表里」变成纯函数。
 *
 * 为什么不在 PowerShell 里过滤：那边一改就要在 Windows 上重跑才能验证，
 * 而且 CI 上没有开始菜单。这里只吃「扫描器交上来的原始行」，规则全部可单测。
 *
 * 三条设计原则：
 *  1. **用户 curated 的源（PROG_DIR / only / extraRoots）不套黑名单**——你自己往
 *     程序目录里放一个 cmd.exe 的快捷方式，轮不到我们替你做主。
 *  2. **过滤要能解释**：被挡掉的条目带 reason 返回，界面上能看到「为什么没有」。
 *  3. **不猜**：目标为空、指向目录、指向 msiexec 的，直接归到「不能当程序启动」。
 */
/** 取扩展名（带点、小写）。不用 node:path：core 的源码也会进前端打包链 */
function extOf(p: string): string {
  const base = p.replace(/\//g, '\\').split('\\').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot).toLowerCase()
}

/** 来源优先级：数字小的赢（同一 target+args 只留一条） */
export type ProgramSource =
  | 'only'
  | 'progDir'
  | 'extra'
  | 'userMenu'
  | 'userDesktop'
  | 'commonMenu'
  | 'commonDesktop'

export const SOURCE_RANK: Record<ProgramSource, number> = {
  only: 0,
  progDir: 1,
  extra: 2,
  userMenu: 3,
  userDesktop: 4,
  commonMenu: 5,
  commonDesktop: 6,
}

export const SOURCE_LABEL: Record<ProgramSource, string> = {
  only: '指定列表',
  progDir: 'PROG_DIR',
  extra: '额外目录',
  userMenu: '开始菜单',
  userDesktop: '桌面',
  commonMenu: '公共开始菜单',
  commonDesktop: '公共桌面',
}

/** 这些源是用户自己挑的：只挡「明显不能启动」，不套黑名单 */
const TRUSTED: ReadonlySet<ProgramSource> = new Set(['only', 'progDir', 'extra'])

export type ProgramFilterReason =
  | 'broken'
  | 'dir'
  | 'msi'
  | 'uwp'
  | 'uninstall'
  | 'installer'
  | 'help'
  | 'system'
  | 'duplicate'

export const REASON_LABEL: Record<ProgramFilterReason, string> = {
  broken: '快捷方式没有可解析的目标（UWP 或已损坏）',
  dir: '指向文件夹',
  msi: 'msiexec 安装/卸载入口',
  uwp: '应用商店（UWP）应用',
  uninstall: '卸载器',
  installer: '安装 / 更新程序',
  help: '帮助 / 说明 / 官网',
  system: '系统工具',
  duplicate: '和更高优先级来源重复',
}

/** `.lnk`（原本就是快捷方式）或 `.exe`（便携程序，服务端会生成 .lnk 包装） */
export type ProgramKind = 'lnk' | 'exe'

/** 扫描器交上来的一行。`target`/`args` 是从 .lnk 里解出来的；exe 行没有 target */
export type RawProgram = {
  path: string
  name: string
  dir: string
  source: ProgramSource
  target: string
  args: string
  /** 缺省 = 'lnk'；'exe' 表示这是便携程序，`path` 就是那个 .exe */
  kind?: ProgramKind
  /** 已经算好的启动值（.lnk 包装的路径）。没有就让服务端生成 */
  launch?: string
}

export type ProgramEntry = {
  /** .lnk 文件名（不含扩展名），给界面看 */
  name: string
  /** 写进 `{{pro}}` 的值：.lnk 的绝对路径——绝对路径不依赖 PROG_DIR 配得对不对 */
  value: string
  /** 原始文件：.lnk 就是它自己，便携 exe 是那个 .exe */
  path: string
  dir: string
  source: ProgramSource
  target: string
  args: string
  kind: ProgramKind
  /** 按 listener 的 SanitizePro 规则算出来的实例槽位名（`wechat`），只用于提示 */
  pro: string
}

export type FilteredProgram = {
  name: string
  path: string
  source: ProgramSource
  reason: ProgramFilterReason
}

/** listener.ahk 的 SanitizePro：小写、去 .exe、非 [A-Za-z0-9_] 与汉字一律换 `_` */
export function sanitizePro(name: string): string {
  const s = name
    .replace(/\.exe$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || 'app'
}

/** Windows 路径归一：统一反斜杠 + 小写，用于去重和 include 匹配 */
export function normalizeWinPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

const SYSTEM_EXES = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'regedit',
  'regedt32',
  'mmc',
  'control',
  'taskmgr',
  'msconfig',
  'services',
  'diskmgmt',
  'devmgmt',
  'eventvwr',
  'gpedit',
  'compmgmt',
  'perfmon',
  'resmon',
  'odbcad32',
  'schtasks',
  'wmic',
  'bitsadmin',
  'certutil',
  'msiexec',
  'takeown',
  'icacls',
  'explorer',
  'dcomcnfg',
  'rstrui',
  'cleanmgr',
  'dfrgui',
  'sdclt',
  'systempropertiesadvanced',
  'windows.old',
])

/** 系统目录里但确实是「用户会主动开」的几个，不挡 */
const SYSTEM_ALLOW = new Set(['notepad', 'calc', 'mspaint', 'snippingtool', 'osk', 'magnify'])

/** 文档类目标：双击能开，但它是「看」的不是「启动的程序」 */
const DOC_EXTS = new Set(['.chm', '.hlp', '.htm', '.html', '.pdf', '.txt', '.rtf', '.md', '.url'])
/** 便携目录里的安装器/更新器：名字一看就不是日常启动的东西 */
const INSTALLER_RE =
  /^(setup|install|installer|uninstall|unins\d*|update|updater|upgrade|updaterui|patch|repair|crashpad(_handler)?|crashreporter|crashreport|report|diagnostic|vc_?redist|dxsetup|dxwebsetup|dotnet|oalinst|helper)$/i
const UNINSTALL_RE =
  /(^|[\s_.-])(uninstall|uninst|unins\d*|remove|repair|modify)([\s_.-]|$)/i/** 中文没有词边界：`卸载格式工厂` 后面直接接名字，`(^|…)(卸载)(…|$)` 那种写法匹配不到 */
const UNINSTALL_CN_RE = /(^|[\s_.-])(卸载|修复|更改)(程序)?/
/** 中文前缀没有词边界，单独判：`帮助文档`、`官网` 后面接什么都算 */
const HELP_CN_RE = /^(帮助|说明|使用说明|用户手册|操作手册|官网|技术支持|常见问题)/
const HELP_RE =
  /^(read\s?me|help|manual|license|licence|eula|changelog|更新日志|release\s?notes|website|homepage|documentation|docs|support|faq)(\s|$|[._-])/i

function baseName(p: string): string {
  const parts = p.replace(/\//g, '\\').split('\\')
  return (parts[parts.length - 1] ?? '').toLowerCase()
}

function stripExe(name: string): string {
  return name.replace(/\.exe$/i, '')
}

/**
 * 返回过滤原因；`null` = 可以出现在列表里。
 *
 * 顺序有意义：`broken` > `dir` > `msi` > `uwp` > `installer` > 黑名单；
 * 同一个条目只报第一个原因。
 */
export function classifyProgram(p: RawProgram): ProgramFilterReason | null {
  const kind: ProgramKind = p.kind ?? 'lnk'
  // 便携 exe 没有 .lnk 可解：目标就是它自己
  const target = ((kind === 'exe' ? p.path : p.target) ?? '').trim()

  if (kind === 'exe') {
    if (!target) return 'broken'
    // 安装器/更新器：信任「这个目录」不等于「这个目录里每个 setup.exe 都要列」。
    // 例外是 only——那是点名要的具体文件，照列。
    if (p.source !== 'only' && INSTALLER_RE.test(stripExe(baseName(target)))) return 'installer'
    if (SYSTEM_ALLOW.has(stripExe(baseName(target)))) return null
    if (SYSTEM_EXES.has(stripExe(baseName(target)))) return 'system'
    return null
  }

  // 没有目标 = 解不出来（UWP 的 .lnk 就长这样）或快捷方式已经损坏：都启动不了
  if (!target) return 'broken'

  const exe = stripExe(baseName(target))
  if (exe === 'msiexec') return 'msi'
  if (/\\windowsapps\\/i.test(target)) return 'uwp'

  // 指向文件夹：目录没有扩展名。真程序几乎都带 .exe/.bat/.cmd/.com
  if (!extOf(target)) return 'dir'

  if (TRUSTED.has(p.source)) return null

  const name = p.name.trim()
  // 帮助文档类目标（.chm / .pdf / .txt…）：能打开，但不是「启动程序」
  if (DOC_EXTS.has(extOf(target))) return 'help'
  if (UNINSTALL_RE.test(name) || UNINSTALL_CN_RE.test(name)) return 'uninstall'
  if (HELP_CN_RE.test(name) || HELP_RE.test(name)) return 'help'

  if (SYSTEM_ALLOW.has(exe)) return null
  if (SYSTEM_EXES.has(exe)) return 'system'
  if (/\\windows\\(system32|syswow64|winsxs|servicing)\\/i.test(target)) return 'system'
  // C:\Windows\ 根下的工具（hh.exe / regedit.exe 之类）；但 Windows 根下没有正常软件
  if (/\\windows\\[^\\]+$/i.test(target)) return 'system'

  return null
}

export type ProgramsSelection = {
  programs: ProgramEntry[]
  filtered: FilteredProgram[]
  /** 扫描到的总行数（含被过滤的） */
  total: number
  /** 超出上限被截掉的条数 */
  truncated: number
}

/**
 * 分类 → 按来源排序 → 去重 → 截断。
 *
 * `include` 是「我知道它被挡了，但我就要它」：命中的条目跳过黑名单（`broken`/`dir`
 * 仍然挡——那两条是真的启动不了，不是判断问题）。
 */
export function selectPrograms(
  rows: RawProgram[],
  opts: { include?: string[]; max?: number } = {},
): ProgramsSelection {
  const max = opts.max ?? 500
  const include = new Set((opts.include ?? []).map(normalizeWinPath).filter(Boolean))
  const filtered: FilteredProgram[] = []
  const kept: RawProgram[] = []

  for (const row of rows) {
    if (!row.path || !/\.(lnk|exe)$/i.test(row.path)) continue
    let reason = classifyProgram(row)
    // include = 「我知道它被挡了，但我就要它」：黑名单原因全部让路。
    // duplicate 不在此列——那条不是对这个条目的判断，是「同一个程序已经有了」。
    if (reason && reason !== 'duplicate' && include.has(normalizeWinPath(row.path))) {
      reason = null
    }
    if (reason) {
      filtered.push({ name: row.name, path: row.path, source: row.source, reason })
      continue
    }
    kept.push(row)
  }

  kept.sort((a, b) => {
    const byRank = (SOURCE_RANK[a.source] ?? 99) - (SOURCE_RANK[b.source] ?? 99)
    if (byRank !== 0) return byRank
    return a.name.localeCompare(b.name, 'zh')
  })

  const seen = new Map<string, RawProgram>()
  const unique: RawProgram[] = []
  for (const row of kept) {
    // exe 行没有 target，用它自己的路径做去重键（同一个 exe 只会出现一次）
    const target = row.kind === 'exe' ? row.path : row.target
    const key = `${normalizeWinPath(target)}|${(row.args ?? '').trim().toLowerCase()}`
    const first = seen.get(key)
    if (first) {
      filtered.push({ name: row.name, path: row.path, source: row.source, reason: 'duplicate' })
      continue
    }
    seen.set(key, row)
    unique.push(row)
  }

  const truncated = Math.max(0, unique.length - max)
  const programs = unique.slice(0, max).map<ProgramEntry>((row) => ({
    name: row.name,
    // 便携 exe 的 value 是「生成的 .lnk 包装」——由服务端填，这里只兜底
    value: row.launch ?? row.path,
    path: row.path,
    dir: row.dir,
    source: row.source,
    target: row.target,
    args: row.args,
    kind: row.kind ?? 'lnk',
    pro: sanitizePro(row.name),
  }))

  return { programs, filtered, total: rows.length, truncated }
}

/* ——— programs.yaml（机器级配置，gitignore） ——— */

export type ProgramsConfig = {
  /** 绝对 .lnk / .exe 路径。非空 = 跳过自动发现，只显示这些；不套黑名单 */
  only: string[]
  /** 额外要扫的目录（递归 .lnk + 两层内的便携 .exe） */
  extraRoots: string[]
  /** 被黑名单挡掉、但你强制要显示的绝对路径 */
  include: string[]
}

export const EMPTY_PROGRAMS_CONFIG: ProgramsConfig = { only: [], extraRoots: [], include: [] }

function strList(value: unknown, label: string, problems: string[]): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    problems.push(`${label} 必须是字符串数组`)
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      problems.push(`${label} 里有非字符串项，已忽略`)
      continue
    }
    const v = item.trim()
    if (!v) continue
    const key = normalizeWinPath(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/** 把磁盘上的对象收成合法配置；结构问题一并返回，不静默吞掉 */
export function normalizeProgramsConfig(input: unknown): {
  config: ProgramsConfig
  problems: string[]
} {
  const problems: string[] = []
  const raw = (input ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { ...EMPTY_PROGRAMS_CONFIG }, problems: ['programs.yaml 顶层必须是对象'] }
  }
  return {
    config: {
      only: strList(raw.only, 'only', problems),
      extraRoots: strList(raw.extraRoots, 'extraRoots', problems),
      include: strList(raw.include, 'include', problems),
    },
    problems,
  }
}

export function programsConfigIsEmpty(c: ProgramsConfig): boolean {
  return c.only.length === 0 && c.extraRoots.length === 0 && c.include.length === 0
}
