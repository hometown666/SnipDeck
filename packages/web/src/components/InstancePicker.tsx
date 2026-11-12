import { useState } from 'react'
import type { InstanceView, InstancesView, PickerView, VarView } from '../api'
import type { VarDraft } from '../types'

/**
 * 实例下拉（P7.2）：把一个或两个变量变成「从 instances.txt 里选」。
 *
 * 三条规矩：
 *  1. **列表只是便利，不是约束**——永远保留「手动输入」，列表没覆盖到的槽位仍能手输；
 *     列表空 / 接口失败时直接退化成原来的输入框。
 *  2. **不把过期数据当真**：listener 不是 fresh 就标黄，但不禁用列表——stale 的槽位
 *     常常还是对的，禁用只会逼人重抄。
 *  3. **选中后只写 var**：`slot` 写一个，`{{pro}}#{{n}}` 写两个；命令模板一个字符都不动。
 */
export function InstancePicker({
  pick,
  vars,
  specs,
  instances,
  error,
  onChange,
  onReload,
}: {
  pick: PickerView
  vars: VarDraft
  specs: Record<string, VarView>
  instances: InstancesView | null
  /** 拉取失败（401 之外）：接口没通、目标不是 exec 等 */
  error: string | null
  /** 只 patch 值，不替换整个 vars */
  onChange: (patch: Record<string, string>) => void
  onReload: () => void
}) {
  const rows = instances?.instances ?? []
  const [manual, setManual] = useState(false)
  const showManual = manual || rows.length === 0
  const names = pickVarNames(pick)
  const nameLabels = names.map((name) => specs[name]?.prompt ?? name)
  const current = currentValue(pick, vars)
  const missingCurrent = current !== '' && !rows.some((r) => optionValue(pick, r) === current)
  const groups = groupByPro(rows)
  const pros = uniquePros(rows)

  function handleSelect(value: string) {
    if (pick.mode === 'slot') {
      onChange({ [pick.vars.slot]: value })
      return
    }
    if (pick.mode === 'proN') {
      if (!value) {
        onChange({ [pick.vars.pro]: '', [pick.vars.n]: '' })
        return
      }
      const row = rows.find((r) => r.slot === value)
      if (row) {
        onChange({
          [pick.vars.pro]: row.pro,
          [pick.vars.n]: row.n == null ? '' : String(row.n),
        })
        return
      }
      // 当前值不在表里（额外的那条 option）：能拆就拆，拆不出来就只写 pro
      const m = /^(.*)#(\d+)$/.exec(value)
      if (m?.[1] && m[2]) onChange({ [pick.vars.pro]: m[1], [pick.vars.n]: m[2] })
      return
    }
    onChange({ [pick.vars.pro]: value })
  }

  return (
    <div className="instance-picker">
      <div className="picker-head">
        <span>
          实例 <em className="hint">只列桥启动的窗口（lnk / run / shell）</em>
        </span>
        {rows.length > 0 && (
          <button
            type="button"
            className="picker-toggle"
            onClick={() => setManual((v) => !v)}
          >
            {manual ? '从列表选' : '手动输入'}
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {instances?.error && <p className="field-note warn-note">{instances.error}</p>}
      {instances && instances.listener.state !== 'fresh' && (
        <p className="field-note warn-note">
          listener {instances.listener.state === 'offline' ? '离线' : '状态较旧'}，列表可能过期；
          以桥的实际结果为准。
        </p>
      )}
      {!instances && !error && <p className="field-note">读取实例表…</p>}
      {instances && rows.length === 0 && (
        <p className="field-note">实例表为空，直接手输槽位。</p>
      )}

      {showManual ? (
        names.map((name) => {
          const spec = specs[name]
          return (
            <label className="field" key={name}>
              <span>
                {spec?.prompt ?? name}
                {spec?.required ? <em className="req"> *</em> : null}
              </span>
              <input
                value={vars[name] ?? ''}
                placeholder={spec?.default != null ? String(spec.default) : ''}
                spellCheck={false}
                onChange={(e) => onChange({ [name]: e.target.value })}
              />
            </label>
          )
        })
      ) : (
        <>
          <label className="field">
            <span>
              从实例表选 <em className="hint">选中后填 {nameLabels.join(' / ')}</em>
            </span>
            <div className="picker-row">
              <select value={current} onChange={(e) => handleSelect(e.target.value)}>
                <option value="" disabled={current !== ''}>
                  选择实例…
                </option>
                {missingCurrent && (
                  <option value={current}>当前：{current}（不在表里）</option>
                )}
                {pick.mode === 'pro'
                  ? pros.map((p) => (
                      <option key={p.pro} value={p.pro}>
                        {p.pro}（{p.count} 个实例）
                      </option>
                    ))
                  : [...groups.entries()].map(([pro, items]) => (
                      <optgroup key={pro} label={`${pro}（${items.length}）`}>
                        {items.map((it) => (
                          <option key={it.slot} value={it.slot}>
                            {it.slot} · {it.exe || '未知进程'} · pid {it.pid}
                          </option>
                        ))}
                      </optgroup>
                    ))}
              </select>
              <button
                type="button"
                className="icon-btn"
                title="刷新实例表"
                onClick={onReload}
              >
                ⟳
              </button>
            </div>
          </label>
          <p className="field-note">
            {rows.length} 个实例。列表里没有的槽位可以切「手动输入」。
          </p>
        </>
      )}
    </div>
  )
}

function pickVarNames(pick: PickerView): string[] {
  if (pick.mode === 'slot') return [pick.vars.slot]
  if (pick.mode === 'proN') return [pick.vars.pro, pick.vars.n]
  return [pick.vars.pro]
}

function currentValue(pick: PickerView, vars: VarDraft): string {
  if (pick.mode === 'slot') return vars[pick.vars.slot] ?? ''
  if (pick.mode === 'proN') {
    const pro = vars[pick.vars.pro] ?? ''
    const n = vars[pick.vars.n] ?? ''
    return pro && n ? `${pro}#${n}` : ''
  }
  return vars[pick.vars.pro] ?? ''
}

function optionValue(pick: PickerView, row: InstanceView): string {
  return pick.mode === 'pro' ? row.pro : row.slot
}

function groupByPro(rows: InstanceView[]): Map<string, InstanceView[]> {
  const map = new Map<string, InstanceView[]>()
  for (const row of rows) {
    const list = map.get(row.pro)
    if (list) list.push(row)
    else map.set(row.pro, [row])
  }
  return map
}

function uniquePros(rows: InstanceView[]): { pro: string; count: number }[] {
  const map = new Map<string, number>()
  for (const row of rows) map.set(row.pro, (map.get(row.pro) ?? 0) + 1)
  return [...map.entries()].map(([pro, count]) => ({ pro, count }))
}
