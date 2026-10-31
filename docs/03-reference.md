# SnipDeck · 参考手册（§13 – §16）

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · 设计 [01-design.md](01-design.md) · 路线图 [02-roadmap.md](02-roadmap.md) · Issue 队列 [00-issues.md](00-issues.md) · 实施记录 [04-phases.md](04-phases.md) · 变更日志 [05-changelog.md](05-changelog.md)
>
> 覆盖原 `SnipDeck-PLAN.md` 的 **§13 – §16**：存量 16 条 snippet 迁移清单、REST + SSE 接口契约、RunEvent 与片段字段参考、运行与部署。
>
> 这一份是**查询用**的：要写片段看 §15 的字段表与命令语义边界，要加路由看 §14 的契约与鉴权分层，要部署/自启看 §16 的脚本与环境变量。
>
> **章节编号全局不变**：文中 §0.x 见 `00-issues.md`，§1–§8 见 `01-design.md`，§9–§12 见 `02-roadmap.md`，§17–§22 见 `04-phases.md`。

---

## 13. 附录：存量 snippet 迁移清单（16 条，来自 Termius Command 包）

> 已全部落到 `data/snippets/`（5 个分组 16 条），实施细节与偏差见 §17。

| #  | Termius 名                  | 原 script                                       | 迁移后                                                                                            |
| -- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1  | Auto pickup                | `ahk.bat admin lnk auto_pickup`                | 程序启动 · danger · 无变量                                                                            |
| 2  | Check Instence             | `ahk.bat instances`                            | 状态 · `queue:false`（纯读文件）                                                                       |
| 3  | Check Status               | `ahk.bat status`                               | 状态 · 走队列                                                                                       |
| 4  | Click Instance             | `ahk.bat click <pro>#<n> <x> <y>`              | 实例控制 · vars: pro/n/x/y                                                                         |
| 5  | Close Program              | `ahk.bat close <pro>#<n>`                      | 实例控制 · danger · vars: pro/n                                                                    |
| 6  | Exit runlog                | `type C:\ahk_trigger\jobs\<job>.<n>.exit`      | 任务与日志 · 纯 cmd 不过桥 · vars: job/n                                                                |
| 7  | Focus Instance             | `ahk.bat focus <pro>#<n>`                      | 实例控制 · vars: pro/n                                                                             |
| 8  | Focus\&Click Cursor_Refill | `set flag=（0,1,2） && if %flag% equ 2 (call …)` | 实例控制 · vars: flag `choices:[0,1,2]` · 迁移为 `if {{flag}} equ 2 (call …)`，去掉 cmd 级 set · 走临时 .cmd |
| 9  | Kill Program               | `ahk.bat admin kill <pro>#<n>`                 | 实例控制 · danger · vars: pro/n                                                                    |
| 10 | Open Airmouse              | `ahk.bat admin lnk Airmouse`                   | 程序启动 · danger(admin)                                                                           |
| 11 | Open Program               | `ahk.bat lnk <pro>`                            | 程序启动 · vars: pro                                                                               |
| 12 | Open Shell or Run Command  | `ahk.bat shell`                                | Shell 与服务 · 无变量                                                                                |
| 13 | Run Backtrans-coach        | `ahk.bat shell shell#<n> "cd /d D:\… && …"`    | Shell 与服务 · vars: n · 发起即返回                                                                    |
| 14 | Run Hexo-pages             | 同上                                             | Shell 与服务 · vars: n                                                                            |
| 15 | Run TxtTunnel              | 同上                                             | Shell 与服务 · vars: n                                                                            |
| 16 | Run with Log               | `ahk.bat runlog <command>`                     | 任务与日志 · vars: command · 异步看 .log/.exit                                                         |

注：截图只覆盖 Command 包；若另有 Powershell 包（`Invoke-AhkLnk` 等），迁移时一并盘点。

---

## 14. 接口契约（REST + SSE）

鉴权分两层：

- **`/api/*`**：**只要服务设了 `SNIP_TOKEN`，任何来源都要 `Authorization: Bearer $SNIP_TOKEN`，包括本机**。没有按来源 IP 的豁免（2026-10-31「方案 D」，见 ISSUE-023）。没设 token 时**不校验**——这条的安全性由 `server.ts` 的启动守卫兜底：无 token 只允许绑 loopback，所以那条分支只可能在本机直连的开发场景成立。
- **静态壳**（`/`、`/assets/*`、`/manifest.webmanifest`、`/sw.js`、图标）：**一律免 token**。它们自身不含任何数据，数据全在 `/api` 后面；若连首屏也挡，手机就拿不到 ⚙ 去填 token，形成死锁（ISSUE-001）。带扩展名但文件不存在的路径返回 404 文本，不回退 `index.html`（否则 `/favicon.ico` 会拿到 200 + HTML）；不带扩展名的路径回退 `index.html` 供前端路由。

