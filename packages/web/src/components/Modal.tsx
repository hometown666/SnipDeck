import type { ReactNode } from 'react'

/**
 * 弹窗外壳：统一遮罩、点击外部关闭、**滚动发生在内层**。
 *
 * 为什么要有内层：`overflow: auto` 直接挂在外层时，Windows / Chrome 的原生滚动条
 * 会从顶到底占满右边缘，把右上角（和桌面端的右下角）的圆角"切"成直角——
 * 滚动条画在圆角裁剪之外。把滚动挪到 `.modal-scroll` 里，滚动条就落在外层圆角以内，
 * 圆角永远是圆的；顺带也让「sticky 底部按钮」有个明确的滚动容器。
 *
 * 顺带统一的两件事：mask 点击关闭（每个弹窗原本各写一遍）、stopPropagation。
 */
export function Modal({
  className = '',
  onClose,
  children,
}: {
  className?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className={`modal ${className}`.trim()} onClick={(e) => e.stopPropagation()}>
        <div className="modal-scroll">{children}</div>
      </div>
    </div>
  )
}
