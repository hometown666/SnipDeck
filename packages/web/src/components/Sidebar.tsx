import type { SnippetView } from '../api'

/**
 * 展示站骨架的左侧固定栏（site.css）。
 *
 * 原来这里是「搜索 + 分组 + 快捷键提示」的窄侧栏，顶栏另有一条 Tabs。
 * 骨架照搬后：主视图导航（片段 / 终端）与分组导航都收进这一栏，
 * 底部换成站点状态与主题切换器。主题按钮只带 data-set-theme / data-set-mode，
 * 点击由 shell.ts 的 document 级委托处理，这里不持有任何主题状态。
 */
export function Sidebar({
  q,
  onQuery,
  onSubmit,
  groups,
  onNavigate,
  instanceCount,
  onInstances,
}: {
  q: string
  onQuery: (v: string) => void
  /** 搜索框里回车 = 执行当前选中项（与主区搜索框同一行为） */
  onSubmit: () => void
  groups: [string, SnippetView[]][]
  /** 窄屏下点分组后收起抽屉 */
  onNavigate: () => void
  /** 实例表条数；null = 还没读到 */
  instanceCount: number | null
  /** 打开实例表弹窗（手机没有顶栏徽标，这里是入口） */
  onInstances: () => void
}) {
  return (
    <aside className="site-sidebar">
      <div className="site-brand">
        <div className="site-brand__mark" aria-hidden="true">{'{}'}</div>
        <div className="site-brand__text">
          <span className="site-brand__name">SnipDeck</span>
          <span className="site-brand__sub">Snippet &amp; Run Deck</span>
        </div>
      </div>

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

      <nav className="site-nav" aria-label="主视图">
        <div className="site-nav__label">工作台</div>
        <a className="site-nav__item" href="/" aria-current="page">
          <svg aria-hidden="true"><use href="#i-layers" /></svg>片段
        </a>
        <a className="site-nav__item" href="/terminal">
          <svg aria-hidden="true"><use href="#i-terminal" /></svg>终端
        </a>
        <button type="button" className="site-nav__item" onClick={onInstances}>
          <svg aria-hidden="true"><use href="#i-database" /></svg>实例
          <em>{instanceCount ?? '—'}</em>
        </button>
      </nav>

      <nav className="site-nav" aria-label="分组">
        <div className="site-nav__label">分组</div>
        {groups.map(([g, items], i) => (
          <button
            key={g}
            type="button"
            className="site-nav__item"
            onClick={() => {
              document.getElementById(`grp-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              onNavigate()
            }}
          >
            <span>{g}</span>
            <em>{items.length}</em>
          </button>
        ))}
      </nav>

      <div className="site-sidebar__spacer" />

      <div className="site-status">
        <span className="site-status__dot" aria-hidden="true" />
        本地服务 · 片段已索引
      </div>

      <div className="site-theme">
        <div className="site-theme__row">
          <span className="site-theme__label">主题</span>
          <div className="site-theme__swatches" role="group" aria-label="主题预设">
            <button type="button" className="site-theme__swatch" data-set-theme="claude"
                    style={{ background: '#cc785c' }} aria-label="Claude 暖橘" title="Claude 暖橘" />
            <button type="button" className="site-theme__swatch" data-set-theme="forest"
                    style={{ background: '#0f6e56' }} aria-label="Forest 墨绿" title="Forest 墨绿" />
            <button type="button" className="site-theme__swatch" data-set-theme="violet"
                    style={{ background: '#8b83e8' }} aria-label="Violet 冷紫" title="Violet 冷紫" />
            <button type="button" className="site-theme__swatch" data-set-theme="butterfly"
                    style={{ background: '#c0603a' }} aria-label="Butterfly 博客" title="Butterfly 博客" />
          </div>
        </div>
        <div className="site-theme__row">
          <span className="site-theme__label">外观</span>
          <div className="site-theme__swatches" role="group" aria-label="明暗模式">
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon-sm"
                    data-set-mode="dark" aria-label="暗色" title="暗色">
              <svg aria-hidden="true"><use href="#i-moon" /></svg>
            </button>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--icon-sm"
                    data-set-mode="light" aria-label="亮色" title="亮色">
              <svg aria-hidden="true"><use href="#i-sun" /></svg>
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
