# SnipDeck（片段坞）· 落地计划

> 一句话：自托管的「片段库 + 跨设备执行」工作台。把 Termius 的壳、你自己的纯文本片段库、以及家里那套 AHK 文件桥，缝成一个东西。
>
> 文档状态：v1.5 · 2026-10-30  
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

**已知缺口（按 §9 排期，不在本轮）**：片段 CRUD / Raw 编辑 API（表单与原文编辑仍是 P5 之后）；跨机并列（P5，需 ssh 驱动；`targets[]` 数据结构与 UI 已在 P3 落地）；token 靠手填 localStorage、配对二维码未做（§12-2）。service worker 与离线缓存已在 P2 落地，但只在 HTTPS 下生效。~~`runs/<runId>.jsonl` 落盘、`expect` 条件步、从 shell 历史导入~~ **P4 已全部落地**（见 §22）。

### 0.2 待修项 ISSUE-001：token 守卫把首屏也挡了，手机端死锁（2026-10-25 实测，**已修 · 2026-10-29**）

> 编号约定：从这里起统一用 `ISSUE-xxx`，不再分「BUG」与「缺口」两套号。理由——两者的共同点是**计划承诺了、当前做不到**，区别只在来源：bug 是写错了，缺口是没写完。分两套号会让「哪些还没补」散在两处。原 BUG-001 沿用 ISSUE-001。
>
> **队列约定（2026-10-29 起）**：issue **只往队尾追加**，编号永不复用、不重排、不插队。新发现的 issue 接在当前最大号之后（下一个是 `ISSUE-005`）。修好的：标题行「**未修**」改「**已修 · YYYY-MM-DD**」，「状态」行写明改了什么、哪个测试兜住；**现场记录原样保留不删**——它同时是回归用例的说明书。修到一半的写「**修中**」。issue 与其修复计划成对出现：正文在 §0.2/§0.3，计划在 §0.4。

**状态**：**已修 · 2026-10-29**。守卫改为按路径分流——`/api/*` 仍需 Bearer，其余一律放行；`notFound` 对「带扩展名但文件不存在」返回 404 文本（`/favicon.ico` 不再被 SPA 回退成 HTML）。冒烟补 5 条（远端 `GET /` → 200 HTML、远端 `/assets/*.js` → 200、`/favicon.ico` → 404 非 HTML、`/some/spa/route` → 200 HTML、静态放行未顺带放行 `/api`），共 33 项。另用 `SNIPDECK_HOST=100.99.202.54 SNIP_TOKEN=…` 起了个 7879 临时实例，从 Tailscale 地址实测：`/` → 200 `text/html` 885B、无 token 打 `/api/snippets` → 401、带 token → 16 条列表、`/favicon.ico` → 404 `text/plain`。以下为原始现场记录，保留作回归说明书。

**原状态**：待修。以下为完整现场记录，修的时候按「修复方向」执行，并补回归用例。

**发现场景**：P2 验收转真机。`npm run build:web` 产出 dist 后，`set SNIPDECK_HOST=100.99.202.54` + `set SNIP_TOKEN=<32位hex>` + `npm run dev:server`，日志显示 `Server listening at http://100.99.202.54:7878`，服务启动正常。手机（Lemur 浏览器）走 Tailscale 打开 `http://100.99.202.54:7878`。

**现象**：手机看到的不是 Web UI，而是一行 JSON：`{"error":"unauthorized"}`。服务端日志中 6 个请求全部 401，且全部是 `GET /` 与 `GET /favicon.ico`——**一次 `/api/*` 都没打到**，页面根本没有加载过。

**根因**：`packages/server/src/app.ts` 第 63–68 行的鉴权是**全局 `onRequest` 钩子**，不区分路径：

```ts
app.addHook('onRequest', async (req, reply) => {
  if (!token || isLoopback(req.ip)) return
  const auth = req.headers.authorization ?? ''
  if (auth === `Bearer ${token}`) return
  return reply.code(401).send({ error: 'unauthorized' })
})
```

只要服务端设了 `SNIP_TOKEN`，所有非 loopback 请求（含静态页面 `/`、`/assets/*`、favicon）不带 Bearer 一律 401。`fastifyStatic` 注册在第 173 行，在守卫之后，永远走不到。

**死锁链条**（这是它必须修的原因）：

1. 手机打开 `/` → 401 JSON，拿不到 HTML
2. 没有 HTML → 没有 ⚙ 按钮、没有「去填写」横幅 → token 无处填写
3. 不填 token → 永远 401

即「要页面先过 token，要 token 先有页面」。本机 loopback 访问无此问题（守卫放行 loopback），所以 P2 验收（CDP 仿真走本机）完全看不出，一上真机就死。

**与设计意图的矛盾**：README「手机访问」第 3 步写明「第一次会弹横幅要 token —— 点右上角 ⚙ 粘贴一次，存在这台设备的 localStorage」；§18 P2 记录「401 时顶部横幅引导」。横幅和 ⚙ 都活在 HTML 里，而 HTML 被同一个守卫挡死。§14 接口契约首行「来源是 loopback 免 token；其余一律 `Authorization: Bearer`」是这条实现的书面来源，表述本身过宽。

**为什么冒烟测试没抓到**：`smoke-server.ts` 的鉴权用例只打 `/api/*`（远端无 token → 401、带 token → 200、loopback → 200），没有「远端访问静态首屏」这条用例。同理，没有任何自动化覆盖「手机首次访问能拿到页面」。

**修复方向**（守卫按路径分流）：

- `/api/*` → 维持现状，必须 `Authorization: Bearer <token>`
- 其余（`/`、`/assets/*`、favicon 等静态资源）→ 放行免 token

安全权衡论证：页面 HTML/JS/CSS 本身不含任何数据（所有数据都经 `/api`），放行静态资源暴露的只是一个空壳 UI；真正的能力（片段列表、命令执行、GUI 操作）仍全部在 token 之后。这是最小暴露，不削弱原威胁模型（§11）。注意 `req.url` 可能带 query string，用 `startsWith('/api/')` 判断，与 404 handler（第 177–182 行）的既有写法保持一致。

**修复时同步更新**：

1. `app.ts` 守卫加路径判断；
2. `smoke-server.ts` 补用例：远端（模拟 Tailscale 来源）`GET /` → 200 且 `content-type: text/html`；远端 `GET /api/snippets` 无 token → 401（已有）；远端 `GET /assets/*` → 200；
3. §14 契约首行改为「`/api/*` 需 Bearer；静态资源免 token」；
4. README「手机访问」补充说明首屏免 token、token 只护 API；
5. 顺手确认 `/favicon.ico` 的 404 是否可接受（favicon 不存在时静态托管返回 404，属正常，但值得在日志里认出来）。

**关联**：§11 安全模型、§14 接口契约、§18 P2 实施记录、README「安全」节。

---

### 0.3 待修缺口 ISSUE-002 ~ 004（2026-10-25 P1/P2 复验，**三条全部已修 · 2026-10-29**）

P1/P2 按 §9 的验收标准重跑了一遍：主干全部真跑通（16 条片段 / 5 组 / 0 quarantine；CLI 执行 120ms 回实例表；热更新 100ms；队列 4.5s 严格串行；手机 390×844 无横向溢出；抽屉、表单、danger 确认、choices 下拉、PWA 全部正常）。以下是没做到的，按严重度排。

#### ISSUE-002：CLI 的中文搜索基本搜不出东西（功能缺口）—— **已修 · 2026-10-29**

**状态**：已修。`store.ts` 删掉 MiniSearch，`search()` 改子串匹配 + 多词 AND（haystack = id / title / group / tags / 命令正文，全小写）；命中按 title(3) > id(2) > tags(1) > body(0.5) 排序，排序不影响「能否命中」。`minisearch` 依赖从 `packages/core` 移除并刷了 lock。新增 `packages/core/scripts/test-search.mts`（14 项）并入 `npm test`。真实片段库实测：`实例` → 6 条、`点击`/`点` → click-instance、`续杯` → cursor-refill、`壳` → open-shell、`实例表` 与 `实例 表` → check-instence、`zzz` → 空。以下为原始现场记录。

**现场**（16 条真实片段，服务在线）：

```
$ npm run snip -- search 实例      → （空）
$ npm run snip -- search 点击      → （空）
$ npm run snip -- search 点        → （空）
$ npm run snip -- search 实例控制  → click-instance / close-program / cursor-refill / focus-instance / kill-program
$ npm run snip -- search 续杯      → cursor-refill
$ npm run snip -- search 壳        → open-shell
```

能命中的只有「被空白或标点切出来的整块」：`实例控制`（恰好等于 group 全值）、`续杯`（括号前独立成块）、`壳`（空格后独立成块）。

**根因**：`packages/core/src/store.ts` 的 MiniSearch 用默认 tokenizer（只按空白与标点切），CJK 串不会进一步分词；`search()` 也没传 `prefix` / `fuzzy`。于是 `查看实例表`、`点击实例` 各是一个完整 token，查 `实例` 既不是整词也不是前缀 → 0 命中。

**为什么验收没抓到**：§17 的 P1 验收只验了 `list` / `run` / 热更新 / flag 下拉，没有一条验 `search`。而前端搜索走的是 `includes()` 子串匹配（`App.tsx` 第 107–110 行），中文完全正常（`实例` → 6 条），所以从网页看是好的，只有 CLI 侧坏。§1 把「模糊搜索」写成了卖点。

**修复方向**（三条，建议 C 为准、A 顺手带上）：

- **A**（一行改善）`this.ms.search(q, { prefix: true, fuzzy: 0.2 })` —— `实例` 能命中 `实例控制` 这类**前缀**，但 `查看实例表` 仍不中（前缀从 token 头算）。
- **B**（正确但重）自定义 tokenizer：CJK 串用 `Intl.Segmenter('zh', { granularity: 'word' })` 切词，或生成 1~2 字 n-gram，`processTerm` 保留原词。
- **C**（推荐先做）CLI/服务端搜索直接走子串匹配，与前端同语义。当前规模 16 条、目标上限几百条，`includes()` 的 O(n) 完全够；等真涨到几千条再上 B。好处是「网页搜到什么，CLI 就搜到什么」，不会出现两套语义。

**回归用例**：新增 `scripts/test-search.mts`（或并入 smoke）——`实例` 至少命中 `click-instance` / `close-program` / `focus-instance` / `check-instence`；`续杯` 命中 `cursor-refill`；`zzz` 为空；大小写与前后空格不敏感。

#### ISSUE-003：顶栏「排队 N」实际看不见（可见性缺口）—— **已修 · 2026-10-29**

**状态**：已修。`App.tsx` 两处改动：① 轮询间隔跟着运行态走（空闲 4s / 运行中 **500ms**）；② 收到 `queued` 或 `exit`/`error` 事件时立刻刷一次 health。新增 `scripts/check-queue-badge.mjs`（`npm run ui:queue`）：CDP 打开页面 → 连点两次 `check-status` → 页面内 100ms 采样 45 次 `.badge.queue`。
**实测**：连跑 3 次全部通过，首次命中均在 **+500ms**，文本 `排队 2`，抽屉同时有 `⏳ 队列等待`（改前 45 次采样 0 命中）。
**两个反直觉的点**（下次改这里先看）：
1. `queued` 事件是在**等待结束**时才 yield 的（它要带 `waitedMs`），所以它不是「徽标亮起」的时机，只能用来收尾刷新；真正的触发是 500ms 采样。
2. 采样间隔不能用 1s：桥被占用 0.3~1s 时 1s 采样仍可能整段漏掉（实测首次命中在 +1000ms，属于撞上）；500ms 才稳。
3. 测试片段必须是**慢的**：`check-status`（约 0.8s）能排队，`check-instence` 只 30ms，两下点完第一下早结束，断言会假失败。

**现场**：CDP 连点两次「刷新桌面状态」（单条约 0.8s，并发时第二条 `waitedMs=527`），以 100ms 间隔采样 45 次（4.5s），`.badge.queue` 出现 **0 次**；同一次运行的抽屉里能看到 `⏳ 队列等待 0.8s`。

**根因**：`App.tsx` 第 59–65 行的 health 轮询固定 4000ms，而徽标只在 `health.queue > 0` 的那一帧渲染。桥被占用通常不到 1s，4s 采样窗命中率约 20%，短命令基本必然错过。§18 写的「顶栏显示 `排队 N`」在代码上成立、在使用中拿不到。

**修复方向**（二选一，推荐后者）：

- run 进行期间（`output.running`）把轮询降到 500ms，结束恢复 4s；
- 收到 `queued` 事件时立刻 `refresh()` 一次 —— 请求更少，语义也更准（有排队就一定刷）。

**回归用例**：CDP 脚本连发两条 `check-status`，断言 `.badge.queue` 至少出现一次且文本匹配 `/排队 \d+/`；同时断言抽屉里出现 `⏳ 队列等待`（这条已通过，防回退）。

#### ISSUE-004：`npm test` 因清理失败而红（测试洁癖，环境相关）—— **已修 · 2026-10-29**

