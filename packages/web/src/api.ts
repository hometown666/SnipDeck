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

export type HostView = {
  name: string
  driver: string
  reserved: boolean
  default: boolean
}

/** 片段的一个步骤：与 core 的 Step 联合类型对齐（编辑器要把它完整读回来再写回去） */
export type SnippetStep =
  | { do: 'run'; cmd: string; timeout?: number; optional?: boolean; queue?: boolean }
  | { do: 'sleep'; ms: number; optional?: boolean }
  | {
      do: 'expect'
      match: string
      flags?: string
      from?: string
      timeout?: number
      interval?: number
      optional?: boolean
    }

export type SnippetVarSpec = {
  prompt?: string
  default?: string | number
  choices?: (string | number)[]
  secret?: boolean
  from?: string
}

/** `GET /api/snippets/:id/detail`：编辑器要的完整字段 + 冲突检测用的 mtime */
export type SnippetDetail = {
  id: string
  title?: string
  group?: string
  target?: string
  shell?: 'cmd' | 'powershell'
  tags?: string[]
  danger?: boolean
  meta?: Record<string, unknown>
  vars?: Record<string, SnippetVarSpec>
  steps: SnippetStep[]
  /** 相对 snippets 根的路径，形如 `状态/check-instance.yaml` */
  relPath: string
  mtimeMs: number
}

export type SnippetSaveInput = {
  id: string
  title?: string
  group?: string
  target?: string
  shell?: 'cmd' | 'powershell'
  tags?: string[]
  danger?: boolean
  meta?: Record<string, unknown>
  vars?: Record<string, SnippetVarSpec>
  steps: SnippetStep[]
  /** 编辑时带上读到的 mtime；对不上服务端回 409，不会静默覆盖 */
  mtimeMs?: number
}

export type SnippetSaveResult = {
  ok: boolean
  id: string
  relPath: string
  created?: boolean
  renamed?: boolean
  mtimeMs: number
}

/** 多目标执行时每条事件都带 target / targetIndex（服务端打的标） */
export type RunEvent =
  | {
      type: 'start'
      stepIndex: number
      cmd?: string
      /** 首条 start 带 runId：这次运行的档案编号（断开后回看用） */
      runId?: string
      target?: string
      targetIndex?: number
    }
  | { type: 'queued'; stepIndex: number; waitedMs: number; target?: string; targetIndex?: number }
  | { type: 'stdout'; stepIndex: number; data: string; target?: string; targetIndex?: number }
  | { type: 'stderr'; stepIndex: number; data: string; target?: string; targetIndex?: number }
  | {
      type: 'step'
      stepIndex: number
      ok: boolean
      exitCode?: number
      durationMs?: number
      note?: string
      /** expect 步：命中的文本 / 等的是哪个正则 */
      matched?: string
      expect?: string
      target?: string
      targetIndex?: number
    }
  | {
      type: 'exit'
      ok: boolean
      exitCode?: number
      durationMs?: number
      stepIndex?: number
      timedOut?: boolean
      /** 失败来源：桥侧报错 / 断言未命中（界面据此选文案） */
      reason?: 'bridge' | 'expect'
      note?: string
      target?: string
      targetIndex?: number
    }
  | { type: 'error'; stepIndex?: number; message: string; target?: string; targetIndex?: number }

export type HealthView = {
  ok: boolean
  bridgeUp: boolean
  queue: number
  snippets: number
  quarantined: number
}

/** `/api/runs` 列表项：档案首行 meta + 末行 summary 的合并视图 */
export type RunListItem = {
  runId: string
  snippetId: string
  title?: string
  targets: string[]
  startedAt: number
  caller?: { ip?: string; ua?: string }
  vars?: Record<string, string>
  varsRedacted?: string[]
  ok: boolean
  durationMs?: number
  panes: {
    target: string
    targetIndex: number
    ok: boolean
    exitCode?: number
    durationMs?: number
    timedOut?: boolean
    reason?: 'bridge' | 'expect'
    note?: string
  }[]
  eventCount: number
}

export type RunDetailView = {
  meta: Omit<RunListItem, 'ok' | 'durationMs' | 'panes' | 'eventCount'>
  events: RunEvent[]
  summary: {
    ok: boolean
    durationMs?: number
    panes: RunListItem['panes']
  } | null
}

/** `/api/sessions` 的一项：终端会话（P5.1） */
export type SessionView = {
  id: string
  kind: 'local'
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  lastActiveAt: number
  state: 'running' | 'exited'
  exitCode?: number
  attached: number
}

