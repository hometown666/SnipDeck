/**
 * 程序发现回归（P7.3）：分类 / 去重 / include / 配置归一。
 *
 * 全部是纯函数，**不碰文件系统也不跑 PowerShell**——扫描那半边的输入
 * 就是这里造的 RawProgram。规则写错在这里挂，而不是等到界面上看见
 * 「我的程序怎么没了」。
 *
 * 运行：npm run test:programs（在 packages/core 下）
 */
import {
  classifyProgram,
  normalizeProgramsConfig,
  sanitizePro,
  selectPrograms,
  type RawProgram,
} from '../src/programs'

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

function row(over: Partial<RawProgram> = {}): RawProgram {
  const name = over.name ?? 'WeChat'
  // `...over` 必须在最后：kind / launch 这类可选字段要能透传（否则 exe 行会被当成 lnk）
  return {
    path: `C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\${name}.lnk`,
    name,
    dir: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    source: 'commonMenu',
    target: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
    args: '',
    ...over,
  }
}

console.log('\n— sanitizePro（对齐 listener.ahk）')
check('WeChat → wechat', sanitizePro('WeChat') === 'wechat')
check('WeChat.exe → wechat', sanitizePro('WeChat.exe') === 'wechat')
check('osu!(lazer) → osu_lazer', sanitizePro('osu!(lazer)') === 'osu_lazer')
check('中文保留', sanitizePro('微信') === '微信')
check('带前缀的中文名照原样', sanitizePro('g格式工厂') === 'g格式工厂')
check('空 → app', sanitizePro('') === 'app')
check('全是符号 → app', sanitizePro('!!!') === 'app')

console.log('\n— 分类：不能当程序启动的')
check('没有目标 → broken', classifyProgram(row({ target: '' })) === 'broken')
check('指向目录 → dir', classifyProgram(row({ target: 'D:\\Tools' })) === 'dir')
check('msiexec → msi', classifyProgram(row({ target: 'C:\\Windows\\System32\\msiexec.exe' })) === 'msi')
check(
  'WindowsApps → uwp',
  classifyProgram(row({ target: 'C:\\Program Files\\WindowsApps\\Foo\\bar.exe' })) === 'uwp',
)

console.log('\n— 分类：黑名单（只对非可信来源）')
check('cmd.exe → system', classifyProgram(row({ target: 'C:\\Windows\\System32\\cmd.exe' })) === 'system')
check(
  'System32 里的普通 exe 也 → system',
  classifyProgram(row({ target: 'C:\\Windows\\System32\\dfrgui.exe' })) === 'system',
)
check(
  'notepad 在白名单 → 通过',
  classifyProgram(row({ target: 'C:\\Windows\\System32\\notepad.exe' })) === null,
)
check('卸载 格式工厂 → uninstall', classifyProgram(row({ name: '卸载格式工厂' })) === 'uninstall')
check('Uninstall nvm → uninstall', classifyProgram(row({ name: 'Uninstall nvm' })) === 'uninstall')
check('Release Notes → help', classifyProgram(row({ name: 'Release Notes' })) === 'help')
check('帮助文档 → help', classifyProgram(row({ name: '帮助文档' })) === 'help')
check(
  '目标是 .chm 手册 → help',
  classifyProgram(row({ name: '控制台 RAR 中文手册', target: 'C:\\Program Files\\WinRAR\\Rar.chm' })) ===
    'help',
)
check('普通程序 → 通过', classifyProgram(row()) === null)

console.log('\n— 可信来源不套黑名单')
const trusted = (source: RawProgram['source']) =>
  row({ source, target: 'C:\\Windows\\System32\\cmd.exe' })
check('progDir 里的 cmd 保留', classifyProgram(trusted('progDir')) === null)
check('only 里的 cmd 保留', classifyProgram(trusted('only')) === null)
check('extra 里的 cmd 保留', classifyProgram(trusted('extra')) === null)
check(
  '可信来源里的空目标仍然挡（启动不了）',
  classifyProgram(row({ source: 'progDir', target: '' })) === 'broken',
)

console.log('\n— 去重与排序')
{
  const sel = selectPrograms([
    row({ name: 'WeChat', source: 'commonMenu' }),
    row({ name: 'WeChat', source: 'progDir', path: 'D:\\程序\\WeChat.lnk' }),
    row({ name: 'Notepad', source: 'userMenu', target: 'C:\\Windows\\System32\\notepad.exe' }),
  ])
  check('同 target+args 只留一条', sel.programs.length === 2, String(sel.programs.length))
  check('留下的是高优先级（progDir）', sel.programs[0]?.source === 'progDir', sel.programs[0]?.source)
  check('另一条记为 duplicate', sel.filtered.some((f) => f.reason === 'duplicate'))
  check('第一条是 progDir 的 WeChat', sel.programs[0]?.name === 'WeChat')
}
{
  const sel = selectPrograms([
    row({ name: 'Zeta', source: 'commonMenu', target: 'C:\\z\\z.exe' }),
    row({ name: 'Alpha', source: 'progDir', path: 'D:\\p\\Alpha.lnk', target: 'C:\\a\\a.exe' }),
  ])
  check('按来源优先级排，不按名字', sel.programs[0]?.name === 'Alpha', sel.programs[0]?.name)
}
{
  const sel = selectPrograms([
    row({ name: 'A', source: 'commonMenu', target: 'C:\\x\\a.exe' }),
    row({ name: 'B', source: 'commonMenu', target: 'C:\\x\\a.exe', args: '--min' }),
  ])
  check('target 相同但 args 不同 → 都留', sel.programs.length === 2, String(sel.programs.length))
}