**状态**：已修。fixture 改 `mkdtempSync(join(tmpdir(),'snipdeck-smoke-'))`（开场那句 `rmSync` 随之删除），收尾改 `tryRemove()`——`rmSync` 包 try/catch，失败只 `console.warn` 并打印可手动删除的路径，**不碰 `process.exitCode`**。`test:cmd` / `test:queue` 复核后确认无删除目录的动作，无需改。回归兜底 = `npm test` 本身（`结果: 28 通过, 0 失败` + 退出码 0，连跑两遍无残留）。另清掉了旧代码留在 `data/tmp/smoke` 的一次性 fixture。

**现场**：28 项冒烟断言全 ✓，进程随后挂在 `packages/server/scripts/smoke-server.ts:241`：

```
Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
  {"count":6,"scope":"turn","targets":["D:\\试炼之地\\remote text control\\data\\tmp\\smoke"]}
    at checkBulkDeleteGuard (...node-safe-delete-shim.cjs:243:19)
```

`rmSync(FIXTURE, { recursive: true, force: true })` 被宿主注入的 safe-delete shim 拦下，整体退出码 1。

**性质**：环境相关（本机 Node 被 `NODE_OPTIONS` 注入保护 shim），不是产品缺陷。但后果和缺陷一样——测试红，`npm test` 不能当门禁。清理是测试的收尾动作，不该决定成败。

**修复方向**：`rmSync` 包 try/catch，失败只 `console.warn` 不改 `process.exitCode`；`test:cmd` / `test:queue` 里清临时目录的地方同理。顺带在 smoke 里把 fixture 目录改成 `mkdtemp` 到系统临时目录，绕开项目内 `data/tmp`（避免和真实 run 的临时 .cmd 混在一起）。

**回归用例**：带 shim 的环境跑 `npm test`，断言最后一行是 `结果: 28 通过, 0 失败` 且退出码 0。

---

### 0.4 修复计划（2026-10-29，**四条全部已修**）

四条 issue 按「先让门禁可信 → 再修阻塞项 → 最后修体验缺口」排。每条都带：改哪、怎么改、怎么验、有什么坑。

| 序 | Issue | 性质 | 改动面 | 验收 | 状态 |
|---|---|---|---|---|---|
| 1 | ISSUE-004 | 测试环境 | `smoke-server.ts` 一处 | `npm test` 退出码 0 | **已修 10-29** |
| 2 | ISSUE-001 | 功能阻塞（手机全废） | `app.ts` 守卫 3 行 + 冒烟 5 条 | 远端 `GET /` → 200 HTML | **已修 10-29** |
| 3 | ISSUE-002 | 功能缺口（CLI 搜不到） | `store.ts` 重写 `search()` + 新测试 | `test:search` 14 项全过 | **已修 10-29** |
| 4 | ISSUE-003 | 可见性缺口 | `App.tsx` 轮询策略 + CDP 脚本 | `.badge.queue` 至少出现 1 次 | **已修 10-29** |

先做 004 的理由：它不是产品缺陷，但**现在任何修复都验不干净**——断言全绿、退出码 1，等于没有门禁。先 20 分钟把它变绿，后面三条的验证才站得住。

#### 计划 1 · ISSUE-004（测试清理别决定成败）—— **已修 · 2026-10-29**

**落地**：改法与下面写的一字不差。跑完 `npm test` → `结果: 28 通过, 0 失败`，退出码 0；连跑两遍系统 temp 无 `snipdeck-smoke-*` 残留。


**根因复核**：`smoke-server.ts:22` 与 `:241` 各有一处 `rmSync(FIXTURE, {recursive:true, force:true})`。首次跑时目录为空（count=0，shim 放行），收尾时目录里有 6 个文件 → 触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。`test:cmd` / `test:queue` 不删任何目录，不受影响。

**改法**

1. `FIXTURE` 改 `mkdtempSync(join(tmpdir(), 'snipdeck-smoke-'))`：目录天然干净，**开头的 `rmSync` 整行删掉**（也顺带不与 `data/tmp` 里真实 `run-*.cmd` 混放）。
2. 收尾改成容错函数，**不许动 `process.exitCode`**：
   ```ts
   function tryRemove(p: string): void {
     try { rmSync(p, { recursive: true, force: true }) }
     catch (e) { console.warn('  ~ 清理失败（忽略）：', e instanceof Error ? e.message : e) }
   }
   ```
   若连 warn 都嫌吵，可退一步：先逐个 `unlinkSync` 再 `rmdirSync`，单文件删除不触发 bulk 守卫。
3. 结果行保持在最后：`结果: 28 通过, 0 失败`，`process.exit(fail > 0 ? 1 : 0)` 不动。

**验收**：带宿主 shim 跑 `npm test`，最后一行是 `结果: 28 通过, 0 失败` 且 `echo $?` 为 0；再跑第二遍同样绿（复用同机不残留）。

**文档**：§16 「测试」行补一句「临时 fixture 落系统 temp，清理失败只 warn」。

#### 计划 2 · ISSUE-001（token 守卫按路径分流）—— **已修 · 2026-10-29**

**落地**：改法与下面一致，另把 `notFound` 也做了扩展名判断（原计划把它列为可选，实测值得做——`/favicon.ico` 之前会拿到 200 + 一段 HTML）。冒烟补了 5 条而非 4 条（多一条 SPA 回退）。Tailscale 地址实测通过（7879 临时实例，验完已关）。

**改法**（`packages/server/src/app.ts` 第 63–68 行）

```ts
app.addHook('onRequest', async (req, reply) => {
  if (!token || isLoopback(req.ip)) return
  // 静态壳（/、/assets/*、manifest、sw.js、favicon）免 token：
  // 它们不含任何数据，数据全在 /api 后面。挡住首屏 = 手机没有入口填 token。
  if (!req.url.startsWith('/api/')) return
  const auth = req.headers.authorization ?? ''
  if (auth === `Bearer ${token}`) return
  return reply.code(401).send({ error: 'unauthorized' })
})
```

- 用 `req.url.startsWith('/api/')`，与 177–182 行的 404 handler 同写法（带 query 也命中）。
- 顺带修「favicon 被 SPA 回退成 HTML」：notFound handler 里先判 `/api/` → JSON 404；再判**末段带扩展名**（`/\.[a-z0-9]+$/i`）→ 404 纯文本；其余才 `sendFile('index.html')`。这样 `/favicon.ico` 是真 404，浏览器不会拿一坨 HTML 当图标。

**冒烟新增**（`smoke-server.ts`，远端地址 `100.64.0.9`，`webDist` 不存在时整组跳过并打 `~`）

| 断言 | 期望 |
|---|---|
| 远端 `GET /` | 200 且 `content-type` 含 `text/html` |
| 远端 `GET /assets/<从 dist/assets 实读的第一个文件名>` | 200 |
| 远端 `GET /api/snippets` 无 token | 401（已有，防回退） |
| 远端 `GET /favicon.ico` | 404（做了扩展名判断之后） |

**同步改**：§14 首行改「`/api/*` 需 `Authorization: Bearer`；静态资源免 token」；§11 加一句「静态壳放行是最小暴露：暴露的只有空 UI」；README「手机访问」写清「首屏免 token，token 只护 API」。

**坑 / 待记**

- `isLoopback` 免 token 在将来 `tailscale serve` 反代下会变成**全豁免**（代理源是 127.0.0.1），token 等于关闭。现在不动，但 §12 待定项 1 要附这条：上 HTTPS 那天，前盾必须改成「反代传 `X-Forwarded-For` + 关 loopback 豁免」或改走身份头。
- 别把 `webDist` 判断顺序弄反：`fastifyStatic` 仍在路由之后注册，hook 只管准入。

#### 计划 3 · ISSUE-002（搜索改成与前端同语义的子串匹配）—— **已修 · 2026-10-29**

**落地**：按下面执行。两处偏差：
1. 测试写了 **14 项**而非 6 项——顺手把「分组名可搜」「标签可搜」「命令正文可搜」「多词无交集为空」「单字可搜」也钉住了。
2. `实例` 的期望集合包含 `close-program`：它在「实例控制」分组里，分组名属于搜索面（与前端 `${id} ${title} ${group} ${tags}` 同源），不是误命中。第一版断言把它当噪声，跑红了才想明白。

**改法**（`packages/core/src/store.ts`）

1. 删掉 `MiniSearch`（`ms` 字段、两处 `new MiniSearch`、`addAll`）与 `packages/core/package.json` 的 `minisearch` 依赖，`npm install` 刷 lock。
2. `search(q)` 重写：

```ts
search(q: string): Snippet[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return this.list()
  const terms = needle.split(/\s+/)
  return this.list()
    .map((s) => ({ s, hay: haystack(s), score: 0 }))     // hay = id + title + group + tags + body
    .filter(({ s }) => terms.every((t) => haystack(s).includes(t)))
    .map((x) => ({ ...x, score: scoreOf(x.s, terms) }))  // title 3 / id 2 / tags 1 / body 0.5
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s)
}
```

- 多词按 **AND**（`实例 表` 只出 `check-instence`），与「子串 + 全词命中」的直觉一致，也和前端单串 `includes` 不冲突（前端是单串，暂不加词拆分——两边差异只多一点宽松）。
- 顺手把 `haystack()` 提成 `store.ts` 里的模块级函数，供测试直接引用，避免测试再抄一份。

**新增测试** `packages/core/scripts/test-search.mts` + `npm run test:search`，并串进根 `test`。

- fixture 用 `mkdtempSync` 写 6 条（`click-instance/点击实例`、`check-instence/查看实例表`、`focus-instance`、`close-program`、`cursor-refill/续杯`、`open-shell`）。
- 断言：`实例` → ≥4 条且含 click-instance / check-instence / focus-instance；`续杯` → cursor-refill；`实例 表` → 只有 check-instence；` 实例 `（前后空格）与 `实例` 同集；`CLICK` → click-instance；`zzz` → 空。

**文档**：§7 技术选型 `minisearch` 行改「内存子串匹配（含 CJK，零依赖）」；§0.3 该条标已修。

**为什么不做 CJK 分词（B 方案）**：当前 16 条、目标上限几百条，子串 O(n) 是几十微秒；分词要背 `Intl.Segmenter` 的分词差异，还得分词后重建索引。等真到几千条再上。

#### 计划 4 · ISSUE-003（队列徽标：事件驱动 + 运行期加密采样）—— **已修 · 2026-10-29**

**落地偏差**（三条都和「以为」不一样，记下来省下次时间）：

1. 运行期间隔用 **500ms** 而非 1000ms：1s 采样对 0.3~1s 的占用窗口仍可能整段漏采（实测首次命中落在 +1000ms，纯靠运气）。
2. `queued` 事件不是「开始排队」的时机——`serialized()` 里它是 `await prev` **之后**才 yield 的（要带 `waitedMs`）。所以它只能用来收尾刷新，主路径是 500ms 采样。
3. 连点间隔从 60ms 改成**同一 tick 连发两下**，且片段换成慢的 `check-status`：`check-instence` 只要 30ms，第一下早就跑完了，排不上队 → 断言假失败（第一次跑就是这么红的）。

**改法**（`packages/web/src/App.tsx`）

1. `doRun` 的 `onEvent` 里，`case 'queued'` 追加 `void api.health().then(setHealth).catch(() => undefined)`。**这是主路径**：有 `queued` 事件 ⇒ 此刻服务端 `queue > 0`，一刷必中。
2. 轮询改成可变间隔：把现有 4s `setInterval` 换成依赖 `output?.running` 的 effect——运行时 `1000ms`、空闲 `4000ms`，run 结束时立刻 `refresh()` 一次（收尾也要把徽标清回去）。
3. 不改服务端：`/api/health` 已有 30s TTL + 单飞去重，密采样不会打桥。

**回归脚本** `scripts/check-queue-badge.mjs`（复用 `ui-shot.mjs` 的 CDP 套路，`npm run ui:queue`）

- 打开页面 → 以 60ms 间隔连点两条走桥片段 → 100ms 采样 `.badge.queue` 共 45 次；
- 断言出现 ≥1 次且文本匹配 `/排队 \d+/`，同时断言抽屉里有 `⏳ 队列等待`；
- 依赖「服务在线 + listener 在线 + 有两条走桥片段」，所以**不进 `npm test`**，单独手动跑，结论抄进 §18。

**已知上限**：若第二条命令在 `queued` 事件发出前就被判定为无需等待（`waitedMs < 50`），徽标仍不出现——那说明压根没排队，属正确行为。

#### 修复顺序与验收总表

1. 004 → `npm test` 退出码 0（28 通过）。
2. 001 → `npm test`（28 + 4 通过）；手机走 Tailscale 打开 `http://100.x:7878` 看到页面 + 顶部「去填写」横幅；填 token 后片段可点。
3. 002 → `npm run test:search` 全绿；`npm run snip -- search 实例` 出 4 条以上。
4. 003 → `npm run ui:queue` 断言通过；顶栏能看到 `排队 N`。
5. 收尾：`npm test` 整体再跑一遍；§14/§16/README/§0.x 状态同步；Changelog 记 v0.9。

> 本次只动这四条，不动 §0.1 的「已知缺口」（`runs/*.jsonl`、片段 CRUD、`targets[]`、配对二维码、service worker 离线）——那些是 P2 前/P3/P4 的排期，不是 bug。

---

### 0.5 待修缺口 ISSUE-005 ~ 008（2026-10-29 P2.5/P3 复验，**四条全部已修 · 2026-10-29**）

