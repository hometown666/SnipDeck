#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RunLog,
  SnippetStore,
  groupOf,
  loadHosts,
  parseHistorySource,
  planImport,
  renderTolerant,
  resolveTarget,
  resolveVars,
  runSnippet,
  writePlan,
  type RunEvent,
} from '@snipdeck/core'
import { createDriver, ExecDriver } from '@snipdeck/drivers'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DATA_DIR = resolve(REPO_ROOT, process.env.SNIPDECK_DATA ?? 'data')
const SNIPPETS_DIR = resolve(DATA_DIR, 'snippets')
const HOSTS_FILE = resolve(DATA_DIR, 'hosts.yaml')
const TMP_DIR = resolve(DATA_DIR, 'tmp')
const RUNS_DIR = resolve(DATA_DIR, 'runs')

const [cmd = 'help', ...rest] = process.argv.slice(2)
const flag = (name: string) => rest.includes(`--${name}`)
const positional = rest.filter((a) => !a.startsWith('--') && !a.includes('='))

/** `--name=value` 与 `--name value` 两种写法都认 */
function opt(name: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === `--${name}`) return rest[i + 1]
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return undefined
}

function parseVars(args: string[]): Record<string, string> {
  const vars: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    // 两种写法都认：`--var k=v` 与 `--k=v`
    if (a === '--var') {
      const kv = args[i + 1]
      const eq = kv ? kv.indexOf('=') : -1
      if (kv && eq > 0) {
        vars[kv.slice(0, eq)] = kv.slice(eq + 1)
        i++
      }
      continue
    }
    if (a.startsWith('--var=')) {
      const kv = a.slice('--var='.length)
      const eq = kv.indexOf('=')
      if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1)
      continue
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) vars[a.slice(2, eq)] = a.slice(eq + 1)
    }
  }
  return vars
}

function previewCmd(snippet: ReturnType<SnippetStore['get']> & object, vars: Record<string, string>): string[] {
  if (!snippet) return []
  const { values } = resolveVars(snippet, vars)
  // 预览用容错渲染：缺变量时保留 {{x}}，别让「看一眼最终命令」变成一次异常
  return snippet.steps.filter((s) => s.do === 'run').map((s) => renderTolerant(s.cmd, values))
}

/**
 * 失败结局的一句话说明。
 * 三种失败长得完全不一样：桥报错（退出码还是 0）、断言没命中（压根没有退出码）、
 * 命令自己返回非 0。以前一律打印「桥侧报错」，断言失败也被说成桥的问题（ISSUE-013）。
 */
function exitText(ev: Extract<RunEvent, { type: 'exit' }>): string {
  if (ev.timedOut) return `超时被终止${ev.note ? ` · ${ev.note}` : ''}`
  if (ev.reason === 'expect') return `断言未命中 · ${ev.note ?? '未命中'}`
  if (ev.reason === 'bridge') return `桥侧报错（退出码 ${ev.exitCode ?? 0}）`
  return `failed exit=${ev.exitCode ?? '-'}`
}

