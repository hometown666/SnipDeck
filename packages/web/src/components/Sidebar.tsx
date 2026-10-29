import type { SnippetView } from '../api'

/**
 * 桌面态左栏（≥1024px）：搜索框 + 分组导航 + 快捷键提示。
 * 分组点击不触发路由，只把对应 section 滚到顶——列表是单页的，别引入滚动状态。
 */
export function Sidebar({
  q,
  onQuery,
  onSubmit,
  groups,
}: {
  q: string
  onQuery: (v: string) => void
  /** 搜索框里回车 = 执行当前选中项（与主区搜索框同一行为） */
  onSubmit: () => void
  groups: [string, SnippetView[]][]
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <input
          data-search
          type="search"
          placeholder="搜索（/）"
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
          }}
        />
      </div>
      <nav className="nav">
        {groups.map(([g, items], i) => (
          <button
            key={g}
            className="nav-item"
            onClick={() =>
              document.getElementById(`grp-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }
          >
            <span className="nav-name">{g}</span>
            <em>{items.length}</em>
          </button>
        ))}
      </nav>
      <p className="nav-hint">/ 搜索 · ↑↓ 选择 · Enter 执行 · T 选目标 · H 历史 · Esc 关闭</p>
    </aside>
  )
}
