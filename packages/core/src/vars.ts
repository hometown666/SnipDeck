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

/**
 * 预览专用：没解析出来的占位符原样保留（`{{x}}`），不抛错。
 * 预览的价值是「看清楚将要执行什么」，填不全时更需要看到原始命令，而不是一个 500。
 */
export function renderTolerant(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (m: string, name: string) => values[name] ?? m)
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
    } else if (step.do === 'expect' && step.from) {
      // `from: file:{{logPath}}` 也要参与变量校验，否则运行时才炸
      for (const n of collectVarNames(step.from)) used.add(n)
    }
  }

  for (const name of used) {
    const spec: VarSpec | undefined = specs[name]
    const raw = provided[name]

    // 空串不等于「用户想填空」：前端表单会把未填项当 '' 发上来，
    // 直接当有效值会让 `click {{x}} {{y}}` 渲染成缺参数的命令并静默执行。
    if (raw !== undefined && raw !== '') {
      values[name] = raw
      continue
    }
    const envName = spec?.from?.startsWith('env:') ? spec.from.slice(4) : undefined
    if (envName && process.env[envName] !== undefined) {
      values[name] = process.env[envName]!
      continue
    }
    if (spec?.default !== undefined) {
      values[name] = String(spec.default)
      continue
    }
    // 显式允许空值：choices 里带空项（如 admin 的 "" / "admin"）
    if (raw === '' && spec?.choices?.some((c) => String(c) === '')) {
      values[name] = ''
      continue
    }
    if (spec?.prompt) pending.push(name)
    else missing.push(name)
  }
  return { values, pending, missing }
}
