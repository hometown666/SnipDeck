import { useEffect, useMemo, useState } from 'react'
import { api, type SnippetView } from '../api'

/**
 * 片段宏面板（P5.4）。
 *
 * 把片段库当「命令面板」用：点一条 → 渲染出最终命令行 → 插到终端输入行。
 *
 * **默认不回车**（insert 语义）。终端里误执行的代价比多点一次高得多，
 * 所以「插入并执行」放在次要位置，主按钮只插入。
 * 多步片段（steps > 1）不给插入：多行命令在 cmd / powershell 里的连接符不一样，
 * 硬拼会在其中一种 shell 上出错，不如让它回片段页跑。
 */
export function MacroPanel({
  snippets,
  onInsert,
  onClose,
}: {
  snippets: SnippetView[]
  onInsert: (cmd: string, execute: boolean) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState<SnippetView | null>(null)
  const [vars, setVars] = useState<Record<string, string>>({})
  const [cmds, setCmds] = useState<string[] | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return snippets
    return snippets.filter((s) =>
      [s.title, s.id, s.group, ...(s.tags ?? [])].join(' ').toLowerCase().includes(needle),
    )
  }, [q, snippets])

  const groups = useMemo(() => {
    const m = new Map<string, SnippetView[]>()
    for (const s of filtered) {
      const list = m.get(s.group) ?? []
      list.push(s)
      m.set(s.group, list)
    }
    return [...m.entries()]
  }, [filtered])

  // 打开某条时先按默认值填一遍，用户就不用把默认值再敲一次
  useEffect(() => {
    if (!active) return
    const init: Record<string, string> = {}
    for (const [k, v] of Object.entries(active.vars ?? {})) {
      if (v.default !== undefined) init[k] = String(v.default)
      else if (v.choices && v.choices.length > 0) init[k] = String(v.choices[0])
    }
    setVars(init)
    setCmds(null)
  }, [active])

  // 变量改一下就重渲染一次预览（250ms 防抖）：验收要求「变量值正确转义」，得看得见
  useEffect(() => {
    if (!active) return
    let alive = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      api
        .preview(active.id, vars)
        .then((r) => {
          if (!alive) return
          setCmds(r.cmds)
          setMissing(r.missing)
          setErr(null)
        })
        .catch((e: unknown) => {
          if (alive) setErr(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [active, vars])

  const multi = (cmds?.length ?? 0) > 1
  const ready = !!cmds && cmds.length === 1 && missing.length === 0 && !multi

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="macro" onClick={(e) => e.stopPropagation()}>
        {active ? (
          <>
            <div className="macro-head">
              <button className="macro-back" onClick={() => setActive(null)} aria-label="返回列表">
                ←
              </button>
              <h3>{active.title}</h3>
              <button className="icon-btn" onClick={onClose} aria-label="关闭">
                ×
              </button>
            </div>
            <p className="macro-sub">
              {active.id} · {active.steps} 步{active.danger ? ' · 危险' : ''}
            </p>

            {Object.keys(active.vars ?? {}).length > 0 ? (
              <div className="macro-vars">
                {Object.entries(active.vars ?? {}).map(([name, spec]) => (
                  <label key={name} className="macro-var">
                    <span>{spec.prompt ?? name}</span>
                    {spec.choices && spec.choices.length > 0 ? (
                      <select
                        value={vars[name] ?? ''}
                        onChange={(e) => setVars((p) => ({ ...p, [name]: e.target.value }))}
                      >
                        {spec.choices.map((c) => (
                          <option key={String(c)} value={String(c)}>
                            {String(c)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={spec.secret ? 'password' : 'text'}
                        value={vars[name] ?? ''}
                        onChange={(e) => setVars((p) => ({ ...p, [name]: e.target.value }))}
                        placeholder={spec.required ? '必填' : '可留空'}
                      />
                    )}
                  </label>
                ))}
              </div>
            ) : null}

            <div className="macro-preview">
              <div className="macro-preview-label">
                将插入到终端
                {loading ? <em>（渲染中…）</em> : null}
              </div>
              {err ? <div className="macro-bad">{err}</div> : null}
              {multi ? (
                <div className="macro-bad">
                  这条片段有 {cmds?.length} 条命令，多步片段请在片段页执行（cmd 与 powershell
                  的多行连接符不同，硬拼会出错）
                </div>
              ) : (
                <pre>{cmds?.[0] ?? '…'}</pre>
              )}
              {missing.length > 0 ? (
                <div className="macro-bad">还缺变量：{missing.join('、')}</div>
              ) : null}
            </div>

            <div className="macro-actions">
              <button
                className="macro-primary"
                disabled={!ready}
                onClick={() => cmds && onInsert(cmds[0] ?? '', false)}
              >
                插入到终端
              </button>
              <button
                className="macro-secondary"
                disabled={!ready}
                onClick={() => cmds && onInsert(cmds[0] ?? '', true)}
                title="插入并立刻回车执行"
              >
                插入并执行
              </button>
            </div>
            <p className="macro-hint">
              插入只是把命令放进输入行，回车还是你自己按——终端里误执行的代价比多点一次高。
            </p>
          </>
        ) : (
          <>
            <div className="macro-head">
              <h3>片段</h3>
              <button className="icon-btn" onClick={onClose} aria-label="关闭">
                ×
              </button>
            </div>
            <input
              className="macro-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜标题 / id / 分组 / 标签"
              autoFocus
            />
            <div className="macro-list">
              {groups.length === 0 ? <p className="macro-empty">没有匹配的片段</p> : null}
              {groups.map(([group, list]) => (
                <div key={group} className="macro-group">
                  <div className="macro-group-name">
                    {group}
                    <em>{list.length}</em>
                  </div>
                  {list.map((s) => (
                    <button
                      key={s.id}
                      className="macro-item"
                      onClick={() => setActive(s)}
                      data-macro-id={s.id}
                    >
                      <span className="macro-item-title">{s.title}</span>
                      <span className="macro-item-meta">
                        {s.id}
                        {Object.keys(s.vars ?? {}).length > 0
                          ? ` · ${Object.keys(s.vars).length} 变量`
                          : ''}
                        {s.steps > 1 ? ` · ${s.steps} 步` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
