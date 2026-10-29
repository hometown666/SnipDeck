/**
 * `expect` 条件步回归测试（P4）。
 *
 * 不打真桥：用一个假 Driver 按 `cmd` 回放预设输出，把判定逻辑单独钉住。
 *
 * 钉的六件事：
 *   1) `from: last` 只看紧邻的上一条 run 步（sleep 会被跳过）；
 *   2) 不匹配 = 失败，非 optional 时后续步骤不执行；
 *   3) `optional: true` 失败也继续；
 *   4) `flags: i` 真的不区分大小写；
 *   5) `from: all` 能看见更早的步骤；
 *   6) `from: file:` 会**轮询等待**，超时判失败（这是唯一真耗时的来源）。
 *
 * 运行：npm run test:expect（在 packages/core 下）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSnippet } from '../src/runner'
import { validateSnippet } from '../src/snippets'
import type { Driver, RunEvent, Snippet } from '../src/types'

const FIXTURE = mkdtempSync(join(tmpdir(), 'snipdeck-expect-'))

/** 按 cmd 回放预设输出；没配的 cmd 回显 `ok` */
function fakeDriver(map: Record<string, string>): Driver {
  return {
    kind: 'fake',
    async *run(req): AsyncGenerator<RunEvent> {
      yield { type: 'start', stepIndex: req.stepIndex, cmd: req.cmd }
      const out = map[req.cmd] ?? 'ok'
      if (out) yield { type: 'stdout', stepIndex: req.stepIndex, data: out }
      yield { type: 'exit', stepIndex: req.stepIndex, ok: true, exitCode: 0, durationMs: 1 }
    },
  }
}

function snippet(steps: Snippet['steps'], vars?: Snippet['vars']): Snippet {
  return { id: 'test', steps, vars, file: 'test.yaml' }
}

async function collect(s: Snippet, driver: Driver, vars?: Record<string, string>) {
  const events: RunEvent[] = []
  for await (const ev of runSnippet(s, driver, { vars })) events.push(ev)
  const steps = events.filter((e) => e.type === 'step')
  const exit = events.find((e) => e.type === 'exit')
  const ran = events.filter((e) => e.type === 'start' && e.stepIndex >= 0).map((e) => e.stepIndex)
  return { events, steps, exit, ran }
}

