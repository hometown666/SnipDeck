/**
 * 环境变量注入回归：网页上改的 PROG_DIR / AHK_DIR 必须真的到达子进程。
 *
 * 这条链有三段，任何一段断了设置页都是摆设：
 *   设置文件 → buildApp 的 extraEnv 闭包 → ExecDriver spawn 的 env → cmd → (%VAR%)
 *
 * 这里只测最容易被写错的两段：驱动传没传、传的是不是「每次现取」。
 * 「设置文件 → 闭包」在冒烟里用 /api/settings 验。
 *
 * 运行：npm run test:env（在 packages/drivers 下）
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ExecDriver } from '../src/exec'

const TMP_DIR = resolve(fileURLToPath(new URL('../../../data/tmp', import.meta.url)))

let pass = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

async function runOn(driver: ExecDriver, cmd: string): Promise<{ out: string; ok: boolean }> {
  let out = ''
  let ok = false
  for await (const ev of driver.run({ shell: 'cmd', cmd, timeout: 20, queue: true, stepIndex: 0 })) {
    if (ev.type === 'stdout') out += ev.data
    if (ev.type === 'exit') ok = ev.ok
  }
  return { out: out.trim(), ok }
}

const base = { bridgeRoot: 'C:\\ahk_trigger', tmpDir: TMP_DIR }

// 1) 注入后子进程能读到（用方括号包住，避免空值时看不出边界）
const injected = new ExecDriver({ ...base, extraEnv: () => ({ PROG_DIR: 'D:\\probe dir' }) })
const a = await runOn(injected, 'echo [%PROG_DIR%]')
check('注入成功', a.ok && a.out === '[D:\\probe dir]', a.out)

// 2) 不注入时是空/未定义，不会被上一次污染
//    宿主机若自己设了 PROG_DIR，这条会误判 —— 临时摘掉再跑
const hadProgDir = process.env.PROG_DIR
delete process.env.PROG_DIR
const plain = new ExecDriver({ ...base })
const b = await runOn(plain, 'echo [%PROG_DIR%]')
// 未定义的 %VAR% 在这里会展开成空串（不是保留字面量），所以期望 '[]' 而不是 '[%PROG_DIR%]'
check('不注入时为空', b.ok && b.out === '[]', b.out)
if (hadProgDir !== undefined) process.env.PROG_DIR = hadProgDir

// 3) 每次现取：同一个 driver 实例，改完闭包里的值，下一条命令立刻变
let current = { PROG_DIR: 'D:\\first' }
const live = new ExecDriver({ ...base, extraEnv: () => current })
const c1 = await runOn(live, 'echo [%PROG_DIR%]')
current = { PROG_DIR: 'D:\\second' }
const c2 = await runOn(live, 'echo [%PROG_DIR%]')
check('同一个实例改配置立刻生效', c1.out === '[D:\\first]' && c2.out === '[D:\\second]', `${c1.out} → ${c2.out}`)

// 4) 注入 env 不能把基础环境挤掉：传 env 时 Node 不会自动合并 process.env
const pathOk = await runOn(injected, 'echo [%SystemRoot%]')
check('注入后基础环境还在（SystemRoot）', pathOk.out.length > 3 && !pathOk.out.includes('%'), pathOk.out)

// 5) 空对象等价于不注入
const empty = new ExecDriver({ ...base, extraEnv: () => ({}) })
const d = await runOn(empty, 'echo [%AHK_DIR%]')
check('空对象不注入任何东西', d.out === '[]', d.out)

console.log('')
if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f}`)
  process.exit(1)
}
console.log(`环境注入 ${pass} 项通过`)
