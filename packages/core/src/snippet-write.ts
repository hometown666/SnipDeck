import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { stringify, parseDocument } from 'yaml'
import { loadSnippets, validateSnippet } from './snippets'
import type { Snippet, Step, VarSpec } from './types'

/**
 * 片段的写入层（P6：CRUD）。
 *
 * 三条硬规矩，任何一条破了都会让「改片段」变成危险动作：
 * 1. **落点必须在 snippets 根目录内**——id 与 group 都是用户输入，`../` 能写到仓库外；
 * 2. **原子写**——store 的 watcher 会在 200ms 后重建索引，半份文件会让整条片段 quarantine；
 * 3. **写完先校验再落盘**——存进去一份语法错的 YAML，比拒绝保存糟糕得多。
 */

/** 写入失败的种类：server 靠它决定 400 还是 409 */
export type WriteProblem = 'invalid' | 'conflict' | 'exists' | 'path'

export class SnippetWriteError extends Error {
  constructor(
    readonly kind: WriteProblem,
    readonly problems: string[],
  ) {
    super(problems.join('; '))
    this.name = 'SnippetWriteError'
  }
}

/** 表单提交的片段：与 `Snippet` 的区别只有 `file`（那是加载时才知道的） */
export type SnippetDraft = {
  id: string
  title?: string
  group?: string
  target?: string
  shell?: 'cmd' | 'powershell'
  tags?: string[]
  danger?: boolean
  meta?: Record<string, unknown>
  vars?: Record<string, VarSpec>
  steps: Step[]
}

export function draftOf(s: Snippet): SnippetDraft {
  return {
    id: s.id,
    title: s.title,
    group: s.group,
    target: s.target,
    shell: s.shell,
    tags: s.tags,
    danger: s.danger,
    meta: s.meta,
    vars: s.vars,
    steps: s.steps,
  }
}

/**
 * 把用户输入变成安全的单层路径片段。
 *
 * 不只是「防穿越」——Windows 的文件名还有一整套非法字符与保留名（`con`、`nul`…），
 * 而 id 会同时用作 URL 片段与文件名，两边都得能过。
 */
export function safeSegment(raw: string, fallback: string): string {
  const s = String(raw ?? '')
    // `.` 一起换掉：`..` 在路径里是上跳，在 Windows 上是非法结尾，
    // 两种都能靠 `.._` 这类残留名绕开后面的判据。宁可把点变成下划线。
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*.\u0000-\u001f]/g, '_')
    .replace(/_+$/, '')
    .trim()
  const base = s || fallback
  // CON / PRN / AUX / NUL / COM1..9 / LPT1..9 在 Windows 上无法创建
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base) ? `_${base}` : base
  // 目录名过长会让整条路径超 260（未开长路径时）
  return reserved.slice(0, 60)
}

/**
 * 算出这条片段应该落在哪。
 *
 * 目录只由 `group` 决定：改 group 就是搬家。反过来说，**不写 group 的片段会落到
 * 「未分组」目录**——与 `groupOf()` 的兜底文案一致，免得文件散在根目录、界面却显示
 * 一个不存在的分组。
 */
export function snippetPath(root: string, draft: SnippetDraft): string {
  const dir = draft.group ? join(root, safeSegment(draft.group, '未分组')) : join(root, '未分组')
  return join(dir, `${safeSegment(draft.id, 'snippet')}.yaml`)
}

/** 落点必须真在 root 里。safeSegment 已经不可能产出 `..`，这条是第二道闸。 */
function assertInside(root: string, file: string): void {
  const rel = relative(root, file)
  // 别写成 `rel.startsWith('..')`：一个叫 `.._` 的目录名也会命中，
  // 那是合法落点却被判越界（这条判据的 bug 是 smoke 用例抓出来的）。
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SnippetWriteError('path', [`落点越界：${file}`])
  }
}

/**
 * id 是全库唯一的键。换目录保存会让同一个 id 出现两份，
 * `loadSnippets()` 只保留先加载的那份、把另一份标成 duplicate——界面看着正常，
 * 实际「改了没生效」。所以写之前先问一句：这个 id 现在是哪条文件占着？
 */
function idOwner(root: string, id: string, except?: string): string | undefined {
  for (const s of loadSnippets(root).snippets) {
    if (s.id === id && s.file !== except) return s.file
  }
  return undefined
}

/** 去掉 undefined / null / 空数组 / 空对象：YAML 里留一堆 `tags: []` 只是噪音 */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue
    out[k] = v
  }
  return out
}

