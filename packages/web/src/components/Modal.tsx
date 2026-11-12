import type { ReactNode } from 'react'

/**
 * 弹窗外壳：统一遮罩、点击外部关闭、**滚动发生在内层**、底部按钮固定在外层。
 *
 * 为什么要有 `.modal-scroll`：`overflow: auto` 直接挂在外层时，Windows / Chrome 的原生滚动条
 * 会从顶到底占满右边缘，把右上角（和桌面端的右下角）的圆角"切"成直角——
 * 滚动条画在圆角裁剪之外。把滚动挪到 `.modal-scroll` 里，滚动条就落在外层圆角以内。
 *
 * 为什么要有 `footer`：按钮属于"永远看得见"的那一层。放进滚动区就得靠 `position: sticky`
 * 假装固定，一粘就会盖住最后一行内容，滚动条也会从按钮条上穿过去。拆成
 * 「滚动区 + 固定底栏」之后，滚动区自己让出底栏的高度，内容永远滚到按钮上方为止。
 */
export function Modal({
  className = '',
  onClose,
  footer,
  children,
  centered = false,
}: {
  className?: string
  onClose: () => void
  /** 弹窗最底部的按钮条：不参与滚动，永远贴在弹窗下沿 */
  footer?: ReactNode
  children: ReactNode
  /** 运行结果这类需要大视野的弹窗：桌面居中，窄屏仍回到底部 */
  centered?: boolean
}) {
  return (
    <div className={`modal-mask${centered ? ' is-centered' : ''}`} onClick={onClose}>
      <div className={`modal ${className}`.trim()} onClick={(e) => e.stopPropagation()}>
        <div className="modal-scroll">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}
