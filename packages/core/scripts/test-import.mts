/**
 * 历史导入回归测试（P4）。
 *
 * 钉住四件事：
 *   1) 清洗：空行 / bash 时间戳行 / 重复命令 / 噪声命令都要丢，且**不误伤正常命令**；
 *   2) 危险命令标 danger（历史里天然混着 Remove-Item -Recurse 这类）；
 *   3) id 唯一（不同命令也可能撞同一个 slug）；
 *   4) 只在 `--write` 时才落盘，且**不覆盖**已存在的文件（force 才覆盖）。
 *
 * 运行：npm run test:import（在 packages/core 下）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isDangerous,
  looksIncomplete,
  normalizeHistory,
  planImport,
  slugify,
  writePlan,
} from '../src/history'
import { loadSnippets } from '../src/snippets'

const FIXTURE = mkdtempSync(join(tmpdir(), 'snipdeck-import-'))
const SNIPPETS = join(FIXTURE, 'snippets')

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

// 1. 清洗
const { kept, dropped } = normalizeHistory([
  '',
  '   ',
  '#1672531200',
  'ls',
  'cd ..',
  'netstat -ano | findstr 3389',
  'netstat -ano | findstr 3389',
  'Get-Service TermService',
  'abc',
  '  Restart-Service TermService -Force  ',
])
check(
  '只留下三条有意义的命令（去空行/时间戳/噪声/短命令/重复）',
  kept.join('|') ===
    'netstat -ano | findstr 3389|Get-Service TermService|Restart-Service TermService -Force',
  JSON.stringify(kept),
)
check('丢弃计数 = 7（3 空行含时间戳 + ls + cd .. + 重复 + abc）', dropped === 7, String(dropped))
check('首尾空白被 trim', kept[2] === 'Restart-Service TermService -Force', JSON.stringify(kept[2]))

// 1b. 控制台转录带进来的提示符（ISSUE-011）
{
  const prompt = normalizeHistory([
    'PS C:\\Users\\Kakyo George> Get-Date',
    'PS D:\\试炼之地\\remote text control> npm test',
    '>>  Set-Item -Path a -Value b',
    '>>  }',
  ])
  check(
    'PS 提示符被剥掉，命令留下',
    prompt.kept.join('|') === 'Get-Date|npm test',
    JSON.stringify(prompt.kept),
  )
  check('>> 续行提示符整条丢弃', prompt.dropped === 2, String(prompt.dropped))
  check(
    '剥过前缀的行不再以 PS 开头',
    prompt.kept.every((c) => !c.startsWith('PS ')),
    JSON.stringify(prompt.kept),
  )
}

// 1c. 多行命令被 PSReadLine 拆开后只剩半条，不能导
check(
  '未闭合花括号 → 不完整（多行被截断的第一半）',
  looksIncomplete('Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*RDP*"'),
)
check('结尾是管道符 → 不完整', looksIncomplete('Get-Service |'))
check(
  '结尾是续行符（PS 反引号 / cmd ^）→ 不完整',
  looksIncomplete('Enable-NetFirewallRule -DisplayGroup "Remote Desktop"`') &&
    looksIncomplete('dir C:\\Windows ^'),
)
check(
  '命令中间出现反引号不算不完整',
  !looksIncomplete('Get-Process `Select-Object -First 3'.replace('`', '|')),
)
check('结尾是逗号/等于号 → 不完整', looksIncomplete('Set-Item -Path x -Value') === false && looksIncomplete('Get-Thing,') === true)
check(
  '配平的完整命令 → 完整',
  !looksIncomplete('Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*RDP*"}'),
)
check('引号里的括号不算结构', !looksIncomplete('echo "a(b"'))
check('单引号里的括号也不算', !looksIncomplete("Set-ItemProperty 'HKLM:////x' -Name y"))

// 2. 危险命令
const dangers: [string, boolean][] = [
  ['Remove-Item -Recurse -Force C:\\temp\\x', true],
  ['rm -rf /tmp/x', true],
  ['shutdown /s /t 0', true],
  ['git reset --hard HEAD~3', true],
  ['taskkill /f /im notepad.exe', true],
  // ISSUE-012：服务 / 注册表 / 计划任务 / 账户 / ACL 的写操作，历史里常有一键生效的
  ['Restart-Service TermService -Force', true],
  ['Set-Service -Name Spooler -StartupType Disabled', true],
  ["Set-ItemProperty 'HKLM:/SYSTEM/x' -Name Start -Value 0", true],
  ['New-ItemProperty -Path HKCU:/x -Name y -Value 1', true],
  ['reg add HKLM\\Software\\x /v y /d 1 /f', true],
  ['schtasks /create /tn x /tr y /sc daily', true],
  ['net user admin2 P@ss /add', true],
  ['icacls C:\\x /grant Everyone:F', true],
  ['takeown /f C:\\Windows', true],
  ['bcdedit /set testsigning on', true],
  ['Set-ExecutionPolicy Bypass -Scope LocalMachine', true],
  ['netstat -ano | findstr 3389', false],
  ['Get-Service TermService', false],
  ['Get-ItemProperty HKLM:/SOFTWARE/x', false],
  ['git status', false],
]
for (const [cmd, want] of dangers) {
  check(`danger(${cmd.slice(0, 32)}) = ${want}`, isDangerous(cmd) === want)
}

// 3. slug
check('路径分隔符拍平成 -', slugify('type C:\\a b\\x.txt') === 'type-c-a-b-x-txt', slugify('type C:\\a b\\x.txt'))
check('中文保留', slugify('查看实例表') === '查看实例表', slugify('查看实例表'))
check('全是符号时兜底为 cmd', slugify('\\\\/') === 'cmd', slugify('\\\\/'))
check('长度截断到 40', slugify('a'.repeat(80)).length === 40, String(slugify('a'.repeat(80)).length))

// 3b. 标题保留全文（截断过会让搜索命中不了，ISSUE-015）
{
  const long =
    'Get-Content C:\\Windows\\System32\\winevt\\Logs\\Microsoft-Windows-TerminalServices-LocalSessionManager%4Operational.evtx -Tail 20'
  const p = planImport({ lines: [long], snippetsDir: SNIPPETS, force: true })
  const first = p.planned[0]
  check('长命令的 title 是全文（没有 …）', first?.title === long, JSON.stringify(first?.title))
  check('title 里仍有被人搜的词 Terminal', /Terminal/.test(first?.title ?? ''))
  // id = 'hist-' + slug(≤40)，所以上限是 45
  check('id 长度 ≤ 45（hist- 前缀 + 40 字符 slug）', (first?.id.length ?? 99) <= 45, String(first?.id.length))
  check('id 不以 - 结尾（不留半截词）', !(first?.id ?? 'x').endsWith('-'), first?.id)
}

// 4. 规划：id 唯一 + limit 取尾部
const lines = ['dir C:\\a', 'dir C:/a', 'echo one', 'echo two', 'echo three']
const plan = planImport({ lines, snippetsDir: SNIPPETS, limit: 10 })
check('5 条全部规划（无重复行）', plan.planned.length === 5, JSON.stringify(plan.planned.map((p) => p.id)))
check(
  'slug 相同的两条自动加序号',
  plan.planned[0]!.id !== plan.planned[1]!.id && plan.planned[1]!.id.endsWith('-2'),
  JSON.stringify(plan.planned.slice(0, 2).map((p) => p.id)),
)
const tail = planImport({ lines, snippetsDir: SNIPPETS, limit: 2 })
check(
  'limit 取最近的 2 条（尾部）',
  tail.planned.map((p) => p.cmd).join('|') === 'echo two|echo three',
  JSON.stringify(tail.planned.map((p) => p.cmd)),
)
check('规划阶段不写盘', !existsSync(SNIPPETS), SNIPPETS)

// 5. 落盘
const opts = { lines, snippetsDir: SNIPPETS, group: '历史导入', shell: 'powershell' as const }
const written = writePlan(plan, opts)
check('writePlan 写了 5 个文件', written === 5, String(written))
const { snippets, errors } = loadSnippets(SNIPPETS)
check('生成的 YAML 全部可加载（无 quarantine）', errors.length === 0, JSON.stringify(errors))
check('片段 id 与规划一致', snippets.map((s) => s.id).sort().join(',') === plan.planned.map((p) => p.id).sort().join(','))
check('shell 透传为 powershell', snippets.every((s) => s.shell === 'powershell'))
check('命令原样保留（含反斜杠与冒号）', snippets.some((s) => s.steps[0]?.do === 'run' && s.steps[0].cmd === 'dir C:\\a'))
check('分组写入 group', snippets.every((s) => s.group === '历史导入'))

// 6. 不覆盖
const target = join(SNIPPETS, '历史导入', `${plan.planned[0]!.id}.yaml`)
const before = readFileSync(target, 'utf8')
writeFileSync(target, `${before}# 用户手写的注释\n`, 'utf8')
const again = planImport(opts)
check('二次规划的 state = skip', again.planned.every((p) => p.state === 'skip'), JSON.stringify(again.planned.map((p) => p.state)))
check('二次 writePlan 写 0 条', writePlan(again, opts) === 0)
check('用户改动仍在（没被覆盖）', readFileSync(target, 'utf8').includes('用户手写的注释'))

// 7. force
const forced = planImport({ ...opts, force: true })
check('force 后 state = new', forced.planned.every((p) => p.state === 'new'))
writePlan(forced, opts)
check('force 覆盖掉了手写注释', !readFileSync(target, 'utf8').includes('用户手写的注释'))

// 8. danger 落盘
const dangerPlan = planImport({ lines: ['Remove-Item -Recurse -Force C:\\tmp\\x'], snippetsDir: SNIPPETS, force: true })
check('危险命令被标记', dangerPlan.planned[0]?.danger === true)
writePlan(dangerPlan, opts)
const dangerSnip = loadSnippets(SNIPPETS).snippets.find((s) => s.id === dangerPlan.planned[0]!.id)
check('落盘后 danger: true 保真', dangerSnip?.danger === true, JSON.stringify(dangerSnip?.danger))

// 9. 生成文件带来源注释
const head = readFileSync(target, 'utf8').split('\n').slice(0, 2).join('\n')
check('文件头两行是注释（说明来源）', head.startsWith('# 由 snip import-history 生成') && head.includes('# 来源:'), head)

try {
  rmSync(FIXTURE, { recursive: true, force: true })
} catch (e) {
  console.warn(`  ~ 清理失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
