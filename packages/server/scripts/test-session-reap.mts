/**
 * 会话回收的真时长验收（ISSUE-020）。
 *
 * 为什么单独一个脚本、且**不进 npm test**：
 * 主测试里跑的是 `graceMs: 800` 的缩短版，而 ISSUE-020 记录的那次故障恰恰是
 * 「缩短版过了、真实 60 秒没过」。缩短版测的是「定时器会 fire」，
 * 真实时长测的是「定时器在 60 秒这个量级上仍会 fire」——后者会被
 * 事件循环长任务、系统休眠、`unref()` 与进程生命周期交互等一堆东西影响。
 *
 * 两条路径并行跑（约 70 秒）：
 *   A. 创建后没人连（constructor 里的 armGrace）
 *   B. 连上 → 用一会儿 → 断开（detach 里的 armGrace）
 *
 * 判据三条：进程真的没了、日志里有 grace-fire(kill=true)、kill 的 reason 是 grace。
 *
 * 运行：npm run test:session-reap
 * 只验 A 或只调宽限期：REAP_GRACE_MS=5000 npm run test:session-reap
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type Session } from '../src/sessions'

const GRACE_MS = Number(process.env.REAP_GRACE_MS ?? 60_000)
/** 宽限期之外再给多少余量：定时器 fire 到 taskkill 完成不是瞬间的 */
const SLACK_MS = 10_000

const problems: string[] = []
function check(name: string, ok: boolean, extra?: string): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    problems.push(name)
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function pidAlive(pid: number): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return out.includes(String(pid))
  } catch {
    return false
  }
}

function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer)
        done(true)
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer)
        done(false)
      }
    }, 100)
  })
}

const dataDir = mkdtempSync(join(tmpdir(), 'snipdeck-reap-'))
mkdirSync(join(dataDir, 'sessions'), { recursive: true })

const logs: string[] = []
const mgr = new SessionManager({
  pidDir: join(dataDir, 'sessions'),
  cwd: process.cwd(),
  graceMs: GRACE_MS,
  log: (level, msg) => {
    logs.push(`${level} ${msg}`)
  },
})

const t0 = Date.now()
console.log(`宽限期 ${GRACE_MS}ms，两条路径并行，预计 ${Math.round((GRACE_MS + SLACK_MS) / 1000)}s 内出结果\n`)

const nobody: Session = mgr.create({ shell: 'cmd' })
const used: Session = mgr.create({ shell: 'cmd' })
const nobodyPid = nobody.pid
const usedPid = used.pid
console.log(`  A（没人连）id=${nobody.id} pid=${nobodyPid}`)

// B：连上、写一句、再断开——这正是真机上「关掉页面」的路径
const off = used.attach({
  onData: () => undefined,
  onExit: () => undefined,
})
used.write('echo reap-probe\r')
await new Promise((r) => setTimeout(r, 800))
off()
console.log(`  B（连上后断开）id=${used.id} pid=${usedPid}\n`)

console.log('等宽限期走完…')
const [aGone, bGone] = await Promise.all([
  waitFor(() => !pidAlive(nobodyPid), GRACE_MS + SLACK_MS),
  waitFor(() => !pidAlive(usedPid), GRACE_MS + SLACK_MS),
])
const took = Date.now() - t0

console.log('')
check('A 没人连 → 进程被回收', aGone, `pid=${nobodyPid} 仍存活`)
check('B 连上后断开 → 进程被回收', bGone, `pid=${usedPid} 仍存活`)
check(
  `回收耗时在宽限期内（${Math.round(took / 1000)}s ≤ ${Math.round((GRACE_MS + SLACK_MS) / 1000)}s）`,
  took <= GRACE_MS + SLACK_MS,
)

// 日志闭环：没有这三条，说明修的是别的地方（ISSUE-020 当时最大的困境就是没有痕迹）
const hasArm = logs.some((l) => l.includes('grace-arm'))
const hasFire = logs.some((l) => l.includes('grace-fire') && l.includes('kill=true'))
const hasKill = logs.some((l) => l.includes('reason=grace'))
check('日志有 grace-arm', hasArm)
check('日志有 grace-fire（kill=true）', hasFire)
check('日志有 kill reason=grace', hasKill)

if (problems.length > 0) {
  console.log('\n最近 20 条会话日志：')
  for (const l of logs.slice(-20)) console.log(`  ${l}`)
}

mgr.disposeAll()
try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  // 清理失败不影响结论
}

console.log(`\n结果: ${problems.length === 0 ? '全部通过' : `${problems.length} 项未通过`}`)
process.exit(problems.length === 0 ? 0 : 1)
