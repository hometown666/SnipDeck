import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { initTheme } from './shell'
// 图标 symbol 随 bundle 一起加载，避免在 /terminal 这类 SPA 回退路径下
// 相对路径 ./kakyo-ui/icons.js 被解析错而 404。副作用导入：注入 <svg> 到 body 开头。
import './vendor/kakyo-ui/icons.js'
import './styles.css'

// 主题用 document 级事件委托，模块加载时挂一次即可，不受 React StrictMode 重挂载影响。
// 抽屉开合由 App 的 navOpen state 驱动，不需要脚本。
initTheme()

// 两页共用一个入口，按路径分流：不值得为一个链接引入 router。
// 服务端 setNotFoundHandler 已经把 /terminal 回退到 index.html。
const path = window.location.pathname.replace(/\/+$/, '')
const isTerminal = path.endsWith('/terminal')

// **终端页必须懒加载**：xterm.js 是 450KB 的量级（gzip 后约 130KB），
// 打进主包的话，手机打开片段页也要先把它下完。动态 import 之后，
// 片段页的包体维持在 P2.5 的水平，终端是单独一个 chunk。
const TerminalApp = React.lazy(() =>
  import('./TerminalApp').then((m) => ({ default: m.TerminalApp })),
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isTerminal ? (
      <Suspense fallback={null}>
        <TerminalApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
)

// service worker 只在安全上下文（https / localhost）可用。
// 经 http://100.x.x.x:7878 访问时 isSecureContext 为 false，这里静默跳过——
// 此时「加到主屏」仍可用，但没有离线缓存。
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('[snipdeck] service worker 注册失败', e)
    })
  })
}
