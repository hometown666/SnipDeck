import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
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
