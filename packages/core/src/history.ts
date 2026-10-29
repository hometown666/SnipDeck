import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'

/**
 * 从 shell 历史批量生成片段（P4）。
 *
 * 设计上的三个克制：
 * 1. **默认不写盘**：只打印计划。真实片段库是手写的 16 条，一次导入几十条会把它淹掉，
 *    所以「写」必须显式 `--write`。
 * 2. **不覆盖**：目标文件已存在就跳过（要覆盖请先自己删），避免第二次导入把改过的片段冲掉。
 * 3. **危险命令一律标 `danger`**：历史里天然混着 `Remove-Item -Recurse`、`shutdown`。
 *    标了 danger，Web 执行前会多一道确认框。
 */

/** PSReadLine 的默认历史文件（Win 10/11 PowerShell 5.1 与 7 共用这个名字） */
export function psReadlineHistoryPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')
}

/** Git Bash / WSL 的 bash 历史（只做参考：命令语义与 cmd/powershell 不兼容） */
export function bashHistoryPath(): string {
  return join(homedir(), '.bash_history')
}

export type HistorySource = { kind: 'psreadline'; path: string } | { kind: 'file'; path: string }

export function parseHistorySource(from: string | undefined): HistorySource {
  const f = (from ?? 'ps').trim()
  if (f === '' || f === 'ps' || f === 'psreadline') {
    return { kind: 'psreadline', path: psReadlineHistoryPath() }
  }
  if (f.startsWith('file:')) return { kind: 'file', path: f.slice('file:'.length) }
  if (f === 'bash') return { kind: 'file', path: bashHistoryPath() }
  throw new Error(`--from 只能是 ps / bash / file:<路径>，收到 ${JSON.stringify(from)}`)
}

/** 没有片段价值、导进来只会占地方的命令 */
const NOISE = new Set([
  'ls',
  'dir',
  'pwd',
  'cls',
  'clear',
  'exit',
  'history',
  'Get-History',
  'cd',
  'cd ..',
  'cd ~',
  'whoami',
])

const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+-(r|rf|fr)\b/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bdel\b\s+.*\/[fsq]/i,
  /\b(rd|rmdir)\b\s+.*\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bcipher\s+\/w/i,
  /\bshutdown\b/i,
  /\b(Restart|Stop)-Computer\b/i,
  /\bStop-Process\b/i,
  /\btaskkill\b.*\/f/i,
  /\breg\s+delete\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b.*--force/i,
  /\bdd\s+if=/i,
]

export function isDangerous(cmd: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(cmd))
}

/**
 * 多行命令在历史里被拆成多行，PSReadLine 只存每一行。
 * 被截断的第一半（`Get-Thing | Where-Object {$_.X -like "*y*"`）语法不完整，
 * 导进来就是一条必炸的片段——宁可丢掉。
 *
 * 判据是「结构不完整」而不是「像命令」：括号/引号不成对、或以 `|` `{` `,` `=` 结尾。
 * 代价是极少数合法写法（cmd 里未闭合的 `echo "hi`）会被误丢，比导进坏片段划算。
 */
