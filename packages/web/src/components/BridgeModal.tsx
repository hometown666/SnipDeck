import type { InstancesView } from '../api'
import { Modal } from './Modal'

/**
 * 实例表（P7.1）：只读。
 *
 * 这里刻意不放「软关 / 硬关」按钮：那会变成第二条写 `command.txt` 的路径，
 * 得和 ExecDriver 的串行队列重新对齐。当前只展示 listener 的 instances.txt，
 * 执行仍走片段（P7.2 会在片段表单里给实例下拉）。
 */
const STATE = {
  fresh: { label: '实时', className: 'up' },
  stale: { label: '可能过期', className: 'queue' },
  offline: { label: '离线', className: 'down' },
} as const

function fmtAge(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return '刚刚'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

export function BridgeModal({
  data,
  error,
  onRefresh,
  onClose,
}: {
  data: InstancesView | null
  /** 拉取失败（401 之外）：接口没通、目标不是 exec 等 */
  error: string | null
  onRefresh: () => void
  onClose: () => void
}) {
  const state = data ? STATE[data.listener.state] : null
  const countMismatch =
    data?.status.count != null && data.status.count !== data.instances.length

  return (
    <Modal
      className="bridge-modal"
      onClose={onClose}
      footer={
        <>
          <span className="modal-hint">每 4 秒自动刷新</span>
          <button className="btn ghost" onClick={onRefresh}>
            刷新
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <h3>实例表</h3>
      <p className="modal-sub">
        只有通过桥启动的窗口（lnk / run / shell）才会出现在这里；手动打开的窗口不在表内。
      </p>

      {error && <p className="form-error">{error}</p>}
      {!data && !error && <p className="field-note">读取中…</p>}

      {data && (
        <>
          <div className="bridge-meta">
            {state && <span className={`badge ${state.className}`}>{state.label}</span>}
            <span>更新于 {fmtAge(data.status.ageMs)}</span>
            {data.status.admin && <span>listener 提权</span>}
            {data.status.foreground && <span>前台 {data.status.foreground}</span>}
          </div>
          <p className="field-note">
            目标 <code>{data.target}</code> · 桥目录 <code>{data.bridge}</code>
          </p>
          {data.error && <p className="field-note warn-note">{data.error}</p>}
          {countMismatch && (
            <p className="field-note warn-note">
              listener 报告 {data.status.count} 条，文件里读到 {data.instances.length} 条 ——
              可能正在写，刷新一次再看。
            </p>
          )}

          {data.instances.length === 0 ? (
            <p className="field-note">
              实例表为空。先用 `lnk` / `run` 起一个窗口，再回来看。
            </p>
          ) : (
            <div className="bridge-list">
              {data.instances.map((it) => (
                <div className="bridge-card" key={it.slot}>
                  <div className="bridge-card__top">
                    <code className="bridge-card__slot">{it.slot}</code>
                    <span
                      className={`bridge-alive ${
                        it.alive === true ? 'on' : it.alive === false ? 'off' : ''
                      }`}
                    >
                      {it.alive === true
                        ? '运行中'
                        : it.alive === false
                          ? 'pid 已退出'
                          : '—'}
                    </span>
                  </div>
                  <div className="bridge-card__meta">
                    <span>{it.exe || '未知进程'}</span>
                    <span>pid {it.pid}</span>
                    <span>hwnd {it.hwnd}</span>
                    {it.ts && <span>启动于 {it.ts}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="field-note">
            表由 listener 每 10 秒回收一次；pid 判定只是辅助，槽位是否还在以桥为准。
          </p>
        </>
      )}
    </Modal>
  )
}
