export type VarView = {
  prompt?: string
  choices?: (string | number)[]
  default?: string | number
  secret?: boolean
  required?: boolean
}

export type SnippetView = {
  id: string
  title: string
  group: string
  tags: string[]
  danger: boolean
  shell: string
  target?: string
  vars: Record<string, VarView>
  steps: number
}

export type RunEvent =
  | { type: 'start'; stepIndex: number; cmd?: string }
  | { type: 'queued'; stepIndex: number; waitedMs: number }
  | { type: 'stdout'; stepIndex: number; data: string }
  | { type: 'stderr'; stepIndex: number; data: string }
  | {
      type: 'step'
      stepIndex: number
      ok: boolean
      exitCode?: number
      durationMs?: number
      note?: string
    }
  | {
      type: 'exit'
      ok: boolean
      exitCode?: number
      durationMs?: number
      stepIndex?: number
      timedOut?: boolean
      note?: string
    }
  | { type: 'error'; stepIndex?: number; message: string }

export type HealthView = {
  ok: boolean
  bridgeUp: boolean
  queue: number
  snippets: number
  quarantined: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const TOKEN_KEY = 'sniptoken'

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式下 localStorage 不可用，忽略
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  })
  if (!r.ok) throw new ApiError(r.status, await r.text())
  return (await r.json()) as T
}

export const api = {
  snippets: () => req<SnippetView[]>('/api/snippets'),
  health: () => req<HealthView>('/api/health'),
  preview: (id: string, vars: Record<string, string>) =>
    req<{ cmds: string[]; pending: string[]; missing: string[]; redacted: string[] }>(
      `/api/snippets/${encodeURIComponent(id)}/preview`,
      { method: 'POST', body: JSON.stringify({ vars }) },
    ),
  run: (id: string, vars: Record<string, string>, confirmed: boolean, onEvent: (ev: RunEvent) => void) =>
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id, vars, confirm: confirmed }),
    }).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, await r.text())
      const reader = r.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as RunEvent)
        }
      }
    }),
}