复验口径：`npm test` 46/46 + `npm run ui:multi` 20 条断言全过；下面四条都是断言没覆盖到的地方，用 CDP 补测出来的。所有数据均为 `Emulation.setDeviceMetricsOverride` 真仿真（非窗口缩放），服务 `127.0.0.1:7878`、listener 在线。

> **撤回一条误报**：上一轮报告里的「`/` 快捷键在 ≤1023 失效」不成立。当时用 `document.querySelector('[data-search]')` 手写模拟，命中了左栏里 `display:none` 的那个；实际代码 `App.tsx:261–289` 用的是 `querySelectorAll(...).find(el => el.offsetParent !== null)`。用 CDP `Input.dispatchKeyEvent` 发真实按键复测：390 与 768 聚焦到 `.searchbar` 输入框（placeholder「搜索片段（id / 标题 / 分组 / 标签）…」）、1366 聚焦到 `.sidebar` 输入框（「搜索（/）」），三档全部正确。**这条不要修，也不要再入库。**

#### ISSUE-005：手机多目标时抽屉头部折成两行（视觉）—— **已修 · 2026-10-29**

**现场**：390×844，⊕ 连点一次跑双目标：

| 元素 | 尺寸 | 文本行数 |
|---|---|---|
| `.drawer-id`（`check-instence`） | 97×42 | **2**（`check-` / `instence`） |
| `.drawer-status`（`2/2 成功 · 49ms`） | 77×38 | **2** |
| `.drawer-head` | 高 63 | 对照：390 单目标 55、桌面 48 |

截图 `data/tmp/ui-multi-390.png` 可直接看到 `check-` / `instence` 断开。

**根因**：`.drawer-head` 是 `display:flex`（`styles.css:521`），`.drawer-id`（`:530–533`）与 `.drawer-status`（`:535–539`）既没 `white-space:nowrap` 也没 `min-width:0`/`flex-shrink:0`。四个子元素（id / status / `2 目标` 徽章 / 三个图标）在 390 宽下溢出，flex 默认收缩把 id 压到 97px，文本就在连字符处折行。桌面 720 宽不触发，所以 CDP 桌面验收看不出来。

**影响**：只在「手机 + 多目标」出现；头部高度抖动 8px，标题被切成两段读着别扭。

**修复方向**（三行 CSS）：

```css
.drawer-id { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.drawer-status, .drawer-count, .drawer-tools { flex-shrink: 0; }
```

让 `<1s` 与目标数永远单行，id 优先让位（省略号），而不是整块换行。

**回归用例**：390 双目标下断言 `.drawer-id` 的 Range 文本行数 === 1、`.drawer-head` 高度 ≤ 50、`idText` 仍以 `check-` 开头（省略号只截显示，不改文本）。

#### ISSUE-006：并列两列时输出右侧被切 56px（阅读体验）—— **已修 · 2026-10-29**

**现场**（1366×768，双目标 `check-instence`）：

| | 抽屉宽 | 每块 pane `.drawer-body` |
|---|---|---|
| 双目标 | 1100 | `clientWidth 549` / `scrollWidth 605` → **每行右侧切 56px** |
| 单目标（1920） | 720 | `718 / 718` → 不切 |

被切掉的正是行尾：`…WorkBuddy.exe\|workbuddy\|2026-10-29 18:35:` 之后的时间秒数与末尾竖线看不到，必须各自横向滚动。截图 `data/tmp/ui-multi-1366.png` 里两块 pane 底部各有一条横向滚动条。

**根因**：多目标抽屉宽 `min(1100px, 88vw)`（`styles.css:904`），双列时每块 `1100/2 - 14*2 padding ≈ 549`；而 `ahk.bat instances` 的单行在 13.5px 等宽下实测 605px。**差 56px ≈ 7 个半角字符**，正好是时间戳尾巴。

**影响**：并列的核心价值是「一眼对比两份结果」，但两份都看不全行尾时，对比退化成「两边一起滚」。

**修复方向**（先动布局、别动字号）：

抽屉宽度按内容需求给足 —— 双列要 `605*2 + 28*2 + 4 ≈ 1266`，取整 1320：

```css
.drawer.multi { width: min(1320px, calc(100vw - 48px)); }
```

- 1366 → `calc(100vw - 48px)` = 1318，每块 631 > 605 ✓
- 1920 → `min(1320, 1872)` = 1320，每块 632 > 605 ✓
- 三列是物理上限：`605*3 + 84 = 1899 > 1366`，**3 列必然横滚**，这条写进已知缺口，不要试图用降字号掩盖（要降到 ~11px 才够，那就不能读了）。

备选（不推荐）：`.panes.multi .drawer-body { font-size: 12px }` 能省 11%，但 1920 大屏上 12px 输出偏小，且与单目标态不一致。

**回归用例**：1366 与 1920 双目标跑 `check-instence`，断言每块 `.drawer-body` 的 `scrollWidth <= clientWidth`（即无横向滚动）；同时断言页面 `scrollWidth <= innerWidth`（别为了放宽抽屉把整页撑出横向滚动条）；390 仍堆叠单列且抽屉宽 390。

#### ISSUE-007：超过 8 个目标时不拦截，且错误裸露 JSON（体验崩）—— **已修 · 2026-10-29**

**现场**：1366，⊕ 打开后连点 `win-desktop` 8 次（预选 1 + 点击 8 = 9 个 chip），点执行：

```
chips: 9
抽屉: 打开
panes: 9
状态: 0/9 成功 · 0ms
每块 pane 内容: ! ERROR ApiError: {"error":"targets 最多 8 个"}
```

一个都没跑，却开了 9 块空面板、把同一句错误重复 9 遍、状态栏还写成「0/9 成功」。

**根因**（两处，互相独立）：

1. **前端不设防**：`App.tsx:651–661` 的 `target-btn` 只 `disabled={h.reserved}`，没有数量上限；`submitDraft()`（`:392–406`）只校验「至少一个目标」和必填变量。服务端 `MAX_TARGETS = 8`（`app.ts:45`）是唯一闸门。
2. **错误串是 HTTP 正文原文**：`api.ts:104` 是 `throw new ApiError(r.status, await r.text())` —— `message` 直接等于 `{"error":"targets 最多 8 个"}` 这段 JSON，前端 `String(e)` 又加前缀 `ApiError: `。**所有 400 都这样**（danger 未确认、未知目标、空数组、vars 非对象），不只是目标数。
3. 抽屉先开开关：`doRun`（`:345–355`）在 `await api.run(...)` 之前就 `setOutput(...)`，所以请求被拒时 9 块 pane 已经渲染出来了，catch 只能往每块里塞错误行。

**影响**：用户唯一能撞到的高频 400 就是「点多了一个目标」，而现在的表现像程序坏了。

**修复方向**（三条都做，改动都不大）：

1. `api.ts` 加一个 `parseError(status, text)`：先 `JSON.parse`，取 `.error` 作 message，解析失败退回 `text.slice(0, 200)`。`ApiError` 顺带留 `detail` 字段（原始文本）供调试。注意 `req()` 与 `api.run` 两处都要走它。
2. 前端在 `draft.targets.length >= 8` 时把 `target-btn` 变 `disabled`，并给 chips 区一句 `最多 8 个目标` 的 hint；常量与 `app.ts:45` 的 `MAX_TARGETS` 对齐（能由 `/api/hosts` 带出来更好，但先硬编码 + 注释指回服务端）。
3. 让 400 回到表单里，而不是开抽屉：`api.run` 加 `onStart` 回调（`fetch` 返回 `r.ok` 后立刻调一次），`doRun` 把 `setOutput` 挪进 `onStart`；catch 里 `status === 400` 且还没 `onStart` 时 `setFormError(message)` 并保留 draft。

**回归用例**：CDP 连点 9 次 → 第 9 个按钮 `disabled`；即便绕过 UI 直接打 API 9 目标，前端应显示表单内错误、`.drawer` 不存在、`.form-error` 文案不含 `{"error"` 与 `ApiError` 字样。另加一条冒烟：`POST /api/run` 带 9 目标 → 400 且 `body.error` 是纯文本句子。

#### ISSUE-008：桌面多开入口是「看不见但点得到」的热区（可达性）—— **已修 · 2026-10-29**

**现场**（1366，鼠标未悬停卡片）：

| 属性 | 值 |
|---|---|
| `opacity` | **0** |
| `pointer-events` | **auto** |
| 尺寸 | 22×22（卡片右上角，距边 6px） |
| `tabIndex` | **-1** |
| `aria-label` | **无**（只有 `role="button"` + `title`） |

`styles.css:203–211` 只在 `@media (hover: hover)` 里把 `opacity` 降到 0，**没关掉命中测试**。鼠标移到 22×22 区域时它会自动亮到 0.7（`.card-fan:hover`），所以「看不见」只在鼠标不在上面时成立 —— 但对触摸屏笔记本、以及「手快先按下」的场景，这 22×22 是个静默吃掉点击的坑：点它不会执行片段，而是弹目标选择器。

**影响**：误触概率不高（悬停会显形），但两个真实问题：① 隐形容器吃点击；② 键盘/读屏用户完全无法使用多开（`tabIndex=-1`、无 `aria-label`）。

**修复方向**：

1. 隐形时也关掉命中测试，显形再放行：
   ```css
   @media (hover: hover) {
     .card-fan { opacity: 0; pointer-events: none; }
     .card:hover .card-fan, .card:focus-within .card-fan { opacity: .7; pointer-events: auto; }
   }
   ```
   `@media (hover: none)`（触屏）保持常显，现状不动。
2. 键盘入口另开一条，别把 `<span role=button>` 塞进 `<button class=card>` 里抢 Tab（嵌套交互控件对读屏不友好）：选中卡片时按 `T` 打开目标选择器，与 `Enter`（执行）并列，提示写进左栏 `.nav-hint`。
3. `aria-label="选择执行目标"` 补上，`title` 保留。

**回归用例**：1366 未悬停时点卡片右上角 → 应走「执行/表单」路径而不是目标选择器（断言 `.target-btn` 不出现）；悬停后同一坐标点击 → 目标选择器出现；390（`hover: none`）未操作时 `.card-fan` 的 `opacity >= 0.7`；键盘 `T` 能打开选择器。

---

### 0.6 修复计划（2026-10-29，**四条全部已修 · 2026-10-29**）

四条全在前端（`styles.css` / `App.tsx` / `api.ts`），服务端只在 ISSUE-007 有一条可选改动。按「先摘确定性的疤 → 再碰结构 → 最后做要拍板的」排序。

| 序 | Issue | 性质 | 改动面 | 验收 | 状态 |
|---|---|---|---|---|---|
| 1 | ISSUE-005 | 视觉（手机多目标） | `styles.css` 3 行 | 390 双目标头部 1 行、高 ≤56 | **已修 10-29** |
| 2 | ISSUE-007 | 体验崩 + 错误呈现 | `api.ts` 1 函数 + `App.tsx` 3 处 | 9 目标只出表单错误、无抽屉 | **已修 10-29** |
| 3 | ISSUE-006 | 阅读体验（并列） | `styles.css:904` 1 行 + 两档实测 | 双目标 pane 无横向滚动 | **已修 10-29** |
| 4 | ISSUE-008 | 可达性 | `styles.css` hover 块 + 键盘入口 | 未悬停点不中 ⊕；`T` 可开 | **已修 10-29** |

先做 005 的理由：三行 CSS、无逻辑、当场能验，而且是每天都会看到的疤。007 排第二：影响面最大（**所有** 400 都裸 JSON），但动 `api.ts` 的错误路径与 `doRun` 的时序，要先想清楚再下笔。006 排第三：一条宽度规则，但要在 1366 / 1920 两档实测，还要接受「三列必然横滚」这个物理事实。008 排最后：不改也能用，且「`T` 键 vs 让 `⊕` 进 Tab 序列」是个交互口味问题，值得单独拍。

**落地**（四条一起做完，回归并进 `npm run ui:multi`：20 → **49 项断言**，全过）

| Issue | 落地要点 | 与计划的偏差 |
|---|---|---|
| 005 | `.drawer-id` 加 `nowrap + overflow:hidden + ellipsis + min-width:0`；`.drawer-status / .drawer-count / .drawer-tools` 加 `flex-shrink:0` | 头部高度阈值从「≤50」改「手机 ≤56 / 桌面 ≤50」——手机图标按钮本身 34px + 上下 padding，55 才是单行的正常高度（折行时是 63） |
| 006 | `.drawer.multi { width: min(1320px, calc(100vw - 48px)) }` | 无。1366 抽屉 1318、1920 抽屉 1320，两块 pane 均 `scrollWidth <= clientWidth` |
| 007 | `api.ts` 新增 `parseError()`（取 `.error`，非 JSON 退原文前 200 字）+ `ApiError.detail`；`api.run` 新增 `onStart`；`App.tsx` 常量 `MAX_TARGETS=8` + 按钮 disabled + `onClick` 二次判断 + `field-note` 提示 + 提交前拦截 + `doRun` 把 `setOutput` 挪进 `onStart`、400 回填 draft | 多改了一处：`doRun` 新增 `fromDraft` 参数，被拒时把整份 draft（含变量与目标）原样回填，而不只是报错 |
| 008 | `@media (hover:hover)` 里隐形态加 `pointer-events:none`，显形挂 `.card:hover / :focus-within`；`aria-label="选择执行目标"`；快捷键 `T`（无修饰键、非输入态、无弹窗时）+ 左栏 `.nav-hint` 补文案 | 无 |

