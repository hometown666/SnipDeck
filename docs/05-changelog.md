# SnipDeck · 变更日志

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · 设计 [01-design.md](01-design.md) · 路线图 [02-roadmap.md](02-roadmap.md) · 参考 [03-reference.md](03-reference.md) · 实施记录 [04-phases.md](04-phases.md) · Issue 队列 [00-issues.md](00-issues.md)
>
> 覆盖原 `SnipDeck-PLAN.md` 的 **Changelog**：v0.1 → 当前。每条都指回对应的详细章节（§0.x = issue，§17–§22 = 分期实施记录）。
>
> 写新条目时按项目既有习惯：**一句一句是事实**（数字、文件名、断言条数），不写「优化了体验」这种没主语的话；顺手把状态行（已修 / 完成）与 §9 路线图对齐。

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

- **v1.6**（2026-10-30 凌晨，P4 复验八条全修，**已修**）：
  - **ISSUE-009**：`expect from: file:` 新增 `decodeText()`——按 BOM 分 UTF-8/UTF-16 LE/BE，无 BOM 看 `0x00` 位置，最后按 UTF-8 解出替换字符就回退 GBK（与驱动侧 `decodeOutput` 同判据）；CRLF 统一成 LF。真桥 `instances.txt`（UTF-16 LE）从「3s 超时」变 **2ms 命中**。
  - **ISSUE-010**：正则执行改走 `vm.runInContext(..., {timeout:500})`，灾难性回溯被 V8 interrupt 截断；超预算记「疑似灾难性回溯」而不是「未匹配」。炸弹运行期间 `/api/health` 从 8.13s 回到 **1~20ms**。
  - **ISSUE-011 / 012**：`import-history` 剥 `PS <盘符>:\…>` 前缀、丢 `>>` 续行；危险清单 16 → 28 条（服务 / 注册表 / 计划任务 / 账户 / ACL / 执行策略），`Remove-Item -Force` 也算。
  - **ISSUE-013**：`exit` 事件加 `reason: 'bridge' | 'expect'`，断言失败带 `stepIndex` + `note`，档案 `summary.panes` 同记 `reason`；Web 与 CLI 按 `reason` 选文案，`✗ failed exit=-` 与「一律叫桥侧报错」都消失。
  - **ISSUE-014 / 015**：`/api/runs` 不再泄漏存储用的 `kind`（解构摘掉，不整行 spread）；导入的 title 保留全文、id 按词边界截断。
  - **ISSUE-016**：`ui:multi` 的 008 段先 `scrollIntoView` 再量矩形——片段库涨到 27 条后目标卡片落到 y=864（视口 768），鼠标事件在视口外等于没发。
  - 用例：`test:expect` 28 → 40、`test:import` 41 → 60、冒烟 59 → 66；`npm test` 退出码 0，`ui:multi` 49 / `ui:history` 26 / `ui:queue` 全过。服务经桥重启加载新代码。

- **v1.7**（2026-10-30，文档拆分 · **无代码改动**）：
  - 单文件 1635 行拆成 1 + 6：仓库根 `SnipDeck-PLAN.md` 留总览（§0 / §0.1 + 文档地图 + 进度快照），其余进 `docs/`——`00-issues.md`（§0.2–§0.8）/ `01-design.md`（§1–§8）/ `02-roadmap.md`（§9–§12）/ `03-reference.md`（§13–§16）/ `04-phases.md`（§17–§22）/ `05-changelog.md`。
  - **章节编号一个没改**：全库的 `§x` 引用（README、SSH-USAGE、会话记录、代码注释）继续有效，总览的「文档地图」负责 § 号 → 文件名的换算。
  - 切分方式：按行号 `sed` 搬运 + 逐段 `diff` 校验。`00-issues` / `02-roadmap` / `03-reference` / `04-phases` / `05-changelog` 与原文件**逐字一致**；`01-design.md` 只改了 §8 的仓库结构树（补 `docs/` 六个分卷、补 `README.md`）并加一句拆分规则。正文零删改。
  - README「文档」节改成七条分卷链接；§8 树与新目录同步。

