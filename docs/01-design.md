# SnipDeck · 设计（§1 – §8）

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · Issue 队列 [00-issues.md](00-issues.md) · 路线图 [02-roadmap.md](02-roadmap.md) · 参考 [03-reference.md](03-reference.md) · 实施记录 [04-phases.md](04-phases.md) · 变更日志 [05-changelog.md](05-changelog.md)
>
> 覆盖原 `SnipDeck-PLAN.md` 的 **§1 – §8**：为什么不用 Termius、目标与非目标、总体架构、执行驱动、数据模型、运行时行为、技术选型、仓库结构。
>
> 这一份回答「要做什么、为什么这么设计」。查接口与字段去 `03-reference.md`，查某一期实际怎么落地、有什么偏差去 `04-phases.md`，查某个 bug 的来龙去脉去 `00-issues.md`。
>
> **章节编号全局不变**：文中 §0.x 见 `00-issues.md`，§9–§12 见 `02-roadmap.md`，§13–§16 见 `03-reference.md`，§17–§22 见 `04-phases.md`。

---

## 1. 为什么不用 Termius

| 维度   | Termius 现状         | 我们要的                        |
| ---- | ------------------ | --------------------------- |
| 片段组织 | 分组+标签，拖拽排序勉强，跨组搜索弱 | 目录即分组、模糊搜索、`meta` 任意字段      |
| 片段复用 | 只能粘进当前会话           | 变量渲染 + 一键执行 + 输出归档          |
| 数据归属 | 存在它云端，导出困难         | 本地 YAML 文件，拷走即迁移，git 可 diff |
| 执行能力 | 只会发 shell 命令       | 还能驱动桌面 GUI（走 ahk.bat）       |
| 多目标  | 需要手工各连一遍           | 一条片段投多台，收并列结果（P3 已做「同目标多开」与并列面板；跨机广播投放已废弃，改由 P5 终端多会话承担）           |
| 手机体验 | App 内功能齐全但片段编辑难用   | PWA，点一下就跑，不依赖实时输入           |

结论：不是要做一个「更好的 Termius」，是要做一个**片段优先**的工作台。v0.2 把这句话落到了实处：本期根本没有交互终端，只有片段 + 执行结果。

---

## 2. 目标与非目标

**做**

1. 片段库：YAML 文件为唯一真相（目录即分组），支持变量（含 `choices` 下拉）、多步动作、任意 `meta` 字段。
2. 一类执行目标：**win-desktop（exec 驱动）**，统一到驱动接口下；`home-win` / `vps` 在 hosts.yaml 里继续占位但仍是 `reserved`（P5 的终端走自己的连接列表，不读 `target`）。
3. 跨设备：同一份库、同一套主机配置，手机和笔记本看到的是同一个东西。
4. CLI：`snip list|run|search|hosts|status|reindex`，任意 SSH 终端（包括 Termius）里都能用。
5. Web/PWA：片段面板 + 变量表单 + 一键运行 + 输出查看 + 桥队列可视化。

**不做（本期）**

- 交互式终端（node-pty / xterm.js / WS）——**P5 就是它**（见 06-terminal.md），P0–P4 不做。
- ssh 的**片段执行**驱动——不做；P5 的 ssh 只做 shell channel，不跑片段。
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

驱动只回答一件事：**怎么把一条片段跑完，交出输出和退出码。**

```ts
interface Driver {
  readonly kind: 'exec' | 'local' | 'ssh'
  describe(): DriverInfo            // 能力声明：{ pty, stream, gui, concurrent }
  run(req: RunRequest): AsyncIterable<RunEvent>
}
```

`RunRequest` 里带：片段、目标、渲染后的变量、步骤列表。  
`RunEvent`：`{ type: 'start' | 'stdout' | 'stderr' | 'step' | 'exit' | 'error', ... }`。

**要点**：UI 只认 `RunEvent`，不认驱动。本期只实现 exec，`kind` 另外两个值留着是因为 `hosts.yaml` 里 `home-win` / `vps` 还占着位。

> **没有 `openSession()`。** 2026-10-30 删掉了这个预留方法：它暗示终端会话可以长在驱动上，而实际模型不是——驱动一次性返回、有退出码；会话长驻、双向、没有退出码。P5 的终端在 `packages/server` 的 `SessionManager` 里，见 [06-terminal.md](06-terminal.md) §24。

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

### 4.4 P5：网页终端（会话不是驱动）

**2026-10-30 改**：P5 不再是「local / ssh 两个驱动」，而是**一个终端**。设计与验收全在 [06-terminal.md](06-terminal.md)，这里只留它与驱动层的边界。

- **驱动**（`packages/drivers`）：只服务「片段执行」——一次性、整段返回、有退出码。本期仍然只有 `exec`。
- **会话**（`packages/server` 的 `SessionManager`）：PTY / ssh 的 shell channel——长驻、流式、双向。它**不实现 `Driver` 接口**，也不参与 `RunRequest` / `RunEvent`。硬塞进去会让两个模型互相污染：一个要退出码，一个没有退出码。
- **唯一共享**的是输出解码（BOM / UTF-8 合法性 / GBK 回退）。真需要时再抽，不预支。
- `hosts.yaml` 里 `home-win` / `vps` 继续占位，但仍是 `reserved`——**终端不读 `target`，它有自己的一套连接列表**。