**量出来的两个反直觉点**：

1. 「行数」不能用 `Range.getClientRects().length` 数——被 `text-overflow:ellipsis` 截断时 Chrome 会返回「可见段 + 被裁段」两个矩形，`top` 相同却是单行。要数**不同 top 的个数**。第一版断言就是这么假红的。
2) 007 的「400 回表单」从 UI **不可达**（第 9 个按钮已 disabled），所以回归脚本用 `page.evaluate` 把 `window.fetch` 对 `/api/run` 桩成 400，再走真实提交流程——断言 `.drawer` 不存在、`.form-error` 恰好是 `targets 最多 8 个`、无 `{"error"` 与 `ApiError` 前缀。

#### 计划 1 · ISSUE-005（抽屉头部不许换行）

**改哪**：`packages/web/src/styles.css`，`.drawer-id`（:530–533）与 `.drawer-status`（:535–539）附近。

**怎么改**：

```css
.drawer-id {
  font-weight: 600;
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;          /* 允许被压缩，配合 ellipsis 而不是折行 */
}

.drawer-status,
.drawer-count,
.drawer-tools {
  flex-shrink: 0;        /* 状态、目标数、按钮组不吃压缩 */
}
```

**怎么验**：390×844 双目标 → `.drawer-id` 用 `Range` 数文本行数 === 1；`.drawer-head` 高度 ≤ 50；`idText` 仍是完整 `check-instence`（省略号只截视觉）。顺带量一次 390 单目标（现 55px）：头部只比桌面 48px 高 7px，属 padding 差异，改完不应变化——若也降了，说明单目标本来就有一处隐性折行，记下来。

**坑**：`text-overflow: ellipsis` 要 `overflow: hidden` + `min-width: 0` 同时在场才生效——只加前两个、flex 项不给 `min-width:0` 时浏览器仍按内容撑开，看起来「没效果」。

#### 计划 2 · ISSUE-007（错误要说人话，上限要当场拦）

**改哪**：`packages/web/src/api.ts`（:104 与 `run` 的 `if (!r.ok)` 分支）、`packages/web/src/App.tsx`（`:345` `doRun` 开头、`:392` `submitDraft`、`:651` `target-btn`）。

**怎么改**（三条独立的，按这个顺序落地）：

1. **解析错误体**（`api.ts`）：
   ```ts
   function parseError(status: number, text: string): ApiError {
     let message = text.slice(0, 200)
     try { const j = JSON.parse(text); if (j && typeof j.error === 'string') message = j.error } catch { /* 不是 JSON 就用原文 */ }
     return new ApiError(status, message, text)
   }
   ```
   `ApiError` 加第三参 `detail`（原始文本，只给 console/debug 看）。`req()` 与 `api.run()` 两处都改成调它。

2. **前端拦住第 9 个**（`App.tsx`）：
   - 常量 `const MAX_TARGETS = 8 // 与 packages/server/src/app.ts 的 MAX_TARGETS 对齐`
   - `target-btn` 的 `disabled` 加 `|| draft.targets.length >= MAX_TARGETS`
   - chips 区在满额时显示一句 `最多 8 个目标`

3. **400 别开抽屉**（`api.ts` + `App.tsx`）：
   - `api.run(id, vars, confirmed, targets, onEvent, onStart?)`：`fetch` 后 `if (!r.ok) throw parseError(...)`，`r.ok` 为真时先 `onStart?.()`，再进读流循环。
   - `doRun` 把 `setOutput(...)` 从函数开头挪进 `onStart`；`catch` 里若 `e instanceof ApiError && e.status === 400` 且 draft 快照还在 → `setDraft(snapshot)` + `setFormError(e.message)`，**不建 pane、不开抽屉**。
   - 快照怎么传：`doRun` 增一个 `fromDraft?: Draft` 参数，`submitDraft` 传入，catch 里回填。

**怎么验**：
- CDP 连点 8 次 → 第 9 个按钮 `disabled=true`，chips 仍 8 个。
- 绕过 UI 直接打 API 9 目标（`page.evaluate` 调 `api.run`）→ `.drawer` 不存在、`.modal .form-error` 文案等于「targets 最多 8 个」、不含 `{"error"` 与 `ApiError`。
- 冒烟补一条：9 目标 → 400 且 `body.error` 是纯句子（这已经是现状，钉住即可）。

**坑**：
- `setOutput` 挪位置后，「运行中」的计时起点会晚一个 RTT（几十 ms）——可接受，但要顺手确认 `startedAt` 也一起搬，否则计时会算进网络延迟。
- `danger` 片段二次确认 + 400 同时发生时，draft 快照可能为 `null`（确认弹窗路径）——回填逻辑要允许 `null`，只做 `setFormError`。

#### 计划 3 · ISSUE-006（并列时把抽屉给够宽）

**改哪**：`packages/web/src/styles.css:904` `.drawer.multi` 的宽度。

**怎么改**：

```css
.drawer.multi {
  width: min(1320px, calc(100vw - 48px));
}
```

依据：双列要放下一行 605px 的输出 → `605*2 + 14*2*2 + 4 = 1266`，取 1320 留余量。1366 上等于 1318（每块 631）、1920 上 1320（每块 632），都不再横滚。

**怎么验**：1366 与 1920 双目标 `check-instence` → 每块 `.drawer-body` 的 `scrollWidth <= clientWidth`；页面 `scrollWidth <= innerWidth`（放宽抽屉不能把整页撑出横向滚动）；390 仍是单列 390 宽、抽屉贴底。

**坑 / 要接受的**：三列（4~8 目标）必然横滚——`605*3 + 84 = 1899`，1366 屏物理放不下。**不要用降字号去凑**：降到 11px 才够，那时输出已经不能读了。把「3 列 + 长行 = 横滚」写进 §21 已知缺口，并在 `--cols >= 3` 时给 pane 头部一个「⤢」提示？——不做，够用了。

#### 计划 4 · ISSUE-008（多开入口：要么能看见，要么点不到）

**改哪**：`packages/web/src/styles.css:203–211` 的 `@media (hover: hover)` 块；`App.tsx` 卡片与快捷键两处（若要键盘入口）。

**怎么改**：

1. 隐形时关命中测试，显形再放行：
   ```css
   @media (hover: hover) {
     .card-fan { opacity: 0; pointer-events: none; }
     .card:hover .card-fan,
     .card:focus-within .card-fan { opacity: .7; pointer-events: auto; }
   }
   ```
   `@media (hover: none)`（手机/平板触摸）现状已是常显，不动。
2. 键盘入口：`App.tsx` 的 keydown（:286 附近，`/` 那条旁边）加 `if (e.key === 't' && !typing && flat[active]) openSnippet(flat[active]!, false, true)`，左栏 `.nav-hint` 补「T 选目标」。
3. 补 `aria-label="选择执行目标"`；`title` 保留。

**怎么验**：1366 未悬停，用 `Input.dispatchMouseEvent` 点卡片右上角 (right-6-11, top+17) → 断言 `.target-btn` **不**出现、走的是执行路径；悬停同一坐标再点 → 选择器出现；390 未悬停读 `getComputedStyle('.card-fan').opacity >= 0.7`；键盘 `T` 在选择卡片后能开选择器。

**坑**：`pointer-events: none` 时 `.card-fan:hover` 永不触发（没有命中就没有 hover），所以显形必须挂在 `.card:hover` 上，不能只靠自身 hover —— 现在的 CSS 两者都有，改完只留 `.card:hover` 那条才有意义。

#### 文档同步清单

**本轮已做**（只登记，不涉及代码）：

- §9 路线图 P2.5 / P3 行已标「复验遗留 ISSUE-00x 见 §0.5，修完再标『稳定』」。
- §20 已知缺口末尾已挂 §0.5 指针；§21 已知缺口已补「两列右裁 56px / 三列必然横滚」与「超 8 目标不拦」两条。

**修完后已同步（2026-10-29）**：

- §9：P2.5 与 P3 两行从「复验遗留…」改为「**已稳定**」，并写明回归入口 `npm run ui:multi`。
- §21：两列右裁那条划线标已修（附新宽度与「1366 每块 631 > 605」的算式），「三列必然横滚」保留为取舍。
- `scripts/check-multi-target.mjs`：断言 20 → 49，新增 005（id 单行 / 头部高度，手机档阈值 56）、006（两档 pane 无横滚，1920 也跑一趟）、007（8 上限 / 满额 disabled / `field-note` / 桩 400 的呈现）、008（未悬停不可点 / 悬停显形 / `T` 键 / 触屏常显）。**注意**：脚本里「行数」用不同 `top` 计数，不是 `getClientRects().length`（ellipsis 会给两个矩形）。

**还没做（留给下一轮）**：

- §20 验收表补「多目标 / 手机」一列（现在只有 1920 / 1366 / 390 单目标），并把「中英混排仍对不齐」写成带条件的事实：本机无 CJK 等宽字体时 4 个汉字比 4 个 ASCII 宽约 22px，装了 Sarasa Mono SC / Noto Sans Mono CJK 即自愈。
- Changelog 版本号：本文件当前停在 v0.9（§0.2–§0.4 那轮）；P2.5/P3/§0.5 这一轮的记录散在 §20/§21，尚未归并成 v1.x 条目——**下次动文档时一起补**。

---

## 1. 为什么不用 Termius

| 维度   | Termius 现状         | 我们要的                        |
| ---- | ------------------ | --------------------------- |
| 片段组织 | 分组+标签，拖拽排序勉强，跨组搜索弱 | 目录即分组、模糊搜索、`meta` 任意字段      |
| 片段复用 | 只能粘进当前会话           | 变量渲染 + 一键执行 + 输出归档          |
| 数据归属 | 存在它云端，导出困难         | 本地 YAML 文件，拷走即迁移，git 可 diff |
| 执行能力 | 只会发 shell 命令       | 还能驱动桌面 GUI（走 ahk.bat）       |
| 多目标  | 需要手工各连一遍           | 一条片段投多台，收并列结果（P3 已做「同目标多开」与并列面板；跨机要等 P5 的 ssh）           |
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

本期 `steps` 动词三种：

| `do`     | 含义                | 关键参数                                  |
| -------- | ----------------- | ------------------------------------- |
| `run`    | 无头执行，收输出与退出码      | `cmd`, `timeout`, `optional`          |
| `sleep`  | 等待                | `ms`                                  |
| `expect` | 对文本做正则断言（不执行命令）   | `match`, `from`, `flags`, `timeout`, `interval`, `optional` |

（`insert` / `send` 留给 P5 的交互会话。）

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


### 6.3 多目标（P3 已实现，跨机并列留到 P5）

`POST /api/run` 接受 `targets: ["win-desktop", "win-desktop"]`：

- **同一目标允许重复**：那是单机唯一能表达「多开」的方式，数组顺序 = 结果并列顺序；
- **校验全在开流前**：空数组 / 非数组 / 未知目标 / 任一 `reserved` → `400`，整条拒绝（不做「跳过并标注」，因为一次请求只返回一条 SSE 流，半个成功最难解释）；
- **事件逐条打标**：`{ ...event, target, targetIndex }`，前端按 `targetIndex` 分流到各自面板；
- **并发拉起、串行执行**：服务端 `Promise.all` 同时启动 N 个 `runSnippet`，但它们共用同一个 `ExecDriver`（按 `bridgeRoot` 缓存）→ 全局串行队列，实际严格一个接一个。**P5 接 ssh 后这段不用改就是真并发**；
- **上限 8 个**（`MAX_TARGETS`）：只是防呆，不是产品限制。

> **P3 只做「同目标多开」**：数据模型、目标选择器、reserved 置灰、事件打标、结果并列都落地了，但可执行目标仍然只有 `win-desktop`，所以实际是「同一条片段在这台机器上排队跑 N 次」。真正的跨机并行要等 P5 的 ssh —— 见 §9 的执行顺序说明。

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
| **P2** Web 界面 | 片段面板 + 变量表单 + 运行抽屉 + 输出查看 + 队列可视化 + 手机布局 + PWA                                     | ✅ 2026-10-24 完成：手机 390×844 仿真下点卡片出表单（4 字段）、点只读片段出抽屉（7 行、完成 0.1s）；队列显示「排队 N / 等待 Xs」。记录见 §18 |
| **P2.5** 电脑端 UI | 桌面布局（左侧分组栏 + 多列网格 + 内容宽上限）；抽屉改**右侧全高面板**；输出区字体与排版重做（CJK 等宽栈、不折行、管道表对齐）；桌面快捷键 | ✅ 2026-10-29 完成：CDP 实测 1920/1366 无横向溢出、4 列、标题 nowrap、抽屉 720×全高（`top:0`）、`white-space:pre`；390 手机态不退化（单列、底部抽屉）。实施与偏差见 §20。**已稳定**：复验遗留 ISSUE-005（390 多目标头部折行）已修，回归见 §0.5 / `npm run ui:multi` |
| **P3** 多目标（数据结构） | `targets[]` 数组 + 目标选择器 + reserved 置灰 + **同目标多开**（串行、结果并列、事件按目标打标） | ✅ 2026-10-29 完成：选 2 个 `win-desktop` 得到两块并列面板（`win-desktop #1/#2`），事件带 `target`/`targetIndex` 且严格串行（冒烟实测总耗时 4.4s ≈ 单条 ×2）；`home-win` / `vps` 灰显、开流前 400。实施与偏差见 §21。**已稳定**：复验遗留 ISSUE-006 / 007 / 008 均已修（宽度 / 上限与错误呈现 / 可达性），回归见 §0.5。**跨机并列不在本期**，见 P5 |
| **P4** 打磨（**已完成 10-30**） | `expect` 条件步；从 shell 历史导入；运行历史落盘（`runs/<id>.jsonl`）+ `/api/runs` + 抽屉回放。*secret 变量 / danger 二次确认 / bridge 预览已在 P1–P2 落地* | 新机器上 30 分钟导入历史并跑通一条；`expect` 超时判失败；断开 SSE 后仍能回看上次运行。**实测见 §22** |
| **P5** 驱动扩展   | local（PTY）+ ssh（ssh2）；`insert` / `send` 动词；xterm 终端页；**跨机并列（原 P3 验收：win-desktop + vps 同时投）** | 一条片段投两台真机、收并列结果；reserved 目标变可执行 |

