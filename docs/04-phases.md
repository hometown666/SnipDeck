# SnipDeck · 分期实施记录（§17 – §22）

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · 设计 [01-design.md](01-design.md) · 路线图 [02-roadmap.md](02-roadmap.md) · 参考 [03-reference.md](03-reference.md) · Issue 队列 [00-issues.md](00-issues.md) · 变更日志 [05-changelog.md](05-changelog.md)
>
> 覆盖原 `SnipDeck-PLAN.md` 的 **§17 – §22**：P1、P2、P2.5（设计与实施）、P3、P4 的逐期记录——做了什么、实测数据、与设计的偏差、有意为之的取舍、已知缺口。
>
> 每一期的结构是固定的：**这一期做了什么 → 验收实测（数字/几何/耗时）→ 与设计或直觉不一样的取舍 → 已知缺口**。查「当时为什么这么做」看第三节，查「还差什么」看第四节。
>
> **章节编号全局不变**：文中 §0.x 见 `00-issues.md`，§1–§8 见 `01-design.md`，§9–§12 见 `02-roadmap.md`，§13–§16 见 `03-reference.md`。

---

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

**复验补修（2026-10-30 凌晨）**：P4 真跑复验又挖出 8 条，全部已修，现场与修法见 §0.7 / §0.8。值得一提的是两条根因都不在「逻辑写错」，而在**输入假设**：桥的文件是 UTF-16 LE（不是 UTF-8），正则执行是不可中断的同步调用（所以 `timeout` 形同虚设）。