async function main(): Promise<void> {
  const store = new SnippetStore(SNIPPETS_DIR)
  const hosts = loadHosts(HOSTS_FILE)

  switch (cmd) {
    case 'list': {
      const groups = new Map<string, ReturnType<SnippetStore['list']>>()
      for (const s of store.list()) {
        const g = groupOf(s, SNIPPETS_DIR)
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(s)
      }
      for (const [g, items] of groups) {
        console.log(`\n[${g}]`)
        for (const s of items) {
          const mark = s.danger ? ' ! ' : '   '
          const vars = s.vars ? ` (${Object.keys(s.vars).join(', ')})` : ''
          console.log(`${mark}${s.id}${vars} - ${s.title ?? ''}`)
        }
      }
      for (const e of store.errors()) console.error(`QUARANTINE ${e.file}: ${e.error}`)
      break
    }

    case 'search': {
      const q = positional[0] ?? ''
      for (const s of store.search(q)) console.log(`${s.id} - ${s.title ?? ''}`)
      break
    }

    case 'hosts': {
      for (const [name, t] of Object.entries(hosts)) {
        console.log(`${t.reserved ? '(reserved)' : '          '} ${name}  driver=${t.driver}`)
      }
      break
    }

    case 'run': {
      const id = positional[0]
      if (!id) {
        console.error('usage: snip run <id> [--var k=v | --k=v ...] [--yes]')
        process.exitCode = 2
        break
      }
      const snippet = store.get(id)
      if (!snippet) {
        console.error(`snippet not found: ${id}`)
        process.exitCode = 2
        break
      }
      const vars = parseVars(rest)
      if (snippet.danger && !flag('yes')) {
        console.error('danger snippet, confirm with --yes. final command:')
        for (const c of previewCmd(snippet, vars)) console.error(`  $ ${c}`)
        process.exitCode = 2
        break
      }
      const { name, target } = resolveTarget(hosts, snippet.target)
      const driver = createDriver(target, { tmpDir: TMP_DIR })
      console.log(`→ target ${name} (${target.driver})`)
      let failed = false
      for await (const ev of runSnippet(snippet, driver, {
        vars,
        defaultTimeout: Number(target.timeout ?? 20),
        defaultShell: typeof target.shell === 'string' ? target.shell : undefined,
      })) {
        switch (ev.type) {
          case 'start':
            if (ev.cmd) console.log(`$ ${ev.cmd}`)
            break
          case 'queued':
            console.log(`⏳ 排队 ${(ev.waitedMs / 1000).toFixed(1)}s`)
            break
          case 'stdout':
            process.stdout.write(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')
            break
          case 'stderr':
            process.stderr.write(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')
            break
          case 'step':
            console.log(
              `${ev.ok ? '✓' : '✗'} step${ev.stepIndex}${
                ev.expect !== undefined
                  ? ` match /${ev.expect}/${ev.matched ? ` → ${ev.matched}` : ev.note ? ` · ${ev.note}` : ''}`
                  : ` exit=${ev.exitCode ?? '-'}${ev.note ? ' · ERR' : ''}`
              } ${ev.durationMs}ms`,
            )
            break
          case 'exit':
            failed = !ev.ok
            console.log(failed ? `✗ ${exitText(ev)}` : `✓ done ${ev.durationMs}ms`)
            break
          case 'error':
            failed = true
            console.error(`ERROR: ${ev.message}`)
            break
        }
      }
      if (failed) process.exitCode = 1
      break
    }

    case 'import-history': {
      const src = parseHistorySource(opt('from'))
      if (!existsSync(src.path)) {
        console.error(`历史文件不存在: ${src.path}`)
        process.exitCode = 2
        break
      }
      const group = opt('group') ?? '历史导入'
      const shell = opt('shell') === 'cmd' ? 'cmd' : 'powershell'
      const limit = Number(opt('limit') ?? 100) || 100
      const opts = {
        lines: readFileSync(src.path, 'utf8').split(/\r?\n/),
        snippetsDir: SNIPPETS_DIR,
        group,
        shell,
        limit,
        force: flag('force'),
        source: `${src.kind} · ${src.path}`,
      } as const
      const plan = planImport(opts)
      const fresh = plan.planned.filter((p) => p.state === 'new')
      console.log(`来源 ${src.path}`)
      console.log(
        `原始 ${plan.total} 行 → 丢弃 ${plan.dropped} 行（空行/去重/时间戳/噪声命令）→ 候选 ${plan.planned.length} 条，其中 ${fresh.length} 条可写`,
      )
      for (const p of plan.planned.slice(0, 20)) {
        console.log(`  ${p.state === 'skip' ? '~' : '+'}${p.danger ? '!' : ' '} ${p.id}  ${p.cmd.slice(0, 64)}`)
      }
      if (plan.planned.length > 20) console.log(`  … 还有 ${plan.planned.length - 20} 条`)
      if (!flag('write')) {
        console.log(`\n未写入（默认 dry-run）。确认无误后加 --write，落到 ${join(SNIPPETS_DIR, group)}/`)
        break
      }
      const written = writePlan(plan, opts)
      console.log(`\n写入 ${written} 条 → ${join(SNIPPETS_DIR, group)}/（已存在的跳过，不覆盖）`)
      break
    }

    case 'runs': {
      const log = new RunLog(RUNS_DIR)
      const arg = positional[0]
      const stamp = (ms: number) => new Date(ms).toLocaleString('sv-SE')
      if (arg && /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(arg)) {
        const d = log.read(arg)
        if (!d) {
          console.error(`run 不存在: ${arg}`)
          process.exitCode = 2
          break
        }
        console.log(`${d.meta.snippetId} · ${stamp(d.meta.startedAt)} · targets=${d.meta.targets.join(',')}`)
        if (d.meta.vars && Object.keys(d.meta.vars).length > 0) {
          console.log(`vars: ${Object.entries(d.meta.vars).map(([k, v]) => `${k}=${v}`).join(' ')}`)
        }
        for (const ev of d.events) {
          switch (ev.type) {
            case 'start':
              if (ev.stepIndex >= 0 && ev.cmd) console.log(`$ ${ev.cmd}`)
              break
            case 'queued':
              console.log(`⏳ 排队 ${(ev.waitedMs / 1000).toFixed(1)}s`)
              break
            case 'stdout':
              process.stdout.write(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')
              break
            case 'stderr':
              process.stderr.write(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')
              break
            case 'step':
              console.log(
                `${ev.ok ? '✓' : '✗'} step${ev.stepIndex}${
                  ev.expect !== undefined
                    ? ` match /${ev.expect}/${ev.matched ? ` → ${ev.matched}` : ''}`
                    : ` exit=${ev.exitCode ?? '-'}`
                } ${ev.durationMs}ms${ev.note ? ` · ${ev.note}` : ''}`,
              )
              break
            case 'error':
              console.error(`ERROR: ${ev.message}`)
              break
            case 'exit':
              // exit 在档案里每个目标一条，用 target 标出来，否则多目标时分不清谁收尾了
              console.log(
                `${ev.ok ? '✓' : '✗'} ${ev.target ?? ''} ${ev.ok ? 'done' : exitText(ev)} ${ev.durationMs}ms`,
              )
              break
          }
        }
        console.log(d.summary ? (d.summary.ok ? '\n档案：全部成功' : '\n档案：有失败') : '\n档案没有 summary（进程可能被强杀）')
        break
      }
      const n = Number(arg ?? 20) || 20
      const items = log.list(n)
      if (items.length === 0) {
        console.log(`还没有运行记录（${RUNS_DIR}）`)
        break
      }
      for (const r of items) {
        console.log(
          `${r.ok ? '✓' : '✗'} ${stamp(r.startedAt)}  ${r.snippetId}  ${r.targets.join(',')}  ${r.durationMs ?? '-'}ms  ${r.runId}`,
        )
      }
      break
    }

    case 'reindex': {
      store.reindex()
      console.log(`reindexed: ${store.list().length} snippets, ${store.errors().length} quarantined`)
      for (const e of store.errors()) console.error(`QUARANTINE ${e.file}: ${e.error}`)
      break
    }

    case 'status': {
      const { target } = resolveTarget(hosts, undefined)
      const driver = createDriver(target, { tmpDir: TMP_DIR })
      if (driver instanceof ExecDriver) {
        const ok = await driver.health()
        console.log(ok ? 'bridge: up' : 'bridge: down')
        if (!ok) process.exitCode = 1
      } else {
        console.log(`driver ${target.driver} is reserved (P5)`)
      }
      break
    }

    default:
      console.log(
        [
          'snip list | search <q> | run <id> [--var k=v | --k=v ...] [--yes] | hosts | status | reindex',
          'snip runs [n] | runs <runId>',
          'snip import-history [--from ps|bash|file:<path>] [--limit 100] [--group 历史导入] [--shell cmd|powershell] [--write] [--force]',
        ].join('\n'),
      )
      console.log(`data dir: ${DATA_DIR}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
