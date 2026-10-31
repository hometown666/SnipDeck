/**
 * `ahk.bat` 的结构化命令（纯函数，不碰 DOM）。
 *
 * 为什么需要它：写片段时手抄 `call C:\ahk_trigger\ahk.bat shell shell#1 "…"` 是纯负担——
 * 路径、动作名、参数顺序都要记，错一个字符就是一条跑不通的片段。
 * 这里把「桥的 CLI」变成可选择的动作 + 该动作真正需要的字段。
 *
 * 关键约束：**YAML 里存的仍然只是 `cmd` 字符串**。这个模块只负责
 * 「字符串 ⇄ 表单」的互转，不改片段格式、不改桥协议。
 * 所以老片段打开时能认出来就显示表单，认不出来就退回自定义原文。
 */

/** 桥目录固定值。换目录要同时改 listener / ahk.bat，见 bridge/README.md */
export const BRIDGE_ROOT = 'C:\\ahk_trigger'
const BAT = `${BRIDGE_ROOT}\\ahk.bat`

export type AhkAction =
  | 'lnk'
  | 'run'
  | 'script'
  | 'shell'
  | 'shellOpen'
  | 'runlog'
  | 'status'
  | 'instances'
  | 'focus'
  | 'close'
  | 'kill'
  | 'click'
  | 'custom'

export type AhkDraft = {
  action: AhkAction
  /** lnk / run / script 的目标；shell / runlog 的命令；custom 的原文 */
  value: string
  slot: string
  job: string
  x: string
  y: string
  admin: boolean
}

export const EMPTY_DRAFT: AhkDraft = {
  action: 'custom',
  value: '',
  slot: 'shell#1',
  job: '',
  x: '',
  y: '',
  admin: false,
}

type Spec = {
  label: string
  /** 表单里要显示的字段 */
  fields: ('value' | 'slot' | 'job' | 'xy')[]
  /** 是否支持 admin 前缀（只有 CLI 里真有 admin 版本的才给） */
  admin?: boolean
  valueLabel?: string
  valueHint?: string
  valueOptional?: boolean
}

export const ACTION_SPECS: Record<AhkAction, Spec> = {
  lnk: {
    label: '打开快捷方式',
    fields: ['value'],
    admin: true,
    valueLabel: '快捷方式名字',
    valueHint: 'PROG_DIR 里的 .lnk 名（可写绝对路径）',
  },
  run: {
    label: '运行程序 / 脚本路径',
    fields: ['value'],
    admin: true,
    valueLabel: '路径或 exe',
    valueHint: '例如 notepad.exe 或完整的 .bat 路径',
  },
  script: {
    label: '运行 AHK 脚本',
    fields: ['value'],
    valueLabel: '脚本名',
    valueHint: 'AHK_DIR 里的 .ahk（不带后缀也行）',
  },
  shell: {
    label: '在 shell 窗口里执行',
    fields: ['slot', 'value'],
    valueLabel: '要执行的命令',
    valueHint: '留空 = 只把 paste.txt 粘进去；命令里不能再带双引号',
    valueOptional: true,
  },
  shellOpen: { label: '打开一个 shell 窗口', fields: [] },
  runlog: {
    label: '后台执行并记日志',
    fields: ['job', 'value'],
    admin: true,
    valueLabel: '命令',
    valueHint: '跑完留下 jobs/<任务>.log 与 .exit',
  },
  status: { label: '刷新桌面状态', fields: [] },
  instances: { label: '查看实例表', fields: [] },
  focus: { label: '切到某个实例', fields: ['slot'] },
  close: { label: '关掉某个实例', fields: ['slot'] },
  kill: { label: '结束某个实例', fields: ['slot'], admin: true },
  click: { label: '点一下某个窗口', fields: ['slot', 'xy'] },
  custom: { label: '自定义命令（原样执行）', fields: ['value'] },
}

