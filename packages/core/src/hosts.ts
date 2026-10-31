/**
 * hosts.yaml：读取、解析默认目标，以及**写入**（网页上增 / 改 / 删目标）。
 *
 * 写入的规矩与 `snippet-write.ts` 同一套，但轻一档：
 *   - **原地改文档**（`loadYamlDoc` + `setIn` + `saveYamlDoc`），不重新 stringify 整个对象，
 *     这样别人在文件里写的注释和顺序能留住；
 *   - 覆盖前留 `.bak`（`saveYamlDoc` 自带）；
 *   - 改之前先校验，改完再解析一遍自检——hosts.yaml 写坏等于整个服务起不来。
 *
 * 不在这里判断「有没有片段引用它」：那要知道片段库，属于路由层的职责。
 */
import { existsSync, statSync } from 'node:fs'
import type { HostTarget } from './types'
import { loadYaml, loadYamlDoc, saveYamlDoc } from './yaml'

export type Hosts = Record<string, HostTarget>

export function loadHosts(file: string): Hosts {
  return loadYaml<Hosts>(file)
}

export function resolveTarget(
  hosts: Hosts,
  name: string | undefined,
): { name: string; target: HostTarget } {
  const usable = Object.keys(hosts).filter((k) => !hosts[k]!.reserved)
  const key =
    name ??
    usable.find((k) => hosts[k]!.default === true) ??
    usable[0] ??
    Object.keys(hosts)[0]
  if (!key) throw new Error('no host target configured')
  const target = hosts[key]
  if (!target) throw new Error(`unknown target: ${key}`)
  return { name: key, target }
}

// ——— 写入 ———

export type HostDraft = {
  name: string
  driver: 'exec' | 'local' | 'ssh'
  bridge?: string
  shell?: string
  timeout?: number
  default?: boolean
}