/** 序列化：字段顺序固定，免得每次保存都产生一整片 diff 噪音 */
export function serializeSnippet(draft: SnippetDraft): string {
  const data = compact({
    id: draft.id,
    title: draft.title,
    group: draft.group,
    target: draft.target,
    shell: draft.shell,
    tags: draft.tags,
    danger: draft.danger || undefined,
    meta: draft.meta,
    vars: draft.vars,
    steps: draft.steps.map((s) => compact(s as unknown as Record<string, unknown>)),
  })
  return stringify(data, { lineWidth: 0 })
}

/**
 * 序列化结果必须能被读回来。
 * `stringify` 成功不等于 `loadSnippets` 认得——比如某些转义序列在写和读两侧的解释不一致，
 * 存进去就是一条「看得见、跑不了」的片段。写盘前自己先解析一遍，成本是一次 parse。
 */
export function verifySerialized(text: string): string[] {
  return parseDocument(text).errors.map((e) => e.message)
}

/**
 * 原子写：先写同目录临时文件再 rename。
 * 直接 `writeFileSync(file)` 会让 watcher 有机会读到半份文件——
 * 它 200ms 后重建索引，读到半个 YAML 就把这条片段标成 quarantined。
 */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件清不掉也不该盖住真正的错误
    }
    throw e
  }
}

export type SaveOptions = {
  /** 正在编辑的那条片段的当前文件；新建时省略 */
  currentFile?: string
  /**
   * 客户端读到的 mtime。与磁盘上的不一致说明文件被别人改过（编辑器、git pull），
   * 这时候静默覆盖等于吃掉别人的改动——ISSUE 级别的体验，所以宁可 409。
   */
  expectedMtimeMs?: number
}

export type SaveResult = {
  file: string
  /** 相对 snippets 根的路径，形如 `状态/check-instance.yaml` */
  relPath: string
  created: boolean
  /** id 或 group 改了之后，旧文件被搬走前的路径 */
  movedFrom?: string
  mtimeMs: number
}

/**
 * 两条写路径共用的落盘动作：目标定位、mtime 冲突、id 占用、`.bak`、原子写、清理旧文件。
 *
 * 抽出来的原因：表单保存（`saveSnippet`）和原文保存（`saveSnippetRaw`）在
 * 「校验」这一层完全不同（一个校验对象、一个校验文本），但**落盘这件事必须一模一样**——
 * 少一处 `.bak`、少一次 `idOwner` 检查，就会有一条路径偷偷丢东西。
 */
function persist(
  root: string,
  target: { id: string; group?: string },
  text: string,
  opts: SaveOptions,
): SaveResult {
  const file = snippetPath(root, { id: target.id, group: target.group, steps: [] })
  assertInside(root, file)

  const current = opts.currentFile
  const created = !current || !existsSync(current)

  if (!created && opts.expectedMtimeMs !== undefined) {
    const actual = statSync(current).mtimeMs
    // 容差 1ms：Windows 上 mtime 精度与 JS 浮点秒的对齐会差一丁点
    if (Math.abs(actual - opts.expectedMtimeMs) > 1) {
      throw new SnippetWriteError('conflict', [
        '这条片段在你编辑期间被改过了（可能是编辑器、git pull，或编辑器的另一侧）。刷新后重试。',
      ])
    }
  }

  // 目标已存在且不是当前文件 = id 撞了。不覆盖别人的片段。
  if (file !== current && existsSync(file)) {
    throw new SnippetWriteError('exists', [
      `目标文件已存在：${relative(root, file)}（换一个 id 或分组）`,
    ])
  }

  // 同一个 id 已经住在别的分组目录里：换目录保存会造出两份同 id 的片段
  const owner = idOwner(root, target.id, current)
  if (owner) {
    throw new SnippetWriteError('exists', [
      `id "${target.id}" 已被 ${relative(root, owner).replace(/\\/g, '/')} 占用（id 必须全库唯一）`,
    ])
  }

  // 覆盖任何已有文件之前留一份副本。与 `saveYamlDoc` 的 `.bak` 约定一致：
  // `*.bak` 已在 .gitignore 里，扩展名也不匹配 `.yaml`，不会被当成片段加载。
  for (const f of new Set([file, current].filter((x): x is string => !!x && existsSync(x)))) {
    copyFileSync(f, `${f}.bak`)
  }

  writeAtomic(file, text)
  if (!created && current && file !== current) {
    try {
      unlinkSync(current)
    } catch {
      // 删不掉旧文件时新文件已经在目标位置了；退回「两份都在」比丢内容好
    }
  }

  return {
    file,
    relPath: relative(root, file).replace(/\\/g, '/'),
    created,
    movedFrom: !created && current !== file ? current : undefined,
    mtimeMs: statSync(file).mtimeMs,
  }
}