export type SessionsView = {
  enabled: boolean
  shells: string[]
  sessions: SessionView[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 原始响应正文，只给 console / debug 看，不要显示给用户 */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 把错误响应体变成人话。
 * 服务端所有 400 都返回 `{error:"……"}`，直接 `throw new Error(await r.text())` 会让
 * 界面上出现 `ApiError: {"error":"targets 最多 8 个"}` 这种东西（ISSUE-007）。
 */
function parseError(status: number, text: string): ApiError {
  let message = text.slice(0, 200)
  try {
    const j = JSON.parse(text) as { error?: unknown }
    if (j && typeof j.error === 'string' && j.error.trim()) message = j.error
  } catch {
    // 不是 JSON（比如反代返回的 HTML）就用原文前 200 字
  }
  return new ApiError(status, message, text)
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
  // **只有真的带 body 才声明 content-type。**
  // 反过来（无条件设 application/json）会让 DELETE 这种无 body 的请求被
  // Fastify 的空体解析器直接 400：`FST_ERR_CTP_EMPTY_JSON_BODY`。
  // 症状极具欺骗性——前端 catch 掉错误、本地把行删了，界面看着「成功」，
  // 服务端其实一次都没删（2026-10-30 实测 9 次 DELETE 全 400，见 ISSUE-019）。
  const headers: Record<string, string> = { ...authHeaders() }
  if (init?.body !== undefined && init.body !== null) headers['Content-Type'] = 'application/json'
  const r = await fetch(path, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
  })
  if (!r.ok) throw parseError(r.status, await r.text())
  return (await r.json()) as T
}

export const api = {
  snippets: () => req<SnippetView[]>('/api/snippets'),
  hosts: () => req<HostView[]>('/api/hosts'),
  health: () => req<HealthView>('/api/health'),
  /** 编辑用：完整字段 + mtime（列表里的 SnippetView 只有摘要） */
  snippetDetail: (id: string) =>
    req<SnippetDetail>(`/api/snippets/${encodeURIComponent(id)}/detail`),
  createSnippet: (input: SnippetSaveInput) =>
    req<SnippetSaveResult>('/api/snippets', { method: 'POST', body: JSON.stringify(input) }),
  updateSnippet: (id: string, input: SnippetSaveInput) =>
    req<SnippetSaveResult>(`/api/snippets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** 删除会先把副本放进 snippets/.trash/，返回的 backup 是那份副本的相对路径 */
  deleteSnippet: (id: string) =>
    req<{ ok: boolean; id: string; backup: string }>(
      `/api/snippets/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  runs: (limit = 20, snippet?: string) =>
    req<RunListItem[]>(
      `/api/runs?limit=${limit}${snippet ? `&snippet=${encodeURIComponent(snippet)}` : ''}`,
    ),
  runDetail: (runId: string) => req<RunDetailView>(`/api/runs/${encodeURIComponent(runId)}`),
  sessions: () => req<SessionsView>('/api/sessions'),
  createSession: (shell: string, cols: number, rows: number) =>
    req<SessionView>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ shell, cols, rows }),
    }),
  deleteSession: (id: string) =>
    req<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  preview: (id: string, vars: Record<string, string>) =>
    req<{ cmds: string[]; pending: string[]; missing: string[]; redacted: string[] }>(
      `/api/snippets/${encodeURIComponent(id)}/preview`,
      { method: 'POST', body: JSON.stringify({ vars }) },
    ),
  /**
   * `targets` 里同一目标可以重复出现（P3 同目标多开）；
   * 只有一条时也可以只传它，服务端不再需要单独的 `target` 字段。
   *
   * `onStart` 在拿到 200 响应头之后、读流之前调用：调用方要等这一刻再开输出抽屉，
   * 否则被 400 拒掉的请求也会先长出 N 块空面板（ISSUE-007）。
   */
  run: (
    id: string,
    vars: Record<string, string>,
    confirmed: boolean,
    targets: string[],
    onEvent: (ev: RunEvent) => void,
    onStart?: () => void,
  ) =>
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(
        targets.length > 0
          ? { id, vars, confirm: confirmed, targets }
          : { id, vars, confirm: confirmed },
      ),
    }).then(async (r) => {
      if (!r.ok) throw parseError(r.status, await r.text())
      onStart?.()
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

/**
 * 终端 WS 地址。
 *
 * token 只能走 query：浏览器的 WebSocket 构造函数不支持自定义 header。
 * 服务端在 upgrade 阶段自己校验（不走 Fastify hook，也没有 loopback 豁免），
 * 所以这里的 token 缺失就等于连不上——前端必须保证它非空。
 */
export function sessionWsUrl(id: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = encodeURIComponent(getToken())
  return `${proto}//${location.host}/ws/session/${encodeURIComponent(id)}?token=${token}`
}
