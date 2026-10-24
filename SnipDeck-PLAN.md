# SnipDeck（片段坞）· 落地计划

> 一句话：自托管的「片段库 + 跨设备执行」工作台。把 Termius 的壳、你自己的纯文本片段库、以及家里那套 AHK 文件桥，缝成一个东西。
>
> 文档状态：v0.2 · 2026-10-24  
> 代号可改：`SnipDeck` / 中文「片段坞」。备选：`SnipDock`、`TextDeck`、`TxtCtl`。

---

## 0. v0.2 修订摘要

- **架构定为方案丙**：第一期只做 **exec 驱动**（spawn `ahk.bat` / cmd / powershell，收 stdout 与退出码）；local-pty 与 ssh 降为 **P5 预留**。Driver 接口与 hosts.yaml 三目标结构不变——以防以后前端后端要融 ssh 命令行时推倒重来。
- **触发事实**：Termius 实况 = Command 包 16 条 snippet，其中 14 条是 `ahk.bat` 子命令包装，2 条是任意 cmd 行（一条纯 `type`，一条 `set/if` 批处理逻辑）。且 `ahk.bat` 自身就是完整的同步桥客户端（写 command.txt → 轮询 last_result → 回显 → 退出码 0/1/2），桥协议无需用 Node 重写。
- **存储定为 YAML 文件**：与 SQLite / JSON / TOML 对比后确定——手改、git diff、注释、多行脚本体四项全胜（对比详见会话记录）。
- **交互终端整体移出本期**：node-pty / xterm.js / ws 通道全部移 P5，数据通道只剩 REST + SSE。浏览器里的"终端"由「运行抽屉 + 输出查看」承担；长驻服务继续走 ahk.bat 的 shell 槽位（桌面可见窗口）。

### 0.1 v0.3 审阅修订（P0 代码实测后）

P0 落地代码经通读 + 实跑（typecheck、smoke 19 项、CLI 真实调桥 122ms）后，修了下列问题。前两条是「设计承诺了、代码没做到」的类型：

| 问题                                | 症状（实测）                                       | 处置                                                         |
| --------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **串行队列退化成并行**                     | 两条各 2s 的命令并发，总耗时 2.27s；两条桥命令会同时写 command.txt | 队列改成等「上一条真正结束」才放行；新增 `npm run test:queue` 钉住这条不变式（现测 4.4s） |
| **danger 片段在网页里永远跑不起来**           | 「仍然执行」把 `confirm` 传成 `false`，服务端稳定回 400      | 确认状态与片段的 `danger` 标记解耦，独立 `confirmed` 参数                   |
| 空变量静默放行                           | 表单未填的坐标当 `''` 渲染成 `click wechat#1  ` 并执行     | 空串按缺失处理（`choices` 含空项时除外）；前端标 `*` 并在提交前拦住                  |
| `/api/*` 未知路径返回 HTML              | 前端拿到 HTML 却去 `JSON.parse`                    | SPA 回退只对非 `/api` 路径生效，其余回 404 JSON                         |
| 每个 `/api/health` 都写一次 command.txt | 页面刷新就打一次桥；listener 离线时每次卡 15s                | 30s TTL + in-flight 去重（实测 0.97s → 0.0016s）                 |
| 对外监听可以没有 token                    | 绑 Tailscale 地址后，同网段任何设备都能执行任意命令              | 非 loopback 且无 `SNIP_TOKEN` → 拒绝启动并说明原因                     |
| 超时与普通失败不可区分                       | 看不出是驱动杀的还是命令自己报错                             | `exit` 事件带 `timedOut`，CLI / UI 显示「超时被终止」                   |
| CLI `--var k=v` 不生效               | 被解析成名为 `var x` 的变量                           | `--var k=v` 与 `--k=v` 两种都认                                 |
| 目标 shell 配置是死代码                   | `hosts.yaml` 的 `shell` 从不生效，只有片段里的算数         | 片段 > 目标 > `cmd` 三级回退                                       |
| 临时 `.bat` 只涨不降                    | `data/tmp` 无清理                               | 启动时清掉 7 天前的 `run-*.cmd`                                    |

第二轮复审（同日稍后，重点是把「测试测的是复制品」这件事解决掉）：

| 问题 | 症状（实测） | 处置 |
|---|---|---|
| **冒烟测的是复制品** | `smoke-server.ts` 另抄了一份路由，队列/鉴权/404 的 bug 一个都没测出来 | 抽出 `buildApp()`，冒烟直接打真路由；用例 19 → 28，覆盖鉴权、404 JSON、secret 脱敏、reserved 目标、**真 SSE 执行** |
| **预览会回显 secret** | 变量走 query，`from: env:` 的值直接渲染进命令返回浏览器 | 预览改 POST；secret 一律显示 `***`，并回 `redacted` 名单 |
| 预览缺变量直接 500 | 严格渲染抛错，「看一眼最终命令」变成异常 | 新增 `renderTolerant`：未解析的占位符原样保留 `{{x}}` |
| 临时 `.bat` 吞掉落单 `%` | `echo 100%` 输出 `100`，与直传路径不一致 | 写入前把不属于 `%var%`/`%1`/`%~dp0`/`%%` 的 `%` 转义成 `%%`；加保真度测试 |
| 计划任务下每条命令闪黑框 | 无控制台会话里 spawn 会弹窗 | `spawn` 一律 `windowsHide: true` |
| 重复 id 静默覆盖 | 两个文件同 id，后者悄悄顶掉前者 | 检测重复 → 后一条 quarantine 并报出前一条路径 |
| reserved 目标返回 200 + 事件 | HTTP 看似成功，错埋在 SSE 里 | 目标未激活改为开流前 `400` |
| P0 要的「计划任务方式起服务」没有脚本 | 验收项无从执行 | 补 `scripts/start-server.ps1` + `install-autostart.ps1`（登录时任务、读 `.env`、日志落盘） |
| PowerShell 重定向把中文日志转成乱码 | 日志里出现 `璇曠偧涔嬪湴` | 追加交给 `cmd`，不让 PowerShell 二次转码 |

