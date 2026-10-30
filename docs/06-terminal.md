# SnipDeck · P5 网页终端（§23 – §29）

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · 设计 [01-design.md](01-design.md) · 路线图 [02-roadmap.md](02-roadmap.md) · 参考 [03-reference.md](03-reference.md) · 实施记录 [04-phases.md](04-phases.md) · Issue 队列 [00-issues.md](00-issues.md) · 变更日志 [05-changelog.md](05-changelog.md)
>
> 覆盖 **P5**：从「驱动扩展」重定义为「网页终端」。§9 的路线图条目指回本文件，P5 的设计与验收都写在这里，不再散进 01/02。
>
> **状态（2026-10-30）：P5.1 已实装。** 会话内核 + WS 通道 + 终端页在本机跑通，实施记录与实测数据见 [04-phases.md](04-phases.md) §30。P5.2–P5.4 未开工。前置验证数据见 §28。

---

## 23. P5 重定义

### 23.1 原方案错在哪

旧的 P5 是四条并列的「驱动扩展」：local 驱动（已实装）、ssh 驱动 + 跨机并列、`insert`/`send` 动词、PTY + xterm 终端页。四条按「驱动」分类，PTY 排在最后一位。

问题不在排期，在**分类**：PTY 不是一种驱动，它是产品形态本身。驱动是「一条片段怎么执行」（一次性、整段返回、有退出码），终端是「一个长驻会话」（流式、双向、无退出码）。把终端塞进驱动清单的尾巴，等于把主菜当配菜，做出来的东西既不是好终端，也不是好驱动。

2026-10-30 的决定：**P5 = 网页终端**。驱动扩展这条线收掉，已经实装的 local 驱动一并撤回。

### 23.2 砍掉了什么

| 旧项 | 状态 | 处置 | 理由 |
|---|---|---|---|
| P5.1 local 驱动 | 已实装（未提交） | **撤**（`git stash` 留档） | 它相对 exec 的唯一差别是「不排桥队列」，而终端会话根本不是「跑一条命令」，无法复用。`home-win` 与 `win-desktop` 又是同一台机器，UI 上像重复选项。 |
| P5.2 ssh exec 驱动 + 跨机并列 | 未做 | **不做** | 唯一卖点是「一条片段投两台真机」，实际只有一台。批量投放是片段坞的用法，不是终端的用法。 |
| P5.3 `insert` / `send` 动词 | 未做 | **不做** | 它是「没有 PTY 才这么设计」的绕路（往 GUI shell 槽贴字符、再从 runlog 读回显）。有了终端，`insert` 就是 WS 的一次 write。 |
| P5.4 PTY + xterm | 未做 | **升为 P5 主体** | 见下文。 |

撤回的代码在 `git stash list` 里（`P5.1 local 驱动…仅留档`），要捞回来说一声。工作区已回到 P4 状态。

### 23.3 一条不动的东西

**exec 驱动不动。** GUI 动作仍然走 `ahk.bat`，`command.txt` 仍然是单车道，串行队列不变。终端是并排加的第二个能力，不是替代——「点窗口」和「敲命令」是两种活，谁也不是谁的升级版。

---

## 24. 会话模型

### 24.1 Session

```ts
type SessionKind = 'local' | 'ssh'

interface Session {
  id: string            // 16 字节随机，hex；id 本身就是能力，必须不可猜
  kind: SessionKind
  shell: string         // powershell / cmd / bash
  cwd: string
  cols: number
  rows: number
  createdAt: number
  lastActiveAt: number
  state: 'running' | 'exited'
  exitCode?: number
  buffer: RingBuffer    // 回滚，200KB 上限
  attach: Set<Subscriber>
}
```

会话是**进程级**的，不进 `Session` 表也不落盘。服务重启 = 所有会话消失，前端收到 `session gone` 后提示「已断开，点击新建」。这与 v0.2「本期无会话可丢」的立场一致——真要在服务重启后还活着，得有 supervisor，那是另一个量级的工程。

### 24.2 三种连接形态

用户最早说的是「本地、ssh、tty」。落成实现时其实是**两条链路 + 一个协议**：

