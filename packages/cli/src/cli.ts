#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SnippetStore,
  groupOf,
  loadHosts,
  renderTolerant,
  resolveTarget,
  resolveVars,
  runSnippet,
} from '@snipdeck/core'
import { createDriver, ExecDriver } from '@snipdeck/drivers'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DATA_DIR = resolve(REPO_ROOT, process.env.SNIPDECK_DATA ?? 'data')
const SNIPPETS_DIR = resolve(DATA_DIR, 'snippets')
const HOSTS_FILE = resolve(DATA_DIR, 'hosts.yaml')
const TMP_DIR = resolve(DATA_DIR, 'tmp')

const [cmd = 'help', ...rest] = process.argv.slice(2)
const flag = (name: string) => rest.includes(`--${name}`)
const positional = rest.filter((a) => !a.startsWith('--') && !a.includes('='))

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
              `${ev.ok ? '✓' : '✗'} step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms${ev.note ? ' · ERR' : ''}`,
            )
            break
          case 'exit':
            failed = !ev.ok
            console.log(
              failed
                ? `✗ ${ev.timedOut ? '超时被终止' : ev.note ? `桥侧报错（退出码 ${ev.exitCode ?? 0}）` : `failed exit=${ev.exitCode ?? '-'}`}`
                : `✓ done ${ev.durationMs}ms`,
            )
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
      console.log('snip list | search <q> | run <id> [--var k=v | --k=v ...] [--yes] | hosts | status | reindex')
      console.log(`data dir: ${DATA_DIR}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
