# SnipDeck · Issue 队列（§0.2 – §0.8）

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · 设计 [01-design.md](01-design.md) · 路线图 [02-roadmap.md](02-roadmap.md) · 参考 [03-reference.md](03-reference.md) · 实施记录 [04-phases.md](04-phases.md) · 变更日志 [05-changelog.md](05-changelog.md)
>
> 覆盖原 `SnipDeck-PLAN.md` 的 **§0.2 – §0.8**：issue 队列约定、ISSUE-001 ~ ISSUE-016 的现场记录、修复计划与修复记录。
>
> **章节编号全局不变**：别处写的「§0.5」就是本文件的 0.5 节。本文件内出现的其他节号（§1、§7、§9、§11、§14、§16、§18、§20、§21、§22…）按总览的「文档地图」查对应文件。
>
> 读法：issue 正文（§0.2 / §0.3 / §0.5 / §0.7）保留**原始现场记录**，它同时是回归用例说明书；修复计划与偏差记在 §0.4 / §0.6 / §0.8。

---

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
- Changelog 版本号：本文件当前停在 v0.9（§0.2–§0.4 那轮）；P2.5/P3/§0.5 这一轮的记录散在 §20/§21，尚未归并成 v1.x 条目——**下次动文档时一起补**。 → **已补 · 2026-10-30**（v1.0 ~ v1.7 逐轮归并进 `05-changelog.md`，含本轮拆分）。

### 0.7 待修缺口 ISSUE-009 ~ 016（2026-10-30 P4 复验，**全部已修 · 2026-10-30**）

> 现场记录原样保留——它同时是回归用例的说明书。八条全部来自 P4 真跑复验：`expect` 三个源、运行档案、`import-history` 各踩到的坑。

#### ISSUE-009：`expect from: file:` 读不了 UTF-16 LE，永远等不到（严重）—— **已修 · 2026-10-30**

**现场**：桥写的 `instances.txt` / `last_result.txt` / `status.txt` / `jobs/*.exit` 全是 `ff fe` BOM + 双字节（`od -c` 确认）。`readFileSync(path,'utf8')` 得到夹 `\0` 的乱码 → 正则永不命中 → 死等 timeout，提示只写「未匹配」，会被误读成「文件还没写」。对照：UTF-8 文件 0ms 命中；同内容走 `run type` + `expect last` 1ms 命中。

**修法**（`core/expect.ts` 新增 `decodeText()`）：按 BOM 分流（UTF-8 BOM / UTF-16 LE / UTF-16 BE），无 BOM 时看前 256 字节里 `0x00` 落在奇位还是偶位判 UTF-16；最后一层按 UTF-8 解，出现 `U+FFFD` 就回退 GBK（与驱动侧 `decodeOutput` 同一套判据）。顺带把 CRLF 统一成 LF——`^done$` 这类带 `m` 的锚点原来会被看不见的 `\r` 毁掉。

**验收**：真桥文件 `C:/ahk_trigger/instances.txt` 用 `expect from: file:` 断言 `airmouse#\d+` → **2ms 命中**（修前 3s 超时）；`test:expect` 新增 UTF-16 LE+BOM / 无 BOM LE / BE+BOM / GBK 四组。

#### ISSUE-010：一个恶意正则可以拖死整个服务（中）—— **已修 · 2026-10-30**

**现场**：`(a+)+$` 对 30 个字符单次 `test` 约 8s（n=25/26/27 分别 250/501/1000ms，指数增长）；实测 `/api/health` 延迟 **8.13s**（正常 1.3ms），期间队列与 SSE 全停。`timeout` 字段救不了——同步 `exec` 卡完才检查 deadline。

**修法**：`execGuarded()` 把 `re.exec(text)` 放进 `vm.runInContext(..., { timeout: 500 })` 执行。JS 层没法中断正则，但 V8 的 interrupt 能打断它。预算 500ms（正常正则跑 1MB 也才几毫秒）；超预算返回 `{kind:'timeout'}`，`note` 写「正则执行超过 500ms（疑似灾难性回溯）」，**不再伪装成「未匹配」**。上下文单例复用——`runInContext` 是同步调用，单线程下不会被别的请求插进来改写。

**验收**：临时实例跑炸弹片段，期间 `/api/health` 采样 **1.3 / 20 / 13 / 1.3 / 1.5 / 1.4ms**；run 在 517ms 判失败并给出原因。`test:expect` 断言「<2s 返回」+「note 写灾难性回溯」。

#### ISSUE-011：`import-history` 放过提示符行与续行提示符（中）—— **已修 · 2026-10-30**

**现场**：本机历史里 4 行 `^PS [A-Z]:...>` 前缀（1 条完整进了候选，导入后 `PS` 不是命令且 `>` 会重定向），3 行 `^>>` 续行提示符（1 条进候选）。

**修法**：`normalizeHistory()` 先过 `stripPrompt()`——`PS <盘符>:\…>` 剥掉前缀留命令，`>>` 整条丢（它是多行命令的第二行，孤零零导进来必炸）。cmd 的 `C:/>` 不认：与真实路径长得太像，宁可漏。

**验收**：`test:import` 断言「PS 前缀被剥掉、`>>` 计入丢弃」；真实历史 dry-run 候选里已无 `PS ` 与 `>>` 开头的行。

#### ISSUE-012：危险清单漏服务 / 注册表 / 计划任务 / 账户 / ACL 的写操作（中）—— **已修 · 2026-10-30**

**现场**：`Restart-Service TermService -Force`、`Set-ItemProperty 'HKLM:/…' -Value 0` 都没标 danger，导入后点一下就直接执行，没有二次确认。