| 形态 | 实现 | 说明 |
|---|---|---|
| 本机 | `node-pty` → ConPTY → `powershell.exe` / `cmd.exe` | Windows 上这就是「PTY」，没有别的选择 |
| SSH | `ssh2` 的 `client.shell({ term, cols, rows })` | **不是 `exec()`**。exec 是一次性命令，shell 才是分配 pty 的长驻通道 |
| TTY | —— | Windows 没有独立的 tty 层；Linux 上相当于 pty，已由上面两条覆盖。若要「裸 tty 设备」（`/dev/tty1` 那种），浏览器接不了，明确不做 |

所以「三种」在实际实现里是两种，第三种是前两种的统称。这一点写在这里，免得下一轮又按三种去排。

### 24.3 生命周期

```
POST /api/sessions  {kind, shell, cwd?, cols, rows}
  → 201 {id, kind, shell, cols, rows, createdAt}

WS  /ws/session/:id?token=…
  → 附加（可多端同时附加，输出广播）

DELETE /api/sessions/:id
  → kill 进程树

GET /api/sessions
  → 现有会话列表（页面刷新后能挑回没死的那个）
```

**三条回收路径**，一条都不能省：

1. **关页面**：WS 断开 → 该会话订阅数归零 → 起一个 60s 宽限定时器（防止刷新页面误杀）→ 到期还没人附加就 kill。
2. **空闲**：`lastActiveAt` 超过 30 分钟且无人附加 → kill。
3. **服务重启**：进程本身没了。但**子进程可能还活着**（ConPTY 的 powershell 不一定跟着死），所以启动时扫一遍 `data/tmp/sessions/*.pid`，把上一轮的残留 `taskkill /T /F` 掉。

回收必须走 `taskkill /F /T /PID`，**不要只调 `p.kill()`**——理由见 §25.4 的 `AttachConsole` 噪音。

### 24.4 回滚

每个会话维护 200KB 的 ring buffer（按字节，不是按行——ANSI 转义序列跨行）。新订阅者 attach 时先灌历史再接着推流。

200KB 的依据：`ahk.bat instances` 那种表约 40 行 / 3KB，200KB 够回看 60 屏以上；再大就要考虑落盘，而落盘会把「终端」变成「日志查看器」，不是本期的目标。

---

## 25. 通道

### 25.1 为什么是 WS

| | WebSocket | SSE 出 + POST 进 |
|---|---|---|
| 按键延迟 | 直发，一帧 | 每批一个 HTTP 请求（需 20ms 合并） |
| 双向语义 | 原生 | 两条独立通道，顺序无法保证 |
| 鉴权 | 要单独写 upgrade 校验 | 复用现有 `onRequest` hook |
| 依赖 | `ws`（经 `@fastify/websocket`） | 零新增 |
| 手机切后台 | 断开后可重连 | 请求会失败重试 |

**结论：WS。** 这是对 v0.2「数据通道只剩 REST + SSE」的推翻，但不是反复——当时的判断前提是「本期没有交互终端」，而终端的本质就是双向低延迟流。SSE 的出向没问题，问题在入向：每次按键一个 POST，顺序、背压、断线重连三件事都得自己兜。

代价明确：新增 `ws`（或 `@fastify/websocket`）+ 一套 upgrade 鉴权。

### 25.2 鉴权：整个功能唯一的安全命门

现行守卫（`packages/server/src/app.ts:119`）：

```ts
if (!token || isLoopback(req.ip)) return   // loopback 直接放行
```

**WS 是 HTTP server 的 `upgrade` 事件，不进 Fastify 的 `onRequest` hook。** 也就是说这行代码对终端**完全无效**——不额外处理的话，任何人都能连上 `/ws/session/:id` 敲命令。

规则三条：

1. **upgrade 阶段独立校验 token**，不走 hook。
2. **没有 loopback 豁免。** REST 的 loopback 豁免是为了「本机打开页面不用填 token」，这个便利在终端上不能有——反代（`tailscale serve`）把请求从 `127.0.0.1` 转进来时，豁免等于把 remote shell 送给整个 Tailscale 网络。这和 §12-1 记的是同一个坑，只是后果更重。
3. **会话 id 不可猜**（16 字节随机）。id 泄露 = 能力泄露，因为附加不需要额外凭据。

前端配套：进 `/terminal` 前检查 `localStorage` 里有没有 token，没有就引导去 ⚙ 设置，不在终端页做「点一下免 token 试玩」。

### 25.3 协议草案

