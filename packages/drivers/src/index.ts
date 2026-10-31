import type { Driver, HostTarget } from '@snipdeck/core'
import { ExecDriver } from './exec'

export { ExecDriver }
export type { ExecDriverOptions } from './exec'

export class ReservedDriverError extends Error {
  constructor(kind: string) {
    super(`driver "${kind}" 为 P5 预留，尚未激活`)
    this.name = 'ReservedDriverError'
  }
}

const cache = new Map<string, Driver>()

export function createDriver(
  target: HostTarget,
  opts: { tmpDir: string; extraEnv?: () => Record<string, string> },
): Driver {
  if (target.driver === 'local' || target.driver === 'ssh') {
    throw new ReservedDriverError(target.driver)
  }
  if (target.driver !== 'exec') {
    throw new Error(`unknown driver: ${String(target.driver)}`)
  }
  const bridgeRoot = target.bridge ?? 'C:\\ahk_trigger'
  const key = `exec:${bridgeRoot}`
  let driver = cache.get(key)
  if (!driver) {
    // 缓存的是实例，不缓存 env：extraEnv 是函数，设置改了下一条命令就生效
    driver = new ExecDriver({ bridgeRoot, tmpDir: opts.tmpDir, extraEnv: opts.extraEnv })
    cache.set(key, driver)
  }
  return driver
}