执行顺序调整为 **P4 → P3 → P5**：P3 的卖点是「一条片段投多台」，但第二台可达主机只能靠 ssh（P5）——`home-win` 的 `local` 驱动是同一台机器，激活它也不产生「多台」。所以先做不依赖新驱动的 P4 打磨；P3 缩到数据模型 + 同目标多开（只有一个可选项时，选择器做了也看不出效果，等 P5 临近再补）；跨机并列的验收整条挪进 P5。P2.5 已于 10-29 完成，排在这两者之前。

> **实际执行**：P2.5 之后先做了 P3（10-29 完成，见 §21），随后回补 §0.5 的四条问题（§0.6），P4 于 10-30 完成（见 §22）。P3 做完仍只有 `win-desktop` 一个可执行目标，选择器的价值确实要等 P5 才完全兑现——这段时间它最大的用处是「同一条命令连跑两次做对照」（比如点下坐标前后各看一次实例表）。

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
- **审计**：`runs/<runId>.jsonl` 记录谁在什么设备上跑了什么片段、退出码多少（P4 已实现）。**secret 变量的实际值不落盘**：落盘时逐字面量抹成 `***`，`meta.vars` 只留键名（< 4 字的短值不抹，防误伤正常输出——短 secret 应重设）。档案本身**不设 token 之外的保护**，分享前先看一遍。
- **单用户假设**：多用户、权限分级不在本期范围，硬要加会让鉴权和片段隔离复杂度翻三倍。

---

## 12. 待定项

已定：代号 `SnipDeck` / 「片段坞」；端口 `7878`（避开 TxtTunnel 的 8787）；`data/tmp` 保留 7 天；danger 片段必须二次确认且默认展示预览。

仍待定：

1. 是否用 `tailscale serve` 上 HTTPS。能顺带拿到 Tailscale 身份头、省掉手填 token，但多一层要维护的反向代理；当前是「Tailscale 网络边界 + `SNIP_TOKEN`」。
   > **上这个之前必须先改鉴权**：反代把请求从 `127.0.0.1` 转进来，`isLoopback(req.ip)` 会放行**全部** `/api/*`，token 等于被关掉。届时要么让反代透传 `X-Forwarded-For` 并关掉 loopback 豁免（`trustProxy` + 只信反代来源），要么改成校验 Tailscale 身份头。现在不动，只留记号。
2. 配对二维码（照搬 TxtTunnel）何时做。现在手机首次访问要手动粘贴 token 到 localStorage。
3. Powershell 包 snippet 的处理：`Invoke-AhkLnk` 归一成 `ahk.bat lnk`，还是 exec 驱动支持 dot-source `ahk.ps1` 后调函数。归一更简单，但会丢掉 PS 包的会话级变量。
4. ~~`runs/<runId>.jsonl` 与 `targets[]` 谁先做~~ → **已定**：`runs/*.jsonl` 归 P4（排障体验优先），`targets[]` 归 P3（数据结构），跨机并列随 P5 的 ssh 一起验收。

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

- **`/api/*`**：来源是 loopback 免 token；其余一律 `Authorization: Bearer $SNIP_TOKEN`，否则 401。
- **静态壳**（`/`、`/assets/*`、`/manifest.webmanifest`、`/sw.js`、图标）：**一律免 token**。它们自身不含任何数据，数据全在 `/api` 后面；若连首屏也挡，手机就拿不到 ⚙ 去填 token，形成死锁（ISSUE-001）。带扩展名但文件不存在的路径返回 404 文本，不回退 `index.html`（否则 `/favicon.ico` 会拿到 200 + HTML）；不带扩展名的路径回退 `index.html` 供前端路由。

| 方法 | 路径 | 入参 | 出参 / 语义 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok,bridgeUp,queue,snippets,quarantined}`；`bridgeUp` 有 30s 缓存与单飞去重 |
| GET | `/api/snippets` | — | `SnippetView[]`（**不含**服务器文件路径） |
| GET | `/api/snippets/:id` | — | `SnippetView`；不存在 404 |
| POST | `/api/snippets/:id/preview` | `{vars}` | `{cmds,pending,missing,redacted}`；secret 渲染为 `***`；未填变量保留 `{{x}}` |
| GET | `/api/hosts` | — | `{name,driver,reserved,default}[]` |
| POST | `/api/run` | `{id,vars?,targets?,target?,confirm?}` | `text/event-stream`；每条事件带 `target` + `targetIndex`；首条 `start` 额外带 `runId` |
| GET | `/api/runs` | `?limit=20&snippet=<id>` | `RunListItem[]`（倒序）；每项是档案首行 `meta` + 末行 `summary` 的合并，带 `ok/durationMs/panes/eventCount` |
| GET | `/api/runs/:runId` | — | `{meta, events, summary}`；`runId` 不匹配 `^\d{8}-\d{6}-[a-z0-9]{4}$` 直接 404（不做路径拼接，不读穿目录） |

`/api/run` 的目标入参优先级：`targets[]` > `target` > 片段 `target` > hosts 的 `default`。`targets[]` 里**同一目标可以重复**（同目标多开），最多 8 个。

`/api/run` 的失败码都在**开流之前**判定：snippet 不存在 → 404；danger 未确认 / `targets` 非数组或为空 / 目标未知 / 目标 `reserved` → 400（多目标里**任一** reserved 就整条拒绝）。开流之后只剩 `error` 事件。

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
| 自启 | `powershell -File .\scripts\install-autostart.ps1`（登录时计划任务）；`-Uninstall` 卸载 |
| 配置 | 复制 `.env.example` 为 `.env`（已 gitignore） |
| 服务启动器 | `npm run sync:launchers` —— 生成 GBK 的 `%AHK_ROOT%\launchers\{hexo,txttunnel,backtrans}.bat`；`shell` 片段依赖它 |
| 测试 | `npm test` = typecheck + `test:queue` + `test:cmd` + `test:search`(14) + `test:expect`(28) + `test:import`(41) + smoke（59 项）。冒烟 fixture 落系统 temp（`mkdtemp`），跑完自动删；**清理失败只 warn，不改退出码**——本机注入的 safe-delete shim 曾让全绿的测试红掉（ISSUE-004）。静态壳免 token 的 5 条用例在 `packages/web/dist` 不存在时整组跳过并打 `~`（先 `npm run build:web`）。多目标的 5 条校验 + 4 条实跑用例用**不打桥**的 `ping -n 3` 片段，listener 离线也跑（串行断言靠事件区间不重叠 + 总耗时 ≥ 3.5s）。运行档案的 12 条用例在临时数据目录里真跑两次 run 再读盘（含 secret 不落盘）。搜索语义 `npm run test:search`；多目标 UI `npm run ui:multi`；历史回放 UI `npm run ui:history`（后两个需服务在线，不进 `npm test`） |

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SNIPDECK_HOST` | `127.0.0.1` | 非 loopback 时必须配 token，否则拒绝启动 |
| `SNIPDECK_PORT` | `7878` | 避开 TxtTunnel 的 8787，两个可同时跑 |
| `SNIP_TOKEN` | 空 | Bearer 准入 token |
| `SNIPDECK_DATA` | `data` | 数据目录 |
| `SNIPDECK_WEB_DIST` | `packages/web/dist` | 不存在则只提供 API |

> 唯一实例约束：日志用 `cmd >>` 追加（独占句柄），重复启动第二条会报「文件被占用」。这顺带防止了两个服务抢同一个 `command.txt` 队列。

## 17. P1 实施记录（2026-10-24）**迁移结果**：16 条 → 5 个分组（程序启动 3 / 状态 2 / 实例控制 5 / Shell 与服务 4 / 任务与日志 2）。`snip list` 无 quarantine，`/api/snippets` 计数 16。

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

## 18. P2 实施记录（2026-10-24）

**这一期做了什么**

| 块 | 具体 |
|---|---|
| 访问令牌 | 新设置弹窗（⚙）：粘贴 `SNIP_TOKEN` 存 localStorage；401 时顶部横幅引导；`ApiError` 带 status，不再把 HTML 塞进 JSON.parse |
| 队列可视化 | health 4s 轮询（页面隐藏时暂停），顶栏显示 `排队 N`；单次 run 收到 `queued` 事件时写「队列等待 Xs」。**顶栏徽标实测抓不到，见 ISSUE-003** |
| 运行抽屉 | 自动滚到底、复制（含 `execCommand` 兜底）、`运行中 12.3s` / `完成 1.2s` / `超时`、Esc 关闭、ANSI 清掉、2000 行上限 |
| 手机布局 | ≤640px：单列卡片、sticky 顶栏、底部抽屉 62vh、`env(safe-area-inset-bottom)`、卡片 60px 触控高度 |
| PWA | `manifest`（icon 两套 + maskable + display_override）、`sw.js`（外壳缓存、API 不缓存）、SVG 图标、apple 三个 meta；SW 只在 `isSecureContext` 注册 |

**验收实测**（CDP `Emulation.setDeviceMetricsOverride` 390×844，非窗口缩放）

- 布局：`innerWidth=390`、`topbar-right.right=378`、两个图标右边缘 336 / 378、卡片宽 366 → 无横向溢出
- 交互：点「点击实例」→ 弹窗 4 个字段（含 `*` 必填）；点「查看实例表」→ 抽屉高 256px、7 行输出、状态「完成 0.1s」
- 资源：`manifest.webmanifest` / `sw.js` / `icon.svg` / `icon-maskable.svg` 均 200 且 MIME 正确

**踩坑：无头 Chrome 的 `--window-size=390` 不是 390**
窗口最小宽度约 500，实际 `innerWidth=478`，截图却被裁成 390 —— 看起来像「右上角按钮被挤出屏幕」。改用 CDP 仿真才看到真实值。工具已沉淀为 `npm run ui:shot -- <url> <宽> <高> <out.png>`（不依赖 Playwright）。

**限制（不是缺陷）**

- SW 需要安全上下文：手机走 `http://100.x:7878` 时注册会被浏览器跳过，「加到主屏」仍可用但没有离线缓存。要完整 PWA 得走 `tailscale serve` 上 HTTPS（§12 待定项 1）。
- 队列位置目前是「长度 + 等待时长」，不是「第几位」——要精确位次得在队列里加序号，P3 多目标时一起做。
- 顶栏 `排队 N` 原来 4s 轮询配短任务基本抓不到（ISSUE-003）。**已修**：运行期采样降到 500ms，`queued` 事件另刷一次收尾；回归脚本 `npm run ui:queue`（CDP 连点两次 `check-status`，采样 45 次断言徽标出现）。

---

## 19. P2.5 电脑端 UI（设计，2026-10-25 提；已实施，见 §20）

**为什么单独一期**：P2 的验收全在 390×844 上做，桌面只是「同一条 CSS 在宽屏下摊开」——能点、能跑，但读不了。手机和桌面的差别不是尺寸，是**阅读姿势**：手机上你是站着点一下看结果，桌面上你是坐着盯一段输出找问题。

### 19.1 现状（对着代码量的，不是感觉）

| 位置 | 现在 | 桌面上的后果 |
|---|---|---|
| `.drawer` | `left:0; right:0; max-height:52vh`（styles.css:292–303） | 1920 宽屏下抽屉 1920×~450：又扁又宽，一行输出能跑 200+ 字符，读代码要横移半个屏幕 |
| `.drawer-body` | `white-space: pre-wrap; word-break: break-all`（:337–346） | `break-all` 在任意字符处断行 —— `D:\试炼之地\remote text control\...\launchers\x.bat` 被劈成两行；`ahk.bat instances` 的 `# slot\|pid\|hwnd\|exe\|pro\|ts` 管道表靠空格对齐，一断全歪 |
| 等宽栈 | `ui-monospace, Consolas, monospace`，无 CJK 成员 | 中文落到系统默认中文字体，与英文不等宽；`完成 0.1s`、中文路径、中文表头混排时列对不齐 |
| 输出字号 | 12.5px / line-height 1.5 | 桌面偏小，一段 7 行输出看着像脚注 |
| 卡片网格 | `minmax(180px, 1fr)`（:348–352） | 1920 下排到 9~10 列，每列 180px，`跑 backtrans-coach（往 shell 里）` 这种标题频繁折行 |
| 内容容器 | 无 `max-width` | 超宽屏文字拉满整行，视线回扫一次要跨 1500px |
| 输出语义 | `lines: string[]`，全拍平成纯文本 | 成功/失败/队列等待/命令回显一个颜色，靠肉眼找 `✓ exit=0` |

