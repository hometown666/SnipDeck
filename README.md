# SnipDeck（片段坞）

自托管的「片段库 + 跨设备执行」工作台：手机上点一下，家里的 Windows 就执行一条命令，输出实时回来看。  
片段就是 YAML 文件——能 `git diff`、能手改、能整包拷走，不锁在任何云里。

> **30 秒版**
>
> ```bash
> npm install && npm run build:web
> npm run dev:server          # → http://127.0.0.1:7878
> ```
>
> 打开网页，点卡片就是执行，输出在右侧面板里流出来。手机上把 `SNIPDECK_HOST` 换成 Tailscale IP、`SNIP_TOKEN` 设一个随机串，打开页面后点右上角 `⚙` 填同一个 token。

## 现在能做什么

- **片段面板**：按目录分组、标签、搜索；手机可加到主屏（http 下是快捷方式，见「手机 / PWA」）
- **16 条存量片段**：Termius 的 Command 包已全量迁移（启动程序 / 实例控制 / 服务 / 日志）
- **变量表单**：`{{port}}` 占位，支持默认值、下拉选项、必填校验
- **一键执行**：实时输出（SSE 流），结束给退出码与耗时
- **危险动作**：`danger: true` 的片段先确认，并可预览渲染后的最终命令行
- **单车道队列**：`command.txt` 只能一条一条来，走桥的命令严格 FIFO，前端会显示排队时长
- **网页里改片段**（P6）：顶栏 `＋` 新建（快捷键 `N`）、卡片右下角 `✎` 编辑（`E`）。两种模式——**表单**覆盖 vars / steps / meta 全字段（保存会重排 YAML），**原文**直接改 YAML 文本（逐字落盘，注释和排版都留住）。改 `id` 会自动搬文件；「另存副本」按 `<id>-copy` 新建；删除进 `snippets/.trash/`。编辑期间文件被别人改过会 409，不静默覆盖
- **写命令不用背格式**：`run` 步骤先选动作（打开快捷方式 / 运行程序 / AHK 脚本 / shell / runlog / 状态 / 实例操作 / 点击），再填这个动作真正需要的字段；选「刷新状态」一个框都没有。YAML 里存的仍是那一行命令，老片段照常跑
- **实例表不用跑片段**（P7.1）：顶栏 `bridge up · N` 或左栏「实例 N」直接打开只读表。服务端**直接读** `instances.txt` / `status.txt`，不写 `command.txt`、不占串行队列；标 `实时 / 可能过期 / 离线`，提权进程的 pid 用 `EPERM` 当活着。只有通过桥启动的窗口（`lnk` / `run` / `shell`）才会在表里
- **运行表单里选实例**（P7.2）：`close` / `kill` / `focus` / `click` 的槽位自动变成下拉（`{{pro}}#{{n}}` / `{{slot}}` / `{{pro}}#1`），选中只写变量、命令模板不动；「手动输入」永远保留，列表空 / 接口失败直接退回输入框。编辑器里的槽位输入也带实例 datalist。服务端从 `run.cmd` 推导，YAML 不加字段
- **启动程序时选程序**（P7.3）：`open-program` 的程序名变成「搜索 + 分组下拉」。列表来自 **`PROG_DIR` + 开始菜单 + 桌面 + 额外目录**（`.lnk`，外加额外目录里两层内的便携 `.exe`；60s 缓存），选中写的是 `.lnk` **绝对路径**——不依赖 `PROG_DIR` 配得对不对。便携 exe 会被包成带工作目录的 `.lnk`（放在 `data/program-links/`），所以启动时不会以 listener 的目录为工作目录。系统工具 / 卸载器 / 安装器 / 帮助文档默认隐藏，但顶部永远显示「已过滤 N 项」并能展开看原因；`⚙ → 程序列表` 里可以用 `only` 只保留你点名的那几个（等于一份带注释的程序清单）
- **⚙ 里配目标**：`hosts.yaml` 的增 / 改 / 删也在设置里——名字、driver、bridge、shell、timeout、默认。改名即换键，`default` 排他；有片段引用或只剩最后一个可用目标时拒绝删除
- **⚙ 里配桥**：`PROG_DIR`（找 `.lnk`）与 `AHK_DIR`（跑 `.ahk`）直接在设置弹窗里改，落 `data/settings.json`，服务下一条命令就注入给桥。留空 = 不注入，桥用它自己那份的默认值（仓库版 `PROG_DIR` 是桌面；本机已安装版可能写死了别的目录，见 docs/04-phases.md §40.5）
- **CLI**：任意 SSH 终端（Termius、手机、iPad）里 `snip run <id>`；`snip cat <id>` 看原文，`snip edit <id>` 用 `$EDITOR` 直接改
- **执行目标**：`win-desktop`（exec 驱动，经 `ahk.bat` 驱动桌面 GUI）
- **多目标执行**：卡片右上角 `⊕` 打开目标选择器；**同一个目标可以重复添加**——只有一台可执行机器时，这就是「同目标多开」，结果在抽屉里并列成 N 块面板，事件按目标分流
- **`expect` 条件步**：片段里除了「跑」和「等」还能断言文本：`match` 正则 + `from`（上一步输出 / 全部输出 / 轮询一个文件）。等日志里出现 `Hexo is running at` 不再是 sleep 猜时长
- **运行档案**：每次执行服务端落一份 `data/runs/<runId>.jsonl`（谁、在哪台、变量、逐条事件、结论）；顶栏 `🕘` 可以回看任意一次，关掉页面 / 网络断了都不丢
- **从 shell 历史导入**：`snip import-history` 把 PSReadLine 历史里用过的命令一键变片段（默认 dry-run，危险命令自动标 `danger`）
- **网页终端**（P5.1 / P5.2 / P5.4）：顶栏「终端」进 `/terminal`，在浏览器里开真 PTY（`powershell` / `cmd` / `pwsh`），手机也能敲。断线自动重连、刷新接回同一会话、底部一排 Esc/Tab/Ctrl/方向键；工具条「片段…」可以把片段库里的命令渲染好插进终端（**不自动回车**，回车你自己按）。**必须配 `SNIP_TOKEN`**——WS 通道没有 loopback 豁免，没 token 就整个关掉。SSH 会话不做（2026-10-30 决定）

