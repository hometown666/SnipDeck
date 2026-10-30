import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  api,
  type HostView,
  type SnippetDetail,
  type SnippetStep,
  type SnippetVarSpec,
} from '../api'

/**
 * 片段编辑器（结构化表单）。
 *
 * 设计取舍（2026-10-31 拍板，见 docs/04-phases.md §33）：
 * - 用表单而不是原文 YAML：字段多、手机上要能改；代价是保存会重排整份 YAML，
 *   `meta.note` 的 `>` 折叠块会变成普通多行串。内容不丢，形式会变。
 * - **`meta` 里非字符串的值不展示**：它们被原样带回（`hiddenMeta`），
 *   否则「把对象拍平成 "[object Object]"」这种静默损坏迟早会发生。
 * - 数字字段在输入框里是字符串：`timeout` 允许暂时为空，保存时才校验，
 *   不然「删掉再输入」会被 input[type=number] 的 NaN 卡住。
 */

type VarRow = {
  name: string
  prompt: string
  def: string
  /** 原来的 default 是数字：保存时还原成数字，别把 16 条片段全变成字符串 */
  defNum: boolean
  choices: string
  choicesNum: boolean
  secret: boolean
}

type MetaRow = { key: string; value: string }

type Do = 'run' | 'sleep' | 'expect'

type StepRow = {
  do: Do
  cmd: string
  ms: string
  match: string
  flags: string
  from: string
  timeout: string
  optional: boolean
}

type Form = {
  id: string
  title: string
  group: string
  target: string
  shell: '' | 'cmd' | 'powershell'
  tags: string
  danger: boolean
  meta: MetaRow[]
  vars: VarRow[]
  steps: StepRow[]
}

function blankStep(doKind: Do = 'run'): StepRow {
  return {
    do: doKind,
    cmd: '',
    ms: '',
    match: '',
    flags: '',
    from: '',
    timeout: '',
    optional: false,
  }
}

function blankForm(defaultTarget: string): Form {
  return {
    id: '',
    title: '',
    group: '',
    target: defaultTarget,
    shell: '',
    tags: '',
    danger: false,
    meta: [],
    vars: [],
    steps: [blankStep()],
  }
}

function stepRowOf(st: SnippetStep): StepRow {
  return {
    do: st.do,
    cmd: st.do === 'run' ? st.cmd : '',
    ms: st.do === 'sleep' ? String(st.ms) : '',
    match: st.do === 'expect' ? st.match : '',
    flags: st.do === 'expect' ? (st.flags ?? '') : '',
    from: st.do === 'expect' ? (st.from ?? '') : '',
    timeout: 'timeout' in st && st.timeout != null ? String(st.timeout) : '',
    optional: !!st.optional,
  }
}

function varRowOf(name: string, spec: SnippetVarSpec): VarRow {
  return {
    name,
    prompt: spec.prompt ?? '',
    def: spec.default == null ? '' : String(spec.default),
    defNum: typeof spec.default === 'number',
    choices: (spec.choices ?? []).map(String).join(', '),
    choicesNum: typeof spec.choices?.[0] === 'number',
    secret: !!spec.secret,
  }
}

/**
 * 从 detail 拆出「可编辑的行」与「原样带回的值」。
 * 非字符串的 meta 值一律进 hiddenMeta：表单里没有合适控件，
 * 展示成 JSON 再解析回去只会把类型改掉。
 */
function splitDetail(d: SnippetDetail): { form: Form; hiddenMeta: Record<string, unknown> } {
  const hiddenMeta: Record<string, unknown> = {}
  const meta: MetaRow[] = []
  for (const [k, v] of Object.entries(d.meta ?? {})) {
    if (typeof v === 'string') meta.push({ key: k, value: v })
    else hiddenMeta[k] = v
  }
  return {
    form: {
      id: d.id,
      title: d.title ?? '',
      group: d.group ?? '',
      target: d.target ?? '',
      shell: d.shell ?? '',
      tags: (d.tags ?? []).join(', '),
      danger: !!d.danger,
      meta,
      vars: Object.entries(d.vars ?? {}).map(([k, v]) => varRowOf(k, v)),
      steps: d.steps.map(stepRowOf),
    },
    hiddenMeta,
  }
}