文本帧，JSON。终端输出本身是 UTF-8 字符串，不涉及二进制。

```jsonc
// 客户端 → 服务端
{ "t": "input",  "d": "ls\r" }
{ "t": "resize", "cols": 120, "rows": 30 }
{ "t": "ping" }

// 服务端 → 客户端
{ "t": "ready",  "id": "...", "shell": "powershell", "cols": 80, "rows": 24, "replay": "…" }
{ "t": "output", "d": "…" }
{ "t": "exit",   "code": 0 }
{ "t": "error",  "message": "…" }
{ "t": "pong" }
```

`ready.replay` 是回滚缓冲的原文，一次性发完；之后只发增量。用 `\r\n` 还是 `\n` 交给 xterm 处理，服务端不改写字节。

### 25.4 已知噪音：`AttachConsole failed`

`node-pty` 的 `kill()` 会 fork 一个 `conpty_console_list_agent.js`，用 `AttachConsole(shellPid)` 枚举进程树。父进程没有控制台时（服务把 stdout 重定向到 `data/logs/server.log`，正是这种情况）会抛：

```
Error: AttachConsole failed
    at Object.<anonymous> (…/node-pty/lib/conpty_console_list_agent.js:13:26)
```

实测**功能不受影响**（子孙进程照样被 ConPTY 带走，见 §28 的 3b），但每次 kill 都往 stderr 喷一段栈。处理：服务侧 kill 统一走 `taskkill /F /T /PID`，绕开这个 agent；日志侧对这段栈做过滤。

---

## 26. 界面

### 26.1 位置：顶栏两个 tab

`片段` / `终端`。`/terminal` 是独立路由，现有片段坞的布局、断点、抽屉、断言**一个字不动**。

不做「终端当首屏、片段变侧栏」——那要重做 P2.5 的全套布局和 100+ 条 UI 断言，收益只是打开快一次点击。

### 26.2 终端页结构

```
┌ 顶栏：SnipDeck  [片段] [终端]        ● bridge  ● 2 sessions ┐
├ 会话条： [本机 powershell ×] [vps bash ×] [+ 新建]          ┤
├ xterm 区域（fit 到容器，等宽 CJK 栈沿用 P2.5）               ┤
└ 状态行：80×24 · UTF-8 · 已连接 12m                          ┘
```

- 新建会话：一个下拉（本机 powershell / 本机 cmd / ssh 目标）+ 一个按钮。ssh 目标从 `hosts.yaml` 里 `driver: ssh` 的条目读。
- 会话条可切换，同时活多个会话（这就是「多台机器同时干活」的形态，不需要跨机广播）。
- 断线：xterm 上盖一层半透明提示 + 「重连」按钮，会话还在就重连，不在了就新建。

### 26.3 手机

- 底部快捷键盘条：`Esc` `Tab` `Ctrl` `↑` `↓` `←` `→` `Ctrl+C`。Android 输入法对组合键支持参差，这些键走 `input` 事件直接发字节，不依赖输入法。
- 高度用 `100dvh`（不是 `100vh`，手机地址栏收起时会跳）。
- 软键盘弹起时 `fit()` 重算尺寸并 `resize`，否则下半屏被挡。
- 不折行，横向滚动交给 xterm 自己的 scrollback。

### 26.4 不做

暗色主题（另立议题，和 §19.7 同一条理由）、分屏、多窗口、终端录制回放、会话持久化（服务重启就结束）。

---

## 27. 分期与验收

四段，每段自己闭环（代码 + 测试 + 文档），做完可停。

| 段 | 内容 | 量级 | 依赖 |
|---|---|---|---|
| **P5.1** 骨架 ✅ 10-30 | `SessionManager` + 本机 ConPTY（powershell/cmd）+ WS 通道 + 最小 xterm 页（能敲、能看、能 resize） | 中 | 无（已验可行）· 实施记录见 [04-phases.md](04-phases.md) §30 |
| **P5.2** 韧性 | 回滚缓冲 + 断线重连 + 三条回收路径 + 手机快捷键盘 + 会话条 | 中 | P5.1 |
| **P5.3** SSH | `ssh2` 的 `shell()` channel → 复用同一套 `Session`；`known_hosts` 校验；凭据只从 env 读 | 中 | P5.1（会话抽象已定型） |
| **P5.4** 整合 | 片段宏侧栏：把现有片段注入当前终端（点一下发 `cmd\r`，变量仍走表单） | 小 | P5.1 |

