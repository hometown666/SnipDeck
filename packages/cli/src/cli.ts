#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SnippetStore,
  groupOf,
  loadHosts,
  renderString,
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
  for (const a of args) {
    const i = a.indexOf('=')
    if (a.startsWith('--') && i > 0) vars[a.slice(2, i)] = a.slice(i + 1)
  }
  return vars
}

function previewCmd(snippet: ReturnType<SnippetStore['get']> & object, vars: Record<string, string>): string[] {
  if (!snippet) return []
  const { values } = resolveVars(snippet, vars)
  return snippet.steps.filter((s) => s.do === 'run').map((s) => renderString(s.cmd, values))
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
        console.error('usage: snip run <id> [--var k=v ...] [--yes]')
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
      })) {
        switch (ev.type) {
          case 'start':
            if (ev.cmd) console.log(`$ ${ev.cmd}`)
            break
          case 'stdout':
            process.stdout.write(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')
            break
          case 'stderr':
            process.stderr.write(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')
            break
          case 'step':
            console.log(`✓ step${ev.stepIndex} exit=${ev.exitCode ?? '-'} ${ev.durationMs}ms`)
            break
          case 'exit':
            failed = !ev.ok
            console.log(failed ? `✗ failed exit=${ev.exitCode ?? '-'}` : `✓ done ${ev.durationMs}ms`)
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
      console.log('snip list | search <q> | run <id> [--var k=v ...] [--yes] | hosts | status')
      console.log(`data dir: ${DATA_DIR}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
