export type StepRun = {
  do: 'run'
  cmd: string
  timeout?: number
  optional?: boolean
  queue?: boolean
}

export type StepSleep = {
  do: 'sleep'
  ms: number
  optional?: boolean
}

/**
 * 条件步：对**已有输出**做正则断言，不匹配即失败。
 *
 * `from` 三种来源：
 * - `last`（默认）= 前面最近一条 `run` 步的合并输出（stdout + stderr）
 * - `all` = 本次 run 里所有 `run` 步的合并输出
 * - `file:<path>` = 轮询读文件，直到匹配或超时
 *
 * **为什么要 `file:`**：exec 驱动是「跑完才吐整段输出」，所以 `last` / `all`
 * 立即判定，`timeout` 对它们没有意义。真正需要「等」的场景（等桥的 runlog
 * 出现 `<job>.exit`、等服务日志出现 listening），源头是文件，只有 `file:`
 * 会按 `interval` 轮询到 `timeout` 秒。
 */
export type StepExpect = {
  do: 'expect'
  /** 正则正文（不含 `/…/` 包裹）；`flags` 另给 */
  match: string
  /** 正则 flags，只用 `i` / `m` / `s`；填 `g` 会被去掉（有状态匹配会跳） */
  flags?: string
  from?: string
  /** 秒：仅 `file:` 源会真的等待 */
  timeout?: number
  /** 毫秒：`file:` 轮询间隔，默认 200 */
  interval?: number
  optional?: boolean
}

export type Step = StepRun | StepSleep | StepExpect

export type VarSpec = {
  prompt?: string
  default?: string | number
  choices?: (string | number)[]
  secret?: boolean
  from?: string
}

export type Snippet = {
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
  file: string
}

export type HostTarget = {
  driver: 'exec' | 'local' | 'ssh'
  shell?: string
  bridge?: string
  timeout?: number
  reserved?: boolean
  /** 片段未写 target 时优先落在这台；没标则取第一个非 reserved 目标 */
  default?: boolean
  [key: string]: unknown
}

export type RunRequest = {
  shell: string
  cmd: string
  timeout: number
  queue: boolean
  stepIndex: number
}

/**
 * 多目标执行时由 server 给每条事件打标：这条事件属于哪个目标。
 * `target` 是 hosts.yaml 的键（同一目标多开时会出现重复值），
 * `targetIndex` 是它在本次请求 `targets[]` 里的下标——重名时靠它区分。
 */
export type TargetTag = {
  target?: string
  targetIndex?: number
}

export type RunEvent =
  | ({ type: 'start'; stepIndex: number; cmd?: string; runId?: string } & TargetTag)
  | ({ type: 'queued'; stepIndex: number; waitedMs: number } & TargetTag)
  | ({ type: 'stdout'; stepIndex: number; data: string } & TargetTag)
  | ({ type: 'stderr'; stepIndex: number; data: string } & TargetTag)
  | ({
      type: 'step'
      stepIndex: number
      ok: boolean
      exitCode?: number
      durationMs?: number
      /** 失败但退出码为 0 时的说明（桥用 `ERR|` 前缀报错，见 runner） */
      note?: string
      /** `expect` 步命中时给出的实际匹配文本（截断到 120 字） */
      matched?: string
      /** `expect` 步用的正则源（失败时前端要能一眼看到在等什么） */
      expect?: string
    } & TargetTag)
  | ({
      type: 'exit'
      ok: boolean
      exitCode?: number
      durationMs?: number
      stepIndex?: number
      /** 被驱动超时杀掉（区别于命令自己返回非 0） */
      timedOut?: boolean
      /** 失败但退出码为 0 时的说明 */
      note?: string
    } & TargetTag)
  | ({ type: 'error'; stepIndex?: number; message: string } & TargetTag)

export interface Driver {
  readonly kind: string
  run(req: RunRequest): AsyncIterable<RunEvent>
}