| 方法 | 路径 | 入参 | 出参 / 语义 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok,bridgeUp,queue,snippets,quarantined}`；`bridgeUp` 有 30s 缓存与单飞去重 |
| GET | `/api/snippets` | — | `SnippetView[]`（**不含**服务器文件路径） |
| GET | `/api/snippets/:id` | — | `SnippetView`；不存在 404 |
| GET | `/api/snippets/:id/detail` | — | 编辑器用：完整 `id/title/group/target/shell/tags/danger/meta/vars/steps` + `relPath`（相对 snippets 根）+ `mtimeMs`（冲突检测）；不存在 404 |
| GET | `/api/snippets/:id/raw` | — | `{id,relPath,yaml,mtimeMs}`：磁盘上的 YAML **原文**（注释、字段顺序、`>` 折叠块都还在） |
| PUT | `/api/snippets/:id/raw` | `{yaml,mtimeMs?}` | 原文保存：**落盘的就是这段文本**，不经过 `stringify`。YAML 解析失败 400 且错误带「第 N 行第 M 列」；改 `id` 同样会搬家 |
| POST | `/api/snippets` | 完整片段对象（不含 `file`） | 201 `{ok,id,relPath,created,mtimeMs}`；校验失败 400（`problems[]` 逐条给原因）；id 或落点已存在 409 |
| PUT | `/api/snippets/:id` | 同上 + `mtimeMs?` | 200 `{ok,id,relPath,renamed,mtimeMs}`；`body.id` 与 URL 不同即视作**改名**（文件跟着搬）；`mtimeMs` 与磁盘不符 409（不覆盖别人的改动） |
| DELETE | `/api/snippets/:id` | — | 200 `{ok,id,backup}`；删除前先把副本放进 `snippets/.trash/<id>-<时间戳>.yaml.txt` |
| POST | `/api/snippets/:id/preview` | `{vars}` | `{cmds,pending,missing,redacted}`；secret 渲染为 `***`；未填变量保留 `{{x}}` |
| GET | `/api/hosts` | — | `{name,driver,reserved,default}[]` |
| POST | `/api/run` | `{id,vars?,targets?,target?,confirm?}` | `text/event-stream`；每条事件带 `target` + `targetIndex`；首条 `start` 额外带 `runId` |
| GET | `/api/runs` | `?limit=20&snippet=<id>` | `RunListItem[]`（倒序）；每项是档案首行 `meta` + 末行 `summary` 的合并，带 `ok/durationMs/panes/eventCount` |
| GET | `/api/runs/:runId` | — | `{meta, events, summary}`；`runId` 不匹配 `^\d{8}-\d{6}-[a-z0-9]{4}$` 直接 404（不做路径拼接，不读穿目录） |

`/api/run` 的目标入参优先级：`targets[]` > `target` > 片段 `target` > hosts 的 `default`。`targets[]` 里**同一目标可以重复**（同目标多开），最多 8 个。

`/api/run` 的失败码都在**开流之前**判定：snippet 不存在 → 404；danger 未确认 / `targets` 非数组或为空 / 目标未知 / 目标 `reserved` → 400（多目标里**任一** reserved 就整条拒绝）。开流之后只剩 `error` 事件。

**两条写路径的差别（这不是实现细节，是产品承诺）**

| | `POST/PUT /api/snippets`（表单） | `PUT /api/snippets/:id/raw`（原文） |
|---|---|---|
| 落盘内容 | `stringify` 之后的 YAML | **用户给的文本，逐字** |
| 注释 | 丢 | 保留 |
| 字段顺序 / 引号风格 | 按固定顺序重排 | 保留 |
| `meta.note` 的 `>` 折叠块 | 变成普通多行串 | 保留 |
| 校验强度 | `validateSnippet` + 序列化后自解析 | 解析（带行列号）+ `validateSnippet` |
| 适合 | 手机上改字段、新建 | 写注释、调排版、改嵌套 meta |

两条路径共用同一套守卫：`mtimeMs` 冲突、`id` 全库唯一、落点越界、`.bak`、原子写、写后 `reindex`。所以「表单改一半切到原文保存」不会绕过任何一条。

**写入语义（POST / PUT / DELETE）**

| 规矩 | 为什么 |
|---|---|
| 落点 = `snippets/<group>/<id>.yaml`；`group` 留空落 `未分组/` | 目录与 `groupOf()` 的兜底文案一致，文件不会散在根目录、界面却显示一个不存在的分组 |
| `id` 与 `group` 都过 `safeSegment`：`<>:"/\|?*.` 与控制字符换成 `_`，Windows 保留名（`con`/`nul`/`com1`…）加前缀，截断 60 字 | id 同时是 URL 片段与文件名，两边都得能过；`.` 一起换掉是为了让 `..` 不可能出现在任何路径段里 |
| 落点再经 `relative()` + `sep` 判一次越界 | `safeSegment` 是第一道闸，这是第二道（判据写成本身也踩过坑，见 ISSUE-021） |
| `id` 全库唯一（写前扫一遍索引） | 同一 id 住两个目录时 `loadSnippets()` 只留先加载的那份、另一份 quarantine——界面看着正常，实际「改了没生效」（ISSUE-022） |
| 原子写（同目录 `.tmp` → rename） | store 的 watcher 200ms 后重建索引，半份文件会让整条片段 quarantine |
| 写前 `validateSnippet`，序列化后再 `parseDocument` 自检一遍 | 存进去一份语法错的 YAML 比拒绝保存糟糕得多；`stringify` 成功不等于能读回来 |
| 覆盖已有文件前留 `<file>.bak`；删前留 `.trash/*.yaml.txt` | 手滑一次就没有退路，代价只是一个文件。`.yaml.txt` 不匹配 `loadSnippets()` 的后缀，不会被当成片段 |
| 写后立刻 `store.reindex()` | 不等 watcher 的 200ms 去抖，否则「保存成功」之后马上 GET 可能还是旧索引 |

