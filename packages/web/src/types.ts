/**
 * 前端共用类型与常量。
 *
 * 从 App.tsx 抽出来的原因：这些类型被抽屉、表单、历史弹窗共同引用，
 * 留在 App 里就得靠循环 import 或者 props 传 any。纯类型文件没有副作用。
 */
import type { SnippetView } from './api'

export type VarDraft = Record<string, string>

/** 输出行带语义：桌面端要按类型上色，不能全拍平成纯文本 */
export type LineKind = 'cmd' | 'step' | 'queue' | 'out' | 'err' | 'meta'
export type Line = { kind: LineKind; text: string; ok?: boolean }

/** 一个目标一块面板。多目标时并列展示，单目标时只渲染它、不显示面板头 */
export type Pane = {
  target: string
  index: number
  lines: Line[]
  running: boolean
  ok?: boolean
  startedAt: number
  durationMs?: number
  exitCode?: number
  timedOut?: boolean
  /** 失败来源：桥侧报错 / 断言未命中。文案据此选，不再靠 note 有没有值去猜 */
  reason?: 'bridge' | 'expect'
  /** 失败的具体说明（桥报错原因、未匹配的正则、等了多久…） */
  note?: string
}

export type Output = {
  id: string
  panes: Pane[]
  startedAt: number
  /** 服务端档案编号：首条 start 事件带回来，断开后能凭它回看 */
  runId?: string
  /** 从档案回放出来的（不是本次真跑的）：不跑计时、头部显示历史时间 */
  replayed?: boolean
  replayedAt?: number
}

export type Draft = {
  snippet: SnippetView
  vars: VarDraft
  confirmed: boolean
  targets: string[]
}

export const MAX_LINES = 2000
/** 与服务端 packages/server/src/app.ts 的 MAX_TARGETS 对齐（那边只是防呆，前端也拦一道才有好体验） */
export const MAX_TARGETS = 8
