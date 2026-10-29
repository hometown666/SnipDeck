/**
 * 搜索回归测试（ISSUE-002）。
 *
 * 背景：原来走 MiniSearch，默认 tokenizer 只按空白/标点切，CJK 不进一步分词，
 * `查看实例表` 是一个完整 token，查 `实例` 就是 0 命中。前端走 `includes()` 所以
 * 从网页看不出来，只有 CLI 坏。
 *
 * 现在 CLI 与网页同语义：子串 + 多词 AND。这个测试钉住三件事：
 *   1) 中文子串能命中（不再是整词匹配）；
 *   2) 多词是 AND，不是 OR；
 *   3) 大小写、前后空白不敏感；空查询返回全部。
 *
 * 运行：npm run test:search（在 packages/core 下）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnippetStore } from '../src/store'

const FIXTURE = mkdtempSync(join(tmpdir(), 'snipdeck-search-'))

function put(rel: string, content: string): void {
  const file = join(FIXTURE, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

// 与真实片段库同构：分组目录、中文标题、带括号、带空格
put(
  '实例控制/click.yaml',
  [
    'id: click-instance',
    'title: 点击实例坐标',
    'tags: [click, wechat]',
    'steps:',
    "  - { do: run, cmd: 'echo click' }",
    '',
  ].join('\n'),
)
put(
  '状态/check.yaml',
  ['id: check-instence', 'title: 查看实例表', 'steps:', "  - { do: run, cmd: 'echo table' }", ''].join(
    '\n',
  ),
)
put(
  '实例控制/focus.yaml',
  ['id: focus-instance', 'title: 聚焦实例', 'steps:', "  - { do: run, cmd: 'echo focus' }", ''].join('\n'),
)
put(
  '实例控制/close.yaml',
  ['id: close-program', 'title: 关闭程序', 'steps:', "  - { do: run, cmd: 'echo close' }", ''].join('\n'),
)
put(
  '任务与日志/cursor.yaml',
  ['id: cursor-refill', 'title: 续杯（Cursor 请求重置）', 'steps:', "  - { do: run, cmd: 'echo refill' }", ''].join('\n'),
)
put(
  'Shell 与服务/shell.yaml',
  ['id: open-shell', 'title: 开一个可见 cmd 壳', 'steps:', "  - { do: run, cmd: 'echo shell' }", ''].join('\n'),
)

const store = new SnippetStore(FIXTURE)

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
const ids = (q: string): string[] => store.search(q).map((s) => s.id)
const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

check('空查询返回全部 6 条', store.search('').length === 6, String(store.search('').length))
check('纯空白查询同样返回全部', store.search('   ').length === 6)

// 1. 中文子串（原 bug 的核心：MiniSearch 这里 0 命中）
// 注意 close-program 也算命中：它在「实例控制」分组里，而分组名是搜索面的一部分
// （与前端 `${id} ${title} ${group} ${tags}` 同源），不是误命中。
const inst = ids('实例')
check(
  '「实例」命中 click-instance / check-instence / focus-instance / close-program（含分组名）',
  same(inst, ['click-instance', 'check-instence', 'close-program', 'focus-instance']),
  JSON.stringify(inst),
)
check('「实例」不误命中 cursor-refill / open-shell', !inst.includes('cursor-refill') && !inst.includes('open-shell'), JSON.stringify(inst))

check('「续杯」命中 cursor-refill', same(ids('续杯'), ['cursor-refill']), JSON.stringify(ids('续杯')))
check('「壳」命中 open-shell（单字也要能搜）', same(ids('壳'), ['open-shell']), JSON.stringify(ids('壳')))

// 2. 多词 AND
const and = ids('实例 表')
check('「实例 表」只出 check-instence（AND 而非 OR）', same(and, ['check-instence']), JSON.stringify(and))
check('多词无交集时为空', ids('实例 续杯').length === 0, JSON.stringify(ids('实例 续杯')))

// 3. 大小写 / 空白 / 标签 / id / 命令正文
check('「CLICK」大小写不敏感', same(ids('CLICK'), ['click-instance']), JSON.stringify(ids('CLICK')))
check('前后空格不敏感', same(ids('  实例  '), inst), JSON.stringify(ids('  实例  ')))
check('「wechat」按标签命中', same(ids('wechat'), ['click-instance']), JSON.stringify(ids('wechat')))
check('「echo table」按命令正文命中', same(ids('echo table'), ['check-instence']), JSON.stringify(ids('echo table')))

// 4. 排序：标题命中排在正文命中前面
const ranked = ids('实例')
check(
  '标题命中优先（click-instance 在 close-program 之前不影响；此处校验首条有标题命中）',
  store.search('实例')[0]?.title?.includes('实例') === true,
  JSON.stringify(ranked),
)

check('「zzz」搜不到任何东西', ids('zzz').length === 0, JSON.stringify(ids('zzz')))

try {
  rmSync(FIXTURE, { recursive: true, force: true })
} catch (e) {
  console.warn(`  ~ 清理失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
