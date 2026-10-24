import type { Snippet, VarSpec } from './types'

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export function collectVarNames(text: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(VAR_RE)) names.add(m[1]!)
  return [...names]
}

export function renderString(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (_m, name: string) => {
    const v = values[name]
    if (v === undefined) throw new Error(`missing variable: ${name}`)
    return v
  })
}

export type ResolvedVars = {
  values: Record<string, string>
  pending: string[]
  missing: string[]
}

export function resolveVars(snippet: Snippet, provided: Record<string, string>): ResolvedVars {
  const values: Record<string, string> = {}
  const pending: string[] = []
  const missing: string[] = []
  const specs = snippet.vars ?? {}

  const used = new Set<string>()
  for (const step of snippet.steps) {
    if (step.do === 'run') {
      for (const n of collectVarNames(step.cmd)) used.add(n)
    }
  }

  for (const name of used) {
    if (provided[name] !== undefined) {
      values[name] = provided[name]
      continue
    }
    const spec: VarSpec | undefined = specs[name]
    const envName = spec?.from?.startsWith('env:') ? spec.from.slice(4) : undefined
    if (envName && process.env[envName] !== undefined) {
      values[name] = process.env[envName]!
      continue
    }
    if (spec?.default !== undefined) {
      values[name] = String(spec.default)
      continue
    }
    if (spec?.prompt) pending.push(name)
    else missing.push(name)
  }
  return { values, pending, missing }
}