### 每段验收

**P5.1**
- 手机开 `/terminal`，起 powershell，`dir` 有回显，中文路径不乱码
- 桌面 1366×768：xterm 宽高 = 容器（`fit` 后 `cols/rows` 与容器像素匹配，无溢出）
- 无 token 访问：HTTP 401，WS 握手被拒
- `node-pty` 的 `.node` 能被 **`D:\node.js Symllink\node.exe`（v22.17.1）** 加载

**P5.2**
- 刷新页面 → 60s 内重连成功且看得到上文（回滚生效）
- 关闭页面等 90s → `tasklist /FI "IMAGENAME eq powershell.exe"` 里那个 PID 消失
- 服务重启 → 上一轮残留子进程被 `taskkill` 清掉（查 `data/tmp/sessions/*.pid`）
- 手机软键盘弹起 → `rows` 变化，`resize` 事件到服务端

**P5.3**
- 连真远端跑 `uname -a`（或本机 sshd 的 `whoami`），输出正常
- 错密码 / 未知主机 → 明确报错，不静默重试
- 关终端 → 远端 `ps` 里那条 shell 消失

**P5.4**
- 点一条带变量的片段 → 终端里出现渲染后的命令行，变量值正确转义
- 不发回车（`insert` 语义），再点「执行」才发 `\r`

### 从哪开始下手

`packages/drivers` 新建 `session.ts`（不复用 `spawn.ts` 那套一次性模型），`packages/server` 加 `/ws/session/:id`，`packages/web` 加 `/terminal` 路由。三个包各自加测试，`npm test` 里挂 `test:session`。

---

## 28. 前置验证结果（2026-10-30 实测）

三项全部通过。复现脚本在 `data/tmp/pty-probe/`（`probe.cjs` / `probe2.cjs` / `probe3.cjs`，数据同目录 `RESULT.md`）。

| # | 验证 | 结果 | 数据 |
|---|---|---|---|
| 1 | `node-pty` 能否装 / load | ✅ | 1.1.0，`npm install` **9s / 2 个包 / 零编译**（win32-x64 prebuild 命中） |
| 2 | ConPTY 能否在计划任务会话起 | ✅ | 按 `SnipDeck-server` 同款 Principal（`Kakyo George` / `Interactive` / `Limited`）建的临时任务：`SPAWN=ok(62ms)` |
| 3 | 交互式会话可用 | ✅ | 提示符 154B(1264ms) → `resize(100,30)` ok → 写入 `echo INTERACTIVE_OK` → **命中 40ms**，ANSI 正常 |
| 3b | kill 后子孙进程回收 | ✅ | 终端内跑 `ping -n 30` → `PING_DURING=1` → kill → `PING_AFTER=0`，`ORPHAN=NO` |

**两条环境事实**（会咬人，写在这免得忘）：

1. **服务跑的不是 PATH 里那个 node。** 实际进程是 `D:\node.js Symllink\node.exe` **v22.17.1**（ABI 127），而 `node -v` 在 WorkBuddy 的 shells 里给的是 22.22.2。两者 ABI 相同，prebuild 互通，但**换 Node 大版本会让 `.node` 失配**。装依赖 / 改 `start-server.ps1` 时按这个路径对齐。
2. **`ws` 的 `upgrade` 不进 Fastify hook**，见 §25.2。这是终端唯一的安全命门，别在实现时图省事复用 REST 的守卫。

---

## 29. 待定

1. **`GET /api/sessions` 要不要暴露给片段坞页面**（顶栏显示「2 个会话在跑」）。倾向要，但等 P5.2 会话条做完再定。
2. **SSH 凭据放哪**：`env:` / `secrets.yaml` / Windows 凭据管理器三选。倾向 `secrets.yaml` + 文件权限，与现有 secret 变量一致。
3. **`hosts.yaml` 的 `driver: ssh` 条目要不要同时支持 exec 和 shell**。倾向不支持——`vps` 只为终端存在，片段想在上面跑就等以后单独加 ssh exec 驱动。
4. **是否保留旧 P5.1 的 `spawn.ts` 抽取**。倾向不保留，等 P5.1 真需要解输出时再抽，不预支。