console.log('\n— include：点名要的必须出现')
{
  const sys = row({ name: 'Command Prompt', target: 'C:\\Windows\\System32\\cmd.exe' })
  const without = selectPrograms([sys])
  check('默认挡掉', without.programs.length === 0)
  const withIt = selectPrograms([sys], { include: [sys.path] })
  check('include 后出现', withIt.programs.length === 1, String(withIt.programs.length))
  const caseInsensitive = selectPrograms([sys], { include: [sys.path.toUpperCase()] })
  check('include 大小写不敏感', caseInsensitive.programs.length === 1)
  const slash = selectPrograms([sys], { include: [sys.path.replace(/\\/g, '/')] })
  check('include 正反斜杠等价', slash.programs.length === 1)
}

console.log('\n— 上限与截断')
{
  const many = Array.from({ length: 5 }, (_, i) =>
    row({ name: `P${i}`, target: `C:\\x\\p${i}.exe` }),
  )
  const sel = selectPrograms(many, { max: 3 })
  check('截到 max', sel.programs.length === 3, String(sel.programs.length))
  check('truncated 报出剩余', sel.truncated === 2, String(sel.truncated))
}

console.log('\n— 只认 .lnk / .exe，空 path 直接丢')
{
  const sel = selectPrograms([
    row({ path: 'C:\\x\\a.bat', target: 'C:\\x\\b.exe' }),
    row({ path: '' }),
    row({ name: 'ok', target: 'C:\\x\\b.exe' }),
    row({ name: 'portable', path: 'C:\\x\\p.exe', kind: 'exe', target: '' }),
  ])
  check('留下 .lnk + .exe，丢掉 .bat 与空 path', sel.programs.length === 2, String(sel.programs.length))
}

console.log('\n— programs.yaml 归一')
{
  const { config, problems } = normalizeProgramsConfig({
    only: ['  D:\\a.lnk  ', 'D:/a.lnk', '', 'D:\\b.lnk'],
    extraRoots: ['D:\\Tools'],
    include: 'nope',
  })
  check('去空白、去重（大小写/斜杠等价）', config.only.length === 2, JSON.stringify(config.only))
  check('extraRoots 保留', config.extraRoots[0] === 'D:\\Tools')
  check('include 不是数组 → 报问题', problems.length === 1 && problems[0]?.includes('include'))
  check('include 退化为空数组', config.include.length === 0)
}
{
  const { config } = normalizeProgramsConfig(null)
  check('null → 全空', config.only.length + config.extraRoots.length + config.include.length === 0)
}
{
  const { problems } = normalizeProgramsConfig({ only: [1, 'D:\\a.lnk'] })
  check('非字符串项报问题但保留合法项', problems.length === 1)
}

console.log('\n— 便携 exe（P7.3d）')
{
  const exeRow = (over: Partial<RawProgram> = {}): RawProgram => ({
    path: over.path ?? 'D:\\Tools\\Everything\\Everything.exe',
    name: over.name ?? 'Everything',
    dir: over.dir ?? 'D:\\Tools\\Everything',
    source: over.source ?? 'extra',
    target: '',
    args: '',
    kind: 'exe',
    ...over,
  })
  check('普通 exe → 通过', classifyProgram(exeRow()) === null)
  // 过滤看的是「路径里的文件名」，不是 name 字段（两者在生产里同源）
  const named = (file: string) => exeRow({ name: file.replace(/\.exe$/i, ''), path: `D:\\Tools\\X\\${file}` })
  check('setup.exe → installer', classifyProgram(named('setup.exe')) === 'installer')
  check('Update.exe → installer', classifyProgram(named('Update.exe')) === 'installer')
  check('crashpad_handler → installer', classifyProgram(named('crashpad_handler.exe')) === 'installer')
  check(
    'only 里点名的 setup.exe 照列（用户指名要的）',
    classifyProgram({ ...named('setup.exe'), source: 'only' }) === null,
  )
  check(
    'extra 里的 cmd.exe 仍然是系统工具',
    classifyProgram(exeRow({ name: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe' })) === 'system',
  )
  check('exe 没有 path → broken', classifyProgram(exeRow({ path: '' })) === 'broken')

  const sel = selectPrograms([
    exeRow({ launch: 'D:\\wrap\\Everything.lnk' }),
    exeRow({ launch: 'D:\\wrap\\Notepad.lnk' }),
  ])
  check('exe 的 value 用 launch（生成的 .lnk）', sel.programs[0]?.value === 'D:\\wrap\\Everything.lnk', JSON.stringify(sel.programs[0]?.value))
  check('exe 的 kind 保留', sel.programs[0]?.kind === 'exe', sel.programs[0]?.kind)
  check('exe 的 path 仍是原 exe', sel.programs[0]?.path.endsWith('.exe') === true, sel.programs[0]?.path)

  // 同一个 exe：lnk 行和 exe 行不该同时出现（去重键都用 target/path）
  const dup = selectPrograms([
    row({ name: 'SumatraPDF', source: 'progDir', path: 'D:\\p\\SumatraPDF.lnk', target: 'D:\\SumatraPDF\\SumatraPDF.exe' }),
    exeRow({ name: 'SumatraPDF', source: 'extra', path: 'D:\\SumatraPDF\\SumatraPDF.exe' }),
  ])
  check('同名同目标：只留 lnk 那条', dup.programs.length === 1, String(dup.programs.length))
  check('留下的是 progDir', dup.programs[0]?.source === 'progDir', dup.programs[0]?.source)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