**已知缺口（P2 前补）**：`runs/<runId>.jsonl` 落盘未实现（SSE 断开就看不到本次历史）；片段无 CRUD / Raw 编辑 API，只能改文件；`targets[]` 多目标未做；token 靠手填 localStorage，配对二维码未做；无 service worker（只能加主屏，不脱机）。

---

## 1. 为什么不用 Termius

| 维度   | Termius 现状         | 我们要的                        |
| ---- | ------------------ | --------------------------- |
| 片段组织 | 分组+标签，拖拽排序勉强，跨组搜索弱 | 目录即分组、模糊搜索、`meta` 任意字段      |
| 片段复用 | 只能粘进当前会话           | 变量渲染 + 一键执行 + 输出归档          |
| 数据归属 | 存在它云端，导出困难         | 本地 YAML 文件，拷走即迁移，git 可 diff |
| 执行能力 | 只会发 shell 命令       | 还能驱动桌面 GUI（走 ahk.bat）       |
| 多目标  | 需要手工各连一遍           | 一条片段投多台，收并列结果（P3）           |
| 手机体验 | App 内功能齐全但片段编辑难用   | PWA，点一下就跑，不依赖实时输入           |

结论：不是要做一个「更好的 Termius」，是要做一个**片段优先**的工作台。v0.2 把这句话落到了实处：本期根本没有交互终端，只有片段 + 执行结果。

---

## 2. 目标与非目标

**做**

1. 片段库：YAML 文件为唯一真相（目录即分组），支持变量（含 `choices` 下拉）、多步动作、任意 `meta` 字段。
2. 一类执行目标：**win-desktop（exec 驱动）**，统一到驱动接口下；local / ssh 目标在 hosts.yaml 中预留占位。
3. 跨设备：同一份库、同一套主机配置，手机和笔记本看到的是同一个东西。
4. CLI：`snip list|run|search|hosts|status|reindex`，任意 SSH 终端（包括 Termius）里都能用。
5. Web/PWA：片段面板 + 变量表单 + 一键运行 + 输出查看 + 桥队列可视化。

**不做（本期）**

- 交互式终端（node-pty / xterm.js / WS）——P5 预留，接口不动。
- ssh 驱动——P5 预留。
- 多用户 / 团队协作 / 权限分级（单用户假设，见 §11）。
- 公网暴露（只走 Tailscale）。
- 文件传输（SFTP）、端口转发图形化、跳板机链路。
- 移动端离线执行（离线只能看，不能跑）。

---

## 3. 总体架构

```
手机 PWA ─┐
笔记本浏览器 ─┼─ Tailscale 100.x ─→ 服务端（家里 Win11，登录时计划任务）
任意 SSH 终端 ─┘                        │
                                        ├─ Web/API（Fastify + SSE）
                                        ├─ 片段库（data/snippets/**/*.yaml）
                                        ├─ 执行器（exec 驱动 + 全局串行队列）
                                        └─ 运行档案（data/runs/<runId>.jsonl）
                                                │ spawn
                                    cmd /c ahk.bat …（或 powershell）
                                                │ 写 command.txt · 轮询 last_result
                                        listener.ahk（常驻 · 已提权）
                                                │
                                        桌面 GUI（微信 / 多开实例 / shell 槽位）
```

两条数据通道：

| 通道   | 协议                | 用途                                  |
| ---- | ----------------- | ----------------------------------- |
| REST | HTTP/JSON         | 片段 CRUD、主机、run 的发起与查询               |
| SSE  | text/event-stream | 一次 run 的事件流（start/stdout/step/exit） |

WS 通道随交互终端一起移出（v0.1 有三条通道，现在两条）。

---

## 4. 执行驱动（核心）

### 4.1 统一接口

驱动不关心 UI，只回答三件事：能不能开交互会话、能不能无头跑、跑出来什么。

```ts
interface Driver {
  readonly kind: 'exec' | 'local' | 'ssh'
  describe(): DriverInfo            // 能力声明：{ pty, stream, gui, concurrent }
  run(req: RunRequest): AsyncIterable<RunEvent>
  openSession?(opts: SessionOpts): Promise<Session>   // 仅 local/ssh（P5）
}
```

`RunRequest` 里带：片段、目标、渲染后的变量、步骤列表。  
`RunEvent`：`{ type: 'start' | 'stdout' | 'stderr' | 'step' | 'exit' | 'error', ... }`。

**要点**：UI 只认 `RunEvent`，不认驱动。本期只实现 exec；加 local/ssh = 加一个实现类，前端一行不改。

### 4.2 exec 驱动（本期唯一实现）

一句话：**spawn 一个进程，收 stdout/stderr 和退出码**。不碰 PTY，不碰 ssh2，零原生模块。