## 15. 事件与片段字段参考

**RunEvent**（前端与 CLI 共用同一套语义）

| type | 字段 | 含义 |
|---|---|---|
| `start` | `stepIndex`, `cmd?`, `runId?` | `stepIndex=-1` 表示整条 run 开始（此时带 `runId`）；`stepIndex≥0` 的 `cmd` 是渲染后的命令行 |
| `queued` | `stepIndex`, `waitedMs` | 排队超过 50ms 才发，UI 显示等待时长 |
| `stdout` / `stderr` | `data` | **整段**返回（当前不做逐行流式） |
| `step` | `ok`, `exitCode?`, `durationMs?`, `note?`, `expect?`, `matched?` | 单步收尾；`expect` 步带 `expect`（正则源串）与 `matched`（命中文本，空白压成单空格、超 120 字截断） |
| `exit` | `ok`, `exitCode`, `durationMs`, `timedOut?` | 整条 run 收尾；`timedOut` 表示被驱动杀掉 |
| `error` | `message`, `stepIndex?` | 变量缺失、目标错误等 |

**每条事件都带 `target`（hosts 键）+ `targetIndex`（本次 `targets[]` 的下标）**，由 server 在多目标执行时打标。单目标时也在，前端靠它决定渲染到哪块面板；同一目标多开时两个字段值会重复 `target`，只能靠 `targetIndex` 区分。

**片段字段**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 全局唯一；重复时后一条 quarantine 并报出前一条路径 |
| `title` / `tags` / `danger` / `meta` | 否 | `meta` 任意键，程序原样保留 |
| `group` | 否 | 缺省取目录路径 |
| `target` | 否 | `hosts.yaml` 的键；缺省取 `default: true`，再缺省第一个非 reserved |
| `shell` | 否 | `cmd` / `powershell`；缺省取目标 `shell`，再缺省 `cmd` |
| `vars` | 否 | `prompt` / `default` / `choices` / `secret` / `from: env:XXX` |
| `steps` | 是 | `{do: run, cmd, timeout?, optional?, queue?}` / `{do: sleep, ms}` / `{do: expect, match, from?, flags?, timeout?, interval?}` |

**quarantine 条件**（该文件不进索引、不可运行，其余片段不受影响）：YAML 解析失败、缺 `id`、缺 `steps`、step 不合法（`do` 未知 / `run` 缺 `cmd` / `sleep` 缺 `ms` / `expect` 缺 `match` / `expect.flags` 非字符串 / `expect.from` 不是 `last`|`all`|`file:<路径>`）、`id` 重复。

**命令语义的三个已知边界**