### 19.2 桌面布局（≥1024px）

- **左侧栏 260px 固定**：搜索框移到栏内顶部，下面是分组列表（组名 + 计数 + 折叠），点组滚动到对应区块。移动端不显示左栏（搜索框留在顶栏下方原位置）。
- **主区**：`max-width:1280px; margin:0 auto; padding:24px 28px`，卡片网格 `repeat(auto-fill, minmax(240px, 1fr)); gap:12px`。
- **卡片**：固定高 64px，标题单行 `text-overflow:ellipsis`，meta 单行（id · n 个变量 · danger）；hover 时描边 `--accent`。
- **顶栏**：50px，只留 logo、bridge / queue 徽标、刷新、⚙。搜索框从顶栏移走，桌面不再占一条纵向空间。
- **断点**：`≥1024px` 桌面态；`641–1023px` 平板（保持单栏 + 底部抽屉）；`≤640px` 手机（P2 现状不动）。

### 19.3 抽屉 → 右侧全高面板

桌面态（≥1024px）覆盖右侧，不挤压主区：

```css
.drawer {
  top: 0; bottom: 0; right: 0; left: auto;
  width: min(720px, 46vw);
  max-height: none;
  border-left: 2px solid var(--border);
  border-top: 0;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.08);
}
```

- 头部 48px：`id · 状态 · 耗时 · 退出码` 一行，右侧复制 / 关闭。状态文字用色区分：运行中 `--accent` 呼吸、完成 `--accent`、失败与超时 `--danger`。
- 正文：`padding:16px 20px; font-size:13.5px; line-height:1.55; white-space:pre; overflow:auto; tab-size:2`。
- **不折行是默认**：宁可出横向滚动条，也不让一行断成两截。头部加一个「自动换行」开关（默认关），给看长段落报错时用。
- 面板全高 → 同样的 7 行输出，桌面一屏能看 40+ 行，不用滚。
- 手机态保持底部 62vh 抽屉与 `env(safe-area-inset-bottom)`，不受影响。

### 19.4 字体与格式（这一项是重点）

**字体栈**（只用本机字体，**不加载 webfont** —— 内网离线场景 + 600KB CJK 字体不划算）：

```css
/* UI 正文：桌面 14px / 1.6 */
font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;

/* 输出与代码：带 CJK 等宽回退 */
font-family: ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas,
             "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei", monospace;
```

Cascadia Mono（Win11 自带 Terminal）/ Sarasa Mono SC 谁在就用谁，都没有时退到雅黑 —— 中文字符在等宽上下文里本来就是全宽，管道表也能对齐。**关键是别让中文掉到比例字体**。

**输出格式**（需要改数据结构：`output.lines: string[]` → `{ kind, text }[]`，现在所有事件都被拍平成纯文本了）：

| 行类型 | 来源 | 桌面呈现 |
|---|---|---|
| 命令回显 | `start.cmd` | `$ ` 前缀用 `--text-2`，命令本身等宽加粗 |
| 步骤结果 | `step` | `✓ exit=0 120ms` 成功 `--accent`，非零 `--danger` |
| 队列等待 | `queued` | `⏳ 队列等待 0.8s` 用 `--amber` |
| 普通输出 | `stdout` | 正文色 `--text`，保留原始空白与缩进 |
| 错误 | `stderr` / `error` | `[stderr]` 前缀 `--danger`，整行淡红底 |
| 超时 | `timedOut` | 面板左边框 `--danger`，头部状态写「超时」 |

**排版细则**：

- 表格与管道行：`tab-size:2`，不折行保证列对齐；`ahk.bat instances` 的表头与数据行自然对齐。
- 长路径：`pre` 下整段保留；打开「自动换行」时才 `overflow-wrap:anywhere`，且断点优先落在 `\` 与 `/` 之后（`word-break:normal`）。
- 行首时间戳：可选，默认关（调试长任务时开，格式 `[HH:MM:SS]`，`--text-2` 12px）。
- 行号：不做（输出不是源码，加了反而挤）。

### 19.5 桌面交互

- 快捷键：`/` 聚焦搜索、`Esc` 关抽屉或弹窗、`Ctrl/Cmd+Enter` 在表单里直接执行、`↑`/`↓` 在搜索结果里移动、`Enter` 打开。
- 左栏分组点击滚动定位；`Ctrl/Cmd+K` 可选（不做，别和 `/` 重复）。
- 抽屉打开时主区**不**变窄（覆盖，不挤压），但左侧留 8px 阴影暗示层次。

### 19.6 验收（必须 CDP 设定 viewport，不许用窗口缩放）

```
npm run ui:shot -- http://127.0.0.1:7878/ 1920 1080 data/tmp/ui-desk-1920.png
npm run ui:shot -- http://127.0.0.1:7878/ 1366 768  data/tmp/ui-desk-1366.png
npm run ui:shot -- http://127.0.0.1:7878/ 390  844  data/tmp/ui-mobile-regress.png
```

| 项 | 判据 |
|---|---|
| 无横向溢出 | 三档 `document.documentElement.scrollWidth === window.innerWidth` |
| 卡片列数 | 1920 下 ≥4 列、1366 下 ≥3 列；标题 `text-overflow` 生效（`scrollWidth > clientWidth` 即被截断，不换行） |
| 抽屉形态 | 1920/1366 下 `drawer.top === 0`、`drawer.bottom === innerHeight`、`width === 720`；390 下仍是底部（`bottom === innerHeight`、`top > 0`） |
| 不折行 | `getComputedStyle('.drawer-body').whiteSpace === 'pre'`；长路径输出后 `scrollWidth > clientWidth`（证明没断行） |
| 管道表对齐 | `ahk.bat instances` 输出在 1920 与 390 下 `# slot\|pid\|hwnd` 表头与数据行的 `\|` 竖线 x 坐标逐一相等 |
| 语义着色 | 一次 run 后 DOM 里存在 `.line-cmd` / `.line-step.ok` / `.line-err` 三类节点（用 `check-status` + 一条故意失败的命令验） |
| 手机回归 | 390×844：卡片单列、抽屉 62vh、`env(safe-area-inset-bottom)` 生效、PWA 图标与 manifest 不受影响 |
| 构建 | `npm run build:web` 后 dist 体积增量 < 15KB（gzip），且无新增运行时依赖 |

### 19.7 不做

- **暗色主题**：另立议题。配色要成套换（`--bg/--surface/--border/--text/--accent` 两套值 + `theme-color` + PWA 图标底色），顺手做会得到一个半黑半白的界面。
- 抽屉拖拽调宽、多标签、输出虚拟滚动（2000 行上限内 DOM 直出够用）、卡片自定义排序。

---

## 20. P2.5 实施记录（2026-10-29）

**布局（≥1024px）**

- 左侧栏 260px：搜索框（`/` 提示）+ 分组导航（组名 + 计数）+ 底部快捷键提示；`position: sticky; top: 52px`
- 主区 `max-width:1280px` 居中，`padding:24px 28px`；网格 `minmax(240px,1fr)`、`gap:12px`
- 卡片固定 64px，标题与 meta 单行 `nowrap + ellipsis`，hover 描边 `--accent`
- 顶栏 52px；桌面把搜索移进左栏，顶栏下不再多占一条纵向空间

**抽屉**

- 桌面：`top:0; bottom:0; right:0; width:min(720px,62vw)`，左侧 2px 边 + 阴影，全高覆盖
- 正文 `white-space:pre; tab-size:2; 13.5px/1.55`，默认不折行；`↩` 开关切到 `pre-wrap`
- 头部：id（等宽）+ 状态（运行中/完成/失败/超时，颜色区分，`<1s` 显示毫秒）+ 换行/复制/关闭

**输出语义**

- `lines: string[]` → `{ kind, text, ok? }[]`；stdout 按行拆分，`ERR|` 开头的行直接标错误色
- 四类着色：命令回显（加粗）、步骤（✓ 绿 / ✗ 红）、队列等待（琥珀）、错误（红字 + 淡红底）

**键盘**：`/` 聚焦搜索、`↑↓` 移动、`Enter` 执行、`Ctrl/⌘+Enter` 表单直接跑、`Esc` 逐层关闭。

**顺手修的真 bug**：`ahk.bat` 出错时打 `ERR|...` 但退出码是 0，runner 只看 exitCode ——「slot not found」会被显示成「完成」。现在 runner 兼看输出前缀，`step`/`exit` 事件带 `note`，CLI 与 Web 都判失败；冒烟加 2 条（现 35 项）。

**验收数据（CDP 真仿真，非窗口缩放）**

| 项 | 1920×1080 | 1366×768 | 390×844 |
|---|---|---|---|
| 页面横向溢出 | 无（scrollWidth=1920） | 无 | 无 |
| 卡片列数 | 4 | 4 | 1 |
| 标题 | `nowrap`，1 条 ellipsis | `nowrap`，3 条 | 正常换行（手机不省略） |
| 抽屉 | 720×1080，top=0 | 720×768，top=0、bottom=768 | 底 299px，top=545、bottom=844 |
| `drawer-body` | `pre` | `pre` | `pre`（横向滚动，不折行） |
| 语义行 | cmd 1 / step 2 / out 7 | 同左 | 同左 |

体积：CSS 1.41→2.36KB、JS 48.85→51.45KB（gzip），合计 +3.5KB，无新增运行时依赖。

**与 §19 设计的偏差（有意为之）**

1. **抽屉宽度**取 `min(720px,62vw)`，而非设计里的 `min(720px,46vw)`：验收要求 1366 下也是 720，46vw 只到 628。代价是 1366 上面板盖住 4 列里的 2 列；更看重可见区域就把这行改回 46vw。
2. **手机抽屉是 `max-height:62vh`**（7 行输出实测 299px），不是固定高度——短输出不该占半屏。
3. **管道表对齐无法靠 CSS 达成**：`ahk.bat instances` 的输出本身没按列补空格，竖线位置取决于内容长度。CSS 能做的是「不折行 + 等宽」；用注入的等长前缀两行验证过：ASCII 的 `|` x 坐标完全一致（1253.6 = 1253.6）。
4. **中英混排仍对不齐**：中文落到 `Microsoft YaHei`（本机未装 Sarasa Mono SC / Noto Sans Mono CJK SC），4 个汉字比 4 个 ASCII 宽约 22px。装上 CJK 等宽字体后自愈。
5. **顶栏右侧被面板盖住**（`top:0` 是验收项），运行中看不到 bridge/queue 徽标；面板头部自带运行状态。

**已知缺口**：抽屉覆盖而非挤压（1920 下约 1.5 列不可见）；分组折叠未做；`Ctrl+K` 按 §19.5 不做。**2026-10-29 复验另查出四条（手机多目标头部折行、并列 pane 右裁 56px、`.card-fan` 隐形热区，见 §0.5）**——这些不在本期验收项里，是补测发现的。

---

## 21. P3 实施记录（2026-10-29）

**这一期做了什么**

| 块 | 具体 |
|---|---|
| 数据模型 | `POST /api/run` 接受 `targets: string[]`；同一目标可重复（同目标多开），最多 8 个；优先级 `targets[]` > `target` > 片段 `target` > hosts `default` |
| 校验 | 空数组 / 非数组 / 空字符串项 / 未知目标 / 任一 `reserved` → 开流前 `400`，整条拒绝 |
| 事件打标 | `RunEvent` 全部成员加可选 `target` + `targetIndex`（core 导出的 `TargetTag`）；server 每条事件合并进去；**删掉了原来那个 `cmd: "[target xxx]"` 的假 start 事件**，目标名现在走字段而不是藏在命令文本里 |
| 执行 | 服务端 `Promise.all` 同时拉起 N 个 `runSnippet`，共用按 `bridgeRoot` 缓存的同一个 `ExecDriver` → 队列天然串行；P5 接 ssh 后不用改就是真并发 |
| 目标选择器 | 卡片右上角 `⊕`（手机常显、桌面悬停显示）→ 打开表单弹窗，顶部是目标区：已选 chips（同名带 `#1/#2`，可 ×）+ 可选目标按钮（reserved 灰显带 `P5` 角标）。`⊕` 会**预选一个**目标（片段 target 或 hosts default），再点一次就是「多开」 |
| 结果并列 | `output.lines` → `output.panes[]`，每块 pane 独立 `lines / running / ok / durationMs / exitCode / note`；事件按 `targetIndex` 路由；抽屉 `multi` 态加宽到 `min(1100px, 88vw)`，内部 `grid-template-columns: repeat(var(--cols), 1fr)`；`--cols` 上限 3 |
| 汇总状态 | 多目标时头部显示 `2/2 成功 · 34ms` + `N 目标` 徽章，每块 pane 自己一条 `完成/失败/超时` |