- **命令来源**：片段的 `shell: cmd` → `cmd.exe /d /s /c "<rendered>"`；`shell: powershell` → `powershell -NoProfile -Command "…"`（或先 dot-source `ahk.ps1` 再调函数，见 §12.4）。
- **双模式**：
  - 简单命令（无 `&&`/`||`/`|`/`(`/`)`/`%`/`^`、无换行）→ 直接 spawn，命令行传参（宽字符，中文安全）。
  - 复杂命令（含控制字符、`%var%`、多行）→ 落 `data/tmp/run-<runId>.cmd` 再 spawn。临时文件固定带 `@echo off` + `setlocal EnableDelayedExpansion` 头，**按 GBK 写入**（cmd 读 .bat 按 ANSI/GBK，与 ahk.bat 头部注释同一结论；含中文的片段没有第二条路）。落盘前把**不属于 `%var%` / `%1` / `%~dp0` / `%%` 的单个 `%`** 转义成 `%%`，否则 `echo 100%` 在批处理里会被吞成 `100`，与直传路径行为不一致。跑完保留供排查，`data/tmp` 定期清理（默认 7 天）。
  - 两条路径都带 `windowsHide: true`：服务将来以计划任务（无控制台）运行时，不会每条命令闪一个黑框。
- **编码**：输出按 BOM / UTF-8 合法性判别，失败回退 GBK（复用 `listener.ahk` 已验证的判别思路，别重造）。
- **超时**：默认 20s。**必须大于 ahk.bat 内部 15s 等待**（wait_core 的 `TIMEOUT_SEC`），否则驱动杀掉了 ahk.bat、桥命令还在途。超时不重试——GUI 动作重试的代价通常比失败更大。
- **全局串行队列**（硬约束）：`command.txt` 是单车道，且 ahk.bat 自身没有锁——两条并发调用会互相覆盖 command.txt（`wait_before` 只能防读到旧结果，防不了覆盖）。所有走桥的命令在同一队列里 FIFO 排队；UI 显示队列长度与等待位置；长任务引导改用 shell 槽位 / runlog（ahk.bat 15s 内回收，不长期占道）。
- **免队列通道**：纯读文件的命令（如 `ahk.bat instances` 只 type instances.txt）不写 command.txt，可绕过队列直接跑，片段里标 `queue: false`。
- **健康检查**：启动时 + 每 60s 跑一次 `ahk.bat status`（或比对 instances.txt / status.txt 新鲜度）。listener 离线时：UI 徽标示灰，GUI 片段快速失败并提示「listener 不在线」，纯本地命令不受影响。

### 4.3 ahk.bat 协议面（exec 驱动的能力边界）

ahk.bat 就是桥协议的客户端，exec 驱动通过它的子命令获得全部 GUI 能力。**子命令即协议面**：

| 子命令                               | 能力               | 备注                                |
| --------------------------------- | ---------------- | --------------------------------- |
| `instances`                       | 实例表              | 纯读文件，免队列；可能略旧                     |
| `status`                          | 刷新并读 status      | 写桥，走队列                            |
| `focus/close/kill <slot>`         | 激活 / 关窗 / 杀进程树   | kill 建议 danger                    |
| `click <slot> <x> <y>`            | 窗口坐标点击           | Window 坐标非 Client                 |
| `lnk <name>` / `admin lnk <name>` | 启动快捷方式（可提权）      | 成功入实例表                            |
| `run` / `runlog [jobN] <cmd…>`    | 同步跑 / 异步跑+日志     | runlog 输出在 `jobs\*.log` / `.exit` |
| `script <name>`                   | 跑 AHK 脚本         |                                   |
| `shell` / `shell <slot> "cmd"`    | 开可见 cmd / 往槽位粘命令 | 发起即返回，输出在桌面窗口                     |
| `send "raw"` / `wait [sec]`       | 原始协议行 / 等待非 PEND | 逃生舱，一般不用                          |

退出码约定：0 = 拿到结果；1 = 等待超时；2 = 写入失败 / 用法错误。

**v0.1 的结构化桥动词（`{op, slot, x, y}`）取消**——ahk.bat 的 CLI 就是接口，`do: run` 直接携带渲染后的命令行；Raw 模式下用户看到的即执行的，不搞结构化黑盒。

### 4.4 预留：local 与 ssh（P5）

- **local**：node-pty 起 powershell / cmd / Git Bash；交互模式 PTY 直通（届时 reintroduce WS + xterm.js）；无头模式已被 exec 驱动覆盖。激活条件：确实需要浏览器里的交互 shell，且 ConPTY 在计划任务会话里验证可用。
- **ssh**：ssh2，密钥 / agent / 密码，`known_hosts` 校验；`exec` 无头、`shell` channel 交互。激活条件：要管 VPS / Linux 机器。到那时 `insert` / `send` 两个步骤动词一起实装。
- 两者在 hosts.yaml 中占位（`reserved: true`），UI 灰显，fan-out 时跳过并提示。

### 4.5 能力矩阵（这决定了片段怎么写）