/** 需要引号就加：含空格、为空、或本身以引号开头（后者无法表达，交给 UI 警告） */
function quote(s: string): string {
  const v = s.trim()
  if (!v) return '""'
  if (/^".*"$/.test(v)) return v
  return /\s/.test(v) ? `"${v}"` : v
}

/** 把 `call "...ahk.bat" a b "c d"` 拆成参数（尊重双引号） */
export function tokenize(rest: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of rest) {
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

export function buildAhkCommand(d: AhkDraft): string {
  const a = d.action
  if (a === 'custom') return d.value
  const admin = d.admin ? 'admin ' : ''
  switch (a) {
    case 'lnk':
    case 'run':
      return `call ${BAT} ${admin}${a} ${quote(d.value)}`
    case 'script':
      return `call ${BAT} script ${quote(d.value)}`
    case 'shell':
      return d.value.trim() ? `call ${BAT} shell ${d.slot} ${quote(d.value)}` : `call ${BAT} shell ${d.slot}`
    case 'shellOpen':
      return `call ${BAT} shell`
    case 'runlog':
      return `call ${BAT} ${admin}runlog ${d.job.trim() ? `${d.job.trim()} ` : ''}${quote(d.value)}`
    case 'status':
      return `call ${BAT} status`
    case 'instances':
      return `call ${BAT} instances`
    case 'focus':
    case 'close':
    case 'kill':
      return `call ${BAT} ${admin}${a} ${d.slot}`
    case 'click':
      return `call ${BAT} click ${d.slot} ${d.x.trim() || '0'} ${d.y.trim() || '0'}`
    default:
      return d.value
  }
}

/**
 * 认不出来的命令一律当自定义：**不猜**。
 * 猜错的代价是「打开编辑器什么都没干，命令就被改了」。
 */
export function parseAhkCommand(cmd: string): AhkDraft {
  const base = { ...EMPTY_DRAFT, value: cmd }
  const m = /^\s*call\s+"?([^"\s]*?ahk\.bat)"?\s*(.*)$/i.exec(cmd)
  if (!m) return base

  const tokens = tokenize(m[2] ?? '')
  if (tokens.length === 0) return base

  let admin = false
  if ((tokens[0] ?? '').toLowerCase() === 'admin') {
    admin = true
    tokens.shift()
    if (tokens.length === 0) return base
  }

  const head = (tokens[0] ?? '').toLowerCase()
  const rest = tokens.slice(1)
  const mk = (action: AhkAction, extra: Partial<AhkDraft> = {}): AhkDraft => ({
    ...EMPTY_DRAFT,
    action,
    admin,
    ...extra,
  })

  switch (head) {
    case 'lnk':
    case 'run':
    case 'script':
      if (rest.length === 0) return base
      return mk(head, { value: rest.join(' ') })
    case 'status':
    case 'instances':
      return rest.length === 0 ? mk(head) : base
    case 'focus':
    case 'close':
    case 'kill':
      return rest.length === 1 ? mk(head, { slot: rest[0] ?? '' }) : base
    case 'click':
      return rest.length === 3 ? mk('click', { slot: rest[0] ?? '', x: rest[1] ?? '', y: rest[2] ?? '' }) : base
    case 'shell':
      if (rest.length === 0) return mk('shellOpen')
      return mk('shell', { slot: rest[0] ?? '', value: rest.slice(1).join(' ') })
    case 'runlog': {
      // jobN 是可选的：只有 `job1` 这种显式名字才当任务名，其余全是命令
      const job = /^job\d+$/i.test(rest[0] ?? '') ? (rest[0] ?? '') : ''
      const value = job ? rest.slice(1).join(' ') : rest.join(' ')
      if (!value) return base
      return mk('runlog', { job, value })
    }
    default:
      return base
  }
}

/** 这个动作的表单里，某个字段要不要显示 */
export function hasField(action: AhkAction, field: 'value' | 'slot' | 'job' | 'xy'): boolean {
  return ACTION_SPECS[action].fields.includes(field)
}