export function looksIncomplete(cmd: string): boolean {
  const s = cmd.trim()
  // 行尾是续行符（PS 是反引号、cmd 是 ^）说明这条命令没写完，下一行被 PSReadLine 单独存了
  if (/[|{,=(`^]$/.test(s)) return true
  if ((s.match(/"/g)?.length ?? 0) % 2 !== 0) return true
  // 先在裸串里数括号：`"a(b"` 里的括号不算结构
  const bare = s.replace(/"[^"]*"|'[^']*'/g, '')
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    if (bare.split(open).length !== bare.split(close).length) return true
  }
  return false
}

/**
 * 清洗原始历史行：
 * - 去掉 bash 的 `#1672531200` 时间戳行（PSReadLine 不写，混着导入时常见）
 * - 多行命令被拆成的续行（`looksIncomplete`）没法可靠合并，直接丢
 * - 去重（保序：同一命令只留第一次出现）
 * - 去噪（`cd`/`ls`/`clear` 之类）
 */
export function normalizeHistory(lines: string[]): { kept: string[]; dropped: number } {
  const kept: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      dropped++
      continue
    }
    if (/^#\d{9,}$/.test(line)) {
      dropped++
      continue
    }
    if (line.length < 4) {
      dropped++
      continue
    }
    if (NOISE.has(line)) {
      dropped++
      continue
    }
    if (looksIncomplete(line)) {
      dropped++
      continue
    }
    if (seen.has(line)) {
      dropped++
      continue
    }
    seen.add(line)
    kept.push(line)
  }
  return { kept, dropped }
}

export function slugify(cmd: string): string {
  const base = cmd
    // 路径分隔符与引号在文件名里是雷，先拍平成空格
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 40)
    .replace(/-$/, '')
  return base || 'cmd'
}

export type PlannedSnippet = {
  id: string
  title: string
  cmd: string
  danger: boolean
  file: string
  /** `skip` = 目标文件已存在且没给 force */
  state: 'new' | 'skip'
}

export type ImportOptions = {
  lines: string[]
  /** 片段库根目录（data/snippets） */
  snippetsDir: string
  group?: string
  shell?: 'cmd' | 'powershell'
  limit?: number
  force?: boolean
  /** 来源标签，写进文件头注释 */
  source?: string
}

export type ImportResult = {
  planned: PlannedSnippet[]
  dropped: number
  /** 原始行数（清洗前） */
  total: number
}

/** 只做规划，不写盘。CLI 先打印它，用户确认后再 `writePlan` */
export function planImport(opts: ImportOptions): ImportResult {
  const group = opts.group ?? '历史导入'
  const shell = opts.shell ?? 'powershell'
  const limit = opts.limit ?? 100
  const { kept, dropped } = normalizeHistory(opts.lines)
  // 历史文件是「旧 → 新」，取尾部最近的 limit 条更有价值
  const picked = kept.slice(-limit)
  const dir = join(opts.snippetsDir, group)
  const used = new Set<string>()
  const planned: PlannedSnippet[] = []

  for (const cmd of picked) {
    let id = `hist-${slugify(cmd)}`
    if (used.has(id)) {
      let n = 2
      while (used.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    used.add(id)
    const file = join(dir, `${id}.yaml`)
    planned.push({
      id,
      title: cmd.length > 70 ? `${cmd.slice(0, 70)}…` : cmd,
      cmd,
      danger: isDangerous(cmd),
      file,
      state: existsSync(file) && !opts.force ? 'skip' : 'new',
    })
  }
  return { planned, dropped, total: opts.lines.length }
}

function renderYaml(p: PlannedSnippet, opts: ImportOptions): string {
  const shell = opts.shell ?? 'powershell'
  const header = [
    '# 由 snip import-history 生成',
    `# 来源: ${opts.source ?? 'shell 历史'}`,
    '# 可以直接改；再次导入不会覆盖这个文件',
    '',
  ].join('\n')
  const body = stringify(
    {
      id: p.id,
      title: p.title,
      group: opts.group ?? '历史导入',
      shell,
      tags: ['imported', 'history'],
      ...(p.danger ? { danger: true } : {}),
      steps: [{ do: 'run', cmd: p.cmd }],
    },
    { lineWidth: 0 },
  )
  return header + body
}

/** 真正落盘。返回写入条数（跳过的既不计入也不删） */
export function writePlan(result: ImportResult, opts: ImportOptions): number {
  let written = 0
  for (const p of result.planned) {
    if (p.state === 'skip') continue
    mkdirSync(dirname(p.file), { recursive: true })
    writeFileSync(p.file, renderYaml(p, opts), 'utf8')
    written++
  }
  return written
}
