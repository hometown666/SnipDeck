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

export type Step = StepRun | StepSleep

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
  [key: string]: unknown
}

export type RunRequest = {
  shell: string
  cmd: string
  timeout: number
  queue: boolean
  stepIndex: number
}

export type RunEvent =
  | { type: 'start'; stepIndex: number; cmd?: string }
  | { type: 'stdout'; stepIndex: number; data: string }
  | { type: 'stderr'; stepIndex: number; data: string }
  | { type: 'step'; stepIndex: number; ok: boolean; exitCode?: number; durationMs?: number }
  | { type: 'exit'; ok: boolean; exitCode?: number; durationMs?: number; stepIndex?: number }
  | { type: 'error'; stepIndex?: number; message: string }

export interface Driver {
  readonly kind: string
  run(req: RunRequest): AsyncIterable<RunEvent>
}