### 4.5 能力矩阵（这决定了片段怎么写）

只有一列了，因为只有一种驱动：

| 能力 | exec（唯一驱动） |
|---|---|
| 交互 PTY | ❌（终端是 P5 的独立页面，不是驱动） |
| 流式 stdout | ✅（整段收回） |
| 退出码 | ✅ |
| 并发执行 | ❌ 单车道排队 |
| 驱动 GUI / 键鼠 | ✅（经 ahk.bat） |
| 跨机器 | ❌（只本机桌面） |
| 运行前提 | listener 常驻且提权 |

**推论**：想碰 GUI，`target` 必须指向 `win-desktop`，且天然不可移植到别的机器——这是物理限制，不试图抹平。片段只在本机跑；跨机器干活走 P5 的终端会话（开一个 tab），不是「把片段投过去」。

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

home-win:                 # 占位：本机 shell（P5 终端有独立连接列表，不走 target）
  driver: local
  reserved: true

vps:                      # 占位：远端 SSH（P5 终端用，不作为片段 target）
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

本期 `steps` 动词三种：

| `do`     | 含义                | 关键参数                                  |
| -------- | ----------------- | ------------------------------------- |
| `run`    | 无头执行，收输出与退出码      | `cmd`, `timeout`, `optional`          |
| `sleep`  | 等待                | `ms`                                  |
| `expect` | 对文本做正则断言（不执行命令）   | `match`, `from`, `flags`, `timeout`, `interval`, `optional` |

（`insert` / `send` 已废弃：P5 的终端用 WS 直接写 PTY，不需要独立动词。）

`expect` 的三种取文来源（`from`）：

| `from` | 取什么 | 是否等待 |
|---|---|---|
| `last`（缺省） | 往前找最近一条有输出的 `run` 步 | 否（exec 整段返回，立刻判定） |
| `all` | 本次 run 到目前为止所有 `run` 步的输出拼起来 | 否 |
| `file:<路径>` | 读文件内容（日志、`.exit`、runlog） | **是**：每 `interval`（默认 200ms）重读一次，到 `timeout`（默认 10s）仍不匹配则判失败 |

```yaml
id: wait-hexo-ready
steps:
  - { do: run, cmd: 'type D:\blog\hexo.log' }
  - { do: expect, match: 'Hexo is running at', from: 'file:D:\blog\hexo.log', timeout: 20 }
  - { do: expect, match: 'Generating done', from: last }
```

`flags` 只认 `i` / `m` / `s`——`g` 会被**静默去掉**（`RegExp.test()` 在 `g` 下带 `lastIndex`，同一个正则连测两次会一真一假，这种 bug 在片段里极难查）。

通用参数：`timeout`（秒，走桥时 ≥ 20；`expect` 的 `timeout` 是等文件的时间）、`optional`（失败继续）。

### 5.3 「自定义」的四个口子

1. **字段自由**：`meta:` 下任意键值。UI 不认识的键**原样保留**，升级不洗库。
2. **动作自由**：`steps` 是序列，一个片段可以是「跑一条 → 等一下 → 再跑一条」。
3. **命令自由**：`cmd` 就是最终命令行，变量渲染后整条可见、可预览（bridge 类默认开预览）；不搞结构化黑盒。
4. **原文编辑**：Raw 模式直接写 YAML 文本，表单只是可选入口。

### 5.4 变量

```yaml
vars:
  port:  { default: 7878, prompt: 端口 }
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
└─ runs/<runId>.jsonl    # 执行档案（P4 已实现）：meta / event×N / summary 三段
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
  → 落盘 runs/<runId>.jsonl（首行 meta / 中间每条事件 / 末行 summary），返回汇总
```

run 是服务端行为：前端断开不影响执行（`send()` 见 `closed` 就丢，命令照跑）。首条 `start` 事件带 `runId`，前端存住；**不做 SSE 续传**（`Last-Event-ID` 只在同一条连接上有意义，页面一关就没了）——要回看就打 `GET /api/runs/:runId` 重放整份档案。

### 6.2 没有交互会话之后

- v0.1 的「PTY 会话 + 回滚缓冲 + 重连续看」整体移除：本期没有长命交互进程可持。
- 长驻服务（hexo s、TxtTunnel、Backtrans）继续走 ahk.bat `shell` 槽位：桌面可见窗口、服务重启不受影响、`kill` 带进程树。浏览器只负责发起，以及事后的 `runlog` / `.exit` 查看。
- 「服务重启丢会话」这条风险随之消失；run 档案落盘，只能看不能接——本来也不接。


### 6.3 多目标（P3 已实现；跨机并列已废弃）

`POST /api/run` 接受 `targets: ["win-desktop", "win-desktop"]`：

