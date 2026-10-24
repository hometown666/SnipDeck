import { buildApp } from './app'

const PORT = Number(process.env.SNIPDECK_PORT ?? 7878)
const HOST = process.env.SNIPDECK_HOST ?? '127.0.0.1'
const TOKEN = process.env.SNIP_TOKEN ?? ''

// 这是一个「任意命令执行」服务：对外监听却没有 token，等于把机器交给整个网络。
// 与其发一条容易被忽略的警告，不如直接拒绝启动。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
if (!LOOPBACK_HOSTS.has(HOST) && !TOKEN) {
  console.error(`[snipdeck] 拒绝启动：SNIPDECK_HOST=${HOST} 对外监听，但未设置 SNIP_TOKEN。`)
  console.error('  请先设置 SNIP_TOKEN（例如 32 位随机串）再启动，否则任何能连到该地址的人都能执行命令。')
  process.exit(1)
}

const { app, dirs } = buildApp()
console.log(`[snipdeck] data=${dirs.data}`)
await app.listen({ port: PORT, host: HOST })
console.log(`[snipdeck] listening on http://${HOST}:${PORT}`)
