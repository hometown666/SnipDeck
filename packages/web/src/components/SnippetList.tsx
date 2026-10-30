import type { SnippetView } from '../api'

/**
 * 主区：搜索栏 + 「缺 token」横幅 + 分组卡片墙。
 *
 * 卡片是 button，右上角的 ⊕ 用 span 承担点击（不能嵌 button）。
 * 隐形时靠 CSS 的 pointer-events:none 关掉命中测试，键盘入口是 `T`（ISSUE-008）。
 */
export function SnippetList({
  q,
  onQuery,
  onSubmit,
  groups,
  activeIndex,
  active,
  onOpen,
  onFan,
  onEdit,
  needToken,
  onFillToken,
}: {
  q: string
  onQuery: (v: string) => void
  onSubmit: () => void
  groups: [string, SnippetView[]][]
  activeIndex: Map<string, number>
  active: number
  onOpen: (s: SnippetView) => void
  /** 打开目标选择器（同目标多开） */
  onFan: (s: SnippetView) => void
  /** 打开编辑器（不执行） */
  onEdit: (s: SnippetView) => void
  needToken: boolean
  onFillToken: () => void
}) {
  return (
    <div className="content">
      <div className="searchbar">
        <input
          data-search
          type="search"
          placeholder="搜索片段（id / 标题 / 分组 / 标签）…"
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
          }}
        />
      </div>

      {needToken && (
        <div className="banner">
          这台设备还没有 token，先填一次才能执行片段。
          <button className="link" onClick={onFillToken}>
            去填写
          </button>
        </div>
      )}

      <main className="groups">
        {groups.map(([g, items], gi) => (
          <section key={g} className="group" id={`grp-${gi}`}>
            <h2>
              {g} <em>{items.length}</em>
            </h2>
            <div className="cards">
              {items.map((s) => {
                const idx = activeIndex.get(s.id)
                return (
                  <button
                    key={s.id}
                    className={`card${s.danger ? ' danger' : ''}${idx === active ? ' active' : ''}`}
                    onClick={() => onOpen(s)}
                    title={`${s.title} · ${s.id}`}
                  >
                    <span className="card-title">{s.title}</span>
                    <span className="card-meta">
                      {s.id}
                      {Object.keys(s.vars).length > 0 ? ` · ${Object.keys(s.vars).length} 变量` : ''}
                      {s.danger ? ' · danger' : ''}
                    </span>
                    {/* 多开入口：卡片本身是 button，不能嵌 button，用 span 承担点击。
                        隐形时 pointer-events:none，键盘走 `T`（见快捷键）——要塞进 Tab 序列就得嵌
                        交互控件，读屏体验更差（ISSUE-008） */}
                    <span
                      className="card-fan"
                      role="button"
                      tabIndex={-1}
                      aria-label="选择执行目标"
                      title="选目标 / 同目标多开（选中卡片后按 T）"
                      onClick={(e) => {
                        e.stopPropagation()
                        onFan(s)
                      }}
                    >
                      ⊕
                    </span>
                    {/* 编辑入口：放右下角，与右上角的 ⊕ 对角分开——
                        两个热区挨在一起时，指针设备上很容易点错（一个是「选目标」，一个是「改片段」） */}
                    <span
                      className="card-edit"
                      role="button"
                      tabIndex={-1}
                      aria-label="编辑片段"
                      title="编辑片段（选中后按 E）"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(s)
                      }}
                    >
                      ✎
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="empty">没有匹配的片段</p>}
      </main>
    </div>
  )
}
