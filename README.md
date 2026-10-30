# SnipDeck（片段坞）

自托管的「片段库 + 跨设备执行」工作台：手机上点一下，家里的 Windows 就执行一条命令，输出实时回来看。  
片段就是 YAML 文件——能 `git diff`、能手改、能整包拷走，不锁在任何云里。

## 现在能做什么

- **片段面板**：按目录分组、标签、搜索；手机加到主屏即 PWA
- **16 条存量片段**：Termius 的 Command 包已全量迁移（启动程序 / 实例控制 / 服务 / 日志）
- **变量表单**：`{{port}}` 占位，支持默认值、下拉选项、必填校验
- **一键执行**：实时输出（SSE 流），结束给退出码与耗时
- **危险动作**：`danger: true` 的片段先确认，并可预览渲染后的最终命令行
- **单车道队列**：`command.txt` 只能一条一条来，走桥的命令严格 FIFO，前端会显示排队时长
- **CLI**：任意 SSH 终端（Termius、手机、iPad）里 `snip run <id>`
- **执行目标**：`win-desktop`（exec 驱动，经 `ahk.bat` 驱动桌面 GUI）
- **多目标执行**：卡片右上角 `⊕` 打开目标选择器；**同一个目标可以重复添加**——只有一台可执行机器时，这就是「同目标多开」，结果在抽屉里并列成 N 块面板，事件按目标分流
- **`expect` 条件步**：片段里除了「跑」和「等」还能断言文本：`match` 正则 + `from`（上一步输出 / 全部输出 / 轮询一个文件）。等日志里出现 `Hexo is running at` 不再是 sleep 猜时长
- **运行档案**：每次执行服务端落一份 `data/runs/<runId>.jsonl`（谁、在哪台、变量、逐条事件、结论）；顶栏 `🕘` 可以回看任意一次，关掉页面 / 网络断了都不丢
- **从 shell 历史导入**：`snip import-history` 把 PSReadLine 历史里用过的命令一键变片段（默认 dry-run，危险命令自动标 `danger`）
- **网页终端**（P5.1）：顶栏「终端」进 `/terminal`，在浏览器里开真 PTY（`powershell` / `cmd` / `pwsh`），手机也能敲。**必须配 `SNIP_TOKEN`**——WS 通道没有 loopback 豁免，没 token 就整个关掉

> 多目标目前只有 `win-desktop` 一个可选项（`home-win` / `vps` 灰显）。
> 「一条片段投多台机器」**不做**（2026-10-30 决定）；跨机器干活走 P5 的网页终端，开多个会话并排。数据结构和 UI 按 `targets[]` 铺好了，同目标多开照样能用。

## 快速开始

需要 Node 22+，且桌面已运行 `AutoHotKey\listener.ahk`（提权，负责真正执行）。

```bash
npm install
npm run sync:launchers            # 生成服务启动器（跑 hexo/txttunnel/backtrans 片段前需要）

npm run snip -- list              # 看有哪些片段（已迁移 Termius 的 16 条）
npm run snip -- status            # 探活：bridge up / down
npm run snip -- run check-instence

npm run snip -- import-history    # 历史命令 → 片段（默认只看计划，加 --write 才落盘）
npm run snip -- import-history --limit 30 --write
npm run snip -- runs              # 本机最近的运行档案（带 runId 可看详情）

npm run dev:server                # http://127.0.0.1:7878
npm run dev:web                   # http://127.0.0.1:5173（/api 代理到 7878）
npm run build:web                 # 构建后由 server 直接托管
```

手机访问：服务端监听 Tailscale 地址时**必须**设 token，否则会拒绝启动（见「安全」）。

```bash
SNIPDECK_HOST=100.x.x.x SNIP_TOKEN=<32位随机串> npm run dev:server
```

## 常驻运行

```powershell
# 一次性：注册「登录时启动」计划任务（用户会话，才能驱动桌面 GUI）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Uninstall

# 手动起（等价于计划任务干的事）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
```

配置放 `.env`（复制 `.env.example`，已 gitignore）：

