import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 从仓库根 `.env` 读 `SNIP_TOKEN`（也认环境变量）。
 *
 * 为什么 UI 脚本需要它：2026-10-31 的「方案 D」删掉了 loopback 豁免——
 * 只要服务设了 token，本机访问 `/api/*` 也要带 Bearer。
 * 不注入的话，脚本截到的每一张图都是「这台设备还没有 token」的横幅。
 */
export function readToken() {
  if (process.env.SNIP_TOKEN) return process.env.SNIP_TOKEN.trim()
  const file = join(REPO_ROOT, '.env')
  if (!existsSync(file)) return ''
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*SNIP_TOKEN\s*=\s*(.*)$/.exec(line)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/**
 * 在每个新文档的最早期把 token 写进 localStorage。
 *
 * 用 `Page.addScriptToEvaluateOnNewDocument` 而不是「navigate → eval → reload」：
 * 后者在每个脚本里要改多处导航点，而且会多一次白屏重载。
 * 这个注入在页面自身脚本之前执行，React 挂载时读到的就已经是正确值。
 */
export async function primeToken(send, url) {
  const token = readToken()
  if (!token) return ''
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    return ''
  }
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { if (location.origin === ${JSON.stringify(origin)}) localStorage.setItem('sniptoken', ${JSON.stringify(token)}) } catch (e) {}`,
  })
  return token
}