- **v1.8**（2026-10-30，工程债清理 + 前端拆分 · **行为不变**）：
  - **`.gitattributes` 落地**：全库 `eol=lf`。本机 `core.autocrlf=true` 且此前没有这个文件 = 检出时会把工作区写成 CRLF，之后动一个 markdown 都是整文件 diff。`.bat/.cmd` 例外，强制 CRLF（cmd 对 LF 的多行块会报语法错）。
  - **修好一个没人发现的坏脚本**：`install-autostart.ps1` 是 UTF-8 **无 BOM**，PS 5.1 按 CP936 解码后，中文注释里的三字节字符让引号配对错位，`Parser::ParseFile` 直接报「字符串缺少终止符」——**它根本跑不起来**，所以自启从没被真正装过（`Get-ScheduledTask SnipDeck-server` 为空佐证）。两个 `.ps1` 都补了 BOM，`.editorconfig` 用 `charset = utf-8-bom` 锁住。字节级复盘见 `00-issues.md` **§0.9 ISSUE-017**。
  - **版本号对齐**：6 个 `package.json` 从 `0.1.0` 改成 `1.7.0`（此前与 Changelog 差 17 个小版本）。
  - **`npm run clean:tmp`**：清 `data/tmp` 下 7 天前的 `run-*.cmd` 与 `*-profile`（CDP 用的 Chrome profile）。四个 UI 脚本改走 `scripts/lib/profile.mjs`，自家 profile 超过 1 天没用就重建。首清释放 **59MB**（6 个目录），`data/tmp` 67MB → 4.1MB。
  - **日志轮转**：`start-server.ps1` 启动前若 `server.log` > 5MB，改名为 `server.log.1`（只留一份；运行中句柄独占改不动，失败只提示不阻塞）。
  - **`.env` 补齐**：值 = 当前实际运行值（`127.0.0.1:7878`），`SNIP_TOKEN` 留空并注释说明。此前只有 `.env.example`，自启路径从未配过。
  - **eslint 9 + typescript-eslint 接入**（`eslint.config.mjs`，`npm run lint`，已串进 `npm test` 的 typecheck 之后）。首跑 14 个 error 全是对规则的误用面（`sw.js` 的 serviceworker 全局、ANSI 正则里的控制字符），配 globals 与单行 disable 后归零；**顺手清掉两处死代码**——`planImport` 里算出来没人用的 `shell`、`test-import.mts` 里没用的 `mkdirSync`。
  - **CI**（`.github/workflows/ci.yml`，windows-latest）：`npm ci` → typecheck → lint → queue / cmd / search / expect / import。smoke 与三个 `ui:*` 要 listener.ahk / Chrome / 在线服务，**不进 CI**。
  - **`App.tsx` 1096 → 570 行**：抽出 `types.ts`、`lib/run-events.ts`（事件→面板的纯函数层，不含 React）、`components/` 下 8 个展示组件（Topbar / Sidebar / SnippetList / RunFormModal / RunDrawer / HistoryModal / SettingsModal / DangerModal）。分层约定：判定与状态在 App，长相在 components，事件语义在 lib。
  - 回归：`npm test` 退出码 0（search 14 / expect 40 / import 60 / smoke 66）、`ui:multi` 49 项、`ui:queue`、`ui:history` 全过——拆分对行为零影响。

- **v1.9**（2026-10-30，把两个问题钉死 + 自启待办入档 · 无行为改动）：
  - **自启写进计划**：新增 §16.1，记清 `SnipDeck-server` 的任务定义（AtLogOn / `-File "…"` 引号不能省 / 电池与重试设置）、「为什么还没装」、**装前必须确认的两件事**（`.env` 的 `SNIP_TOKEN`；有没有手工实例在跑）、验收三条、以及「只管登录后」这个限制。总览加「待办」表做唯一入口。
  - **ISSUE-017 防回归**：新增 `npm run check:ps1`（`scripts/check-ps1.ps1`）——扫全仓 `.ps1`，同时验 **UTF-8 BOM** 与 **`Parser::ParseFile` 语法**，已串进 `npm test`（typecheck → lint → check:ps1）并加进 CI 一步。负例验证过：一个无 BOM 的临时脚本被抓出「缺 BOM + 行 2 字符串缺少终止符」，退出码 1。
  - **死代码防回归**：`@typescript-eslint/no-unused-vars` 从 `warn` 升 `error` —— 之前 `history.ts` 里那个算出来没人用的 `shell` 能活着一整期，就是因为 warn 不会让 CI 变红。负例验证：临时写一个未使用变量，eslint 退非 0。
  - 顺手修 `check-ps1.ps1` 在 npm/CI 管道下的中文乱码（PowerShell 5.1 重定向时按 ANSI 写 stdout，改成 `[Console]::IsOutputRedirected` 时切 UTF-8，直接开窗口跑不受影响）。