**验收实测**

| 项 | 结果 |
|---|---|
| `npm test` | **46 通过 / 0 失败**（原 35 + 多目标 11 条） |
| 严格串行（冒烟） | 两个 `win-desktop` 跑 `ping -n 3`：两组 `stdout/step` 事件区间不重叠，总耗时 ≥ 3.5s（并行会接近 2s） |
| 事件打标（冒烟） | `every(e => e.target === 'win-desktop')` 为真，`targetIndex` 集合 = `{0,1}`，两个 index 各有 `exit.ok=true` |
| 校验（冒烟） | 空数组 / 未知目标 / 含 reserved / 非数组 / 空字符串项 五条全 `400` |
| UI 1366×768 | `.panes.multi` 2 块、`grid-template-columns` 2 列、抽屉 1100px、页面 `scrollWidth - innerWidth = -15`（无横向溢出） |
| UI 390×844 | 2 块、`cols=1`（堆叠）、无横向溢出 |
| 防回退 | `npm run ui:queue` 仍通过（+500ms 命中 `排队 2`）；`npm run ui:shot` 单目标抽屉仍是 720×全高、`white-space:pre` |
| 体积 | CSS 2.36 → 2.89KB gzip、JS 51.45 → 52.61KB gzip，无新增运行时依赖 |

回归脚本：`npm run ui:multi`（CDP，1366 + 390 各 10 条断言，`MULTI_SHOT=0` 可关截图）。依赖服务在线，不进 `npm test`。

**与设计/直觉不一样的取舍**

1. **`⊕` 入口而不是「点卡片先弹目标选择」**：单点卡片的行为（有变量出表单、无变量直接跑）一个字没改，多开是显式的第二入口。代价是无变量片段想多开也必须点 `⊕`，而不是长按/双击那种更隐晦的手势。
2. **`⊕` 预选一个目标**：打开就有 1 个 chip，再点一次变 2 个，少点一次。副作用是「想跑别的目标得先删掉预选的那个」——但只有一个可执行目标时这就是最省的操作。
3. **reserved 整条拒绝，不做「跳过并标注」**：§6.3 原来写的是「跳过并标注未激活」，实现改成 `400`。理由：一条 SSE 流里混着「跑了的」和「没跑的」，前端得造第三套状态；而用户在多选界面里看到灰按钮本身就不会选它，`400` 只会在手写 API 时出现。
4. **抽屉宽度 1100 而非按 pane 数线性放宽**：`min(1100px, 88vw)` 在 1366 上占 1100（盖住约 3.7 列卡片），1080p 上同样 1100。再宽就变成「两列各 800px 的空旷面板」。
5. **`--cols` 上限 3**：4 个以上目标时列宽被压到 <300px，不如让它们更窄但保持在视口内。真要 8 路广播应该做「主面板 + 列表」，那是 P5 的事。
6. **手机堆叠 + 每块 `max-height:26vh`**：390 宽并列等于每块 130px，读不了；堆叠后靠 `.panes` 自身滚动。
7. **CLI 没做多目标**：`--targets a,b` 会和 `parseVars` 的 `--k=v` 规则打架，且终端里并列输出没有排版可谈。CLI 保持单目标，写进已知缺口。
8. **删掉假 `start` 事件**：原实现给每条 run 发 `{type:'start', stepIndex:-1, cmd:'[target xxx]'}` 当前端能用的唯一渠道，前端再用 `cmd.startsWith('[')` 过滤掉。现在是真字段，那行 `if (ev.cmd)` 就干净了。

**已知缺口**

- 3 个以上目标在 1366 下每列约 360px，等宽输出基本只能看短命令；4+ 目标不建议。
- 手机多目标要纵向滚动才能在两个 pane 间切换，没做「tab 切换」形态。
- CLI 不支持 `--targets`。
- 队列徽标仍是「长度」不是「第几位」（P2 §18 遗留，要做得多目标一起排位次）。
- 跨机并列（真并发）仍等 P5 的 ssh 驱动；`home-win` / `vps` 继续灰显。
- ~~两列并列时每块 pane 右裁 56px~~ **已修**（`.drawer.multi` 宽改 `min(1320px, calc(100vw - 48px))`，1366 每块 631 > 605）：见 §0.5 ISSUE-006。**仍存在**：**三列必然横滚**（`605*3+84 = 1899`，1366 屏物理放不下），这是取舍不是缺陷。
- **超过 8 个目标时前端不拦**，服务端 400 后仍开 N 块空面板、错误串裸露 JSON。见 §0.5 ISSUE-007。

---

## 22. P4 实施记录（2026-10-30）

**这一期做了什么**

| 块 | 具体 |
|---|---|
| `expect` 条件步 | `core/expect.ts` 新增 `runExpect()`；`types.ts` 加 `StepExpect`，`Step` 变三动词联合。`from` 三源：`last`（往前找最近一条有输出的 run）/ `all`（本次 run 所有输出拼起来）/ `file:<路径>`（**真等待**：每 `interval` 重读，到 `timeout` 判失败；文件不存在不算错）。`flags` 白名单 `i/m/s`，`g` 静默去掉 |
| 校验 | `snippets.ts` 在加载期就查：`match` 缺省 / `flags` 非字符串 / `from` 不是三源之一 → 该文件 quarantine，不是等跑起来才报 |
| 变量与搜索 | `vars.ts` 的变量扫描把 `expect.from` 也算进去（`file:{{runlog}}` 能弹输入框）；`store.ts` 的 haystack 收 `expect.match`（「等 runlog」这类片段搜得到） |
| 运行档案 | `core/runs.ts`：`RunLog`（list / read / prune）+ `RunWriter`（meta → event×N → summary，`writeSync` 逐行追加）。id 形如 `20261030-001234-a1b2`，按文件名排序即时间排序。`prune()` 启动跑一次：留最近 500 份、30 天内 |
| secret 落盘 | `RunWriter` 收 `redact[]`（secret 变量的**实际值**，长度 < 4 的不抹以防误伤正常输出），对 `cmd` / `data` / `message` / `note` / `matched` 逐个字面量换成 `***`；`meta.vars` 同样打码并记 `varsRedacted`。实时 SSE 照发原值（人就在屏幕前看自己填的东西） |
| API | `GET /api/runs?limit=&snippet=`（倒序，limit 夹在 1–100）、`GET /api/runs/:runId`（`runId` 不匹配 `^\d{8}-\d{6}-[a-z0-9]{4}$` 直接 404，不做路径拼接） |
| 事件 | 首条 `start`（`stepIndex=-1`）额外带 `runId`；`expect` 步的 `step` 事件带 `expect`（正则源串）与 `matched`（命中文本：空白压成单空格、>120 字截断加 `…`）。**先写盘再发流**：客户端断开后档案仍完整 |
| 前端 | 顶栏 `🕘` 打开运行历史弹窗（时间 / 片段 / 目标 / 耗时 / 状态），点条目 → `GET /api/runs/:id` → 复用 `applyEvent` 在抽屉里回放，头部标 `🕘 历史时间`。回放态不跑计时、不显示「运行中」 |
| CLI | `snip import-history [--from ps\|bash\|file:<路径>] [--limit N] [--group 名] [--shell cmd\|powershell] [--write] [--force]`；`snip runs [runId]` 看档案 |

`import-history` 的四条克制：

1. **默认 dry-run**：只打印「原始 N 行 → 丢弃 M 行 → 候选 K 条」，写盘要显式 `--write`。手写的 16 条片段一次被几十条历史淹掉是最坏的结果。
2. **不覆盖**：目标文件已存在就标 `~` 跳过（`--force` 才覆盖），第二次导入不会冲掉改过的片段。
3. **按结构丢残句**：多行命令在 PSReadLine 里被拆成多行，只剩半条（`Get-X | Where {$_.Y -like "*z*"`）语法不完整，导进来是必炸的片段。判据是括号/引号不成对、或以 `|` `{` `,` `=` 结尾、或以**续行符**（PS 反引号 / cmd `^`）结尾——`looksIncomplete()`，引号里的括号不算结构。实测本机 810 行历史里，这条规则比「像不像命令」多丢掉 80 行（都是被拆断的 `Set-ItemProperty` 长命令）。
4. **危险命令一律 `danger: true`**：`Remove-Item -Recurse` / `shutdown` / `taskkill /f` / `git reset --hard` 等 16 条正则，命中后 Web 侧多一道确认框。

**验收实测**

| 项 | 结果 |
|---|---|
| `npm test` | **59 通过 / 0 失败**（46 → 59：`test:expect` 28 项、`test:import` 41 项、冒烟新增 13 条 runs 用例） |
| `expect` 三源 | `last` / `all` / `file:` 各有命中与未命中断言；`file:` 用临时文件延迟写入验证「真等待」，超时 0.5s 判失败且 `note` 带路径 |
| `g` flag | 用 `flags: 'g'` 编译后连测两次，断言结果不翻转（编译期就没有 `g`） |
| 档案落盘 | 冒烟在临时数据目录真跑 `check-instance` + 双目标 `check-status`：`/api/runs` 非空、`/api/runs/:id` 的 `events.length` 与列表 `eventCount` 一致、末条事件是 `exit`、`summary.panes` 两个目标各一条 |
| secret 不落盘 | 带 `token` 变量的 run：档案里命令回显与输出中的实际值都是 `***`，`meta.vars.token = "***"`，`varsRedacted = ["token"]` |
| 非法 runId | 校验正则不通过 → 404（不是 500，也没机会拼路径） |
| UI 1366 / 390 | `npm run ui:history` 26 条断言全过：列表四列（手机三列）、无横向溢出、点条目回放、头部带 🕘 时间、还原命令行与输出、回放态不显示「运行中」 |
| 防回退 | `npm run ui:multi` 49 条断言仍全过（`.drawer-id` 加 `flex:1` 后并列头部仍是单行） |

**与设计/直觉不一样的取舍**

1. **`last` / `all` 不等待**：exec 驱动是「整段返回」，命令跑完才有输出，没有「还在流」的中间态，所以只有 `file:` 需要轮询。真要等长任务的输出，正确姿势是 `run` 一条 `type <日志>` 再 `expect from: file:`——不是把 expect 做成流式监听。
2. **`g` 静默去掉而不是报错**：报错会让人去查「为什么不准用 g」，而真实后果（连测两次一真一假）只有踩过才知道。去掉 + 文档写一行，比让人读一遍 JS 正则状态机便宜。
3. **档案用 jsonl 不用一个大 JSON**：run 中途被 kill 时 jsonl 只丢最后一行，JSON 会整份解析失败——排障档案最怕的正是「出事那次读不出来」。读的时候半行直接跳过。
4. **先写盘再发流**：多一次 `writeSync`（本地盘，微秒级），换来「断开 / 关页面后档案完整」。反过来的话，客户端断开那一刻的收尾事件就丢了。
5. **secret 值 < 4 字不抹**：`abc` 这种字面量替换会把正常输出（`abc123`、路径里的 `abc`）打成 `***`，档案反而失真。代价是 1–3 字的 secret 会明文落盘——这类 secret 本身就该重设。
6. **`import-history` 默认 dry-run**：与「`snip run` 直接就跑」的风格相反，因为导入是**批量且不可逆地写文件**，而 run 是可重复的。
7. **不覆盖已有文件**：第二次导入同名命令时 `slugify` 出的 id 一样，直接写会把用户改过的片段冲掉。跳过 + 打印 `~` 更安全。
8. **回放不复用计时**：档案里只有事件，没有「当时的时间轴」。抽屉头部显示历史时间、状态栏直接给最终结论，不做逐条重演——那是调试器的活，不是排障的最小需求。
9. **不加 SSE 续传**：`Last-Event-ID` 只在同一条连接内有效，页面一关就没了。档案 + `GET /api/runs/:id` 覆盖了「断开后回看」的真实场景，续传是成本高、命中率低的功能。

**已知缺口**

- 档案是追加式全量事件，单条 run 几十 KB，但 `data/runs` 会一直长；只靠启动时 `prune()`（500 份 / 30 天），服务长期不重启就不清。
- 历史列表不分页，`limit` 上限 100；没有「按时间范围」「按状态」筛选。
- 回放只读，不能「基于这次运行再跑一次」（`meta.vars` 有变量值，但 secret 已打码，重跑必须重填）。
- 前端历史弹窗没有「删除这条档案」入口（要删得去 `data/runs/` 手动删）。
- `import-history --from bash` 的 `--shell` 默认仍是 `powershell`，语义不兼容（`rm -rf` 这类会被当 PS 命令跑失败），要自己加 `--shell cmd`。
- 片段 CRUD / Raw 编辑 API 仍未做：改片段只能改文件（`fs.watch` 会热更）。

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
- **v0.6**（2026-10-24 深夜，P2 完成）：
  - Web 界面补齐：token 设置 + 401 引导、health 轮询与队列徽标、抽屉（自动滚动/复制/计时/超时态）、ANSI 清理、Esc 关闭、手机单列与底部抽屉、PWA（manifest + 双图标 + service worker）。
  - 新增 `scripts/ui-shot.mjs`（`npm run ui:shot`）：CDP 移动端仿真截图 + 布局测量；记录「headless `--window-size` 最小约 500」这个坑。
  - §18 记 P2 实施与验收；§9 P2 标完成。