- 落在临时 `.bat` 时 `%` 会被转义保护；`^` 仍按批处理语义处理，要字面量请写 `^^`。
- 同一行 `set X=1 && echo %X%` 在 cmd 里是解析期展开（读不到刚设的值），交互式与批处理一致，不是驱动的 bug。
- **变量是原样插入的**：值里的 `>` / `|` / `&` 会被**驱动侧**的 cmd 解释（实测 `--line="echo X> file"` 把输出重定向进了文件）。需要发这些字符，在片段里自己给变量加引号。
- **`shell shell#N` 的负载必须是单个引号参数**：`... shell shell#1 mkdir C:\a\b` 只会送达 `mkdir`（`chars=7`）。带空格的命令务必写成 `"... shell shell#1 \"你要发的一整行\""`，或走 launcher。

## 16. 运行与部署

| 项 | 位置 / 命令 |
|---|---|
| 启动 | `powershell -File .\scripts\start-server.ps1`（读 `.env`，日志追加到 `data/logs/server.log`） |
| 自启 | `powershell -File .\scripts\install-autostart.ps1`（登录时计划任务，**已注册 2026-10-30**，见 §16.1）；`-Uninstall` 卸载 |
| 配置 | 复制 `.env.example` 为 `.env`（已 gitignore） |
| 服务启动器 | `npm run sync:launchers` —— 生成 GBK 的 `%AHK_ROOT%\launchers\{hexo,txttunnel,backtrans}.bat`；`shell` 片段依赖它 |
| Lint | `npm run lint`（eslint 9 flat config，`eslint.config.mjs`）。**只拦错不排格式**——没有 prettier，免得一次把 5000 行重排成没法 review 的 diff |
| 清临时产物 | `npm run clean:tmp` —— 删 `data/tmp` 下 7 天前的 `run-*.cmd`、`*-profile`（CDP 的 Chrome profile，每个十几 MB）与 `pty-probe/node_modules`（P5 前置验证装过的 node-pty，64MB；同目录的 `probe*.cjs` / `RESULT.md` 是文档引用的复现材料，不删）；`--dry` 只看，`--days N` 改期限，`--all` 忽略年龄全删 profile。UI 脚本启动时也会各自判断 profile 超过 1 天没用就重建（`scripts/lib/profile.mjs`） |
| CI | `.github/workflows/ci.yml`（windows-latest）：`npm ci` → typecheck → lint → check:ps1 → queue / cmd / search / expect / import。**smoke 与三个 `ui:*` 故意不进 CI**，它们要 listener.ahk / Chrome / 在线服务 |
| 测试 | `npm test` = typecheck + lint + `check:ps1` + `test:queue` + `test:cmd` + `test:search`(14) + `test:expect`(40) + `test:import`(60) + smoke（66 项）。`check:ps1` 扫全仓 `.ps1` 验 UTF-8 BOM 与语法（ISSUE-017 的防回归，见 §0.9）。冒烟 fixture 落系统 temp（`mkdtemp`），跑完自动删；**清理失败只 warn，不改退出码**——本机注入的 safe-delete shim 曾让全绿的测试红掉（ISSUE-004）。静态壳免 token 的 5 条用例在 `packages/web/dist` 不存在时整组跳过并打 `~`（先 `npm run build:web`）。多目标的 5 条校验 + 4 条实跑用例用**不打桥**的 `ping -n 3` 片段，listener 离线也跑（串行断言靠事件区间不重叠 + 总耗时 ≥ 3.5s）。运行档案的 12 条用例在临时数据目录里真跑两次 run 再读盘（含 secret 不落盘、`reason` 归类、列表不含存储用的 `kind`）。`expect` 的文件源另测 4 种编码（UTF-16 LE/BE 有无 BOM、GBK）与 CRLF 锚点，正则执行有 500ms 预算（回溯炸弹会被截断而不是拖死服务）。搜索语义 `npm run test:search`；多目标 UI `npm run ui:multi`；历史回放 UI `npm run ui:history`（后两个需服务在线，不进 `npm test`） |

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SNIPDECK_HOST` | `127.0.0.1` | 非 loopback 时必须配 token，否则拒绝启动 |
| `SNIPDECK_PORT` | `7878` | 避开 TxtTunnel 的 8787，两个可同时跑 |
| `SNIP_TOKEN` | 空 | Bearer 准入 token |
| `SNIPDECK_DATA` | `data` | 数据目录 |
| `SNIPDECK_WEB_DIST` | `packages/web/dist` | 不存在则只提供 API |

> 唯一实例约束：日志用 `cmd >>` 追加（独占句柄），重复启动第二条会报「文件被占用」。这顺带防止了两个服务抢同一个 `command.txt` 队列。
>
> **`.ps1` 必须是 UTF-8 with BOM**（2026-10-30 踩到）。PowerShell 5.1 只在看到 BOM 时才按 UTF-8 解码，否则按 CP936 读——中文注释里的三字节字符（`→`、`——`、`「」`）会造成字节错位，把后面的引号配对搞乱，**脚本直接语法失败**。`install-autostart.ps1` 原来就因此跑不起来（`ParseFile` 报「字符串缺少终止符」），已补 BOM。`check .editorconfig` 里 `[*.ps1] charset = utf-8-bom` 就是这个原因。改完请用
> `[System.Management.Automation.Language.Parser]::ParseFile()` 验一遍，别只看编辑器里显示正常。
>
> **日志轮转**：`start-server.ps1` 启动前若 `server.log` 超过 5MB，改名成 `server.log.1`（只留一份）。轮转只能在启动前做——运行中日志句柄被 `cmd >>` 独占，改名必失败（脚本里已经 catch 掉，不阻塞启动）。

### 16.1 自启：已安装（2026-10-30 08:04 注册并实测）

`scripts/install-autostart.ps1` 注册的计划任务名是 **`SnipDeck-server`**：

| 项 | 值 |
|---|---|
| 触发器 | 用户登录（`-AtLogOn -User $env:USERNAME`）。必须跑在交互桌面会话里，否则 listener.ahk 看不见桌面，GUI 片段全废 |
| 动作 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\scripts\start-server.ps1"` |
| 工作目录 | 仓库根。**路径含空格（`remote text control`），`-File` 后面的引号不能省** |
| 设置 | 电池上照跑、错过就补、失败 1 分钟重试 ×3、无执行时限 |
| 权限 | 普通权限即可，只注册当前账户 |