function stepOf(r: StepRow, i: number): SnippetStep | string {
  const n = i + 1
  if (r.do === 'run') {
    if (!r.cmd.trim()) return `第 ${n} 步（run）缺命令`
    const step: { do: 'run'; cmd: string; timeout?: number; optional?: boolean } = {
      do: 'run',
      cmd: r.cmd,
    }
    if (r.timeout.trim()) {
      const t = Number(r.timeout)
      if (!Number.isFinite(t) || t <= 0) return `第 ${n} 步的 timeout 必须是正数（秒）`
      step.timeout = t
    }
    if (r.optional) step.optional = true
    return step
  }
  if (r.do === 'sleep') {
    const ms = Number(r.ms)
    if (!r.ms.trim() || !Number.isFinite(ms) || ms < 0) return `第 ${n} 步（sleep）要填毫秒数`
    const step: { do: 'sleep'; ms: number; optional?: boolean } = { do: 'sleep', ms }
    if (r.optional) step.optional = true
    return step
  }
  if (!r.match.trim()) return `第 ${n} 步（expect）缺正则`
  try {
    new RegExp(r.match, r.flags || undefined)
  } catch (e) {
    return `第 ${n} 步的正则无效：${e instanceof Error ? e.message : String(e)}`
  }
  const step: {
    do: 'expect'
    match: string
    flags?: string
    from?: string
    timeout?: number
    optional?: boolean
  } = { do: 'expect', match: r.match }
  if (r.flags.trim()) step.flags = r.flags.trim()
  if (r.from.trim()) step.from = r.from.trim()
  if (r.timeout.trim()) {
    const t = Number(r.timeout)
    if (!Number.isFinite(t) || t <= 0) return `第 ${n} 步的 timeout 必须是正数（秒）`
    step.timeout = t
  }
  if (r.optional) step.optional = true
  return step
}

function numberish(s: string, asNumber: boolean): string | number {
  if (!asNumber) return s
  const n = Number(s)
  return Number.isFinite(n) ? n : s
}

