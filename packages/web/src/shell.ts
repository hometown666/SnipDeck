/* ==========================================================================
   shell.ts · 站点骨架交互（摘自 kakyo-web-ui-components/src/js/site.js）
   --------------------------------------------------------------------------
   React 项目里只需要「主题」这一块：
     - 抽屉开合由 App 的 navOpen state 驱动，不需要 DOM 脚本
     - 目录链接不走 hash 路由（本项目用 pathname 分流 / 与 /terminal），
       但统一用 data-target + JS 滚动，避免污染地址栏

   在 main.tsx 模块加载时调用一次 initTheme()。用 document 级事件委托，
   所以主题按钮无论由哪个组件渲染、什么时候挂载都能生效。
   ========================================================================== */

const THEMES: Record<string, string> = {
  claude: 'dark',
  forest: 'light',
  violet: 'dark',
  butterfly: 'light',
}

function storageGet(key: string, fallback: string | null): string | null {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function applyTheme(theme: string | null, mode: string | null): void {
  const root = document.documentElement
  const name = theme && theme in THEMES ? theme : 'claude'
  const nextMode = mode ?? THEMES[name] ?? 'dark'

  root.dataset.theme = name
  root.dataset.mode = nextMode
  root.style.colorScheme = nextMode

  document.querySelectorAll<HTMLElement>('[data-set-theme]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.setTheme === name))
  })
  document.querySelectorAll<HTMLElement>('[data-set-mode]').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.setMode === nextMode))
  })

  storageSet('ui-theme', name)
  storageSet('ui-mode', nextMode)
}

export function initTheme(): () => void {
  applyTheme(storageGet('ui-theme', 'claude'), storageGet('ui-mode', null))

  const onClick = (e: MouseEvent): void => {
    const target = e.target
    if (!(target instanceof Element)) return

    const themeBtn = target.closest<HTMLElement>('[data-set-theme]')
    if (themeBtn) {
      applyTheme(themeBtn.dataset.setTheme ?? null, null)
      return
    }

    const modeBtn = target.closest<HTMLElement>('[data-set-mode]')
    if (modeBtn) {
      applyTheme(document.documentElement.dataset.theme ?? null, modeBtn.dataset.setMode ?? null)
    }
  }

  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
