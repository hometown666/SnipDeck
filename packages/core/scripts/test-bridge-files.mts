/**
 * 桥文件解析回归（P7.1）。
 *
 * 钉的是「listener 写出什么，SnipDeck 就必须读成什么」：
 *  1) `instances.txt` 的 6 字段、5 字段（旧行没有 ts）、中文 pro；
 *  2) 坏行跳过而不是抛错（槽位带空格 / 缺 #n / pid 非数字）；
 *  3) 同 slot 重复时后一条为准；
 *  4) 排序按 pro + 数字 n（`#2` 在 `#10` 前）；
 *  5) `status.txt` 的固定探测项与 `inst.` 摘要行；
 *  6) `ts` 按本地时间解析，不交给 `new Date(string)` 的实现相关行为。
 *
 * 运行：npm run test:bridge（在 packages/core 下）
 */
import {
  parseInstancesText,
  parseLocalTs,
  parseStatusText,
  slotNumber,
  sortInstances,
} from '../src/bridge-files'
import type { InstanceRow } from '../src/types'

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

const INSTANCES = [
  '# slot|pid|hwnd|exe|pro|ts',
  'wechat#10|100|1|WeChat.exe|wechat|2026-11-10 02:00:00',
  'wechat#2|200|2|WeChat.exe|wechat|2026-11-10 02:01:00',
  '微信#1|300|3|WeChat.exe|微信',
  'shell#1|400|4|cmd.exe|shell|2026-11-10 02:02:00',
  'bad slot#1|500|5|x.exe|bad|2026-11-10 02:03:00',
  'wechat#2|201|2|WeChat.exe|wechat|2026-11-10 02:04:00',
  'nope|600|6|x.exe|nope|2026-11-10 02:05:00',
  'x#7|NaN|7|x.exe|x|2026-11-10 02:06:00',
  'x#8|800|NaN|x.exe|x|2026-11-10 02:07:00',
  '',
].join('\r\n')

const rows = parseInstancesText(INSTANCES)
check('合法行 4 条（坏行全跳过）', rows.length === 4, JSON.stringify(rows.map((r) => r.slot)))

const wechat = rows.filter((r) => r.pro === 'wechat')
check(
  '同 slot 重复时后一条为准',
  wechat.find((r) => r.slot === 'wechat#2')?.pid === 201,
  JSON.stringify(wechat),
)
check(
  '数字 n 排序：#2 在 #10 前',
  wechat.map((r) => r.slot).join(',') === 'wechat#2,wechat#10',
  wechat.map((r) => r.slot).join(','),
)

const cn = rows.find((r) => r.slot === '微信#1')
check('中文 pro 保留', cn?.pro === '微信', JSON.stringify(cn))
check('5 字段旧行 ts 为空', cn?.ts === '', JSON.stringify(cn?.ts))

check('slotNumber(wechat#10) = 10', slotNumber('wechat#10') === 10)
check('slotNumber(nope) = null', slotNumber('nope') === null)
check('slotNumber(wechat#) = null', slotNumber('wechat#') === null)

check('空文本 → 空表', parseInstancesText('').length === 0)
check('只有表头 → 空表', parseInstancesText('# slot|pid|hwnd|exe|pro|ts').length === 0)

// sortInstances 不原地改数组
const raw: InstanceRow[] = [
  { slot: 'a#10', pid: 1, hwnd: 1, exe: 'a.exe', pro: 'a', ts: '', n: 10 },
  { slot: 'a#2', pid: 2, hwnd: 2, exe: 'a.exe', pro: 'a', ts: '', n: 2 },
]
const sorted = sortInstances(raw)
check('sortInstances 不改原数组', raw[0]?.slot === 'a#10', raw[0]?.slot)
check('sortInstances 返回 #2 在前', sorted[0]?.slot === 'a#2', sorted[0]?.slot)

const STATUS = [
  '\uFEFFts=2026-11-10 02:20:30',
  'listener=ok',
  'admin=1',
  'last=OK|2026-11-10 02:16:24|shell|open|pid=34580 slot=shell#1',
  'foreground=WorkBuddy',
  'Cursor=stopped',
  'Weixin=running',
  'notepad=stopped',
  'instances=2',
  'inst.airmouse#1=pid=39292 hwnd=3802174 exe=cmd.exe',
  'inst.snipaste#1=pid=5780 hwnd=6228398 exe=Snipaste.exe',
  '',
].join('\r\n')

const st = parseStatusText(STATUS)
check('status.ts', st.ts === '2026-11-10 02:20:30', st.ts)
check('listener=ok → true', st.listener)
check('admin=1 → true', st.admin)
check('last 保留管道', st.last.includes('shell|open'), st.last)
check('foreground', st.foreground === 'WorkBuddy', st.foreground)
check('instances=2', st.instancesCount === 2, String(st.instancesCount))
check('固定探测项 3 条', st.watched.length === 3, JSON.stringify(st.watched))
check(
  '探测项名称与状态正确',
  st.watched.some((w) => w.name === 'Weixin' && w.running) &&
    st.watched.some((w) => w.name === 'Cursor' && !w.running),
  JSON.stringify(st.watched),
)
check(
  'inst. 摘要行不进探测项',
  st.watched.every((w) => !w.name.startsWith('inst.')),
  JSON.stringify(st.watched),
)

const emptyStatus = parseStatusText('')
check('空 status → 默认值', !emptyStatus.listener && !emptyStatus.admin && emptyStatus.instancesCount === null)
check('空 status → watched 空', emptyStatus.watched.length === 0)

const local = new Date(2026, 10, 10, 2, 20, 30).getTime()
check('parseLocalTs 按本地时间', parseLocalTs('2026-11-10 02:20:30') === local)
check('parseLocalTs 接受 T 分隔', parseLocalTs('2026-11-10T02:20:30') === local)
check('parseLocalTs 拒绝乱格式', parseLocalTs('2026/11/10 02:20:30') === null)
check('parseLocalTs 拒绝越界', parseLocalTs('2026-13-10 02:20:30') === null)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