| 能力          | exec（本期）       | local（P5） | ssh（P5）   |
| ----------- | -------------- | --------- | --------- |
| 交互 PTY      | ❌              | ✅         | ✅         |
| 流式 stdout   | ✅（整段收回）        | ✅         | ✅         |
| 退出码         | ✅              | ✅         | ✅         |
| 并发执行        | ❌ 单车道排队        | ✅         | ✅         |
| 驱动 GUI / 键鼠 | ✅（经 ahk.bat）   | ❌         | ❌         |
| 跨机器         | ❌（只本机桌面）       | ❌         | ✅         |
| 运行前提        | listener 常驻且提权 | 无         | sshd + 密钥 |

**推论**：想碰 GUI，`target` 必须指向 win-desktop，且天然不可移植到别的机器。这是物理限制，不试图抹平。P5 之后想「到处都能跑」的片段只写 POSIX 命令投 local / ssh。

---

## 5. 数据模型（YAML 文件为唯一真相）

### 5.1 主机与目标（data/hosts.yaml）

片段的 `target` 指这里的一个键，驱动类型由目标决定，片段不直接写驱动。

```yaml
win-desktop:              # 本期唯一可用目标
  driver: exec
  shell: cmd
  bridge: C:\ahk_trigger  # ahk.bat 所在目录
  timeout: 20

home-win:                 # 预留（P5）：本机 shell，含交互 PTY
  driver: local
  reserved: true

vps:                      # 预留（P5）：远端 SSH
  driver: ssh
  host: 100.99.202.54
  reserved: true
```

### 5.2 片段（data/snippets/\*\*/\*.yaml）

```yaml
id: click-instance
title: 点击实例
group: 实例控制             # 也可由目录路径决定
target: win-desktop
shell: cmd                 # ← Termius 的 Package: Command（Powershell 包则为 powershell）
tags: [gui, instance]
danger: false
meta:                      # 任意键，UI 原样保留
  owner: kakyo
  since: 2026-10
vars:
  pro: { prompt: 程序, default: wechat }
  n:   { prompt: 实例号, default: 1 }
  x:   { prompt: X }
  y:   { prompt: Y }
steps:
  - { do: run, cmd: 'call C:\ahk_trigger\ahk.bat click {{pro}}#{{n}} {{x}} {{y}}', timeout: 20 }
  - { do: sleep, ms: 300 }
```

本期 `steps` 动词两种：

| `do`    | 含义           | 关键参数                         |
| ------- | ------------ | ---------------------------- |
| `run`   | 无头执行，收输出与退出码 | `cmd`, `timeout`, `optional` |
| `sleep` | 等待           | `ms`                         |

（`insert` / `send` 留给 P5 的交互会话；`expect` 正则条件步 P4 实装。）

通用参数：`timeout`（秒，走桥时 ≥ 20）、`optional`（失败继续）。

### 5.3 「自定义」的四个口子

1. **字段自由**：`meta:` 下任意键值。UI 不认识的键**原样保留**，升级不洗库。
2. **动作自由**：`steps` 是序列，一个片段可以是「跑一条 → 等一下 → 再跑一条」。
3. **命令自由**：`cmd` 就是最终命令行，变量渲染后整条可见、可预览（bridge 类默认开预览）；不搞结构化黑盒。
4. **原文编辑**：Raw 模式直接写 YAML 文本，表单只是可选入口。

### 5.4 变量

```yaml
vars:
  port:  { default: 8787, prompt: 端口 }
  flag:  { choices: [0, 1, 2], default: 0, prompt: 模式 }   # ← Focus&Click 的 set flag=（0,1,2）
  token: { secret: true, from: env:SNIP_TOKEN }
```

渲染：`{{port}}`，行内可组合（`{{pro}}#{{n}}`）。带 `prompt` 的执行前弹输入框；`choices` 渲染为下拉；`secret` 的不落历史、不进日志。**规则：密钥永远不内联在片段里**，只引用环境变量或 `data/secrets.yaml`（该文件默认进 .gitignore）。

### 5.5 存储布局

```
data/
├─ hosts.yaml
├─ snippets/
│  ├─ 实例控制/click-instance.yaml
│  ├─ 程序启动/open-program.yaml
│  └─ 运维/部署.yaml
├─ secrets.yaml          # gitignore
├─ tmp/run-<runId>.cmd   # 临时批文件，GBK，定期清理
└─ runs/<runId>.jsonl    # 执行历史（可选，P4）
```

目录层级 = 分组路径，也可用文件内 `group:` 覆盖。一个文件放单条或列表都行。

### 5.6 索引与保真

- 启动全量扫盘建内存索引（id/title/tags/正文），`fs.watch` 增量更新（防抖 200ms），`snip reindex` 可随时全量重建。几千条无压力。
- 表单保存走 `yaml` 的 Document API，尽量保住注释与字段顺序；Raw 模式直接写原文；每次保存前留 `.bak`。**不认识的键一律原样落盘**。
- 加载时逐文件校验：字段缺失 / 类型错误 → 该文件 quarantine（不进索引、不可运行），错误列表在 CLI 与 UI 都可见；不影响其他文件。

---

## 6. 运行时行为

### 6.1 一次 run 的时序

```
前端 POST /api/run {id, vars}
  → core 读片段 → 解析 target → 取 host → 选驱动（exec）
  → 渲染变量 → 校验 steps
  →（danger 片段弹确认 → 预览渲染后的最终命令）
  → 入串行队列（queue:false 的纯读命令跳过）
  → 逐 step 调 driver.run()，事件实时推 SSE
  → 每步结果累积，遇到的第一个非 optional 失败即中止
  → 收尾写 runs/<runId>.jsonl，返回汇总（每步 exit / 耗时）
```

