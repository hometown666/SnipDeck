import { useEffect, useId, useState } from 'react'
import {
  ACTION_SPECS,
  EMPTY_DRAFT,
  buildAhkCommand,
  hasField,
  parseAhkCommand,
  type AhkAction,
  type AhkDraft,
} from '../lib/ahk-command'

/**
 * `run` 步骤的命令编辑：先选「做什么」，再填这个动作真正需要的字段。
 *
 * 三件事刻意这么做：
 *  1. **不改片段格式**——表单最终只吐出 `cmd` 字符串，YAML 里还是那一行；
 *  2. **认不出来就退回原文**——老片段/手写命令打开时原样显示，绝不"猜着改写"；
 *  3. **字段跟着动作出现/消失**——选「刷新状态」就一个输入框都不给，选「点一下」才要 x/y。
 */
export function CommandBuilder({
  value,
  onChange,
  slots = [],
  programValues = [],
}: {
  value: string
  onChange: (cmd: string) => void
  /** 当前实例表的槽位，只给 `<datalist>` 做建议；不限制手输 */
  slots?: string[]
  /** 发现到的 .lnk 绝对路径，给「打开快捷方式」的输入框做建议 */
  programValues?: string[]
}) {
  const [draft, setDraft] = useState<AhkDraft>(() => parseAhkCommand(value))
  const slotsId = useId()
  const programsId = useId()

  // 外部把 cmd 换掉了（切步骤、从原文模式切回来）：重新解析
  useEffect(() => {
    setDraft((d) => (buildAhkCommand(d) === value ? d : parseAhkCommand(value)))
  }, [value])

  const apply = (patch: Partial<AhkDraft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    onChange(buildAhkCommand(next))
  }

  const spec = ACTION_SPECS[draft.action]
  // 命令里不能再嵌双引号：ahk.bat 的负载本身是引号参数，嵌套会在空格处被 cmd 截断
  const nestedQuote = draft.action !== 'custom' && draft.value.includes('"')

  return (
    <div className="cmd-builder">
      <div className="editor-row tight">
        <label className="field">
          <span>动作</span>
          <select
            value={draft.action}
            onChange={(e) => {
              const action = e.target.value as AhkAction
              // 切动作时保留已填的值：大多数时候换的只是执行方式（lnk → run）
              apply({ action })
            }}
          >
            {(Object.keys(ACTION_SPECS) as AhkAction[]).map((a) => (
              <option key={a} value={a}>
                {ACTION_SPECS[a].label}
              </option>
            ))}
          </select>
        </label>

        {hasField(draft.action, 'slot') && (
          <label className="field">
            <span>槽位</span>
            <input
              value={draft.slot}
              list={slots.length > 0 ? slotsId : undefined}
              placeholder="shell#1 / wechat#1"
              title="可从当前实例表选，也可以手输变量"
              spellCheck={false}
              onChange={(e) => apply({ slot: e.target.value })}
            />
            {slots.length > 0 && (
              <datalist id={slotsId}>
                {slots.map((slot) => (
                  <option key={slot} value={slot} />
                ))}
              </datalist>
            )}
          </label>
        )}

        {hasField(draft.action, 'xy') && (
          <>
            <label className="field">
              <span>x</span>
              <input
                value={draft.x}
                inputMode="numeric"
                placeholder="140"
                onChange={(e) => apply({ x: e.target.value })}
              />
            </label>
            <label className="field">
              <span>y</span>
              <input
                value={draft.y}
                inputMode="numeric"
                placeholder="520"
                onChange={(e) => apply({ y: e.target.value })}
              />
            </label>
          </>
        )}
      </div>

      {hasField(draft.action, 'job') && (
        <label className="field">
          <span>
            任务名 <span className="hint">可空；留空时由桥自己起名</span>
          </span>
          <input
            value={draft.job}
            placeholder="job1"
            spellCheck={false}
            onChange={(e) => apply({ job: e.target.value })}
          />
        </label>
      )}

      {draft.action === 'custom' ? (
        <textarea
          className="mono"
          rows={2}
          value={draft.value}
          placeholder="原样执行的命令，例如 call C:\ahk_trigger\ahk.bat status"
          onChange={(e) => apply({ value: e.target.value })}
        />
      ) : (
        hasField(draft.action, 'value') && (
          <label className="field">
            <span>
              {spec.valueLabel ?? '值'}
              {spec.valueOptional ? <span className="hint">可留空</span> : null}
            </span>
            <input
              value={draft.value}
              placeholder={spec.valueHint}
              spellCheck={false}
              list={draft.action === 'lnk' && programValues.length > 0 ? programsId : undefined}
              onChange={(e) => apply({ value: e.target.value })}
            />
            {draft.action === 'lnk' && programValues.length > 0 && (
              <datalist id={programsId}>
                {programValues.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            )}
          </label>
        )
      )}

      {spec.admin && (
        <label className="mini-check">
          <input
            type="checkbox"
            checked={draft.admin}
            onChange={(e) => apply({ admin: e.target.checked })}
          />
          <span>以管理员身份运行（admin 前缀）</span>
        </label>
      )}

      {nestedQuote && (
        <p className="field-note warn-note">
          值里有双引号：桥的负载是单个引号参数，嵌套引号会在空格处被截断。去不掉的用「自定义命令」自己拼。
        </p>
      )}

      {/* 自定义模式下 textarea 本身就是最终命令，再显示一遍只是噪音 */}
      {draft.action !== 'custom' && (
        <figure
          className="ui-code ui-code--sm cmd-preview-code"
          title="最终写进 YAML 的命令"
        >
          {/* pre 内不能有换行缩进：JSX 会把它原样保留成空白行 */}
          <pre className="ui-code__pre"><code className="mono">{buildAhkCommand(draft) || '（还没填完整）'}</code></pre>
        </figure>
      )}
      <p className="field-note">
        任何字段里都能写变量占位符，例如 <code>{'{{n}}'}</code>。
      </p>
    </div>
  )
}

export { EMPTY_DRAFT }