let pass = 0
let fail = 0
function check(label: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label} ${extra}`)
  }
}

async function main(): Promise<void> {
  // 1. last 命中
  {
    const d = fakeDriver({ 'echo hi': 'bridge alive slot=wechat#1' })
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo hi' },
        { do: 'expect', match: 'slot=wechat#\\d' },
      ]),
      d,
    )
    const st = r.steps[1]
    check('last 命中 → step ok', st?.ok === true && st.type === 'step', JSON.stringify(st))
    check('命中带 matched 文本', st?.type === 'step' && /slot=wechat#1/.test(st.matched ?? ''), JSON.stringify(st))
    check('last 命中 → 整条 exit ok', r.exit?.type === 'exit' && r.exit.ok === true)
  }

  // 2. last 不匹配 → 失败且中止
  {
    const d = fakeDriver({ 'echo hi': 'no such slot' })
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo hi' },
        { do: 'expect', match: 'slot=\\w+' },
        { do: 'run', cmd: 'echo never' },
      ]),
      d,
    )
    const st = r.steps[1]
    check('不匹配 → step 失败', st?.type === 'step' && st.ok === false, JSON.stringify(st))
    check('不匹配 → note 写明未匹配', st?.type === 'step' && /未匹配/.test(st.note ?? ''), JSON.stringify(st))
    check('不匹配 → 第 3 步没跑', !r.ran.includes(2), JSON.stringify(r.ran))
    check('不匹配 → exit false', r.exit?.type === 'exit' && r.exit.ok === false)
  }

  // 3. optional 失败继续
  {
    const d = fakeDriver({ 'echo a': 'nothing' })
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo a' },
        { do: 'expect', match: 'impossible', optional: true },
        { do: 'run', cmd: 'echo b' },
      ]),
      d,
    )
    check('optional 失败不中止', r.ran.includes(2), JSON.stringify(r.ran))
    check('optional 仍如实标失败', r.steps[1]?.type === 'step' && r.steps[1].ok === false)
    check('optional 之后 exit 仍 ok', r.exit?.type === 'exit' && r.exit.ok === true)
  }

  // 4. flags: i
  {
    const d = fakeDriver({ 'echo x': 'Bridge UP' })
    const r1 = await collect(
      snippet([
        { do: 'run', cmd: 'echo x' },
        { do: 'expect', match: 'bridge up' },
      ]),
      d,
    )
    const r2 = await collect(
      snippet([
        { do: 'run', cmd: 'echo x' },
        { do: 'expect', match: 'bridge up', flags: 'i' },
      ]),
      d,
    )
    check('无 flags 时大小写敏感 → 失败', r1.steps[1]?.type === 'step' && r1.steps[1].ok === false)
    check('flags: i → 命中', r2.steps[1]?.type === 'step' && r2.steps[1].ok === true)
  }

  // 5. from: all（中间隔了 sleep）
  {
    const d = fakeDriver({ 'echo a': 'alpha', 'echo b': 'beta' })
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo a' },
        { do: 'sleep', ms: 10 },
        { do: 'run', cmd: 'echo b' },
        { do: 'expect', match: 'alpha', optional: true },
        { do: 'expect', match: 'alpha', from: 'all' },
      ]),
      d,
    )
    check('last 只看上一步 → 找不到 alpha', r.steps[3]?.type === 'step' && r.steps[3].ok === false)
    check('from: all 能找到更早的 alpha', r.steps[4]?.type === 'step' && r.steps[4].ok === true)
  }

  // 5b. sleep 不占用 last 的「上一步」位置
  {
    const d = fakeDriver({ 'echo a': 'alpha' })
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo a' },
        { do: 'sleep', ms: 5 },
        { do: 'expect', match: 'alpha' },
      ]),
      d,
    )
    check('sleep 之后 expect 仍能回溯到上一条 run', r.steps[2]?.type === 'step' && r.steps[2].ok === true)
  }

  // 6. from: file 轮询等待（文件在 300ms 后才出现匹配内容）
  {
    const log = join(FIXTURE, 'later.log')
    const d = fakeDriver({ 'echo start': 'started' })
    const s = snippet([
      { do: 'run', cmd: 'echo start' },
      { do: 'expect', match: 'listening', from: `file:${log}`, timeout: 5, interval: 50 },
    ])
    writeFileSync(log, 'booting\n', 'utf8')
    setTimeout(() => writeFileSync(log, 'booting\nlistening on 7878\n', 'utf8'), 300)
    const t0 = Date.now()
    const r = await collect(s, d)
    const ms = Date.now() - t0
    check('file: 等到匹配 → ok', r.steps[1]?.type === 'step' && r.steps[1].ok === true, JSON.stringify(r.steps[1]))
    check('file: 真的等了 ≥250ms（不是一次读完就判）', ms >= 250, `${ms}ms`)
  }

  // 7. from: file 超时 → 失败
  {
    const log = join(FIXTURE, 'never.log')
    writeFileSync(log, 'nothing here\n', 'utf8')
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo start' },
        { do: 'expect', match: 'listening', from: `file:${log}`, timeout: 0.4, interval: 50 },
      ]),
      fakeDriver({}),
    )
    const st = r.steps[1]
    check('file: 超时 → 失败', st?.type === 'step' && st.ok === false, JSON.stringify(st))
    check('超时 note 说明等了多久', st?.type === 'step' && /等待 0s|等待 1s|未匹配/.test(st.note ?? ''), st?.type === 'step' ? st.note : '')
    check('超时 → exit false', r.exit?.type === 'exit' && r.exit.ok === false)
  }

  // 7b. file 不存在也不崩（服务还没写日志）
  {
    const log = join(FIXTURE, 'missing-dir', 'none.log')
    const r = await collect(
      snippet([
        { do: 'run', cmd: 'echo start' },
        { do: 'expect', match: 'x', from: `file:${log}`, timeout: 0.2, interval: 50, optional: true },
      ]),
      fakeDriver({}),
    )
    check('file 不存在 → 判失败但不抛异常', r.steps[1]?.type === 'step' && r.steps[1].ok === false)
    check('没有 error 事件（不是崩溃）', !r.events.some((e) => e.type === 'error'))
  }

  // 8. 前面没有 run 步
  {
    const r = await collect(snippet([{ do: 'expect', match: 'x' }]), fakeDriver({}))
    const st = r.steps[0]
    check('first-step expect → 失败并说明没有输出', st?.type === 'step' && st.ok === false && /没有可检查/.test(st.note ?? ''), JSON.stringify(st))
  }

  // 9. from 里带变量
  {
    const log = join(FIXTURE, 'var.log')
    writeFileSync(log, 'job5 exit=0\n', 'utf8')
    const r = await collect(
      snippet(
        [
          { do: 'run', cmd: 'echo start' },
          { do: 'expect', match: 'exit=0', from: 'file:{{dir}}', timeout: 1 },
        ],
        { dir: { default: log } },
      ),
      fakeDriver({}),
    )
    check('from 支持 {{var}} 渲染', r.steps[1]?.type === 'step' && r.steps[1].ok === true, JSON.stringify(r.steps[1]))
  }

  // 10. 校验层：坏的正则 / 坏的 from 在加载时就 quarantine
  {
    const bad = validateSnippet({
      id: 'bad',
      steps: [{ do: 'expect', match: '(unclosed' }],
    })
    check('非法正则 → 校验报错', bad.some((e) => /正则无效/.test(e)), JSON.stringify(bad))

    const badFrom = validateSnippet({
      id: 'bad2',
      steps: [{ do: 'expect', match: 'x', from: 'socket:1' }],
    })
    check('非法 from → 校验报错', badFrom.some((e) => /expect\.from/.test(e)), JSON.stringify(badFrom))

    const noMatch = validateSnippet({ id: 'bad3', steps: [{ do: 'expect' }] })
    check('缺 match → 校验报错', noMatch.some((e) => /缺 match/.test(e)), JSON.stringify(noMatch))

    const okStep = validateSnippet({
      id: 'good',
      steps: [
        { do: 'run', cmd: 'echo hi' },
        { do: 'expect', match: 'h.', flags: 'i', from: 'all' },
      ],
    })
    check('合法 expect 通过校验', okStep.length === 0, JSON.stringify(okStep))
  }

  try {
    rmSync(FIXTURE, { recursive: true, force: true })
  } catch (e) {
    console.warn(`  ~ 清理失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