run 是服务端行为：前端断开不影响执行；重连按 runId 补拉事件尾（SSE Last-Event-ID）。

### 6.2 没有交互会话之后

- v0.1 的「PTY 会话 + 回滚缓冲 + 重连续看」整体移除：本期没有长命交互进程可持。
- 长驻服务（hexo s、TxtTunnel、Backtrans）继续走 ahk.bat `shell` 槽位：桌面可见窗口、服务重启不受影响、`kill` 带进程树。浏览器只负责发起，以及事后的 `runlog` / `.exit` 查看。
- 「服务重启丢会话」这条风险随之消失；run 档案落盘，只能看不能接——本来也不接。


### 6.3 多目标并发（预留形态）

`POST /api/run` 支持 `targets: [win-desktop, …]`：

- exec 目标全部进同一条串行队列，事件按目标打标；
- reserved 目标（home-win / vps）跳过，并在结果里标注「未激活」；
- 前端并列展示。P5 激活 local / ssh 后，这两个目标才真正并发。

### 6.4 编码与中文（已知雷区）

| 雷                                         | 处理                                                               |
| ----------------------------------------- | ---------------------------------------------------------------- |
| 控制台 CP936 把中文变 `绋嬪簭`                      | 输出解码做 BOM / UTF-8 合法性判别，失败回退 GBK                                 |
| `%var%` / `&&` / 括号进不了 `cmd /c "…"`       | 双模式：复杂命令落临时 .cmd，头部 `setlocal EnableDelayedExpansion`；批文件按 GBK 写 |
| 临时 .cmd 里的中文路径                            | 同上，GBK；或优先走 ahk.bat 子命令（中文经 ahk_cmd.ps1 / paste.txt，不落 .bat）     |
| 嵌套引号（`shell shell#1 "cd /d … && hexo s"`） | Node spawn 前按 cmd 转义规则处理；这条链路的中文已由 paste.txt 解决                  |
| YAML 里的 Windows 路径反斜杠                     | 统一单引号字符串，写入时不转义转换                                                |
| Android 输入法吃字                             | 本期无实时输入，主路径 = 点片段 + 填变量表单                                        |

### 6.5 错误与超时

- 每步独立超时：`run` 默认 20s（> ahk.bat 内部 15s），`sleep` 即 ms。
- 超时不重试，直接标 `timeout` 并保留已有输出。
- 桥命令超时后**不清理** `command.txt`（避免与 listener 抢文件），只记录并告警。
- listener 离线（健康检查失败）→ GUI 片段直接失败，提示明确；纯本地命令不受影响。

---

## 7. 技术选型

| 层    | 选型                             | 理由                       |
| ---- | ------------------------------ | ------------------------ |
| 运行时  | Node 22 + TypeScript           | 和 TxtTunnel 同栈，鉴权/自启可直接搬 |
| 服务端  | Fastify + SSE                  | 轻；无 WS 后更简单              |
| 片段解析 | `yaml`（Document API）           | 能保注释、保未知键                |
| 搜索   | `minisearch`                   | 纯 JS 模糊搜索，零 native 依赖    |
| 前端   | Vite + React + Tailwind        | 出活快，手机布局好调               |
| 手机   | PWA（manifest + service worker） | 加到主屏，复刻 TxtTunnel 的做法    |
| 持久化  | 文件 + 内存索引                      | 数据可读可 diff；不上 SQLite     |

v0.1 移出（进 P5）：node-pty、xterm.js、`ws`、ssh2。

**从 TxtTunnel 只搬四件**：token 鉴权、配对二维码、PWA manifest、自启脚本。Cursor 相关的一律不带。

---

## 8. 仓库结构

```
remote text control/                 # 仓库根
├─ packages/
│  ├─ core/         片段模型 · 变量渲染 · 索引 · 驱动注册表 · 类型
│  ├─ drivers/      exec.ts（local.ts / ssh.ts 为 P5 占位）
│  ├─ cli/          snip list|run|search|hosts|status|reindex
│  ├─ server/       Fastify 路由 · SSE · 静态托管
│  └─ web/          Vite + React（PWA）
├─ data/
│  ├─ hosts.yaml
│  ├─ snippets/
│  ├─ tmp/
│  └─ runs/
├─ scripts/         自启安装 / 启动脚本 / 冒烟测试
├─ docs/            协议说明 · 片段写法 · 排错
└─ SnipDeck-PLAN.md # 本文件
```

---

## 9. 路线图与验收