- **v1.10**（2026-10-30 08:04，自启装上 · 无代码改动）：
  - **`SnipDeck-server` 计划任务已注册并实测**：`State=Running`、`LogonType=Interactive`、`RunLevel=Limited`、`ExecutionTimeLimit=PT0S`、`LastTaskResult=267009`（0x41301 = 正在运行，非错误）；`curl --noproxy '*' http://127.0.0.1:7878/api/health` 200；日志有 `listening on http://127.0.0.1:7878`。P0 那条「计划任务方式起服务」自此真正闭环——之前只是脚本存在。
  - **顺手挖到一个操作坑并写进 §16.1**：`Stop-ScheduledTask` 只结束任务本身的 powershell，**node 子进程不跟着死、继续占 7878**；此时 `Start-ScheduledTask` 会因 `EADDRINUSE` 静默退出（任务状态仍是 Running，但没有服务）。正确姿势是先 `Get-NetTCPConnection -LocalPort 7878` 确认端口空、必要时 `Stop-Process` 残留 PID，再 Start。重启电脑不受影响。
  - `.env` 维持 `127.0.0.1:7878` 且 `SNIP_TOKEN` 留空——**手机要能用还得改两处**（`SNIPDECK_HOST` 换成 Tailscale 地址 + 填 token），那会改变网络暴露面，没擅自做。

- **v2.0**（2026-10-30，P5 重定义为网页终端 · 撤掉旧 P5 全部产出）：
  - **P5 改性质**：从「驱动扩展」改为「**网页终端**」。旧四项作废——local 驱动（曾实装）、ssh exec 驱动 + 跨机并列、`insert`/`send` 动词、把 PTY 当 P5.4 子项。新方案 = 本机 ConPTY + SSH 会话 + WS + xterm，四段（P5.1 骨架 / P5.2 韧性 / P5.3 SSH / P5.4 片段宏）。新增 [06-terminal.md](06-terminal.md)（§23–§29），`02-roadmap.md` §9.1 改成摘要 + 指针。
  - **撤回已实装的 local 驱动**：全部改动当时尚未提交（17 个已跟踪文件 + 4 个新增），整份 `git stash` 留档（`P5.1 local 驱动…仅留档`），工作区回到 P4。撤完 `npm test` 全绿。`test:queue` 首次跑因冷启动抖动误报（单条 2592ms → 并发/单条 = 1.615 < 1.7 阈值），单独重跑 2097 / 4164ms 通过——**这条断言偏脆**，已知未改。
  - **前置验证三条全过**：node-pty 1.1.0 `npm install` **9s / 2 个包 / 零编译**（win32-x64 prebuild）；ConPTY 在 `SnipDeck-server` 同款 Principal（`Kakyo George` / `Interactive` / `Limited`）的临时任务里 `SPAWN=ok 62ms`；交互式会话写入到命中 **40ms**、`resize(100,30)` 正常；kill 后 `PING_AFTER=0`、`ORPHAN=NO`。脚本与数据在 `data/tmp/pty-probe/`（`RESULT.md`）。
  - **两条环境事实入档**：服务实际跑 `D:\node.js Symllink\node.exe` **v22.17.1**（不是 PATH 里那个 22.22.2；两者 ABI 127 可互通，但换 Node 大版本会让 `.node` 失配）；WS 的 `upgrade` 不进 Fastify `onRequest` hook，终端必须单独鉴权且**不能有 loopback 豁免**。
  - **已知噪音**：`node-pty` 的 `kill()` 会 fork `conpty_console_list_agent`，父进程没有控制台时抛 `AttachConsole failed`（服务把 stdout 重定向到日志正是这种情况）。功能不受影响，但会脏日志；处置定为走 `taskkill /F /T /PID`。

