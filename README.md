# SnipDeck（片段坞）

自托管的「片段库 + 跨设备执行」工作台：手机上点一下，家里的 Windows 就执行一条命令，输出实时回来看。
片段就是 YAML 文件——能 `git diff`、能手改、能整包拷走，不锁在任何云里。

## 现在能做什么

- **片段面板**：按目录分组、标签、搜索；手机加到主屏即 PWA
- **变量表单**：`{{port}}` 占位，支持默认值、下拉选项、必填校验
- **一键执行**：实时输出（SSE 流），结束给退出码与耗时
- **危险动作**：`danger: true` 的片段先确认，并可预览渲染后的最终命令行
- **单车道队列**：`command.txt` 只能一条一条来，走桥的命令严格 FIFO，前端会显示排队时长
- **CLI**：任意 SSH 终端（Termius、手机、iPad）里 `snip run <id>`
- **执行目标**：`win-desktop`（exec 驱动，经 `ahk.bat` 驱动桌面 GUI）

## 快速开始

需要 Node 22+，且桌面已运行 `AutoHotKey\listener.ahk`（提权，负责真正执行）。

```bash
npm install

npm run snip -- list              # 看有哪些片段
npm run snip -- status            # 探活：bridge up / down
npm run snip -- run check-instence

npm run dev:server                # http://127.0.0.1:8787
npm run dev:web                   # http://127.0.0.1:5173（/api 代理到 8787）
npm run build:web                 # 构建后由 server 直接托管
```

手机访问：服务端监听 Tailscale 地址时**必须**设 token，否则会拒绝启动（见「安全」）。

```bash
SNIPDECK_HOST=100.x.x.x SNIP_TOKEN=<32位随机串> npm run dev:server
```

## 写一条片段

放在 `data/snippets/<分组>/<名字>.yaml`，目录就是分组：

```yaml
id: click-instance
title: 点击实例
target: win-desktop        # 指向 data/hosts.yaml 的目标
shell: cmd                 # 不写则用目标的默认 shell
tags: [gui]
danger: false
vars:
  pro: { prompt: 程序, default: wechat }
  n:   { prompt: 实例号, default: 1 }
  x:   { prompt: X 坐标 }   # 无默认值 → 必填
  y:   { prompt: Y 坐标 }
steps:
  - { do: run, cmd: 'call C:\ahk_trigger\ahk.bat click {{pro}}#{{n}} {{x}} {{y}}', timeout: 20 }
  - { do: sleep, ms: 300 }
```

`do` 目前支持 `run`（无头执行）与 `sleep`（等待）。`meta:` 下可写任意键，程序原样保留。

## 数据与目录

```
data/
├─ hosts.yaml          执行目标（driver / shell / 超时）
├─ snippets/**/*.yaml  片段，目录即分组
├─ secrets.yaml        密钥（已 gitignore，可选）
└─ tmp/                复杂命令的临时 .bat（GBK，7 天后自动清）
```

## 安全

- **网络边界靠 Tailscale**，不要做公网端口映射
- 对外监听必须设 `SNIP_TOKEN`，否则服务拒绝启动——这是「任意命令执行」的服务
- 密钥只写 `from: env:XXX` 或 `data/secrets.yaml`，不要内联进片段
- `kill` / `admin:` 类片段请标 `danger: true`

## 结构

| 包 | 作用 |
|---|---|
| `packages/core` | 片段模型、YAML 读写、变量渲染、索引、运行编排 |
| `packages/drivers` | `exec` 驱动（cmd / powershell + 全局串行队列） |
| `packages/server` | Fastify：REST + SSE + 静态托管 |
| `packages/cli` | `snip list / run / search / hosts / status / reindex` |
| `packages/web` | Vite + React + PWA |

## 测试

```bash
npm run typecheck
npm run test:queue --workspace @snipdeck/drivers   # 队列串行不变式
npm run smoke --workspace @snipdeck/server         # API 冒烟
```

## 文档

- [SnipDeck-PLAN.md](./SnipDeck-PLAN.md) — 架构、驱动能力边界、路线图与验收