| 期             | 内容                                                                                 | 验收标准（可自己动手验）                                                                   |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **P0** 技术验证   | Monorepo 骨架；exec 驱动 spawn `ahk.bat status` 跑通；Fastify + SSE 一条 run 事件流；`scripts/start-server.ps1` + `install-autostart.ps1`（登录时计划任务、读 `.env`、日志落 `data/logs/server.log`）   | `npm test` 全绿；手机走 Tailscale 打开网页，点 `check-instence` 看到实例表；服务重启后片段索引自动重建                      |
| **P1** 内核     | `core` 片段模型 + YAML 读写 + 索引 + 校验/quarantine；exec 驱动（双模式 + 串行队列 + 健康检查）；CLI；16 条存量迁移 | ✅ 2026-10-24 完成：`snip run` 带变量真的点中实例（notepad 回环实测）；改/删 YAML 1s 内索引变化；flag 为下拉（choices [0,1,2]）。记录见 §17 |
| **P2** Web 界面 | 片段面板 + 变量表单 + 运行抽屉 + 输出查看 + 队列可视化 + 手机布局 + PWA                                     | 手机上不打开终端也能跑片段并看结果；队列等待时显示位置                                                    |
| **P3** 多目标    | `targets` 数组、并列结果、reserved 目标标注                                                    | 一条片段投 win-desktop + home-win，后者标注「未激活」                                         |
| **P4** 打磨     | `expect` 条件步、secret 变量、danger 二次确认、bridge 预览最终命令（默认开）、从 shell 历史导入                 | 新机器上 30 分钟内导入全部历史命令并跑通一条                                                       |
| **P5** 预留扩展   | local-pty（ConPTY 验证后）+ ssh（ssh2）；`insert`/`send` 动词；xterm.js 终端页                   | 届时定；激活一项做一项                                                                    |

顺序说明：本期只有 exec 一条主线，先把「片段 → 变量 → 队列 → 输出」全链路跑稳；P5 两项互不依赖，哪个需求先来先做。

---

## 10. 风险与预案

| 风险                        | 影响                  | 预案                                                    |
| ------------------------- | ------------------- | ----------------------------------------------------- |
| 桥单车道被长命令占住                | 后续 GUI 命令全排队        | 队列带长度上限与等待提示；长任务引导 shell 槽位 / runlog（ahk.bat 15s 内回收） |
| ahk.bat 内部 15s 与驱动超时错位    | 驱动杀了 ahk.bat，桥命令还在途 | 驱动超时 ≥ 内部 + 5s；超时不重试                                  |
| listener.ahk 离线           | 全部 GUI 片段失败         | 健康检查（status / instances.txt 新鲜度）+ UI 徽标 + 快速失败        |
| 控制字符 / `%var%` / 中文进不了命令行 | 片段跑不动或乱码            | 双模式 spawn；临时 .cmd 带 EnableDelayedExpansion、按 GBK 写    |
| 临时 .cmd 残留堆积              | 磁盘垃圾                | runId 命名 + data/tmp 定期清理（默认 7 天），失败件保留供排查             |
| YAML 被表单保存后注释丢失           | 用户手写的排版被洗           | 走 Document API；Raw 模式兜底；每次保存前留 `.bak`                 |
| 单文件 YAML 写坏               | 索引半残                | quarantine 隔离 + 错误列表可见 + `snip reindex` 全量重建          |
| 密钥写进片段被同步出去               | 泄露                  | 强制 `from: env:` / `secrets.yaml`；提交前扫一遍明显的 token 模式   |
| 服务重启                      | 进行中的 run 中断         | run 档案落盘可回看；本期无会话可丢                                   |

（v0.1 的 ConPTY 风险随交互终端移出而消失；P5 激活 local-pty 时重新评估。）

---

## 11. 安全模型

- **网络边界靠 Tailscale**：只监听 Tailscale 接口（或 `tailscale serve` 拿 HTTPS + 身份头），不做公网端口映射。
- **单一 token 准入**：首次在本机 loopback 生成 token，手机扫码配对后写 cookie（搬 TxtTunnel 的做法）。
- **危险动作二次确认**：片段可标 `danger: true`，执行前弹确认；`kill` / `admin:` 类默认标记。
- **执行前预览**：bridge 类动作默认展示渲染后的最终命令行，确认后才发（对不可撤销动作）。
- **审计**：`runs/<runId>.jsonl` 记录谁在什么设备上跑了什么片段、退出码多少。
- **单用户假设**：多用户、权限分级不在本期范围，硬要加会让鉴权和片段隔离复杂度翻三倍。

---

## 12. 待定项

已定：代号 `SnipDeck` / 「片段坞」；端口 `8787`；`data/tmp` 保留 7 天；danger 片段必须二次确认且默认展示预览。

仍待定：

1. 是否用 `tailscale serve` 上 HTTPS。能顺带拿到 Tailscale 身份头、省掉手填 token，但多一层要维护的反向代理；当前是「Tailscale 网络边界 + `SNIP_TOKEN`」。
2. 配对二维码（照搬 TxtTunnel）何时做。现在手机首次访问要手动粘贴 token 到 localStorage。
3. Powershell 包 snippet 的处理：`Invoke-AhkLnk` 归一成 `ahk.bat lnk`，还是 exec 驱动支持 dot-source `ahk.ps1` 后调函数。归一更简单，但会丢掉 PS 包的会话级变量。
4. `runs/<runId>.jsonl`（历史可回看）与 `targets[]`（多目标）谁先做——前者影响排障体验，后者才是「一条片段投多台」的卖点。

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

鉴权：来源是 loopback 免 token；其余一律 `Authorization: Bearer $SNIP_TOKEN`，否则 401。