/**
 * 保存一条片段（表单路径）。校验失败、路径冲突、mtime 冲突都会抛 `SnippetWriteError`，
 * 上层据此回 400 / 409——**不写半份文件，也不静默覆盖**。
 *
 * 注意：这条路径会 `stringify`，所以**注释、字段顺序、引号风格都不保留**。
 * 想逐字保真用 `saveSnippetRaw`。
 */
export function saveSnippet(root: string, draft: SnippetDraft, opts: SaveOptions = {}): SaveResult {
  const problems = validateSnippet({
    ...draft,
    // 空字符串等同于没填，否则 `title: ''` 会过校验却在界面上显示成空白
    title: draft.title || undefined,
    group: draft.group || undefined,
  })
  if (problems.length > 0) throw new SnippetWriteError('invalid', problems)

  const text = serializeSnippet(draft)
  // 写盘前再解析一次：stringify 的结果自己也得能被读回来，否则等于存了个炸弹
  const parseProblems = verifySerialized(text)
  if (parseProblems.length > 0) {
    throw new SnippetWriteError('invalid', ['序列化结果无法解析', ...parseProblems])
  }

  return persist(root, { id: draft.id, group: draft.group }, text, opts)
}

/** `parseDocument` 的 errors 元素：message 一定有，位置可能没有 */
type YamlError = { message: string; linePos?: { line: number; col: number }[] }

function formatYamlErrors(errors: YamlError[]): string[] {
  return errors.map((e) => {
    const pos = e.linePos?.[0]
    // 行号从 1 开始，与编辑器左侧的行号列一致；不给行号等于让用户自己数
    return pos ? `第 ${pos.line} 行第 ${pos.col} 列：${e.message}` : e.message
  })
}

export type RawSaveResult = SaveResult & { id: string }

/**
 * 保存**原文**（编辑器里的 YAML 文本）。
 *
 * 与 `saveSnippet` 的区别只有一处、但很关键：**落盘的是用户给的文本本身**，
 * 不经过 `stringify`。所以注释、字段顺序、引号风格、`meta.note` 的 `>` 折叠块
 * 全都原样保留——这正是用户选「原文模式」的全部理由。
 *
 * 代价是校验更弱：只能确认「是合法 YAML」+「过 `validateSnippet`」，
 * 字段顺序之类的东西没有约束（也不该有）。
 */
export function saveSnippetRaw(
  root: string,
  text: string,
  opts: SaveOptions = {},
): RawSaveResult {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new SnippetWriteError('invalid', formatYamlErrors(doc.errors as YamlError[]))
  }
  const data = doc.toJS() as Record<string, unknown> | null
  const problems = validateSnippet(data)
  if (problems.length > 0) throw new SnippetWriteError('invalid', problems)

  const id = String((data as Record<string, unknown>).id)
  const rawGroup = (data as Record<string, unknown>).group
  const group = typeof rawGroup === 'string' && rawGroup.trim() ? rawGroup.trim() : undefined

  const saved = persist(root, { id, group }, text, opts)
  return { ...saved, id }
}

/**
 * 删除：先拷一份到 `<root>/.trash/`，再删原文件。
 *
 * 备份的扩展名刻意写成 `.yaml.txt`——`loadSnippets()` 只认 `.yaml`/`.yml`，
 * 放进 `.trash/` 的副本不会被当成片段加载（否则删一条反而多出一条）。
 */
export function deleteSnippet(root: string, file: string, id: string): string {
  assertInside(root, file)
  mkdirSync(join(root, '.trash'), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(root, '.trash', `${safeSegment(id, 'snippet')}-${stamp}.yaml.txt`)
  copyFileSync(file, backup)
  unlinkSync(file)
  // `.bak` 是「上一次保存前的版本」，片段都删了它就没有意义了。
  // 留着只会在 snippets/ 里堆一堆看不见的垃圾——UI 回归跑几轮就能堆出十几条。
  try {
    unlinkSync(`${file}.bak`)
  } catch {
    // 没有 .bak 是常态
  }
  return backup
}