| 变量                                    | 默认                           | 说明                                |
| ------------------------------------- | ---------------------------- | --------------------------------- |
| `SNIPDECK_HOST`                       | `127.0.0.1`                  | 改 Tailscale IP 手机才能访问，此时必须配 token |
| `SNIPDECK_PORT`                       | `7878`                       | 避开 TxtTunnel 的 8787               |
| `SNIP_TOKEN`                          | 空                            | 非 loopback 访问 `/api/*` 的 Bearer token（静态页免）       |
| `SNIPDECK_DATA` / `SNIPDECK_WEB_DIST` | `data` / `packages/web/dist` | 一般不用改                             |

日志：`data/logs/server.log`（同一时间只允许一个实例，第二条会报「文件被占用」）。

## 桌面端

宽屏（≥1024px）换一套布局：左侧 260px 分组栏 + 居中主区，卡片固定 64px、标题单行省略；运行输出改成**右侧全高面板**，默认不折行（管道表、长路径保持原样），右上角 `↩` 可切自动换行。

| 快捷键 | 作用 |
|---|---|
| `/` | 聚焦搜索 |
| `↑` `↓` | 在搜索结果里移动，卡片描边高亮 |
| `Enter` | 执行选中的片段 |
| `Ctrl/⌘ + Enter` | 变量表单里直接执行 |
| `Esc` | 逐层关闭：设置 → 表单/确认 → 运行面板 |

> 输出按语义上色：命令回显、步骤结果（✓ 绿 / ✗ 红）、队列等待（琥珀）、错误（红底）。
> 桥用 `ERR|` 前缀报错但退出码是 0 时，这里也会判成失败——不会把「slot not found」显示成「完成」。

多目标时抽屉加宽到 `min(1320px, calc(100vw - 48px))`，内部按目标数并列（顶部标 `win-desktop #1 / #2`）；
手机上自动改成上下堆叠。执行仍然是**一条一条来**（`command.txt` 单车道），并列的是结果不是时间。

顶栏 `🕘` 是运行历史：点一条就在抽屉里回放那次执行的命令与输出，头部标 `🕘 历史时间`。
回放只读（不会重跑），secret 变量的值在档案里已经抹成 `***`。

## 手机 / PWA

1. 服务端监听 Tailscale 地址并设 token；
2. 手机浏览器打开 `http://100.x.x.x:7878`——**首屏和静态资源免 token**，页面能正常打开；
3. 打开后顶部会弹「这台设备还没有 token」横幅：点右上角 ⚙ 粘贴一次，存在这台设备的 localStorage。**token 只护 `/api/*`**，所以页面本身不设防，防的是数据与执行；
4. 「添加到主屏幕」即可当应用用。

> **关于离线**：service worker 只在安全上下文注册。经 `http://100.x` 访问时浏览器会跳过，  
> 此时是「快捷方式」而不是完整 PWA；要离线缓存与安装提示，需要 `tailscale serve` 上 HTTPS。

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

`do` 支持 `run`（无头执行）、`sleep`（等待）、`expect`（正则断言）：

```yaml
steps:
  - { do: run, cmd: 'type D:\blog\hexo.log' }
  - { do: expect, match: 'Hexo is running at', from: 'file:D:\blog\hexo.log', timeout: 20 }
  - { do: expect, match: 'ERROR', from: last, optional: true }   # optional: 不匹配也继续
```

`expect.from` 三选一：`last`（缺省，最近一条有输出的 `run`）、`all`（本次 run 全部输出）、`file:<路径>`（**真的等**：每 200ms 重读，到 `timeout` 秒还不匹配就判失败）。`flags` 只认 `i` / `m` / `s`。

`meta:` 下可写任意键，程序原样保留。

现成片段按五组放好：`程序启动` / `状态` / `实例控制` / `Shell 与服务` / `任务与日志`。

### 三个容易踩的边界

- **变量是原样插入**：值里的 `>`、`|`、`&` 会被驱动侧的 cmd 解释。要发这类字符，自己在片段里给变量加引号。
- **`shell shell#N` 的负载必须是单个引号参数**：不带引号时只有第一个词送得到（`chars=7` 那种）。带空格的命令走 launcher，别内联。
- **路径带空格就别内联 `cd`**：`shell shell#1 "cd /d D:\a b && …"` 会被 cmd 在空格处截断，`&&` 后面的命令甚至会泄漏到本地执行。用 `npm run sync:launchers` 生成的 `C:\ahk_trigger\launchers\*.bat`。