| 方法 | 路径 | 入参 | 出参 / 语义 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok,bridgeUp,queue,snippets,quarantined}`；`bridgeUp` 有 30s 缓存与单飞去重 |
| GET | `/api/snippets` | — | `SnippetView[]`（**不含**服务器文件路径） |
| GET | `/api/snippets/:id` | — | `SnippetView`；不存在 404 |
| POST | `/api/snippets/:id/preview` | `{vars}` | `{cmds,pending,missing,redacted}`；secret 渲染为 `***`；未填变量保留 `{{x}}` |
| GET | `/api/hosts` | — | `{name,driver,reserved,default}[]` |
| POST | `/api/run` | `{id,vars?,target?,confirm?}` | `text/event-stream` |

`/api/run` 的失败码都在**开流之前**判定：snippet 不存在 → 404；danger 未确认 / 目标未知 / 目标 `reserved` → 400。开流之后只剩 `error` 事件。

## 15. 事件与片段字段参考

**RunEvent**（前端与 CLI 共用同一套语义）

| type | 字段 | 含义 |
|---|---|---|
| `start` | `stepIndex`, `cmd?` | `stepIndex=-1` 表示整条 run 开始（server 用它打目标名） |
| `queued` | `stepIndex`, `waitedMs` | 排队超过 50ms 才发，UI 显示等待时长 |
| `stdout` / `stderr` | `data` | **整段**返回（当前不做逐行流式） |
| `step` | `ok`, `exitCode`, `durationMs` | 单步收尾 |
| `exit` | `ok`, `exitCode`, `durationMs`, `timedOut?` | 整条 run 收尾；`timedOut` 表示被驱动杀掉 |
| `error` | `message`, `stepIndex?` | 变量缺失、目标错误等 |

**片段字段**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 全局唯一；重复时后一条 quarantine 并报出前一条路径 |
| `title` / `tags` / `danger` / `meta` | 否 | `meta` 任意键，程序原样保留 |
| `group` | 否 | 缺省取目录路径 |
| `target` | 否 | `hosts.yaml` 的键；缺省取 `default: true`，再缺省第一个非 reserved |
| `shell` | 否 | `cmd` / `powershell`；缺省取目标 `shell`，再缺省 `cmd` |
| `vars` | 否 | `prompt` / `default` / `choices` / `secret` / `from: env:XXX` |
| `steps` | 是 | `{do: run, cmd, timeout?, optional?, queue?}` 或 `{do: sleep, ms}` |

**quarantine 条件**（该文件不进索引、不可运行，其余片段不受影响）：YAML 解析失败、缺 `id`、缺 `steps`、step 不合法、`id` 重复。

**命令语义的三个已知边界**

- 落在临时 `.bat` 时 `%` 会被转义保护；`^` 仍按批处理语义处理，要字面量请写 `^^`。
- 同一行 `set X=1 && echo %X%` 在 cmd 里是解析期展开（读不到刚设的值），交互式与批处理一致，不是驱动的 bug。
- **变量是原样插入的**：值里的 `>` / `|` / `&` 会被**驱动侧**的 cmd 解释（实测 `--line="echo X> file"` 把输出重定向进了文件）。需要发这些字符，在片段里自己给变量加引号。
- **`shell shell#N` 的负载必须是单个引号参数**：`... shell shell#1 mkdir C:\a\b` 只会送达 `mkdir`（`chars=7`）。带空格的命令务必写成 `"... shell shell#1 \"你要发的一整行\""`，或走 launcher。

## 16. 运行与部署

| 项 | 位置 / 命令 |
|---|---|
| 启动 | `powershell -File .\scripts\start-server.ps1`（读 `.env`，日志追加到 `data/logs/server.log`） |
| 自启 | `powershell -File .\scripts\install-autostart.ps1`（登录时计划任务）；`-Uninstall` 卸载 |
| 配置 | 复制 `.env.example` 为 `.env`（已 gitignore） |
| 服务启动器 | `npm run sync:launchers` —— 生成 GBK 的 `%AHK_ROOT%\launchers\{hexo,txttunnel,backtrans}.bat`；`shell` 片段依赖它 |
| 测试 | `npm test` = typecheck + `test:queue` + `test:cmd` + smoke（28 项） |

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SNIPDECK_HOST` | `127.0.0.1` | 非 loopback 时必须配 token，否则拒绝启动 |
| `SNIPDECK_PORT` | `8787` | 与 TxtTunnel 默认端口相同，同时跑要改 |
| `SNIP_TOKEN` | 空 | Bearer 准入 token |
| `SNIPDECK_DATA` | `data` | 数据目录 |
| `SNIPDECK_WEB_DIST` | `packages/web/dist` | 不存在则只提供 API |

> 唯一实例约束：日志用 `cmd >>` 追加（独占句柄），重复启动第二条会报「文件被占用」。这顺带防止了两个服务抢同一个 `command.txt` 队列。

## 17. P1 实施记录（2026-10-24）

**迁移结果**：16 条 → 5 个分组（程序启动 3 / 状态 2 / 实例控制 5 / Shell 与服务 4 / 任务与日志 2）。`snip list` 无 quarantine，`/api/snippets` 计数 16。

**验收实测**

| 项 | 结果 |
|---|---|
| 带变量真的点中实例 | `notepad` 回环：`run notepad.exe` → `slot=notepad#1 hwnd=…` → `click x=320 y=180 moved=1 setPos=1` → `close dead=1` |
| 索引热更新 | 新增 YAML 1s 内出现在 API、删除 1s 内消失（`fs.watch` + 200ms 防抖） |
| flag 是下拉 | `cursor-refill` 的 `flag` 为 `choices: [0,1,2]`，Web 渲染成 select |
| 桥并发不变式 | 两条 `check-status` 并发：总 1.75s，第二条 `waitedMs=569`，`durationMs` 643/1211 呈串行 |
| PowerShell 分支 | `shell: powershell` 下中文与 `$PSVersionTable` 正常（psver=5） |
| runlog 链路 | `run-with-log whoami` → job5 spawned → `exit-runlog job5` 读到 `0`（27ms，`queue:false` 不过桥） |

