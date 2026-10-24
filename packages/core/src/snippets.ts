import { type Dirent, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Snippet, Step, VarSpec } from './types'
import { loadYamlDoc, saveYamlDoc } from './yaml'

export type SnippetError = { file: string; error: string }

function isStep(v: unknown): v is Step {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  if (s.do === 'run') return typeof s.cmd === 'string'
  if (s.do === 'sleep') return typeof s.ms === 'number'
  return false
}

export function validateSnippet(data: unknown): string[] {
  const errs: string[] = []
  if (typeof data !== 'object' || data === null) return ['not a mapping']
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id) errs.push('missing id')
  if (!Array.isArray(d.steps) || d.steps.length === 0) errs.push('missing steps')
  else if (!d.steps.every(isStep)) errs.push('invalid step (do: run|sleep)')
  if (d.vars !== undefined && (typeof d.vars !== 'object' || d.vars === null)) {
    errs.push('vars must be a mapping')
  }
  return errs
}

export function toSnippet(data: unknown, file: string): Snippet {
  const d = data as Record<string, unknown>
  return {
    id: String(d.id),
    title: d.title as string | undefined,
    group: d.group as string | undefined,
    target: d.target as string | undefined,
    shell: (d.shell as Snippet['shell']) ?? 'cmd',
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
  for (const file of listYamlFiles(dir)) {
    try {
      const data = loadYamlDoc(file).toJS()
      const errs = validateSnippet(data)
      if (errs.length > 0) {
        errors.push({ file, error: errs.join('; ') })
        continue
      }
      snippets.push(toSnippet(data, file))
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
