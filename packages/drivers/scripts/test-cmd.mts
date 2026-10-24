/**
 * exec 驱动保真度回归：临时 .bat 路径最容易悄悄改变命令语义，
 * 这里把已知的坑钉成断言（% 落单、中文、引号、管道、超时）。
 *
 * 注意：`set FOO=bar&& echo %FOO%` 这类「同一行先设后用」在 cmd 里
 * 本来就是解析期展开，交互式与批处理行为一致，不算回归。
 *
 * 运行：npm run test:cmd（在 packages/drivers 下）
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ExecDriver } from '../src/exec'

const TMP_DIR = resolve(fileURLToPath(new URL('../../../data/tmp', import.meta.url)))
const driver = new ExecDriver({ bridgeRoot: 'C:\\ahk_trigger', tmpDir: TMP_DIR })

type RunOut = { out: string; ok: boolean; timedOut: boolean; code?: number }

async function run(cmd: string, timeout = 20): Promise<RunOut> {
  let out = ''
  let ok = false
  let timedOut = false
  let code: number | undefined
  for await (const ev of driver.run({ shell: 'cmd', cmd, timeout, queue: true, stepIndex: 0 })) {
    if (ev.type === 'stdout') out += ev.data
    if (ev.type === 'exit') {
      ok = ev.ok
      code = ev.exitCode
      timedOut = !!ev.timedOut
    }
  }
  return { out: out.trim(), ok, timedOut, code }
}

const cases: { name: string; cmd: string; expect: (r: RunOut) => boolean; detail?: string }[] = [
  { name: '落单 % 不被吞', cmd: 'echo 100%', expect: (r) => r.out === '100%' },
  { name: '%% 转义成单个 %', cmd: 'echo %%', expect: (r) => r.out === '%' },
  { name: '中文（临时 bat / GBK）', cmd: 'echo 你好中文 && echo ok', expect: (r) => r.out.includes('你好中文') && r.out.includes('ok') },
  { name: '引号直传', cmd: 'echo "a b"', expect: (r) => r.out === '"a b"' },
  { name: '管道', cmd: 'echo a|findstr a', expect: (r) => r.out === 'a' },
  { name: '多行脚本', cmd: 'echo one\r\necho two', expect: (r) => r.out.includes('one') && r.out.includes('two') },
  { name: '非零退出码', cmd: 'exit /b 3', expect: (r) => !r.ok && r.code === 3 },
]

const failures: string[] = []
for (const c of cases) {
  const r = await run(c.cmd)
  const ok = c.expect(r)
  console.log(`${ok ? '✓' : '✗'} ${c.name.padEnd(22)} exit=${r.code ?? '-'} out=${JSON.stringify(r.out)}`)
  if (!ok) failures.push(`${c.name}${c.detail ? ` (${c.detail})` : ''}`)
}

// 超时：必须在 ~1s 被砍掉并标 timedOut，而不是等命令自己结束
const t = await run('ping -n 6 127.0.0.1 > nul', 1)
const timedOutOk = t.timedOut && !t.ok
console.log(`${timedOutOk ? '✓' : '✗'} 超时被终止              timedOut=${t.timedOut} ok=${t.ok}`)
if (!timedOutOk) failures.push('超时未正确标记 timedOut')

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败: ${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\n✓ 命令保真度全部通过')
