/**
 * 串行队列回归测试。
 *
 * 背景：command.txt 是单车道，两条并发桥命令会互相覆盖。
 * 这条不变式一旦退化成并行，GUI 动作就会静默丢失/串台，
 * 所以用「两条等长命令的总时长」把它钉住。
 *
 * 运行：npm run test:queue（在 packages/drivers 下）
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ExecDriver } from '../src/exec'

const TMP_DIR = resolve(fileURLToPath(new URL('../../../data/tmp', import.meta.url)))
const CMD = 'ping -n 3 127.0.0.1 > nul'
const SINGLE_EXPECT_MS = 1500

const driver = new ExecDriver({ bridgeRoot: 'C:\\ahk_trigger', tmpDir: TMP_DIR })

type Result = { ok: boolean; waited: number; ms: number }

async function once(): Promise<Result> {
  const t = Date.now()
  let ok = false
  let waited = 0
  for await (const ev of driver.run({
    shell: 'cmd',
    cmd: CMD,
    timeout: 30,
    queue: true,
    stepIndex: 0,
  })) {
    if (ev.type === 'queued') waited = ev.waitedMs
    if (ev.type === 'exit') ok = ev.ok
  }
  return { ok, waited, ms: Date.now() - t }
}

// 先空跑一次丢掉：第一次调用桥要走「起 cmd → 起 PS → 写文件」的冷路径，
// 比稳态慢 400~600ms。拿它当基准会让「严格串行」的比值掉到 1.7 以下
// （实测：冷 2574ms vs 稳态 2085ms，串行两条 4167ms → 1.62，误报成没串行）
await once()

const single = await once()
const t0 = Date.now()
const [a, b] = await Promise.all([once(), once()])
const total = Date.now() - t0

const problems: string[] = []
if (!single.ok) problems.push('单条命令执行失败')
if (single.ms < SINGLE_EXPECT_MS) problems.push(`单条耗时异常偏短（${single.ms}ms），测试基准不可信`)
if (!a.ok || !b.ok) problems.push('并发命令有失败')
if (total < single.ms * 1.7) {
  problems.push(`两条并发只用了 ${total}ms（单条 ${single.ms}ms）→ 队列没有串行`)
}
if (a.waited < 50 && b.waited < 50) problems.push('两条命令都没有收到 queued 事件')

console.log(`单条: ${single.ms}ms`)
console.log(`并发两条: ${total}ms（A 排队 ${a.waited}ms / B 排队 ${b.waited}ms）`)

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`)
  process.exit(1)
}
console.log('✓ 队列严格串行')