**修法**：`DANGER_PATTERNS` 从 16 条扩到 28 条：`Restart/Stop/Set/New/Start-Service`、`sc create|delete|config|stop|start`、`reg add|delete|import|restore`、`Set/New/Remove/Rename-ItemProperty …HK(LM|CU|CR|U|EY|CC)`、`Remove-ItemProperty`、`schtasks`、`net user|localgroup`、`takeown`、`icacls`、`bcdedit`、`Set-ExecutionPolicy`；`Remove-Item` 原来只认 `-Recurse`，补 `-Force`。

**验收**：`test:import` 的 danger 表从 8 条扩到 21 条，含 11 条新的真危险 + 3 条必须**不**误报（`Get-Service` / `Get-ItemProperty HKLM:` / `git status`）。

#### ISSUE-013：expect 失败的 exit 事件缺原因，界面写「桥侧报错」（低）—— **已修 · 2026-10-30**

**现场**：断言失败时 `exit` 只有 `{ok:false}` → UI 显示 `✗ failed exit=-`，真正原因（未匹配哪条正则）只留在上一条 `step` 里；档案 `summary` 也没有原因。更糟的是前端一律把「有 note」当桥报错，加了原因也会被写成「桥侧报错」。

**修法**：`exit` 事件加 `reason?: 'bridge' | 'expect'`，断言失败带 `stepIndex` + `note`（未匹配的正则、等了多久），桥报错带 `reason:'bridge'`；`RunPaneResult` 同样记 `reason`，档案 `summary` 跟着有。前端 / CLI 按 `reason` 选文案，不再靠 note 有没有值去猜。

**验收**：冒烟新增 3 条（`exit.reason=expect`、`note` 带未匹配、`stepIndex` 指断言步）+ 1 条档案 `panes[0].reason`；`test:expect` 3 条。

#### ISSUE-014：`/api/runs` 列表泄漏存储用的 `kind`（低）—— **已修 · 2026-10-30**

**现场**：`read()` 把 jsonl 的整行当 `RunMeta`，`kind:"meta"` 一起进了接口——类型里根本没这个字段。

**修法**：解构时把 `kind` 摘掉（meta 与 summary 两处），不做整行 spread。

**验收**：冒烟断言列表项与详情 meta/summary 都不含 `kind`；线上 `GET /api/runs?limit=1` 字段回到 12 个。

#### ISSUE-015：导入的 title 硬截断带 `…`，搜不到尾部词（低）—— **已修 · 2026-10-30**

**现场**：`title: cmd.slice(0,70) + '…'`，`...Terminal Serv…` 让「搜 Server 搜不到」；`slugify` 也硬切 40，把半截词留在 id 里。

**修法**：title 保留全文（长标题交给前端折行/省略），`cutAtWord()` 让 id 尽量切在 `-` 边界上（边界太靠前就不管词边界）。

**验收**：`test:import` 断言长命令 title 与原文完全一致、id ≤ 45（`hist-` + 40）且不以 `-` 结尾。

#### ISSUE-016：`ui:multi` 的 008 段假设卡片在首屏内，库变大后假失败—— **已修 · 2026-10-30**

**现场**：片段库从 16 条涨到 27 条后，`查看实例表` 卡片落到 **y=864**（视口高 768）。鼠标事件坐标在视口外 → `:hover` 永不成立 → 两条断言假红（`opacity 0` / 选择器不出现），但 CSS 与逻辑都没问题。

**修法**：脚本在测 `⊕` 之前先 `scrollIntoView({ block: 'center' })` 再取矩形（两处：初次测量与悬停前）。

**教训**：**UI 断言里凡是要发鼠标事件的坐标，必须先保证元素在视口内**——CDP 不会替你滚动，落在视口外的 `mouseMoved` 就是没发生。

### 0.8 修复记录（2026-10-30，**八条全部已修**）

| 序 | Issue | 性质 | 改动面 | 验收 | 状态 |
|---|---|---|---|---|---|
| 1 | ISSUE-009 | 功能阻塞（`file:` 源全废） | `expect.ts` 解码 + 换行 | 真桥 UTF-16 文件 2ms 命中 | **已修 10-30** |
| 2 | ISSUE-010 | 可用性（单请求拖死全服务） | `expect.ts` `vm` 预算 500ms | 炸弹期间 health ≤ 20ms | **已修 10-30** |
| 3 | ISSUE-011 | 数据质量（导进废片段） | `history.ts` `stripPrompt()` | 候选无 `PS `/`>>` 行 | **已修 10-30** |
| 4 | ISSUE-012 | 安全（无确认即执行） | `history.ts` danger 清单 28 条 | danger 表 21 条断言 | **已修 10-30** |
| 5 | ISSUE-013 | 可读性（失败看不懂） | `types/runner/app/web/cli/runs` | 冒烟 4 条 + 单测 3 条 | **已修 10-30** |
| 6 | ISSUE-014 | 接口脏字段 | `runs.ts` 解构摘 `kind` | 列表/meta/summary 均无 `kind` | **已修 10-30** |
| 7 | ISSUE-015 | 搜索退化 | `history.ts` title/id | title 全文、id 词边界 | **已修 10-30** |
| 8 | ISSUE-016 | 测试脆弱（假失败） | `check-multi-target.mjs` | `ui:multi` 49 项全过 | **已修 10-30** |

**排序理由**：009 与 010 是「`expect` 根本不可用」，先修；011/012 决定导进来的片段能不能信、敢不敢点；013/014/015 是呈现层的账；016 是测试自己的账，最后顺手清掉。

**用例数量**：`test:expect` 28 → 40，`test:import` 41 → 60，冒烟 59 → 66。

