import { type Dirent, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseExpectFrom } from './expect'
import type { Snippet, Step, VarSpec } from './types'
import { loadYamlDoc, saveYamlDoc } from './yaml'

export type SnippetError = { file: string; error: string }

/**
 * 单个 step 的校验，返回错误描述（null = 合法）。
 * 逐字段报错而不是一句 `invalid step`：片段是手写的 YAML，
 * 「第 3 步的 expect 缺 match」比「steps 不合法」省半小时。
 */
function stepError(v: unknown, i: number): string | null {
  if (typeof v !== 'object' || v === null) return `steps[${i}] 不是对象`
  const s = v as Record<string, unknown>
  switch (s.do) {
    case 'run':
      return typeof s.cmd === 'string' && s.cmd.trim() ? null : `steps[${i}] run 缺 cmd`
    case 'sleep':
      return typeof s.ms === 'number' ? null : `steps[${i}] sleep 缺 ms（数字，毫秒）`
    case 'expect': {
      if (typeof s.match !== 'string' || s.match === '') {
        return `steps[${i}] expect 缺 match（正则正文）`
      }
      if (s.flags !== undefined && typeof s.flags !== 'string') {
        return `steps[${i}] expect.flags 必须是字符串`
      }
      if (s.from !== undefined && typeof s.from !== 'string') {
        return `steps[${i}] expect.from 必须是字符串`
      }
      const src = parseExpectFrom(s.from as string | undefined)
      if (src.kind === 'invalid') return `steps[${i}] ${src.error}`
      try {
        // 用 flags 一并编译，才能抓出 `(?<` 之类只在带 flag 时非法的情况
        new RegExp(s.match, typeof s.flags === 'string' ? s.flags : undefined)
      } catch (e) {
        return `steps[${i}] expect.match 正则无效: ${e instanceof Error ? e.message : String(e)}`
      }
      return null
    }
    default:
      return `steps[${i}] 未知的 do: ${JSON.stringify(s.do)}（可用 run | sleep | expect）`
  }
}

export function validateSnippet(data: unknown): string[] {
  const errs: string[] = []
  if (typeof data !== 'object' || data === null) return ['not a mapping']
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id) errs.push('missing id')
  if (!Array.isArray(d.steps) || d.steps.length === 0) errs.push('missing steps')
  else {
    d.steps.forEach((s, i) => {
      const e = stepError(s, i)
      if (e) errs.push(e)
    })
  }
  if (d.vars !== undefined && (typeof d.vars !== 'object' || d.vars === null)) {
    errs.push('vars must be a mapping')
  }
  return errs
}

export function toSnippet(data: unknown, file: string): Snippet {
  const d = data as Record<string, unknown>
  const shell = d.shell === 'powershell' ? 'powershell' : d.shell === 'cmd' ? 'cmd' : undefined
  return {
    id: String(d.id),
    title: d.title as string | undefined,
    group: d.group as string | undefined,
    target: d.target as string | undefined,
    // 不写 shell 时不硬塞 cmd，交给目标主机的默认值兜底
    shell,
    tags: d.tags as string[] | undefined,
    danger: d.danger as boolean | undefined,
    meta: d.meta as Record<string, unknown> | undefined,
    vars: d.vars as Record<string, VarSpec> | undefined,
    steps: d.steps as Step[],
    file,
  }
}

export function listYamlFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) out.push(p)
    }
  }
  walk(dir)
  return out
}

export function loadSnippets(dir: string): { snippets: Snippet[]; errors: SnippetError[] } {
  const snippets: Snippet[] = []
  const errors: SnippetError[] = []
  // id 是唯一键：重复时后加载的会静默覆盖前一条，改成明确报错并跳过
  const seen = new Map<string, string>()
  for (const file of listYamlFiles(dir)) {
    try {
      const data = loadYamlDoc(file).toJS()
      const errs = validateSnippet(data)
      if (errs.length > 0) {
        errors.push({ file, error: errs.join('; ') })
        continue
      }
      const snippet = toSnippet(data, file)
      const prev = seen.get(snippet.id)
      if (prev) {
        errors.push({ file, error: `duplicate id "${snippet.id}"（已在 ${prev} 定义）` })
        continue
      }
      seen.set(snippet.id, file)
      snippets.push(snippet)
    } catch (e) {
      errors.push({ file, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { snippets, errors }
}

export function editSnippetField(file: string, keyPath: string[], value: unknown): void {
  const doc = loadYamlDoc(file)
  doc.setIn(keyPath, value)
  saveYamlDoc(file, doc)
}

export function groupOf(snippet: Snippet, root: string): string {
  if (snippet.group) return snippet.group
  const rel = relative(root, snippet.file).replace(/\\/g, '/')
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  return dir || '未分组'
}