- **同一目标允许重复**：那是单机唯一能表达「多开」的方式，数组顺序 = 结果并列顺序；
- **校验全在开流前**：空数组 / 非数组 / 未知目标 / 任一 `reserved` → `400`，整条拒绝（不做「跳过并标注」，因为一次请求只返回一条 SSE 流，半个成功最难解释）；
- **事件逐条打标**：`{ ...event, target, targetIndex }`，前端按 `targetIndex` 分流到各自面板；
- **并发拉起、串行执行**：服务端 `Promise.all` 同时启动 N 个 `runSnippet`，但它们共用同一个 `ExecDriver`（按 `bridgeRoot` 缓存）→ 全局串行队列，实际严格一个接一个。只有一种驱动，所以 N 路永远是排队，不是并发；
- **上限 8 个**（`MAX_TARGETS`）：只是防呆，不是产品限制。

> **P3 只做「同目标多开」**：数据模型、目标选择器、reserved 置灰、事件打标、结果并列都落地了，但可执行目标仍然只有 `win-desktop`，所以实际是「同一条片段在这台机器上排队跑 N 次」。**跨机并行已于 2026-10-30 废弃**——终端用「多个会话并排」满足同一诉求，不做命令行广播，见 [06-terminal.md](06-terminal.md) §26.2。

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
| 搜索   | 内存子串匹配（`includes` + 多词 AND）  | 零依赖、CJK 直接可用；十几到几百条规模下 O(n) 是几十微秒。原定 `minisearch` 因默认 tokenizer 不切 CJK 而弃用（ISSUE-002） |
| 前端   | Vite + React + Tailwind        | 出活快，手机布局好调               |
| 手机   | PWA（manifest + service worker） | 加到主屏，复刻 TxtTunnel 的做法    |
| 持久化  | 文件 + 内存索引                      | 数据可读可 diff；不上 SQLite     |

v0.1 移出、后由 P5 收回的四个依赖：node-pty、xterm.js、`ws`、ssh2——P5 **只把它们用在终端上**，不用于片段执行（ssh2 只开 shell channel，不用 `exec()`）。

**从 TxtTunnel 只搬四件**：token 鉴权、配对二维码、PWA manifest、自启脚本。Cursor 相关的一律不带。

---

## 8. 仓库结构

```
remote text control/                 # 仓库根
├─ packages/
│  ├─ core/         片段模型 · 变量渲染 · 索引 · 驱动注册表 · 类型
│  ├─ drivers/      exec.ts（唯一驱动；终端会话不进这里）
│  ├─ cli/          snip list|run|search|hosts|status|reindex
│  ├─ server/       Fastify 路由 · SSE · 静态托管 ·（P5）SessionManager + WS
│  └─ web/          Vite + React（PWA）·（P5）/terminal 路由
│     ├─ App.tsx        状态编排（570 行；2026-10-30 从 1096 行拆出）
│     ├─ types.ts       Pane / Output / Draft / MAX_TARGETS
│     ├─ lib/run-events.ts  事件 → 面板的纯函数（可单测）
│     └─ components/    Topbar · Sidebar · SnippetList · RunFormModal ·
│                       RunDrawer · HistoryModal · SettingsModal · DangerModal
├─ data/
│  ├─ hosts.yaml
│  ├─ snippets/
│  ├─ tmp/
│  └─ runs/
├─ scripts/         自启安装 / 启动脚本 / 冒烟测试 / UI 回归 / clean-tmp
├─ docs/            计划分卷（2026-10-30 从单文件拆出，章节号不变）
│  ├─ 00-issues.md      issue 队列 · 现场记录 · 修复计划（§0.2–§0.9）
│  ├─ 01-design.md      本文件：设计与架构（§1–§8）
│  ├─ 02-roadmap.md     路线图 · 风险 · 安全 · 待定项（§9–§12）
│  ├─ 03-reference.md   迁移清单 · 接口契约 · 字段参考 · 部署（§13–§16）
│  ├─ 04-phases.md      分期实施记录（§17–§22）
│  └─ 05-changelog.md   变更日志
├─ .github/workflows/ci.yml   CI：typecheck + lint + 不依赖桥的单测
├─ .gitattributes   # 全库 LF；.bat/.cmd 强制 CRLF
├─ .editorconfig    # .ps1 必须 utf-8-bom（理由见 §16）
├─ eslint.config.mjs
├─ SnipDeck-PLAN.md # 总览 · 文档地图 · 修订摘要（§0 / §0.1）
└─ README.md        # 快速开始 / 片段写法 / 安全边界（面向使用者）
```

> 拆分规则：**章节号全局唯一且不变**。任何地方写「§14」就是指 `docs/03-reference.md` 的第 14 节，不需要记文件名——总览的文档地图负责换算。
>
> 前端分层的分工：**判定与状态在 `App.tsx`，长相在 `components/`，事件怎么变成面板在 `lib/run-events.ts`**。后者是纯函数层，改文案/加事件类型都不该动组件。