## 数据与目录

```
data/
├─ hosts.yaml          执行目标（driver / shell / 超时）
├─ snippets/**/*.yaml  片段，目录即分组
├─ secrets.yaml        密钥（已 gitignore，可选）
├─ tmp/                复杂命令的临时 .bat（GBK，7 天后自动清）
├─ runs/               运行档案（jsonl，启动时留最近 500 份 / 30 天）
└─ logs/               服务日志（gitignore）
```

## 安全

- **网络边界靠 Tailscale**，不要做公网端口映射
- 对外监听必须设 `SNIP_TOKEN`，否则服务拒绝启动——这是「任意命令执行」的服务
- token 只护 `/api/*`：静态壳（页面/JS/CSS/图标）免 token，否则手机拿不到页面也就没地方填 token。放行静态页的暴露面只有「一个空壳 UI」，数据与执行仍在 token 之后
- 密钥只写 `from: env:XXX` 或 `data/secrets.yaml`，不要内联进片段
- `kill` / `admin:` 类片段请标 `danger: true`

## 结构

| 包                  | 作用                                                    |
| ------------------ | ----------------------------------------------------- |
| `packages/core`    | 片段模型、YAML 读写、变量渲染、索引、运行编排                             |
| `packages/drivers` | `exec` 驱动（cmd / powershell + 全局串行队列）                  |
| `packages/server`  | Fastify：REST + SSE + 静态托管                             |
| `packages/cli`     | `snip list / search / run / hosts / status / reindex / runs / import-history` |
| `packages/web`     | Vite + React + PWA                                    |

## 测试

```bash
npm test     # typecheck + 队列串行 + 命令保真度 + 搜索语义 + expect + 历史导入 + API 冒烟（66 项）
```

单项：

```bash
npm run test:queue  --workspace @snipdeck/drivers  # 队列必须真串行（command.txt 单车道）
npm run test:cmd    --workspace @snipdeck/drivers  # 临时 .bat 的命令语义保真度
npm run test:search --workspace @snipdeck/core     # 中文子串 / 多词 AND / 大小写与空白（14 项）
npm run test:expect --workspace @snipdeck/core     # expect 三源 / 编码 / 正则预算 / 轮询等待（40 项）
npm run test:import --workspace @snipdeck/core     # 历史清洗 / 残句识别 / 危险标记 / 不覆盖（60 项）
npm run smoke       --workspace @snipdeck/server   # 打真路由：鉴权 / 404 / 脱敏 / 真 SSE 执行
npm run ui:shot -- http://127.0.0.1:7878/ 390 844 data/tmp/ui.png   # 移动端仿真截图 + 布局测量
npm run ui:queue                                   # 顶栏「排队 N」徽标可见性（需服务 + 桥都在线）
npm run ui:multi                                   # 多目标：目标选择器 + 并列面板（需服务在线）
npm run ui:history                                 # 运行历史：列表 + 抽屉回放（需服务在线）
npm run lint                                       # eslint：只拦错，不排格式
npm run check:ps1                                  # .ps1 必须 UTF-8 with BOM 且语法可解析（PS 5.1 的坑）
npm run clean:tmp                                  # 清 data/tmp 里 7 天前的 .cmd 与 Chrome profile
```

## 文档

计划已拆成 7 份，**章节编号全局不变**（写「§14」就是 `docs/03-reference.md` 第 14 节）：

- [SnipDeck-PLAN.md](./SnipDeck-PLAN.md) — 总览：文档地图、修订摘要、进度快照
- [docs/01-design.md](./docs/01-design.md) — 架构、驱动能力边界、数据模型、运行时（§1–§8）
- [docs/02-roadmap.md](./docs/02-roadmap.md) — 路线图与验收、风险、安全模型、待定项（§9–§12）
- [docs/03-reference.md](./docs/03-reference.md) — 迁移清单、接口契约、字段参考、部署（§13–§16）
- [docs/04-phases.md](./docs/04-phases.md) — 各期实施记录与取舍（§17–§22）
- [docs/00-issues.md](./docs/00-issues.md) — ISSUE-001~017 现场记录与修复（§0.2–§0.9）
- [docs/05-changelog.md](./docs/05-changelog.md) — 变更日志