export function SnippetEditor({
  snippetId,
  hosts,
  groups,
  onSaved,
  onClose,
}: {
  /** 省略 = 新建 */
  snippetId?: string
  hosts: HostView[]
  /** 现有分组名，用作 datalist */
  groups: string[]
  onSaved: (message: string) => void
  onClose: () => void
}) {
  const editing = !!snippetId
  const defaultTarget = (hosts.find((h) => h.default && !h.reserved) ?? hosts.find((h) => !h.reserved))?.name ?? ''
  const [form, setForm] = useState<Form>(() => blankForm(defaultTarget))
  const [hiddenMeta, setHiddenMeta] = useState<Record<string, unknown>>({})
  const [mtimeMs, setMtimeMs] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(editing)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const idRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!snippetId) {
      idRef.current?.focus()
      return
    }
    let alive = true
    setLoading(true)
    api
      .snippetDetail(snippetId)
      .then((d) => {
        if (!alive) return
        const { form: f, hiddenMeta: h } = splitDetail(d)
        setForm(f)
        setHiddenMeta(h)
        setMtimeMs(d.mtimeMs)
        setLoadError(null)
      })
      .catch((e) => {
        if (!alive) return
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [snippetId])

  const patch = useCallback((p: Partial<Form>) => setForm((f) => ({ ...f, ...p })), [])

  function patchStep(i: number, p: Partial<StepRow>) {
    setForm((f) => ({ ...f, steps: f.steps.map((s, k) => (k === i ? { ...s, ...p } : s)) }))
  }

  function moveStep(i: number, dir: -1 | 1) {
    setForm((f) => {
      const next = [...f.steps]
      const j = i + dir
      if (j < 0 || j >= next.length) return f
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return { ...f, steps: next }
    })
  }

  function patchVar(i: number, p: Partial<VarRow>) {
    setForm((f) => ({ ...f, vars: f.vars.map((v, k) => (k === i ? { ...v, ...p } : v)) }))
  }

  function patchMeta(i: number, p: Partial<MetaRow>) {
    setForm((f) => ({ ...f, meta: f.meta.map((m, k) => (k === i ? { ...m, ...p } : m)) }))
  }

  async function save() {
    setError(null)
    const id = form.id.trim()
    if (!id) return setError('id 不能为空')
    if (form.steps.length === 0) return setError('至少要有一个步骤')

    const steps: SnippetStep[] = []
    for (const [i, r] of form.steps.entries()) {
      const s = stepOf(r, i)
      if (typeof s === 'string') return setError(s)
      steps.push(s)
    }

    const vars: Record<string, SnippetVarSpec> = {}
    const names = new Set<string>()
    for (const [i, r] of form.vars.entries()) {
      const name = r.name.trim()
      if (!name) return setError(`第 ${i + 1} 个变量没有名字`)
      if (names.has(name)) return setError(`变量名重复：${name}`)
      names.add(name)
      const spec: SnippetVarSpec = {}
      if (r.prompt.trim()) spec.prompt = r.prompt.trim()
      if (r.def !== '') spec.default = numberish(r.def, r.defNum)
      const choices = r.choices
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== '')
        .map((c) => numberish(c, r.choicesNum))
      if (choices.length) spec.choices = choices
      if (r.secret) spec.secret = true
      vars[name] = spec
    }

    const meta: Record<string, unknown> = { ...hiddenMeta }
    for (const [i, r] of form.meta.entries()) {
      const key = r.key.trim()
      if (!key) return setError(`第 ${i + 1} 行 meta 没有键`)
      meta[key] = r.value
    }

    const payload = {
      id,
      title: form.title.trim() || undefined,
      group: form.group.trim() || undefined,
      target: form.target.trim() || undefined,
      shell: form.shell || undefined,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      danger: form.danger,
      meta: Object.keys(meta).length ? meta : undefined,
      vars: Object.keys(vars).length ? vars : undefined,
      steps,
      mtimeMs,
    }

    setSaving(true)
    try {
      if (editing && snippetId) {
        const r = await api.updateSnippet(snippetId, payload)
        onSaved(r.renamed ? `已保存（id 改为 ${r.id}）` : '已保存')
      } else {
        await api.createSnippet(payload)
        onSaved(`已新建 ${id}`)
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
        setError(e.message)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!snippetId) return
    setSaving(true)
    setError(null)
    try {
      const r = await api.deleteSnippet(snippetId)
      onSaved(`已删除（副本在 ${r.backup}）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
      setConfirmDelete(false)
    }
  }

  const shellLabel: Record<Do, string> = {
    run: '执行命令',
    sleep: '等待',
    expect: '断言输出',
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal editor" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? '编辑片段' : '新建片段'}</h3>
        <p className="modal-sub">
          {editing
            ? '保存会重写整份 YAML：注释与字段顺序不保留，内容保真。'
            : '新片段按分组落到 snippets/<分组>/ 下，id 必须全库唯一。'}
        </p>

        {loading ? (
          <p className="empty">加载中…</p>
        ) : loadError ? (
          <p className="form-error">{loadError}</p>
        ) : (
          <>
            <div className="editor-grid">
              <label className="field">
                <span>
                  id<em className="req"> *</em>
                </span>
                <input
                  ref={idRef}
                  value={form.id}
                  placeholder="例如 run-backtrans"
                  onChange={(e) => patch({ id: e.target.value })}
                />
              </label>
              <label className="field">
                <span>标题</span>
                <input
                  value={form.title}
                  placeholder="卡片上显示的名字"
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </label>
              <label className="field">
                <span>分组</span>
                <input
                  value={form.group}
                  list="editor-groups"
                  placeholder="例如 状态（留空 = 未分组）"
                  onChange={(e) => patch({ group: e.target.value })}
                />
                <datalist id="editor-groups">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>目标</span>
                <select value={form.target} onChange={(e) => patch({ target: e.target.value })}>
                  <option value="">跟随默认目标</option>
                  {hosts.map((h) => (
                    <option key={h.name} value={h.name}>
                      {h.name}
                      {h.reserved ? '（预留）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>shell</span>
                <select
                  value={form.shell}
                  onChange={(e) => patch({ shell: e.target.value as Form['shell'] })}
                >
                  <option value="">跟随目标</option>
                  <option value="cmd">cmd</option>
                  <option value="powershell">powershell</option>
                </select>
              </label>
              <label className="field">
                <span>标签</span>
                <input
                  value={form.tags}
                  placeholder="逗号分隔，例如 shell, python"
                  onChange={(e) => patch({ tags: e.target.value })}
                />
              </label>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={form.danger}
                onChange={(e) => patch({ danger: e.target.checked })}
              />
              <span>标记为 danger（执行前要二次确认）</span>
            </label>

            <section className="editor-section">
              <h4>
                变量 <em>{form.vars.length}</em>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      vars: [
                        ...f.vars,
                        {
                          name: '',
                          prompt: '',
                          def: '',
                          defNum: false,
                          choices: '',
                          choicesNum: false,
                          secret: false,
                        },
                      ],
                    }))
                  }
                >
                  ＋ 变量
                </button>
              </h4>
              {form.vars.length === 0 && <p className="editor-hint">没有变量。命令里的 {'{{名}}'} 会渲染成对应用户输入。</p>}
              {form.vars.map((v, i) => (
                <div className="editor-row" key={i}>
                  <input
                    className="mono"
                    value={v.name}
                    placeholder="名字"
                    onChange={(e) => patchVar(i, { name: e.target.value })}
                  />
                  <input
                    value={v.prompt}
                    placeholder="提示文案"
                    onChange={(e) => patchVar(i, { prompt: e.target.value })}
                  />
                  <input
                    value={v.def}
                    placeholder="默认值"
                    onChange={(e) => patchVar(i, { def: e.target.value })}
                  />
                  <input
                    value={v.choices}
                    placeholder="选项（逗号分隔）"
                    onChange={(e) => patchVar(i, { choices: e.target.value })}
                  />
                  <label className="mini-check" title="secret 变量的值不会回显，也不落运行档案">
                    <input
                      type="checkbox"
                      checked={v.secret}
                      onChange={(e) => patchVar(i, { secret: e.target.checked })}
                    />
                    secret
                  </label>
                  <button
                    type="button"
                    className="icon-btn small"
                    aria-label={`删除变量 ${v.name || i + 1}`}
                    onClick={() => setForm((f) => ({ ...f, vars: f.vars.filter((_, k) => k !== i) }))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>

            <section className="editor-section">
              <h4>
                步骤 <em>{form.steps.length}</em>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, blankStep()] }))}
                >
                  ＋ 步骤
                </button>
              </h4>
              {form.steps.map((s, i) => (
                <div className={`editor-step${s.optional ? ' optional' : ''}`} key={i}>
                  <div className="editor-step-head">
                    <strong>#{i + 1}</strong>
                    <select
                      value={s.do}
                      onChange={(e) => patchStep(i, { do: e.target.value as Do })}
                    >
                      {(['run', 'sleep', 'expect'] as Do[]).map((k) => (
                        <option key={k} value={k}>
                          {shellLabel[k]}
                        </option>
                      ))}
                    </select>
                    <label className="mini-check" title="失败也继续往下走">
                      <input
                        type="checkbox"
                        checked={s.optional}
                        onChange={(e) => patchStep(i, { optional: e.target.checked })}
                      />
                      可失败
                    </label>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label="上移"
                      disabled={i === 0}
                      onClick={() => moveStep(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label="下移"
                      disabled={i === form.steps.length - 1}
                      onClick={() => moveStep(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`删除第 ${i + 1} 步`}
                      disabled={form.steps.length === 1}
                      onClick={() =>
                        setForm((f) => ({ ...f, steps: f.steps.filter((_, k) => k !== i) }))
                      }
                    >
                      ×
                    </button>
                  </div>
                  {s.do === 'run' && (
                    <textarea
                      className="mono"
                      rows={2}
                      value={s.cmd}
                      placeholder="call C:\ahk_trigger\ahk.bat shell shell#{{n}} …"
                      onChange={(e) => patchStep(i, { cmd: e.target.value })}
                    />
                  )}
                  {s.do === 'sleep' && (
                    <div className="editor-row tight">
                      <input
                        value={s.ms}
                        inputMode="numeric"
                        placeholder="毫秒，例如 1500"
                        onChange={(e) => patchStep(i, { ms: e.target.value })}
                      />
                    </div>
                  )}
                  {s.do === 'expect' && (
                    <>
                      <textarea
                        className="mono"
                        rows={2}
                        value={s.match}
                        placeholder="正则正文（不含 /…/）"
                        onChange={(e) => patchStep(i, { match: e.target.value })}
                      />
                      <div className="editor-row tight">
                        <input
                          value={s.flags}
                          className="mono"
                          placeholder="flags（i / m / s）"
                          onChange={(e) => patchStep(i, { flags: e.target.value })}
                        />
                        <input
                          value={s.from}
                          className="mono"
                          placeholder="from：last / all / file:C:\path"
                          onChange={(e) => patchStep(i, { from: e.target.value })}
                        />
                      </div>
                    </>
                  )}
                  {s.do !== 'sleep' && (
                    <div className="editor-row tight">
                      <input
                        value={s.timeout}
                        inputMode="numeric"
                        placeholder="timeout（秒，可空）"
                        onChange={(e) => patchStep(i, { timeout: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              ))}
            </section>

            <section className="editor-section">
              <h4>
                meta <em>{form.meta.length}</em>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => setForm((f) => ({ ...f, meta: [...f.meta, { key: '', value: '' }] }))}
                >
                  ＋ 键值
                </button>
              </h4>
              <p className="editor-hint">
                只编辑文本字段。嵌套结构
                {Object.keys(hiddenMeta).length > 0 ? `（${Object.keys(hiddenMeta).join(', ')}）` : ''}
                会原样保留，不在这里显示。
              </p>
              {form.meta.map((m, i) => (
                <div className="editor-row meta" key={i}>
                  <input
                    className="mono"
                    value={m.key}
                    placeholder="键"
                    onChange={(e) => patchMeta(i, { key: e.target.value })}
                  />
                  <textarea
                    // 按内容估行高：`rows={1}` 时一句长 note 会被裁成一行半，
                    // 而「看不到自己在编辑什么」比多占两行高度糟得多
                    rows={Math.min(6, Math.max(2, Math.ceil(m.value.length / 44)))}
                    value={m.value}
                    placeholder="值"
                    onChange={(e) => patchMeta(i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-btn small"
                    aria-label={`删除 meta ${m.key}`}
                    onClick={() => setForm((f) => ({ ...f, meta: f.meta.filter((_, k) => k !== i) }))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          </>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {editing && (
            <button
              className={`btn${confirmDelete ? ' danger' : ' ghost'}`}
              disabled={saving || loading}
              onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
            >
              {confirmDelete ? '确认删除？' : '删除'}
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={saving || loading || !!loadError}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