export class HostWriteError extends Error {
  kind: 'invalid' | 'exists' | 'missing' | 'conflict'
  problems: string[]
  constructor(kind: HostWriteError['kind'], problems: string[]) {
    super(problems.join('；'))
    this.name = 'HostWriteError'
    this.kind = kind
    this.problems = problems
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const DRIVERS = ['exec', 'local', 'ssh'] as const

/** hosts.yaml 的 mtime；不存在时返回 0（首次创建前不该有冲突检测） */
export function hostMtime(file: string): number {
  try {
    return existsSync(file) ? statSync(file).mtimeMs : 0
  } catch {
    return 0
  }
}

/**
 * 校验一条目标。`previousName` 用于改名：改成已存在的名字要拦，改成自己不算冲突。
 */
export function validateHostDraft(
  draft: HostDraft,
  existing: Hosts,
  previousName?: string,
): string[] {
  const problems: string[] = []
  const name = draft.name.trim()

  if (!name) problems.push('名字不能为空')
  else if (!NAME_RE.test(name))
    problems.push(`名字只能用小写字母、数字、- 和 _（最多 32 字符）：${name}`)
  else if (name !== previousName && existing[name]) problems.push(`目标已存在：${name}`)

  if (!DRIVERS.includes(draft.driver)) problems.push(`driver 只能是 ${DRIVERS.join(' / ')}`)

  if (draft.driver === 'exec') {
    const bridge = (draft.bridge ?? '').trim()
    if (!bridge) problems.push('exec 目标必须填 bridge 目录')
    else if (!/^[A-Za-z]:[\\/]/.test(bridge) && !bridge.startsWith('\\\\'))
      problems.push(`bridge 必须是绝对路径：${bridge}`)
  }

  if (draft.shell && !['cmd', 'powershell'].includes(draft.shell))
    problems.push(`shell 只能是 cmd / powershell：${draft.shell}`)

  if (draft.timeout !== undefined) {
    const t = draft.timeout
    if (!Number.isInteger(t) || t < 1 || t > 600)
      problems.push(`timeout 是 1–600 的整数（秒）：${String(t)}`)
  }

  return problems
}

export type HostSaveResult = {
  name: string
  renamed: boolean
  mtimeMs: number
  /** 写回后的整份 hosts：路由层直接换掉内存里那份，免得每条请求都读盘 */
  updated: Hosts
}

export function saveHost(
  file: string,
  draft: HostDraft,
  opts: { previousName?: string; expectedMtimeMs?: number } = {},
): HostSaveResult {
  const doc = loadYamlDoc(file)
  const existing = (doc.toJS() ?? {}) as Hosts

  const name = draft.name.trim()
  // 重名单独判成 409（不是 400）：这是「冲突」，客户端该换个名字重试，不是表单填错了
  if (existing[name] && name !== opts.previousName) {
    throw new HostWriteError('exists', [`目标已存在：${name}`])
  }

  const problems = validateHostDraft({ ...draft, name }, existing, opts.previousName)
  if (problems.length > 0) throw new HostWriteError('invalid', problems)

  if (opts.expectedMtimeMs !== undefined) {
    const actual = hostMtime(file)
    // 容差 1ms：Windows 上 mtime 精度与 JS 浮点秒的对齐会差一丁点
    if (Math.abs(actual - opts.expectedMtimeMs) > 1) {
      throw new HostWriteError('conflict', [
        'hosts.yaml 在你编辑期间被改过了（可能是编辑器或 git pull）。刷新后重试。',
      ])
    }
  }

  const previous = opts.previousName
  if (previous && previous !== name) doc.deleteIn([previous])

  doc.setIn([name, 'driver'], draft.driver)

  // 空值不写进文件：留着 `bridge: ''` 会让「没配」和「配了空串」分不开
  const setOrDrop = (key: string, value: unknown) => {
    if (value === undefined || value === '') doc.deleteIn([name, key])
    else doc.setIn([name, key], value)
  }
  const isExec = draft.driver === 'exec'
  setOrDrop('bridge', isExec ? (draft.bridge ?? '').trim() : undefined)
  setOrDrop('shell', isExec ? draft.shell : undefined)
  setOrDrop('timeout', isExec ? draft.timeout : undefined)

  // reserved 由 driver 推出：只有 exec 真能跑，local / ssh 是 P5.3 之后留的占位
  if (isExec) doc.deleteIn([name, 'reserved'])
  else doc.setIn([name, 'reserved'], true)

  // default 排他：设一台就摘掉其它台的
  if (draft.default) {
    for (const key of Object.keys(existing)) {
      if (key !== name) doc.deleteIn([key, 'default'])
    }
    doc.setIn([name, 'default'], true)
  } else {
    doc.deleteIn([name, 'default'])
  }

  saveYamlDoc(file, doc)

  // 自检：写进去的东西得读得回来。hosts.yaml 坏掉比一条片段坏严重得多
  const after = (loadYamlDoc(file).toJS() ?? {}) as Hosts
  const entry = after[name]
  if (!entry) throw new HostWriteError('invalid', ['写入后读不到该目标，已中止'])
  if (entry.driver !== draft.driver)
    throw new HostWriteError('invalid', [`写入后 driver 不一致：${String(entry.driver)}`])

  return {
    name,
    renamed: !!previous && previous !== name,
    mtimeMs: hostMtime(file),
    updated: after,
  }
}

/** 删除一条目标。引用检查在路由层做，这里只管文件。 */
export function deleteHost(
  file: string,
  name: string,
  opts: { expectedMtimeMs?: number } = {},
): { mtimeMs: number; updated: Hosts } {
  const doc = loadYamlDoc(file)
  const existing = (doc.toJS() ?? {}) as Hosts
  if (!existing[name]) throw new HostWriteError('missing', [`目标不存在：${name}`])

  if (opts.expectedMtimeMs !== undefined) {
    const actual = hostMtime(file)
    if (Math.abs(actual - opts.expectedMtimeMs) > 1) {
      throw new HostWriteError('conflict', ['hosts.yaml 在你编辑期间被改过了。刷新后重试。'])
    }
  }

  doc.deleteIn([name])
  saveYamlDoc(file, doc)
  const after = (loadYamlDoc(file).toJS() ?? {}) as Hosts
  return { mtimeMs: hostMtime(file), updated: after }
}

/** 可用目标（非 reserved）——删掉最后一个，服务就没有默认目标了 */
export function usableNames(hosts: Hosts): string[] {
  return Object.keys(hosts).filter((k) => !hosts[k]!.reserved)
}