- **v2.1**（2026-10-30，P5.1 终端骨架落地）：
  - 新增 `packages/server/src/sessions.ts`：`Session`（`node-pty` 的 ConPTY + 200KB 环形回滚 + 订阅者）+ `SessionManager`（create / get / list / remove / disposeAll / reapOrphans），三条回收路径（无订阅者 60s 宽限 / 空闲 30min / 启动扫残留 PID 并 `taskkill /T`）。
  - 新增 `packages/server/src/terminal-ws.ts`：挂在 `app.server` 的 `upgrade` 事件上，**手工校验 token、无 loopback 豁免**（进不了 `onRequest` hook）；协议 `ready / output / exit / error` ↔ `input / resize / ping`，`ready` 严格先于任何 `output`。
  - 三条 REST：`POST /api/sessions` / `GET /api/sessions` / `DELETE /api/sessions/:id`；`shell` 白名单 `powershell` / `cmd` / `pwsh`。**没配 `SNIP_TOKEN` 时终端整体 403**，本机也一样。
  - 前端：`TerminalApp.tsx` + `components/Tabs.tsx`，顶栏「片段 / 终端」两个 tab，`/terminal` 独立路由。终端页 **`React.lazy` 懒加载**（不这么做主包从 52.6KB 涨到 509.7KB）；CSS 同步拆成 `terminal.css`。最终主包 gzip **55.92KB**（+3.3），终端 chunk gzip 87.30KB 按需加载。
  - `test:session` **27 条**进 `npm test`（REST 7 / WS 5 / 鉴权 2 / 回收 4 / 宽限期 2 / 清残留 4 / 无 token 3），耗时 3.4s。
  - **修 ISSUE-018**：定时器里 `rmSync` 被环境删除守卫拦下 → `uncaughtException` → 服务直接退出。改 `safeUnlink`（吞异常）+ 整块 `try/catch`，删不掉临时文件不再等于服务故障。
  - 真机实测：1366×768 填充率 1.004 × 0.995、390×844 纵向 0.993；两边都能敲 `echo TERM_PROBE` 并收到结果，无横向溢出。

- **v2.2**（2026-10-30，P5.2 韧性与手机）：
  - **断线重连**：`onclose` 后 800 / 1600 / 3200ms 三次退避，`ready` 到达清零；用 `wsRef.current !== ws` 判断旧连接，避免「主动断开→立刻重连」的竞态误判。
  - **刷新接回同一会话**：`sessionStorage` 记 `snipdeck.term.active`，刷新后接回**这一个**而不是「随便一个 running」；测试断言刷新前后 `data-session-id` 完全相同。
  - **心跳**：20s 发 `ping`、45s 无 `pong` 主动 close——修手机切后台 / 换网时 `close` 事件不来导致的「假在线」。
  - **快捷键盘** 8 键（`Esc` `Tab` 粘滞 `Ctrl` `↑↓←→` `^C`），点完自动 focus 回终端；从 10 键砍到 8 是因为 390 宽实测 `^D`/`^Z` 被挤出屏幕，而它们能由粘滞 Ctrl 得到。
  - **软键盘**：`ResizeObserver` 之外加监听 `visualViewport.resize`。
  - 会话条加状态点与多端附加计数；连接状态四态徽标。
  - `test:session` 27 → **32 条**（新增断线重连 replay、多端附加广播）；CDP 脚本新增 3 组断言（8 键、↑ 调历史、刷新接回）。终端 chunk gzip 88.25KB（+0.95）。

- **v2.3**（2026-10-30 23:30，真机测试后的补修 · **砍掉 SSH**）：
  - **真机测试**：17 步操作（桌面 9 + 手机 5 + 破坏性 2 + 准备 1）全部通过，手机经 Tailscale 直连 `100.99.202.54:7878`，token 鉴权生效（无 token / 错 token 均 401）。
  - **修 ISSUE-019（关会话没真删）**：9 次 `DELETE /api/sessions/:id` 全部 **400**，因为 `req()` 无条件声明 `Content-Type: application/json` 而 DELETE 没有 body（`FST_ERR_CTP_EMPTY_JSON_BODY`）；前端 catch 是空块又照常移除 chip，界面上完全看不出来。修法：只在有 body 时声明 content-type；`close()` 只吞 404，其余错误弹 alert 并保留 chip。CDP 复验 chip 1→0、日志 `DELETE → 200`。
  - **查 ISSUE-020（60s 宽限未回收）**：一个 `attached=0` 的会话活了 12 分钟。**当时会话生命周期一行日志都没有**，无法回溯。补：`create/attach/detach/grace-arm/grace-fire/kill/exit` 全量日志（走 `app.log`）、`detach` 幂等保护（close + error 都挂同一个 detach，重复调用会反复重置宽限定时器）、`kill(reason)` 标来源。修后用**真实 60s** 验两条路径（创建后不连 / 连过再断），均 t=65s 回收，日志闭环。根因未回溯，标「待观察」。
  - **砍掉 P5.3 SSH**：本机终端已覆盖实际需求，SSH 要长期维护 `known_hosts` + 凭据 + 断线语义，换来的是一台不存在的机器。`Session` 的 `kind` 字段与协议留位，将来要接照 §24.1 加一个 `SshSession` 即可。`hosts.yaml` 的 `vps` 保留，仅作 `reserved` 样例。

