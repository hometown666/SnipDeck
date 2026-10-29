import type { HealthView } from '../api'

/**
 * 顶栏：桥状态、队列徽标、刷新 / 历史 / 设置三个按钮。
 * 纯展示——所有状态与回调都由 App 注入，这里不碰网络。
 */
export function Topbar({
  health,
  tokenSet,
  replayed,
  onRefresh,
  onHistory,
  onSettings,
}: {
  health: HealthView | null
  tokenSet: boolean
  replayed: boolean
  onRefresh: () => void
  onHistory: () => void
  onSettings: () => void
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">{'{}'}</span>
        <span className="name">SnipDeck</span>
      </div>
      <div className="topbar-right">
        <span className={`badge ${health?.bridgeUp ? 'up' : 'down'}`} title="AHK 桥状态">
          {health === null ? '…' : health.bridgeUp ? 'bridge up' : 'bridge down'}
        </span>
        {health && health.queue > 0 ? (
          <span className="badge queue" title="桥单车道队列长度">
            排队 {health.queue}
          </span>
        ) : null}
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
