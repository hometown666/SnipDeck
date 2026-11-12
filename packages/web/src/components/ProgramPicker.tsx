import { useMemo, useState } from 'react'
import {
  PROGRAM_SOURCE_LABEL,
  type FilteredProgramView,
  type InstancesView,
  type PickerView,
  type ProgramsView,
  type VarView,
} from '../api'
import type { VarDraft } from '../types'

/**
 * 程序下拉（P7.3）：把 `lnk {{pro}}` 的变量变成「从发现的程序里选」。
 *
 * 和实例下拉同一套规矩：手动输入永远保留、列表只是便利、选中只写 var。
 * 唯一的区别是数据量级——本机 148 个候选，裸 `<select>` 已经不好用，
 * 所以上面加一个搜索框（匹配名字与目标路径），下面按来源分组。
 */
export function ProgramPicker({
  pick,
  vars,
  specs,
  programs,
  instances,
  error,
  onChange,
  onReload,
}: {
  pick: Extract<PickerView, { kind: 'programs' }>
  vars: VarDraft
  specs: Record<string, VarView>
  programs: ProgramsView | null
  /** 用来标「已开 N 个」；可为 null */
  instances: InstancesView | null
  error: string | null
  onChange: (patch: Record<string, string>) => void
  onReload: () => void
}) {
  const name = pick.vars.pro
  const spec = specs[name]
  const rows = programs?.programs ?? []
  const [manual, setManual] = useState(false)
  const [q, setQ] = useState('')
  const [showFiltered, setShowFiltered] = useState(false)
  const showManual = manual || rows.length === 0
  const current = vars[name] ?? ''

  const openCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const it of instances?.instances ?? []) map.set(it.pro, (map.get(it.pro) ?? 0) + 1)
    return map
  }, [instances])

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) || p.target.toLowerCase().includes(needle),
    )
  }, [rows, q])

  const groups = useMemo(() => {
    const map = new Map<string, typeof matched>()
    for (const p of matched) {
      const label = PROGRAM_SOURCE_LABEL[p.source] ?? p.source
      const list = map.get(label)
      if (list) list.push(p)
      else map.set(label, [p])
    }
    return [...map.entries()]
  }, [matched])

  const missing = current !== '' && !rows.some((p) => p.value === current)
  const filteredCount = programs?.filtered.length ?? 0

  return (
    <div className="instance-picker">
      <div className="picker-head">
        <span>
          程序 <em className="hint">扫 .lnk 与便携 .exe；选绝对路径，不依赖 PROG_DIR 配得对不对</em>
        </span>
        <button type="button" className="picker-toggle" onClick={() => setManual((v) => !v)}>
          {manual ? '从列表选' : '手动输入'}
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {programs?.error && <p className="field-note warn-note">{programs.error}</p>}
      {programs?.notes.map((n) => (
        <p className="field-note" key={n}>
          {n}
        </p>
      ))}
      {!programs && !error && <p className="field-note">扫描程序…（第一次要一两秒）</p>}

      {showManual ? (
        <label className="field">
          <span>
            {spec?.prompt ?? name}
            {spec?.required ? <em className="req"> *</em> : null}
          </span>
          <input
            value={current}
            placeholder={spec?.default != null ? String(spec.default) : 'WeChat 或 D:\\…\\WeChat.lnk'}
            spellCheck={false}
            onChange={(e) => onChange({ [name]: e.target.value })}
          />
        </label>
      ) : (
        <>
          <label className="field">
            <span>
              搜索 <em className="hint">名字或 exe 路径都能搜</em>
            </span>
            <div className="picker-row">
              <input
                value={q}
                placeholder="微信 / WeChat / wechat.exe"
                spellCheck={false}
                onChange={(e) => setQ(e.target.value)}
              />
              <button type="button" className="icon-btn" title="重新扫描" onClick={onReload}>
                ⟳
              </button>
            </div>
          </label>

          <label className="field">
            <span>
              从程序列表选 <em className="hint">选中后填 {spec?.prompt ?? name}</em>
            </span>
            <select value={current} onChange={(e) => onChange({ [name]: e.target.value })}>
              <option value="" disabled={current !== ''}>
                {matched.length === 0 ? '没有匹配的程序' : '选择程序…'}
              </option>
              {missing && <option value={current}>当前：{current}（不在列表里）</option>}
              {groups.map(([label, items]) => (
                <optgroup key={label} label={`${label}（${items.length}）`}>
                  {items.map((p) => {
                    const n = openCount.get(p.pro) ?? 0
                    return (
                      <option key={p.path} value={p.value}>
                        {p.name}
                        {p.kind === 'exe' ? '（便携 exe）' : ''}
                        {n > 0 ? `（已开 ${n}）` : ''}
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
          </label>

          <p className="field-note">
            {programs
              ? `${rows.length} 个程序 / 扫到 ${programs.total} 条（${programs.mode === 'only' ? 'only 模式' : '自动发现'}）`
              : ''}
            {filteredCount > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  className="picker-toggle"
                  onClick={() => setShowFiltered((v) => !v)}
                >
                  已过滤 {filteredCount} 项{showFiltered ? '（收起）' : ''}
                </button>
              </>
            )}
          </p>
          {showFiltered && <FilteredList items={programs?.filtered ?? []} />}
        </>
      )}
    </div>
  )
}

const REASON_TEXT: Record<FilteredProgramView['reason'], string> = {
  broken: '没有目标（UWP / 损坏）',
  dir: '指向文件夹',
  msi: 'msiexec 入口',
  uwp: '应用商店应用',
  uninstall: '卸载器',
  installer: '安装 / 更新程序',
  help: '帮助 / 官网',
  system: '系统工具',
  duplicate: '已有更高优先级来源',
}

/** 被挡掉的条目**永远能看到原因**，不然「我明明装了 X」只能靠猜 */
function FilteredList({ items }: { items: FilteredProgramView[] }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, 8)
  return (
    <div className="program-filtered">
      {shown.map((f) => (
        <div className="program-filtered__row" key={`${f.path}-${f.reason}`}>
          <span className="program-filtered__name">{f.name}</span>
          <span className="program-filtered__why">{REASON_TEXT[f.reason]}</span>
        </div>
      ))}
      {items.length > 8 && (
        <button type="button" className="picker-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `还有 ${items.length - 8} 项…`}
        </button>
      )}
    </div>
  )
}
