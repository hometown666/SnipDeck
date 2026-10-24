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
  | { type: 'step'; stepIndex: number; ok: boolean; exitCode?: number; durationMs?: number }
  | {
      type: 'exit'
      ok: boolean
      exitCode?: number
      durationMs?: number
      stepIndex?: number
      timedOut?: boolean
    }
  | { type: 'error'; stepIndex?: number; message: string }

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('sniptoken') ?? ''
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return (await r.json()) as T
}

export const api = {
  snippets: () => req<SnippetView[]>('/api/snippets'),
  health: () => req<{ ok: boolean; bridgeUp: boolean; queue: number; snippets: number }>('/api/health'),
  preview: (id: string, vars: Record<string, string>) =>
    req<{ cmds: string[]; pending: string[]; missing: string[] }>(
      `/api/snippets/${encodeURIComponent(id)}/preview?vars=${encodeURIComponent(JSON.stringify(vars))}`,
    ),
  run: (id: string, vars: Record<string, string>, confirmed: boolean, onEvent: (ev: RunEvent) => void) =>
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id, vars, confirm: confirmed }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
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
