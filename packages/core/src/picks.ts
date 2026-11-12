/**
 * 从 `run.cmd` 里认出「这个变量是实例槽位」——只做 UI 提示，**不改命令**。
 *
 * 为什么不在 YAML 里加字段：现有 4 条实例片段（`close` / `kill` / `focus` / `click`）
 * 都是 `{{pro}}#{{n}}`，加字段要改数据、改编辑器、还要兼容老片段。命令本身已经
 * 把结构写清楚了，认出来就给下拉，认不出来就保持原来的输入框——不猜。
 *
 * 支持的形态（与现有片段一一对应）：
 *   close|kill|focus|click  {{slot}}        → 单变量
 *   close|kill|focus|click  {{pro}}#{{n}}   → 双变量
 *   close|kill|focus|click  {{pro}}#1       → 单变量
 *   lnk                     {{pro}}         → 程序下拉（P7.3）
 * 动作前允许 `admin` / `{{admin}}` 前缀；`{{admin}}` 的 choices 不参与判断。
 */
import type { Snippet, VarSpec } from './types'

export type PickerView =
  | { kind: 'instances'; mode: 'slot'; vars: { slot: string } }
  | { kind: 'instances'; mode: 'proN'; vars: { pro: string; n: string } }
  | { kind: 'instances'; mode: 'pro'; vars: { pro: string } }
  | { kind: 'programs'; mode: 'file'; vars: { pro: string } }

type Token = { text: string; quoted: boolean }

/** 引号内不切；引号本身不进 token。空串 `""` 也要留一个 token（它可能是合法的空值） */
function tokenizeArgs(s: string): Token[] {
  const out: Token[] = []
  let cur = ''
  let quoted = false
  let inQuote = false
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote
      quoted = true
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur !== '' || quoted) {
        out.push({ text: cur, quoted })
        cur = ''
        quoted = false
      }
      continue
    }
    cur += ch
  }
  if (cur !== '' || quoted) out.push({ text: cur, quoted })
  return out
}

/** `call ["…"]ahk.bat …`；带引号的桥路径（含空格）也认 */
const CALL_RE = /^\s*call\s+(?:"([^"]*?ahk\.bat)"|([^\s]*?ahk\.bat))\s*(.*)$/i
const VAR_RE = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/
const PAIR_RE = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}\s*#\s*\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/
const PRO_ONLY_RE = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}\s*#\s*\d+$/
const ADMIN_RE = /^\{\{\s*admin\s*\}\}$/i

/**
 * 变量得满足：已声明、不是 secret、没有静态 choices、不来自 env/file。
 * 带 choices 的变量（如 `admin`）是作者明确给了固定集合，不该被实例表覆盖。
 */
function allowed(vars: Record<string, VarSpec>, name: string): boolean {
  const spec = vars[name]
  if (!spec) return false
  if (spec.secret) return false
  if (spec.from) return false
  if (spec.choices && spec.choices.length > 0) return false
  return true
}

export function detectPick(cmd: string, vars: Record<string, VarSpec>): PickerView | null {
  const m = CALL_RE.exec(cmd)
  if (!m) return null
  const tokens = tokenizeArgs(m[3] ?? '')
  if (tokens.length < 2) return null

  let i = 0
  const first = tokens[0]
  if (first && (first.text.toLowerCase() === 'admin' || ADMIN_RE.test(first.text))) i = 1

  const action = tokens[i]?.text.toLowerCase()
  if (!action) return null

  // 程序启动：`lnk {{pro}}`。只认单变量形态——`lnk "C:\x\{{pro}}.lnk"` 这种拼串
  // 我们不猜（值里带不带引号、扩展名补不补，桥自己有一套规则）。
  if (action === 'lnk') {
    const only = tokens[i + 1]
    if (!only || tokens[i + 2]) return null
    const one = VAR_RE.exec(only.text.trim())
    const pro = one?.[1]
    if (!pro) return null
    return allowed(vars, pro) ? { kind: 'programs', mode: 'file', vars: { pro } } : null
  }

  if (!['close', 'kill', 'focus', 'click'].includes(action)) return null

  const arg = tokens[i + 1]
  if (!arg) return null
  // `close {{pro}} # {{n}}` 会被 cmd 拆成三个参数；桥能不能粘合是另一回事，这里不猜。
  if (tokens[i + 2]?.text === '#') return null

  const text = arg.text.trim()

  const one = VAR_RE.exec(text)
  if (one) {
    const slot = one[1]
    if (!slot) return null
    return allowed(vars, slot) ? { kind: 'instances', mode: 'slot', vars: { slot } } : null
  }

  const pair = PAIR_RE.exec(text)
  if (pair) {
    const pro = pair[1]
    const n = pair[2]
    if (!pro || !n) return null
    return allowed(vars, pro) && allowed(vars, n)
      ? { kind: 'instances', mode: 'proN', vars: { pro, n } }
      : null
  }

  const proOnly = PRO_ONLY_RE.exec(text)
  if (proOnly) {
    const pro = proOnly[1]
    if (!pro) return null
    return allowed(vars, pro) ? { kind: 'instances', mode: 'pro', vars: { pro } } : null
  }

  return null
}

/**
 * 一条片段可能有多步。同样的 pick 去重；**同一变量被两种不同形态引用时放弃全部**——
 * 与其在界面上强行解释，不如退回手输，至少不会把值填错。
 */
export function detectPickers(snippet: Pick<Snippet, 'vars' | 'steps'>): PickerView[] {
  const vars = snippet.vars ?? {}
  if (Object.keys(vars).length === 0) return []

  const picks: PickerView[] = []
  const seen = new Set<string>()
  for (const step of snippet.steps) {
    if (step.do !== 'run') continue
    const pick = detectPick(step.cmd, vars)
    if (!pick) continue
    const sig = signature(pick)
    if (seen.has(sig)) continue
    seen.add(sig)
    picks.push(pick)
  }
  if (picks.length === 0) return []

  const byVar = new Map<string, Set<string>>()
  for (const pick of picks) {
    const sig = signature(pick)
    for (const name of Object.values(pick.vars)) {
      const set = byVar.get(name) ?? new Set<string>()
      set.add(sig)
      byVar.set(name, set)
    }
  }
  for (const set of byVar.values()) {
    if (set.size > 1) return []
  }
  return picks
}

function signature(pick: PickerView): string {
  return `${pick.mode}:${Object.values(pick.vars).join('|')}`
}
