import type { HealthView } from '../api'

/**
 * 展示站骨架的页头（site.css 的 .site-header）。
 *
 * 原来这里是整条顶栏（brand + Tabs + 一排按钮）。骨架照搬后 brand 与 Tabs
 * 都移进了左侧固定栏，这里只保留面包屑、移动端菜单按钮和右侧动作区。
 * 纯展示——所有状态与回调都由 App 注入，这里不碰网络。
 */
export function Topbar({
  health,
  instanceCount,
  tokenSet,
  replayed,
  onRefresh,
  onHistory,
  onSettings,
  onNew,
  onMenu,
  onBridge,
}: {
  health: HealthView | null
  /** 实例表条数；null = 还没读到（不等于 0） */
  instanceCount: number | null
  tokenSet: boolean
  replayed: boolean
  onRefresh: () => void
  onHistory: () => void
  onSettings: () => void
  onNew: () => void
  /** 窄屏下打开左侧抽屉 */
  onMenu: () => void
  /** 打开实例表弹窗（桌面入口；手机走左栏） */
  onBridge: () => void
}) {
  return (
    <header className="site-header">
      <button
        type="button"
        className="site-menu-btn ui-btn ui-btn--ghost ui-btn--icon-sm"
        onClick={onMenu}
        aria-label="打开导航"
        aria-expanded="false"
      >
        <svg aria-hidden="true"><use href="#i-menu" /></svg>
      </button>

      <nav className="site-crumb" aria-label="面包屑">
        <span>remote text control</span>
        <svg aria-hidden="true"><use href="#i-chevron-right" /></svg>
        <span className="site-crumb__current">片段</span>
      </nav>

      <div className="site-header__actions">
        <button
          type="button"
          className={`badge badge-btn ${health?.bridgeUp ? 'up' : 'down'}`}
          title="桥状态与实例表"
          onClick={onBridge}
        >
          {health === null ? '…' : health.bridgeUp ? 'bridge up' : 'bridge down'}
          {instanceCount != null ? ` · ${instanceCount}` : ''}
        </button>
        {health && health.queue > 0 ? (
          <span className="badge queue" title="桥单车道队列长度">
            排队 {health.queue}
          </span>
        ) : null}
        <button className="icon-btn" onClick={onNew} aria-label="新建片段" title="新建片段（N）">
          ＋
        </button>
        <button className="icon-btn" onClick={onRefresh} aria-label="刷新" title="刷新（R）">
          ⟳
        </button>
        <button
          className={`icon-btn${replayed ? ' on' : ''}`}
          onClick={onHistory}
          aria-label="运行历史"
          title="运行历史（H）"
        >
          🕘
        </button>
        <button
          className={`icon-btn${tokenSet ? ' on' : ''}`}
          onClick={onSettings}
          aria-label="设置"
          title="访问 token"
        >
          ⚙
        </button>
      </div>
    </header>
  )
}
