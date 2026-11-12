/**
 * 实例下拉识别回归（P7.2）。
 *
 * 钉的是「哪种命令形态给下拉、哪种坚决不给」：
 *  1) close/kill/focus/click + `{{slot}}` / `{{pro}}#{{n}}` / `{{pro}}#1`；
 *  2) `admin` 与 `{{admin}}` 前缀；
 *  3) 字面量、普通 cmd、`shell`、带空格的 `{{pro}} # {{n}}` → 一律不猜；
 *  4) secret / choices / from / 未声明变量 → 不生成；
 *  5) 多步去重；同一变量两种形态 → 整体放弃。
 *
 * 运行：npm run test:picks（在 packages/core 下）
 */
import { detectPick, detectPickers } from '../src/picks'
import type { Snippet, VarSpec } from '../src/types'

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

const VARS: Record<string, VarSpec> = {
  pro: { prompt: '程序', default: 'wechat' },
  n: { prompt: '实例号', default: 1 },
  slot: { prompt: '槽位' },
  admin: { prompt: '提权', choices: ['', 'admin'], default: '' },
  x: { prompt: 'X' },
  y: { prompt: 'Y' },
  secretSlot: { prompt: '秘密槽位', secret: true },
  choiceSlot: { prompt: '固定槽位', choices: ['wechat#1'] },
  envSlot: { prompt: '环境槽位', from: 'env:SLOT' },
}

const pick = (cmd: string, vars = VARS) => detectPick(cmd, vars)
const json = (v: unknown) => JSON.stringify(v)

const SLOT = json({ kind: 'instances', mode: 'slot', vars: { slot: 'slot' } })
const PRO_N = json({ kind: 'instances', mode: 'proN', vars: { pro: 'pro', n: 'n' } })
const PRO = json({ kind: 'instances', mode: 'pro', vars: { pro: 'pro' } })

check(
  'close {{pro}}#{{n}} → proN',
  json(pick('call C:\\ahk_trigger\\ahk.bat close {{pro}}#{{n}}')) === PRO_N,
  json(pick('call C:\\ahk_trigger\\ahk.bat close {{pro}}#{{n}}')),
)
check(
  'admin 字面量前缀 → proN',
  json(pick('call C:\\ahk_trigger\\ahk.bat admin kill {{pro}}#{{n}}')) === PRO_N,
  json(pick('call C:\\ahk_trigger\\ahk.bat admin kill {{pro}}#{{n}}')),
)
check(
  '{{admin}} 变量前缀 → proN（不因 choices 被误伤）',
  json(pick('call C:\\ahk_trigger\\ahk.bat {{admin}} kill {{pro}}#{{n}}')) === PRO_N,
  json(pick('call C:\\ahk_trigger\\ahk.bat {{admin}} kill {{pro}}#{{n}}')),
)
check(
  'focus {{slot}} → slot',
  json(pick('call C:\\ahk_trigger\\ahk.bat focus {{slot}}')) === SLOT,
  json(pick('call C:\\ahk_trigger\\ahk.bat focus {{slot}}')),
)
check(
  'click {{pro}}#{{n}} x y → proN（x/y 不影响）',
  json(pick('call C:\\ahk_trigger\\ahk.bat click {{pro}}#{{n}} {{x}} {{y}}')) === PRO_N,
  json(pick('call C:\\ahk_trigger\\ahk.bat click {{pro}}#{{n}} {{x}} {{y}}')),
)
check(
  'close {{pro}}#1 → pro',
  json(pick('call C:\\ahk_trigger\\ahk.bat close {{pro}}#1')) === PRO,
  json(pick('call C:\\ahk_trigger\\ahk.bat close {{pro}}#1')),
)
check(
  '带引号的槽位 → slot',
  json(pick('call C:\\ahk_trigger\\ahk.bat close "{{slot}}"')) === SLOT,
  json(pick('call C:\\ahk_trigger\\ahk.bat close "{{slot}}"')),
)
check(
  '带引号、含空格的桥路径 → slot',
  json(pick('call "D:\\tools\\ahk bridge\\ahk.bat" close {{slot}}')) === SLOT,
  json(pick('call "D:\\tools\\ahk bridge\\ahk.bat" close {{slot}}')),
)

check(
  '字面量槽位 → 不给下拉（不猜）',
  pick('call C:\\ahk_trigger\\ahk.bat close wechat#1') === null,
)
check('普通 cmd → null', pick('echo click {{pro}}#{{n}}') === null)
check('shell 动作 → null', pick('call C:\\ahk_trigger\\ahk.bat shell shell#{{n}} "dir"') === null)
check(
  '带空格的 {{pro}} # {{n}} → 退回手输',
  pick('call C:\\ahk_trigger\\ahk.bat close {{pro}} # {{n}}') === null,
)
check('没有 call → null', pick('C:\\ahk_trigger\\ahk.bat close {{pro}}#{{n}}') === null)

check(
  'secret 变量 → 不生成',
  pick('call C:\\ahk_trigger\\ahk.bat close {{secretSlot}}') === null,
)
check(
  'choices 变量 → 不生成',
  pick('call C:\\ahk_trigger\\ahk.bat close {{choiceSlot}}') === null,
)
check('from 变量 → 不生成', pick('call C:\\ahk_trigger\\ahk.bat close {{envSlot}}') === null)
check('未声明变量 → 不生成', pick('call C:\\ahk_trigger\\ahk.bat close {{nope}}') === null)

function snippet(cmds: string[], vars: Record<string, VarSpec> = VARS): Pick<Snippet, 'vars' | 'steps'> {
  return { vars, steps: cmds.map((cmd) => ({ do: 'run' as const, cmd })) }
}

check(
  '多步同一形态 → 去重成 1 个',
  json(
    detectPickers(
      snippet([
        'call C:\\ahk_trigger\\ahk.bat click {{pro}}#{{n}} 1 1',
        'call C:\\ahk_trigger\\ahk.bat close {{pro}}#{{n}}',
      ]),
    ),
  ) === json([{ kind: 'instances', mode: 'proN', vars: { pro: 'pro', n: 'n' } }]),
)
check(
  '同一变量两种形态 → 整体放弃',
  json(
    detectPickers(
      snippet([
        'call C:\\ahk_trigger\\ahk.bat close {{pro}}#{{n}}',
        'call C:\\ahk_trigger\\ahk.bat focus {{pro}}',
      ]),
    ),
  ) === '[]',
)
check(
  '不同变量两组 pick → 两个都留',
  json(
    detectPickers(
      snippet([
        'call C:\\ahk_trigger\\ahk.bat focus {{slot}}',
        'call C:\\ahk_trigger\\ahk.bat click {{pro}}#{{n}} 1 1',
      ]),
    ),
  ) === json([
    { kind: 'instances', mode: 'slot', vars: { slot: 'slot' } },
    { kind: 'instances', mode: 'proN', vars: { pro: 'pro', n: 'n' } },
  ]),
)
check('没有变量 → 空', detectPickers(snippet(['echo hi'], {})).length === 0)
check('普通 cmd → 空', detectPickers(snippet(['echo {{pro}}#{{n}}'])).length === 0)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