**迁移中发现并修掉的问题**

1. **`shell shell#N "<cmd>"` 的嵌套引号会截断参数**：cmd 在路径空格处切断（`ARG3` 只剩 `"cd /d "D:\English`）；用 `""` 转义时更糟——`&&` 后面的命令**泄漏到调用方本地执行**（实测真的跑起了 `python run.py`）。→ 三条服务片段改为调用 `C:\ahk_trigger\launchers\*.bat`（路径无空格），`cd` 收进 launcher。
2. **8.3 短名在这块盘已关闭**（`%~s1` 原样返回长路径），没有「免引号」捷径。
3. **`exit-runlog` 模板与实际文件名不符**：原命令是 `{{job}}.{{n}}.exit`，listener 实际写 `<id>.exit`（`JobsDir "\" jobId ".exit"`）。已去掉 `{{n}}`，job 名从 runlog 回传里抄。
4. **冷壳会吞第一次粘贴**：`open-shell` 后 3.4s 投命令仍 `typed=1` 却不执行。`open-shell` 的 sleep 500 → 1500ms，note 里写明「再发一次」。
5. **`shell` 负载必须是单个引号参数**：`--line="mkdir C:\a\b"` 不加引号只送达 `mkdir`（`chars=7`）。
6. **变量值是原样插入**：值里的 `>`/`|`/`&` 由驱动侧 cmd 解释（`--line="echo X> f"` 把 ahk.bat 的输出重定向进了文件）。

**仍未确认**

- `cursor-refill`：原命令在截图里截断，现按 `flag==2 → admin lnk cursor续杯工具` 实现，默认 0 为 no-op，标了 danger。需要你确认 flag 语义与目标。
- `run-backtrans` 的启动命令按该目录 README 推断为 `python run.py`。

**新增脚本**：`scripts/sync-launchers.mjs`（`npm run sync:launchers`）→ 生成 GBK launcher 到 `%AHK_ROOT%\launchers`。

---

## Changelog

- **v0.1**（2026-10-24 早）：初版——三驱动（local/bridge/ssh）、node-pty + xterm.js + ssh2、WS 终端通道。
- **v0.2**（2026-10-24 晚）：
  - 架构改**方案丙**：exec 驱动为唯一实现；local-pty / ssh 移 P5 预留（触发：16 条 snippet 实况 + ahk.bat 即完整桥客户端）。
  - 存储定为 **YAML**（对比 SQLite / JSON / TOML 后确定）。
  - 移除交互终端相关：node-pty、xterm.js、ws 通道；§6.2 会话模型重写；数据通道剩 REST + SSE。
  - bridge 驱动重定义为「spawn ahk.bat」；结构化桥动词取消，`cmd` 即命令行；新增双模式 spawn、全局串行队列、健康检查、临时 .cmd（GBK + 延时展开）。
  - 步骤动词收缩为 `run` / `sleep`（`insert`/`send` 移 P5）。
  - 路线图改 P0–P5；风险表换掉 ConPTY 行；新增 §13 附录 16 条迁移清单。
- **v0.3**（2026-10-24 深夜）：P0 代码审阅与实测后的修订（详见 §0.1）——
  - 修复串行队列退化成并行（核心安全不变式），并加 `test:queue` 回归测试。
  - 修复 danger 片段无法从网页执行、空变量静默放行、`/api` 404 返回 HTML、health 每次打桥、无 token 对外监听、超时不可区分、`--var` 不生效、目标 shell 死配置、临时文件堆积。
  - 新增 `README.md`（快速开始 / 片段写法 / 安全边界）与 `snip reindex`。
- **v0.4**（2026-10-24 第二次复审）：
  - **抽 `buildApp()`**：冒烟测试不再测复制品，直接打真路由；用例 19 → 28，含鉴权（模拟 Tailscale 来源）、404 JSON、secret 脱敏、reserved 目标、**真 SSE 执行**。
  - 预览改 POST 并脱敏 secret；新增 `renderTolerant` 解决「缺变量预览 500」。
  - 临时 `.bat` 补 `%` 转义（`echo 100%` 不再变 `100`），新增 `test:cmd` 保真度回归（8 项，含超时）。
  - `windowsHide`、重复 id quarantine、reserved 目标开流前 400。
  - 补 P0 缺失的运维件：`scripts/start-server.ps1`、`scripts/install-autostart.ps1`、`.env.example`；日志改由 `cmd` 追加以免 PowerShell 把中文转成乱码。
  - 新增 §14 接口契约、§15 事件与字段参考、§16 运行与部署；§12 待定项按当前状态重写。
- **v0.5**（2026-10-24 深夜，P1 完成）：
  - 16 条 Termius 片段全部迁移到 `data/snippets/`（5 组）；`snip run` 带变量点中实例、热更新、flag 下拉三项验收通过（详见 §17）。
  - 修迁移中的三处硬伤：嵌套引号截断 + `&&` 泄漏、`exit-runlog` 文件名不符、冷壳吞首次粘贴。
  - 新增 `scripts/sync-launchers.mjs`（服务启动器，绕开路径空格）。
  - §15 补两条命令语义边界：变量原样插入、`shell` 负载必须单参数。
