/**
 * 顶栏主导航：片段 / 终端。
 *
 * 用整页跳转而不是前端路由：两页共享的只有这一条顶栏，
 * 为一个链接引入 router 不划算，而且 `/terminal` 已经由服务端的
 * SPA 回退兜住了（`app.ts` 的 setNotFoundHandler）。
 */
export function Tabs({ active }: { active: 'snippets' | 'terminal' }) {
  return (
    <nav className="tabs" aria-label="主视图">
      <a
        className={`tab${active === 'snippets' ? ' on' : ''}`}
        href="/"
        aria-current={active === 'snippets' ? 'page' : undefined}
      >
        片段
      </a>
      <a
        className={`tab${active === 'terminal' ? ' on' : ''}`}
        href="/terminal"
        aria-current={active === 'terminal' ? 'page' : undefined}
      >
        终端
      </a>
    </nav>
  )
}