- **v0.7**（2026-10-25，真机实测，**未修**）：
  - 转真机验收发现 BUG-001：`SNIP_TOKEN` 守卫是全局 `onRequest` 钩子，把静态首屏 `/` 也挡成 401，手机拿不到 HTML → 没有 ⚙ 按钮 → token 无处填 → 死锁。本机 loopback 与 CDP 仿真均复现不了（loopback 免 token）。现场记录、根因、修复方向与回归用例清单见 §0.2，待修。
- **v0.8**（2026-10-25，P1/P2 复验 + 桌面端规划）：
  - **编号统一**：`待修 BUG-001` 改名 `待修项 ISSUE-001`，bug 与缺口共用一套号（理由见 §0.2 前的约定）。原 BUG-001 的全部现场记录原样保留。
  - 复验 P1/P2 主干全通，新增三条待修缺口进 §0.3：**ISSUE-002** CLI 中文搜索基本无效（MiniSearch 无 CJK 分词、未开 prefix/fuzzy，只有空白切出的整块能中；前端 `includes` 正常所以从网页看不出来）；**ISSUE-003** 顶栏「排队 N」4s 轮询配 0.8s 短任务实测 0 命中；**ISSUE-004** `npm test` 28 项断言全绿但清理被 safe-delete shim 拦成退出码 1。
  - 路线图新增 **P2.5 电脑端 UI**（排 P3 前）；新增 §19 设计：桌面三栏布局、抽屉改右侧全高 720px 面板、输出区 `white-space:pre` 不折行、等宽字体栈补 CJK 回退、`output.lines` 由 `string[]` 改 `{kind,text}[]` 以支持语义着色；给出 1920 / 1366 / 390 三档验收判据。
- **v0.9**（2026-10-29，修复四连 · **完成 4/4**）：
  - 新增 issue 队列约定（见 §0.2 前的引用块）：**只往队尾追加、编号不复用**，修好的标「已修 · 日期」并保留现场记录。
  - **ISSUE-004 已修**：冒烟 fixture 改 `mkdtempSync` 落系统 temp，收尾清理包 try/catch 只 warn、不改退出码；`npm test` 恢复 `28 通过 / 0 失败 / 退出码 0`（连跑两遍无残留）。旧代码遗留的 `data/tmp/smoke` 已清。
  - **ISSUE-001 已修**：`onRequest` 守卫按路径分流——`/api/*` 仍要 Bearer，静态壳（`/`、`/assets/*`、manifest、图标）一律放行，手机拿得到首屏也就能填 token；`notFound` 对「带扩展名但文件不存在」返 404 文本，`/favicon.ico` 不再被 SPA 回退成 HTML。冒烟 28 → 33 项；Tailscale 地址实测：`/` 200 HTML、无 token `/api` 401、带 token 200、favicon 404。§14 契约、§11、§12 待定项 1、README 同步。
  - **ISSUE-002 已修**：`store.ts` 弃用 MiniSearch（默认 tokenizer 不切 CJK），改子串匹配 + 多词 AND，与网页同语义；`minisearch` 依赖移除。新增 `npm run test:search`（14 项）并入 `npm test`；真实库实测 `实例` → 6 条、`续杯`/`壳`/`实例表` 全部命中。§7 技术选型同步。
  - 新增 `snipdeck.bat` 服务启动器（`npm run sync:launchers` 生成，GBK），走桥 `shell shell#2` 前台起服务；顺带记下桥的坑：`inst.shell#1` 的窗口一旦 `no hwnd` 就送不进命令，得先 `ahk.bat shell` 重开一个。
  - **ISSUE-003 已修**：轮询间隔跟运行态走（空闲 4s / 运行中 500ms），`queued`/`exit`/`error` 事件再刷一次收尾；新增 `npm run ui:queue`（CDP 连点两次 `check-status`，100ms 采样 45 次断言 `.badge.queue`）。连跑 3 次全过，徽标在 +500ms 出现（`排队 2`）。§18 的「4s 抓不到」记录同步改为已修。
  - 四条修完：`npm test` = typecheck + queue + cmd + search(14) + smoke(33)，全绿；`npm run ui:queue` 单独通过。**用例总数 33，单测 14，UI 回归 2 条断言。**
- **v1.0**（2026-10-29，P2.5 电脑端 UI · **完成**）：
  - 桌面三栏：左侧 260px 分组栏 + 1280px 居中主区 + 52px 顶栏；卡片 64px 单行省略，网格 `minmax(240px,1fr)`。
  - 抽屉改右侧全高面板（`min(720px,62vw)`，`top:0`），正文 `white-space:pre` 不折行，新增「自动换行」开关、毫秒级耗时、失败/超时三态色。
  - `output.lines` 由 `string[]` 改 `{kind,text}[]`：命令/步骤/排队/输出/错误分行着色，`ERR|` 行直接标红。
  - 快捷键：`/`、`↑↓`、`Enter`、`Ctrl/⌘+Enter`、`Esc`。
  - **修真 bug**：桥以 `ERR|` 报错但退出码 0，runner 只判 exitCode → 「slot not found」显示成「完成」。现兼看输出前缀，`step`/`exit` 带 `note`，CLI/Web 同步；冒烟 33 → 35 项。
  - 三档 CDP 验收数据与五处「设计 vs 验收」的取舍记在 §20。
- **v1.1**（2026-10-29，路线图调整：P3 让位给 P4）：
  - 发现 P3 的验收「一条片段投 win-desktop + home-win，后者标注未激活」是**自相矛盾**的：`home-win` 用的是 `local` 驱动，它是**同一台机器**，激活了也变不出第二台；真正能产生「多台」的只有 ssh（P5）。所以 P3 按原样做，做完只能看到「一个可选项的选择器」。
  - **P3 缩范围**：改名「多目标（数据结构）」——`targets[]` + 目标选择器 + reserved 置灰 + 同目标多开（串行、事件打标、结果并列）；跨机并列整条挪进 P5 验收。
  - **P4 提前**：`expect` 条件步、从 shell 历史导入、`runs/<id>.jsonl` 落盘；同时标注 secret / danger 确认 / 预览三项其实已在 P1–P2 落地，P4 实际只剩三条。
  - 执行顺序改为 **P4 → P3 → P5**，理由写在 §9 的「执行顺序」段；§12 待定项 4（先做 runs 还是 targets）随之结案；§6.3 补「P3 只做同目标多开」的说明；§0.1 的缺口清单改为按排期归属。
- **v1.2**（2026-10-29，P3 多目标 · **完成**）：
  - `POST /api/run` 接受 `targets[]`，同一目标可重复（同目标多开），上限 8；校验全在开流前（空/非数组/未知/reserved → 400，整条拒绝）。
  - 事件全部带 `target` + `targetIndex`；删掉原先 `cmd: "[target xxx]"` 的假 start 事件。
  - 服务端 `Promise.all` 拉起 N 个 `runSnippet`，共用同一个 `ExecDriver` → 队列保证严格串行；P5 接 ssh 后无需改动即真并发。
  - 前端：卡片 `⊕` 打开目标选择器（chips 可重复、reserved 灰显带 `P5` 角标）；`output.lines` → `output.panes[]`，抽屉多目标加宽到 `min(1100px, 88vw)` 并并列 N 块面板，手机堆叠；头部汇总 `2/2 成功`。
  - 冒烟 35 → **46 项**（5 条 targets 校验 + 6 条多目标实跑，含「事件区间不重叠」与「总耗时 ≥ 单条 ×2」两条串行断言，用不打桥的 `ping -n 3` 片段，listener 离线也跑）。
  - 新增 `npm run ui:multi`（CDP 1366 + 390 各 10 条断言：reserved 灰显、chip 序号、并列/堆叠列数、无横向溢出）。
  - 实施与八处取舍、五条已知缺口见 §21。
- **v1.3**（2026-10-29，P2.5/P3 复验 + 四条新缺口入库，**均未修**）：
  - 复验结论：`npm test` 46/46 退出码 0、`ui:multi` 20 条断言全过；API 边界（9 目标 400、`targets` 压过 `target`、8 目标 8 个 exit、失败×2 都 exit=1、`targetIndex` 连续、两 pane 无串台）全部符合设计。
  - 新增 §0.5 与 §0.6：**ISSUE-005** 手机多目标抽屉头部折成两行（`drawer-id` 97×42、文本 2 行）；**ISSUE-006** 并列两列时每块 pane 输出右侧切 56px（`client 549 / scroll 605`，切掉时间戳尾）；**ISSUE-007** 超 8 目标前端不拦、错误裸 JSON（`! ERROR ApiError: {"error":…}` 重复 9 遍、状态写成「0/9 成功」）；**ISSUE-008** 桌面 `⊕` 隐形但可点（`opacity:0` + `pointer-events:auto`）且键盘不可达。
  - **撤回一条误报**：上一轮报的「`/` 快捷键在 ≤1023 失效」不成立——当时用 `querySelector` 手写模拟命中了隐藏节点，真实按键（`Input.dispatchKeyEvent`）在三档下都聚焦正确。原文与撤回理由留在 §0.5 开头，避免以后照着修一个不存在的问题。
  - 修复计划按 005 → 007 → 006 → 008 排，四条全在前端；每条带改动代码、验收判据与坑（如 `ellipsis` 必须配 `min-width:0`、`pointer-events:none` 时自身 `:hover` 永不触发）。
- **v1.4**（2026-10-29 夜，§0.5 四项全部修完，**已修**）：
  - **ISSUE-005 已修**：`.drawer-id` 加 `nowrap/ellipsis/min-width:0`，状态·目标数·按钮组 `flex-shrink:0`。390 双目标头部从 63px / id 两行 → 55px / 单行（55 是手机图标按钮 34 + padding 的正常高度，桌面仍是定高 48）。
  - **ISSUE-006 已修**：`.drawer.multi` 宽 `min(1320px, calc(100vw - 48px))`。1366 抽屉 1318、1920 抽屉 1320，两档下两块 pane 都 `scrollWidth <= clientWidth`。三列横滚保留为取舍（物理放不下，不降字号）。
  - **ISSUE-007 已修**：`api.ts` 新增 `parseError()`（取 `.error`）+ `ApiError.detail`、`api.run` 新增 `onStart`；`App.tsx` 加 `MAX_TARGETS=8` 三处拦截（disabled / onClick / 提交前）+ `field-note` 提示，`setOutput` 挪进 `onStart`，400 时回填 draft 并把错误放进表单。**所有** 400 的文案从此是人话，不再裸 JSON。
  - **ISSUE-008 已修**：隐形态 `pointer-events:none`（显形挂 `.card:hover / :focus-within`）、补 `aria-label`、加 `T` 快捷键 + `.nav-hint` 文案；触屏（`hover:none`）仍常显。
  - 回归：`npm run ui:multi` 20 → **49 项断言**（新增 005 头部单行、006 两档 pane 无横滚、007 上限与桩 400 呈现、008 未悬停不可点/悬停显形/T 键/触屏常显），全过；`npm test` 46/46 退出码 0；`npm run ui:queue` 通过。
  - 记两条经验：**ellipsis 下 `getClientRects().length` 不等于行数**（会给「可见段 + 被裁段」两个矩形，要看不同 `top` 的个数）；**UI 已拦截的 400 从界面不可达**，回归要用 `page.evaluate` 桩 `window.fetch` 才能测到「错误回表单、不开抽屉」。
- **v1.5**（2026-10-30，P4 打磨 · **完成**）：
  - **`expect` 条件步**：`Step` 变 `run` / `sleep` / `expect` 三动词。`from` 三源 `last`（缺省，最近一条有输出的 run）/ `all` / `file:<路径>`（唯一**真等待**的源，`interval` 轮询到 `timeout`）；`flags` 白名单 `i/m/s`，`g` 静默丢弃（有状态匹配会一真一假）。写法错在加载期就 quarantine。`step` 事件带 `expect` + `matched`。
  - **运行档案**：`data/runs/<runId>.jsonl` 三段式（meta / event×N / summary），启动 `prune()` 留 500 份 / 30 天。secret 变量的实际值在落盘时逐字面量抹成 `***`（< 4 字的不抹），`meta.vars` 打码并记 `varsRedacted`。**先写盘再发流**，断开/关页面后档案仍完整。
  - **API**：`GET /api/runs?limit=&snippet=`、`GET /api/runs/:runId`（runId 正则校验，非法 404）；首条 `start` 事件带 `runId`。
  - **前端**：顶栏 `🕘` 运行历史（时间/片段/目标/耗时/状态），点条目复用 `applyEvent` 在抽屉里回放并标 `🕘 历史时间`，回放态不跑计时。
  - **CLI**：`snip import-history`（PSReadLine / bash / 任意文件 → 片段，默认 dry-run，`--write` 才落盘，不覆盖已有文件，按结构丢弃被拆断的半条命令，危险命令自动 `danger: true`）、`snip runs [runId]`。
  - 测试 46 → **59 项冒烟**（`test:expect` 28、`test:import` 41、冒烟 +13 条 runs 用例）；新增 `npm run ui:history`（CDP 1366 + 390 共 26 条断言）。
  - 九处取舍与六条已知缺口见 §22。