**安装记录（2026-10-30 08:04）**：脚本补 BOM 修好后注册成功。实测 `Get-ScheduledTask` → `State=Running`、`LogonType=Interactive`、`RunLevel=Limited`、`ExecutionTimeLimit=PT0S`、`LastTaskResult=267009`（0x41301 = 任务正在运行，不是错误）；`curl --noproxy '*' http://127.0.0.1:7878/api/health` 直接 200；日志里有 `[snipdeck] listening on http://127.0.0.1:7878`。

**装之前先确认两件事**（下次重装照这个来）：

1. **`.env` 里的 `SNIP_TOKEN` 填了没有** —— 空的话服务只监听 `127.0.0.1`，手机连不上（非 loopback 且无 token 时服务直接拒绝启动，§11）。
2. **当前有没有手工起的实例** —— 脚本末尾会立刻 `Start-ScheduledTask`；日志句柄独占，第二个实例会自己退出。这是设计（顺带防止两个服务抢 `command.txt`），但看起来像「装失败」。

```powershell
# 装（会立刻启动任务）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1

# 卸
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Uninstall
```

**验收**：

| 检查 | 期望 |
|---|---|
| `Get-ScheduledTask -TaskName 'SnipDeck-server'` | State = `Ready` 或 `Running` |
| 注销重登后**不手动起服务** | `curl --noproxy '*' http://127.0.0.1:7878/api/health` 直接返回 `ok:true` |
| `data/logs/server.log` | 有一条新的启动记录 |

**手动重启服务的正确姿势**（2026-10-30 实测踩到）：

`Stop-ScheduledTask` 只结束任务本身（那个 powershell），**它拉起的 node 子进程不跟着死，还占着 7878**。此时再 `Start-ScheduledTask`，新实例会因 `EADDRINUSE` 直接退出——任务状态看着是 Running，实际没有服务。正确顺序：

```powershell
Stop-ScheduledTask -TaskName 'SnipDeck-server'

# 确认端口真的空了。有输出就意思是有残留，先 Stop-Process 掉那些 PID 再继续
Get-NetTCPConnection -LocalPort 7878 -State Listen -ErrorAction SilentlyContinue

Start-ScheduledTask -TaskName 'SnipDeck-server'
```

重启电脑不存在这问题（进程跟着系统走），这条只针对「手动 stop/start 任务」。

**已知限制**：只管「登录后启动」，没登录不跑 —— 刻意的。真要「开机即跑」得配凭据跑 Session 0，那时 GUI 驱动就没意义了。
