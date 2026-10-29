import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import type { StepExpect } from './types'

/**
 * `expect` 步的输出来源。
 * 解析成判别联合，是为了让「写错一个字」在**加载时**就变成 quarantine，
 * 而不是等真跑起来才在 UI 里报一句看不懂的话。
 */
export type ExpectSource = { kind: 'last' } | { kind: 'all' } | { kind: 'file'; path: string }

export function parseExpectFrom(
  from: string | undefined,
): ExpectSource | { kind: 'invalid'; error: string } {
  const f = (from ?? 'last').trim()
  if (f === '' || f === 'last') return { kind: 'last' }
  if (f === 'all') return { kind: 'all' }
  if (f.startsWith('file:')) {
    const path = f.slice('file:'.length).trim()
    if (!path) return { kind: 'invalid', error: 'expect.from 的 file: 后面缺路径' }
    return { kind: 'file', path }
  }
  return {
    kind: 'invalid',
    error: `expect.from 只能是 last / all / file:<路径>，收到 ${JSON.stringify(from)}`,
  }
}

/**
 * 只放行 i / m / s。`g` 必须去掉：`RegExp.test()` 在 `g` 下带 lastIndex 状态，
 * 同一个正则连测两次会一真一假——这种 bug 在片段里极难查。
 */
export function compileExpect(step: StepExpect): RegExp {
  const flags = [...new Set((step.flags ?? '').toLowerCase().split(''))]
    .filter((f) => f === 'i' || f === 'm' || f === 's')
    .join('')
  return new RegExp(step.match, flags)
}

export type ExpectResult = { ok: boolean; note?: string; matched?: string }

const HIT_MAX = 120

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > HIT_MAX ? `${one.slice(0, HIT_MAX)}…` : one
}

/**
 * 单次正则执行的硬上限。
 *
 * 灾难性回溯会把**整个服务**拖住：`(a+)+$` 对 30 个字符的单次 `test` 约 8s，
 * 期间 `/api/health`、队列、SSE 全停，而 `timeout` 字段救不了它——同步调用卡完
 * 才会去检查 deadline。JS 层没法中断一个正在跑的正则，唯一可靠的办法是把它
 * 放进 `vm` 里跑，让 V8 的 interrupt 机制按 timeout 打断（ISSUE-010）。
 *
 * 500ms 是权衡：正常正则跑 1MB 文本也就几毫秒，超过半秒基本只能是回溯爆炸。
 */
const REGEX_BUDGET_MS = 500

export type ExecOutcome =
  | { kind: 'hit'; matched: string }
  | { kind: 'miss' }
  | { kind: 'timeout' }

/**
 * 带预算的正则执行。
 *
 * 复用同一个 `vm` 上下文：Node 是单线程，`runInContext` 是同步调用，
 * 中间不可能被别的请求插进来改写 `re` / `text`，所以共享上下文是安全的，
 * 又省掉每次新建 context 的开销（`file:` 源每 200ms 就要跑一次）。
 */
let sandbox: vm.Context | null = null

export function execGuarded(re: RegExp, text: string, budgetMs = REGEX_BUDGET_MS): ExecOutcome {
  const ctx = (sandbox ??= vm.createContext({ re, text } as Record<string, unknown>))
  ctx.re = re
  ctx.text = text
  let m: RegExpExecArray | null
  try {
    m = vm.runInContext('re.exec(text)', ctx, { timeout: budgetMs, displayErrors: false }) as
      | RegExpExecArray
      | null
  } catch {
    // timeout 之外只可能是上下文自身的问题，一律按「这次没判定出来」处理
    return { kind: 'timeout' }
  }
  return m ? { kind: 'hit', matched: clip(m[0]) } : { kind: 'miss' }
}