> 多目标目前只有 `win-desktop` 一个可选项（`home-win` / `vps` 灰显）。
> 「一条片段投多台机器」**不做**（2026-10-30 决定）；跨机器干活走 P5 的网页终端，开多个会话并排。数据结构和 UI 按 `targets[]` 铺好了，同目标多开照样能用。

## 环境准备（只需一次）

三样缺一不可：

| 需要 | 怎么来 |
|---|---|
| Node 22+ | [nodejs.org](https://nodejs.org) |
| AutoHotkey **v2** | `winget install AutoHotkey.AutoHotkey` |
| 桥脚本装到 `C:\ahk_trigger` | `npm run install:bridge` |

```bash
npm install
npm run install:bridge      # 拷三个桥文件；已存在的会先 .bak，不静默覆盖
npm run doctor              # 自检：Node / AHK / 桥文件 / 服务 / token
```

`doctor` 每条失败都带修复命令。**真正执行命令的是 listener**（常驻在桌面会话里），
SnipDeck 只负责把命令交出去、把结果带回来 —— 细节见 [bridge/README.md](./bridge/README.md)。

装好之后，`lnk:` / `script:` 用到的两个目录（`PROG_DIR` / `AHK_DIR`）可以在网页 ⚙ → **桥的目录**里改，
不用去动系统环境变量；改完下一条命令就生效。

## 第一次跑通（约 5 分钟）

```bash
npm run sync:launchers      # 生成 launchers/*.bat（hexo / txttunnel / backtrans 与 snipdeck 自己）
npm run snip -- status      # 应显示 bridge: up
npm run snip -- list        # 16 条存量片段
npm run snip -- run check-instence
```

最后一条能打出实例表，说明「片段 → 桥 → 桌面」这条链是通的。

## 日常用（网页 / 手机）

```bash
npm run build:web                                              # 前端产物，由 server 直接托管
npm run dev:server                                            # 本机：http://127.0.0.1:7878（默认绑定）
```

- **本机**：`http://127.0.0.1:7878`（默认绑定，无需 token）
- **手机**：走 `tailscale serve` 的 HTTPS 端点（见「HTTPS 访问」），扫码配对免手填 token；旧的明文 `http://100.x:7878` 直连方式已不推荐
- **常驻**：见「常驻运行」，注册成登录自启的计划任务
- 想让服务绑非 loopback（直接暴露 Tailscale IP）时才需要 `SNIP_TOKEN`；推荐改用 serve 模型（绑 `127.0.0.1` + 外层 TLS），见「HTTPS 访问」

## 桌面端

宽屏（≥1024px）换一套布局：左侧 260px 分组栏 + 居中主区，卡片固定 64px、标题单行省略；运行输出改成**右侧全高面板**，默认不折行（管道表、长路径保持原样），右上角 `↩` 可切自动换行。

| 快捷键 | 作用 |
|---|---|
| `/` | 聚焦搜索 |
| `↑` `↓` | 在搜索结果里移动，卡片描边高亮 |
| `Enter` | 执行选中的片段 |
| `T` | 对选中片段打开目标选择器（同目标多开） |
| `E` | 编辑选中的片段 |
| `N` | 新建片段 |
| `H` | 运行历史 |
| `Ctrl/⌘ + Enter` | 变量表单里直接执行 |
| `Esc` | 逐层关闭：编辑器 → 设置 → 表单/确认 → 运行面板 |

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
4. 「添加到主屏幕」。**在 http 下这是快捷方式，不是完整 PWA**（原因见下一条注）。

> **关于离线**：service worker 只在安全上下文注册。经 `http://100.x` 访问时浏览器会跳过，  
> 此时是「快捷方式」而不是完整 PWA；要离线缓存与安装提示，需要 `tailscale serve` 上 HTTPS。

## HTTPS 访问（tailscale serve）

经 `http://100.x:7878` 直连能用，但「加到主屏」只是快捷方式（没离线缓存、没通知）。  
要真 PWA + 扫码配对，最省事的是 **`tailscale serve`**：证书 Tailscale 托管，不用自签。

1. 把服务退回本机绑定并（可选）换新 token：
   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-token.ps1 -Rotate -HostAddress 127.0.0.1
   # 不想换 token 就去掉 -Rotate；-Show 只查看不改写
   ```
   这条脚本写 `.env` 的 `SNIP_TOKEN` / `SNIPDECK_HOST`（保留注释与 `SNIPDECK_PORT`），并在末尾打印出新 token。改完**重启服务**让它绑 `127.0.0.1`。
2. TLS 终结（在装了 tailscale 的机器上一次，**用管理员终端**）：
   ```bash
   tailscale serve --bg 7878
   ```
   默认即 HTTPS（443），自动把 `https://<机器名>.ts.net` 转发到本机 `http://127.0.0.1:7878`，证书 Tailscale 托管。
   > ⚠️ `tailscale serve` 新语法（1.52+）里 `https` 是 `--https=<port>` **标志**而非子命令；写 `tailscale serve https 7878` 会报 `invalid argument format`。端口转发类 serve 在 Windows 不需要管理员，若报权限错再开管理员终端重跑。`--bg` 让它后台常驻（关终端不失效）。
3. **本机先验证**（绕开你机器上的 HTTP_PROXY；PowerShell 里 `curl` 是 `Invoke-WebRequest` 别名，必须写 `curl.exe`）：
   ```powershell
   curl.exe --noproxy '*' -sI https://<机器名>.ts.net/
   # 期望 HTTP/2 200；证书由 Tailscale CA 签发，本机 curl 默认可信
   ```
   再**手机切流**：确认走 `https://<机器名>.ts.net` 能拿页面、`wss` 通，旧的明文 `http://100.x:7878` 已自然失效（服务只绑 127.0.0.1）。
4. **扫码配对**：打开网页 ⚙，设置弹窗里有「配对二维码」——它把 `https://<本机地址>/?token=<token>` 编成图，手机扫一下直接带 token 进，免手填。也支持直接发带 `?token=` 的链接（前端入口会自动写入 localStorage 后把 token 从地址栏抹掉）。
   > 服务退回 `127.0.0.1` 后，启动守卫不再要求 token（守卫只拦「非 loopback 且无 token」）；此时安全来自「serve 这一层」+ 共享 token 双层。**绝不对公网做端口映射**——WS 的 token 走 query，会进 serve 的访问日志，靠 tailnet 私有网络 + token 纵深缓解。

## 写一条片段

放在 `data/snippets/<分组>/<名字>.yaml`，目录就是分组（也可以点网页顶栏 `＋` 新建，或在编辑器里切「原文」直接改 YAML）：

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

## CLI 还有什么

```bash
npm run snip -- cat open-shell            # 看原文（注释、折叠块都在）
npm run snip -- edit open-shell           # 用 $EDITOR 打开；不设就 notepad
npm run snip -- runs                      # 最近 20 份运行档案，带 runId 看详情
npm run snip -- import-history            # shell 历史 → 片段（默认只 dry-run，加 --write 才落盘）
npm run snip -- import-history --limit 30 --write
```

> `npm run snip` 只转发 CLI 子命令。`dev:server` / `build:web` 这些是根级脚本，直接 `npm run <名字>`，别挂在 `snip` 后面——那样只会打印 usage 然后 exit 0，看着像跑成功。

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
| `SNIP_TOKEN`                          | 空                            | `/api/*` 的 Bearer token（**设了就一律校验，本机也不例外**）；不设时服务只能绑 loopback |
| `SNIPDECK_DATA` / `SNIPDECK_WEB_DIST` | `data` / `packages/web/dist` | 一般不用改                             |

日志：`data/logs/server.log`（同一时间只允许一个实例，第二条会报「文件被占用」）。

## 开发

```bash
npm run dev:server          # 7878，后端
npm run dev:web             # 5173，/api 代理到 7878
```

> **手机别走 5173**。dev server 是开发产物，没有 hash 校验，也不该暴露给别的设备；手机一律直连 7878。

## 数据与目录

```
data/
├─ hosts.yaml          执行目标（driver / shell / 超时）
├─ snippets/**/*.yaml  片段，目录即分组
├─ snippets/.trash/    删除片段的副本（*.yaml.txt，不会被当成片段加载）
├─ secrets.yaml        密钥（已 gitignore，可选）
├─ tmp/                临时 .bat、UI 脚本的 Chrome profile（`npm run clean:tmp` 清）
├─ runs/               运行档案（jsonl，启动时留最近 500 份 / 30 天）
└─ logs/               服务日志（gitignore）
```

## 安全

- **网络边界靠 Tailscale**，不要做公网端口映射
- 对外监听必须设 `SNIP_TOKEN`，否则服务拒绝启动——这是「任意命令执行」的服务
- token 只护 `/api/*`：静态壳（页面/JS/CSS/图标）免 token，否则手机拿不到页面也就没地方填 token。放行静态页的暴露面只有「一个空壳 UI」，数据与执行仍在 token 之后
- **不按来源 IP 豁免**：只要设了 `SNIP_TOKEN`，本机访问 `/api/*` 同样要带 `Bearer`。反代（`tailscale serve`）会把远程请求从 `127.0.0.1` 转进来，按来源豁免等于把 token 关掉（2026-10-31 改，见 ISSUE-023）。没设 token 时服务只能绑 loopback，`server.ts` 启动时就拦住了
- 密钥只写 `from: env:XXX` 或 `data/secrets.yaml`，不要内联进片段
- `kill` / `admin:` 类片段请标 `danger: true`

## 结构

| 包                  | 作用                                                    |
| ------------------ | ----------------------------------------------------- |
| `packages/core`    | 片段模型、YAML 读写、变量渲染、索引、运行编排                             |
| `packages/drivers` | `exec` 驱动（cmd / powershell + 全局串行队列）                  |
| `packages/server`  | Fastify：REST + SSE + 静态托管                             |
| `packages/cli`     | `snip list / search / cat / edit / run / hosts / status / reindex / runs / import-history` |
| `packages/web`     | Vite + React + PWA                                    |
| `bridge/`          | 桌面执行端：`listener.ahk` / `ahk.bat` / `ahk_cmd.ps1`，装到 `C:\ahk_trigger`（见 [bridge/README.md](./bridge/README.md)） |

## 测试

```bash
npm test     # typecheck + lint + ps1 编码 + bridge 护栏 + 队列串行 + 命令保真度 + 环境注入 + 搜索 + expect + 导入 + 桥文件 + 实例下拉 + 程序发现 + 会话 + API 冒烟（冒烟 176 项）
```

单项：

```bash
npm run test:queue  --workspace @snipdeck/drivers  # 队列必须真串行（command.txt 单车道）
npm run test:cmd    --workspace @snipdeck/drivers  # 临时 .bat 的命令语义保真度
npm run test:env    --workspace @snipdeck/drivers  # PROG_DIR / AHK_DIR 真的到达子进程（5 项）
npm run test:search --workspace @snipdeck/core     # 中文子串 / 多词 AND / 大小写与空白（14 项）
npm run test:expect --workspace @snipdeck/core     # expect 三源 / 编码 / 正则预算 / 轮询等待（40 项）
npm run test:import --workspace @snipdeck/core     # 历史清洗 / 残句识别 / 危险标记 / 不覆盖（60 项）
npm run test:bridge --workspace @snipdeck/core     # 桥文件解析：instances/status、UTF-16、坏行、排序（27 项）
npm run test:picks  --workspace @snipdeck/core     # 实例下拉识别：命令形态 / admin 前缀 / 冲突放弃（22 项）
npm run test:programs --workspace @snipdeck/core   # 程序发现：分类 / 去重 / include / 配置归一 / 便携 exe（55 项，纯函数）
npm run smoke       --workspace @snipdeck/server   # 打真路由：鉴权 / 404 / 脱敏 / CRUD / 设置 / 目标 / 实例表 / 程序列表 / 真 SSE 执行（176 项）
# CI 上没有 listener：SNIPDECK_SMOKE_BRIDGE=<不存在的目录> 会走「无桥模式」，跳过 5 条实跑，其余 171 条照跑
# 程序扫描同理：冒烟用 SNIPDECK_PROGRAMS_FIXTURE 指向固定 JSON，不去读 runner 的开始菜单
npm run test:session --workspace @snipdeck/server   # 终端会话：PTY / resize / 删除真杀进程 / WS 鉴权
npm run ui:shot -- http://127.0.0.1:7878/ 390 844 data/tmp/ui.png   # 移动端仿真截图 + 布局测量
# ui:* 脚本都会从 .env 读 SNIP_TOKEN 注入页面；服务绑的是 100.x 时记得把地址传进去
# ⚠️ 量布局请用 mobile: false（见 `npm run ui:editor`）：mobile: true 下 innerWidth 会落在真实窗口宽
npm run ui:bridge                                  # 实例表：顶栏 / 左栏入口 + 只读弹窗（需服务 + 桥在线）
npm run ui:picker                                  # 运行表单实例下拉：选中 → 预览命令（需服务 + 桥在线）
npm run ui:program                                 # 运行表单程序下拉：搜索 / 分组 / 已过滤原因（17 项，需服务在线）
npm run ui:queue                                   # 顶栏「排队 N」徽标可见性（需服务 + 桥都在线）
npm run ui:multi                                   # 多目标：目标选择器 + 并列面板（需服务在线）
npm run ui:history                                 # 运行历史：列表 + 抽屉回放（需服务在线）
npm run ui:editor                                  # 片段编辑器：开/改/存/原文/副本/删 + 槽位 datalist（36 项，需服务在线）
npm run ui:settings                                # 设置页：桥目录 / 运行档案 / 目标增删改（30 项，需服务在线）
npm run test:session-reap                          # 会话回收，**真 60 秒**两条路径（约 70s，不进 npm test）
npm run lint                                       # eslint：只拦错，不排格式
npm run check:ps1                                  # .ps1 必须 UTF-8 with BOM 且语法可解析（PS 5.1 的坑）
npm run check:bridge                               # bridge/ 护栏：不许带回私人路径与 cursor:*（11 项）
npm run clean:tmp                                  # 清 data/tmp 里 7 天前的 .cmd、Chrome profile 与 pty-probe 的依赖
```

## 文档

计划已拆成 8 份，**章节编号全局不变**（写「§14」就是 `docs/03-reference.md` 第 14 节）：

- [docs/SnipDeck-PLAN.md](./docs/SnipDeck-PLAN.md) — 总览：文档地图、修订摘要、进度快照
- [docs/01-design.md](./docs/01-design.md) — 架构、驱动能力边界、数据模型、运行时（§1–§8）
- [docs/02-roadmap.md](./docs/02-roadmap.md) — 路线图与验收、风险、安全模型、待定项（§9–§12）
- [docs/03-reference.md](./docs/03-reference.md) — 迁移清单、接口契约、字段参考、部署（§13–§16）
- [docs/04-phases.md](./docs/04-phases.md) — 各期实施记录与取舍（§17–§43）
- [docs/06-terminal.md](./docs/06-terminal.md) — 网页终端的设计与验收（§23–§29）
- [docs/00-issues.md](./docs/00-issues.md) — ISSUE-001~028 现场记录与修复（§0.2–§0.9）
- [docs/05-changelog.md](./docs/05-changelog.md) — 变更日志