/**
 * 按 BOM 与字节分布猜编码。
 *
 * 桥写的文件（`instances.txt` / `last_result.txt` / `status.txt` / `jobs/*.exit`）
 * 全是 **UTF-16 LE + BOM**（`ff fe`），而 `readFileSync(path, 'utf8')` 会读成
 * 夹着一堆 `\0` 的乱码：正则永远不命中，然后把失败归因成「文件还没写」——
 * 这个误判比 bug 本身更贵（ISSUE-009）。
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3)
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2)
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return swap16(buf).toString('utf16le')
  }
  // 无 BOM 的 UTF-16：ASCII 文本在 UTF-16 里每隔一个字节就是 0，
  // ASCII 的 UTF-8 文本几乎不会出现 0 字节，这个判据足够稳。
  const head = buf.subarray(0, Math.min(256, buf.length - (buf.length % 2)))
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== 0) continue
    if (i % 2 === 0) evenZero++
    else oddZero++
  }
  const threshold = head.length / 8
  if (head.length >= 8 && oddZero > threshold && oddZero > evenZero * 4) return buf.toString('utf16le')
  if (head.length >= 8 && evenZero > threshold && evenZero > oddZero * 4) return swap16(buf).toString('utf16le')

  // 最后一层：按 UTF-8 解出替换字符说明字节其实是 GBK（桥在 936 代码页下写的中文）。
  // 与驱动侧 `decodeOutput` 同一套判据——同一个桥写出来的东西，两边不该读得不一样。
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/** 大小端互换：`fe ff` 的 BE 文件按 LE 读会得到一堆 `琀`，换回来就正常 */
function swap16(buf: Buffer): Buffer {
  const even = buf.length - (buf.length % 2)
  const out = Buffer.from(buf.subarray(0, even))
  out.swap16()
  return out
}

/**
 * 统一换行。
 *
 * 桥写出来的文件是 CRLF，而 `^done$` 这类带 `m` 的锚点会把 `\r` 算进行尾，
 * 于是「文件里明明有 done 却匹配不上」。这类错误看起来像正则写错，实际是
 * 换行符不可见——和「多行 cmd 必须 CRLF」是同一类坑的两面。
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 判定一个 `expect` 步。
 *
 * - `last` / `all`：**立即**判定（exec 驱动整段返回输出，没有「还没到」的状态）
 * - `file:<path>`：轮询到 `timeout` 秒；文件不存在不算错（服务刚起、日志还没写）
 */
export async function runExpect(
  step: StepExpect,
  from: string | undefined,
  outputs: (string | undefined)[],
  stepIndex: number,
): Promise<ExpectResult> {
  let re: RegExp
  try {
    re = compileExpect(step)
  } catch (e) {
    return { ok: false, note: `正则无效: ${e instanceof Error ? e.message : String(e)}` }
  }

  const src = parseExpectFrom(from)
  if (src.kind === 'invalid') return { ok: false, note: src.error }

  const label = `/${step.match}/`
  if (src.kind === 'file') {
    const timeoutMs = Math.max(0, (step.timeout ?? 10) * 1000)
    const interval = Math.max(50, step.interval ?? 200)
    const deadline = Date.now() + timeoutMs
    let lastReadErr = ''
    let readOnce = false
    for (;;) {
      let text = ''
      try {
        text = normalizeNewlines(decodeText(readFileSync(src.path)))
        readOnce = true
        lastReadErr = ''
      } catch (e) {
        // 文件还没生成本身就是「再等等」，不是失败；但要记住原因，
        // 否则超时时只能说「未匹配」，让人去猜是不是路径写错了。
        lastReadErr = e instanceof Error ? e.message : String(e)
      }
      const hit = execGuarded(re, text)
      if (hit.kind === 'hit') return { ok: true, matched: hit.matched }
      if (hit.kind === 'timeout') {
        return {
          ok: false,
          note: `正则执行超过 ${REGEX_BUDGET_MS}ms（疑似灾难性回溯）：${label}（${src.path}）`,
        }
      }
      if (Date.now() >= deadline) {
        const secs = (timeoutMs / 1000).toFixed(timeoutMs % 1000 === 0 ? 0 : 1)
        return {
          ok: false,
          note: readOnce
            ? `等待 ${secs}s 未匹配 ${label}（${src.path}）`
            : `等待 ${secs}s 文件仍不可读 ${src.path}（${lastReadErr || '原因未知'}）`,
        }
      }
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
    }
  }

  let text: string
  if (src.kind === 'all') {
    text = outputs.filter((o): o is string => typeof o === 'string').join('\n')
    if (!text) return { ok: false, note: `前面没有可检查的命令输出（${label}）` }
  } else {
    let last: string | undefined
    for (let i = stepIndex - 1; i >= 0; i--) {
      if (typeof outputs[i] === 'string') {
        last = outputs[i]
        break
      }
    }
    if (last === undefined) {
      return { ok: false, note: `前面没有可检查的命令输出（${label}）` }
    }
    text = last
  }

  const hit = execGuarded(re, normalizeNewlines(text))
  if (hit.kind === 'timeout') {
    return { ok: false, note: `正则执行超过 ${REGEX_BUDGET_MS}ms（疑似灾难性回溯）：${label}` }
  }
  return hit.kind === 'hit' ? { ok: true, matched: hit.matched } : { ok: false, note: `未匹配 ${label}` }
}
