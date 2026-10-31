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
- 跨机并列（真并发）仍等 P5 的 ssh 驱动；`home-win` / `vps` 继续灰显。（**2026-10-30 后补**：跨机并列已废弃，改由 P5 终端的多个会话承担，见 [06-terminal.md](06-terminal.md) §23.2。）
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

---

## 30. P5.1 实施记录：终端骨架（2026-10-30）

> 编号说明：§23 原是旧 P5.1（local 驱动）的实施记录，那一期已于 10-30 全量撤回并废弃，编号不复用；P5 的新设计与验收在 [06-terminal.md](06-terminal.md)（§23–§29），实施记录从这里继续。

**这一期做了什么**

| 块 | 具体 |
|---|---|
| 会话内核 | `packages/server/src/sessions.ts`：`Session`（`node-pty` 承载的 ConPTY + 200KB 环形回滚 + 订阅者集合）+ `SessionManager`（create / get / list / remove / disposeAll / reapOrphans） |
| WS 通道 | `packages/server/src/terminal-ws.ts`：挂 `app.server` 的 `upgrade` 事件，**手工校验 token**（不进 `onRequest` hook、无 loopback 豁免），`handleUpgrade` 后走 `ready / output / exit / error` ↔ `input / resize / ping` |
| REST | `POST /api/sessions`（201）、`GET /api/sessions`、`DELETE /api/sessions/:id`；`shell` 走白名单（`powershell` / `cmd` / `pwsh`） |
| 前端 | `TerminalApp.tsx` + `components/Tabs.tsx`：顶栏「片段 / 终端」两个 tab，`/terminal` 独立路由，`xterm` + `fit` + `ResizeObserver`，会话条（新建 / 切换 / 关闭） |
| 回收 | 三条路径：无订阅者 60s 宽限、空闲 30min、启动时扫 `data/tmp/sessions/*.json` 对残留 PID 做 `taskkill /T`（先用 `tasklist` 核映像名，防 PID 复用误杀） |
| 测试 | `test:session` **27 条**（REST 7 / WS 5 / 鉴权 2 / 回收 4 / 宽限期 2 / 清残留 4 / 无 token 3），已串进 `npm test` |

**验收实测**

| 项 | 结果 |
|---|---|
| `npm test` | 全绿：check:ps1 3 个合格、queue 14、cmd 40、expect 60、smoke 66、session **27** |
| `test:session` 耗时 | **3.4s**（真起 PTY、真 listen、真 taskkill） |
| 桌面 1366×768 | `.xterm` 挂上；填充率 横向 1.004 / 纵向 0.995（xterm 按字符格取整，1.0 是理想值）；徽标「已连接」；`echo TERM_PROBE` 回显 + 结果都在；页面无横向溢出 |
| 手机 390×844 | 同上通过，纵向填充率 0.993；顶栏四个元素与三件会话控件都不换行、不溢出 |
| 体积 | 主包 `index.js` 170.03KB（gzip **55.92KB**，P2.5 是 52.61，+3.3KB）；终端 `TerminalApp.js` 340.42KB（gzip 87.30KB）**懒加载**；CSS 同样拆成 13.09KB + 7.75KB |
| 会话回收 | DELETE 后目标 PID 从 `tasklist` 消失；「创建了没人连」在宽限期后自行退出（用 `graceMs=800` 的短版验，不真等 60s） |

**与设计/直觉不一样的取舍**

1. **没配 `SNIP_TOKEN` 就没有终端，本机也一样。** 三条 REST + WS 全部 403。这不是洁癖：WS 的 `upgrade` 不进 hook，一旦留 loopback 豁免，反代转进来的请求就等于 remote shell。代价是本机用终端前得在 `.env` 里填个 token——与片段页「本机免 token」不一致，是有意为之。
2. **终端页必须懒加载，CSS 也要拆。** 第一版把 `xterm` 打进主包，JS 从 52.6KB 涨到 **509.72KB**（gzip 142.84），手机打开片段页要多下 87KB。改成 `React.lazy` + 独立 `terminal.css` 后，主包只涨 3.3KB。
3. **`ready` 必须先于任何 `output`。** 天真写法是先 attach 再发 `ready`，那样 attach 与 `ready` 之间的增量会先到，前端再用 `replay` 覆盖一次，屏幕顺序就乱了。现在做法是「同步取快照 → attach → 发 ready → 补发缓冲」——同一轮事件循环内完成，pty 回调插不进来。
4. **kill 走 `taskkill /F /T`，不用 `p.kill()`。** 后者内部 fork `conpty_console_list_agent` 去 `AttachConsole`，服务把 stdout 重定向到日志文件时必然抛 `AttachConsole failed`（§28 实测过）。另加 3s 兜底：taskkill 成功但句柄不回收时，把状态标成 exited，别让界面永远转圈。
5. **会话不进 `Driver` 接口。** 这是 06-terminal.md §23 定的调子，落代码时也确实没有一处复用 `RunRequest` / `RunEvent`——两边唯一的交集是「输出解码」，而 PTY 输出本来就是 UTF-8，连这个都用不上。
6. **`childEnv()` 摘掉 `SNIP_TOKEN`。** 终端里一句 `echo $env:SNIP_TOKEN` 就能把服务凭据打出来，而那个凭据同时是别的设备进 `/api` 的钥匙。子进程只拿到其余环境变量。

**踩到的坑：定时器里删文件把服务删崩了（ISSUE-018）**

第一版 `removePidRecord` 用 `fs.rmSync`，在一次真机验证中被环境的删除守卫拦下并抛错；调用栈在 `setInterval` 的回调里 → `uncaughtException` → **整个服务直接退出**，日志里连一条正常报错都没有。

修法三条，都在 `sessions.ts`：

- `removePidRecord` 改 `unlinkSync` + 全吞异常（pid 记录删不掉最坏是下次启动多扫一个文件）；
- `idleTimer` 的回调整体 `try/catch`（一次回收失败不该拿整个服务赔）；
- `reapOrphans` 里三处 `rmSync` 一并换成 `safeUnlink`。

**已知缺口**

- 只有本机；SSH 会话（`ssh2` 的 `shell()`）在 P5.3。
- 没有断线重连：WS 一断就是「连接已断开」，要手动点会话重连（P5.2）。刷新页面能接上，靠的是服务端 60s 宽限 + `replay`，不是前端重连。
- 手机软键盘弹起后的 `resize` 没在真机验过（headless 没有软键盘），只在 CDP 尺寸切换下验了 `ResizeObserver`。
- 会话数没有上限：连点「+ 新建」能开出任意多个 PTY，每个都是一个真 powershell。要做上限得先定「几个算多」。
- `pwsh` 在没装 PowerShell 7 的机器上创建会 500（错误信息带出来了，但界面只是弹一条 alert）。
- 关页面→60s 回收这条只在短 `graceMs` 下验过，没有真等 60s 走一遍端到端。

---

## 31. P5.2 实施记录：韧性与手机（2026-10-30）

**这一期做了什么**

| 块 | 具体 |
|---|---|
| 断线重连 | `onclose` 后按 **800 / 1600 / 3200ms** 退避重连，三次不成才认输；`ready` 到达即把重试计数清零 |
| 刷新接回 | `sessionStorage` 记 `snipdeck.term.active`，刷新优先接回**这一个**；找不到才退到「随便一个 running」，再没有才新建 |
| 心跳 | 每 20s 发 `ping`，**45s 没收到 `pong` 就主动 close** 触发重连——手机上切后台 / WiFi 换 4G 时 `close` 事件可能永远不来（半开连接） |
| 快捷键盘 | 8 个键：`Esc` `Tab` `Ctrl`（粘滞）`↑` `↓` `←` `→` `^C`；点完自动把焦点还给终端，软键盘不会收起来 |
| 软键盘适配 | 除 `ResizeObserver` 外再监听 `window.visualViewport.resize`——键盘弹起时 viewport 先变，`100dvh` 未必跟得上 |
| 会话条 | 状态点（running 绿 / exited 灰）、多端附加时显示 `·N`、chip 带 `data-session-id`（回归脚本靠它比对刷新前后是不是同一个会话） |
| 连接状态 | 四态徽标：`已连接` / `连接中…` / `重连中…` / `已断开`。琥珀色表示「正在连」，不是故障 |

**验收实测**

| 项 | 结果 |
|---|---|
| `npm test` | 全绿；`test:session` **32 条**（新增 5 条：断开前有输出 / 重连拿到 ready / replay 含断开前内容 / attached 计到 2 / 一端输入另一端看得到） |
| 桌面 1366×768 | 填充率 1.004 × 1.023；快捷键盘 8 个；点 `↑` 从 PSReadLine 历史里调出上一条命令 |
| 手机 390×844 | 8 个键全部在屏内、无截断、无重叠；同样能点 `↑` 调历史 |
| 刷新接回 | 刷新前后 `data-session-id` **完全相同**（`8ff06366…` / `0ee4e294…`），且 `.xterm-rows` 里仍能看到刷新前敲的 `TERM_PROBE` —— 说明接回的是同一个会话、replay 生效 |
| 多端附加 | 两个 WS 同时挂一个会话，`attached=2`，一端输入另一端即时看到 |
| 体积 | 终端 chunk gzip 87.30 → **88.25KB**（+0.95，重连/心跳/键盘都在这块里）；主包不变 |

**与设计/直觉不一样的取舍**

1. **重连只给三次，不做无限重试。** 服务重启或会话被回收时，重试一百次也是白重试，而界面上会永远停在「重连中」——比直接告诉你「断了，新建一个」更糟。
2. **用 `wsRef.current !== ws` 判断「这条 close 是不是旧的」，不用 `closing` 标志。** 标志位在「主动断开 → 立刻建新连接」这条路径上有竞态：旧 socket 的 close 回调可能在新连接建立之后才跑，那时标志已经复位，就会误判成掉线去重连。拿对象身份比对没有这个窗口。
3. **心跳超时 45s 比心跳间隔 20s 长两倍多。** 宁可多等一轮，也不要因为一次抖动就重连——重连会 `reset` 屏幕再灌 replay，虽然内容不丢，但视觉上会闪一下。
4. **键盘从 10 个减到 8 个。** 第一版带 `^D` `^Z`，390 宽实测这两个被挤出屏幕（`overflow-x` 能滚，但没有任何提示，等于不存在）。而它们完全能由「粘滞 Ctrl + 字母」得到，`^C` 因为太常用才单独留。
5. **粘滞 Ctrl 拦在 `term.onData` 里，不拦键盘事件。** onData 拿到的是「已经过输入法、已经算好编码」的字符，中文输入法和手机软键盘都走这条路；拦 keydown 会在 Android 上漏掉一部分输入。
6. **重连成功后仍然 `reset` 再灌 replay。** 不 reset 的话，重连期间服务端可能已经产出新内容，增量接在旧屏后面会重复一段。代价是滚动位置丢失——但 `replay` 只有 200KB，本来也回不到更早。

**已知缺口**

- **重连期间敲的字会丢**：没有输入缓冲队列。断线那几秒里按键直接掉，重连后不会补发——补发比丢弃更危险（可能重复执行）。
- **软键盘弹起后的 resize 只在 CDP 尺寸切换下验过**，真机（尤其 iOS Safari）没验。`visualViewport` 的 `resize` 在 iOS 上还要配 `scroll` 才能跟住，可能要再加一条。
- 多端附加时没有「谁是主控」的概念：两边都能敲，同时输入会交错。单用户场景下可接受，没做。
- 会话数仍无上限。
- 移动端切回来时的重连有 0–20s 的心跳空窗（取决于断开时离下次 ping 多久），最坏等 45s 才认死。
- **手动清 `data/tmp/sessions/*.json` 之前先确认没有活着的 shell**：那批记录是 `reapOrphans` 唯一的线索，先删记录再留孤儿，下次启动就没法认领它们了（实测踩过一次）。正确顺序是「先杀进程，再删记录」，或者干脆不删、交给启动时清理。

**真机测试后的补修（2026-10-30 23:30）**

用户按 17 步清单手测，反馈「全部正常」。查日志推翻了其中一步，并发现一处没被日志记录的行为：

| 问题 | 现象 | 处置 |
|---|---|---|
| **ISSUE-019** 关会话没真删 | 9 次 `DELETE /api/sessions/:id` **全部 400**（`FST_ERR_CTP_EMPTY_JSON_BODY`）。前端 catch 是空块 + 照常移除 chip，所以界面上「删成功了」 | `req()` 只在有 body 时声明 content-type；`close()` 只吞 404，其余错误弹 alert 并保留 chip。修后 CDP 实测 chip 1→0、日志 200 |
| **ISSUE-020** 60s 宽限没回收 | 一个 `attached=0` 的会话活了 **12 分钟**，直到服务重启才被 `reapOrphans` 收掉 | 会话生命周期日志 + `detach` 幂等保护 + `kill(reason)`。修后两条路径在**真实 60s** 下均 t=65s 回收（日志闭环 `grace-arm → grace-fire(kill=true) → kill(grace) → exit`）。**根因未回溯**，因为当时一行日志都没有 |

顺带补的一件：`Session` / `SessionManager` 现在有完整生命周期日志（`create` / `attach` / `detach` / `grace-arm` / `grace-fire` / `kill` / `exit`），走 Fastify 的 `app.log`。在此之前，终端连上了没、断了没、被谁回收的，日志里一个字都没有——这也是 ISSUE-020 查不下去的直接原因。

---

## 32. P5.4 实施记录：片段宏注入终端（2026-10-31）

**这一期做了什么**

| 块 | 具体 |
|---|---|
| 面板 | 新组件 `components/MacroPanel.tsx`：列表（按分组、搜索标题/id/分组/标签）→ 点一条进详情 → 变量表单 + 命令预览 → 「插入到终端」 |
| 入口 | 终端工具条加「片段…」按钮（`data-open-macro`），首次打开才拉 `/api/snippets`，之后复用 |
| 渲染 | 复用服务端的 `POST /api/snippets/:id/preview`，变量改一下 250ms 防抖重算。**不在前端自己拼字符串**——secret 打码、缺变量提示、宽松渲染都在服务端，两套逻辑迟早不一致 |
| 插入 | `sendInput(cmd)`，**不补回车**；另一个按钮「插入并执行」才补 `\r` |
| 多步片段 | `cmds.length > 1` 直接禁用插入并说明原因（见下） |
| 手机 | 面板在 ≤640 改成底部 sheet（全宽、上方圆角、`env(safe-area-inset-bottom)`） |

**验收实测**

| 项 | 结果 |
|---|---|
| 面板内容 | 16 条片段 / 5 个分组 / 搜索框都在 |
| 变量渲染 | 点 `run-backtrans` → 1 个变量下拉（壳编号，默认 1）→ 预览出 `call C:\ahk_trigger\ahk.bat shell shell#1 C:\ahk_trigger\launchers\backtrans.bat`，**无 `{{}}` 残留** |
| 插入 | 面板关闭，命令出现在终端提示符后面，**提示符仍只有一个**（= 没执行） |
| 桌面 1366 | 居中弹窗 560px，布局无溢出 |
| 手机 390 | 底部 sheet，命令折成 3 个视觉行仍完整，按钮可点，底部有安全区留白 |
| 体积 | 终端 chunk gzip 88.28 → **89.94KB**（+1.66）；CSS +0.6KB |

**与设计/直觉不一样的取舍**

1. **默认不回车，是这一期最重要的决定。** `insert` 与 `run` 之间的选择，实质是「误执行的代价」和「多点一次的代价」二选一。终端里误执行的代价高得多（可能是 `rm`、可能是 `git reset`），所以主按钮只插入，「插入并执行」放次要位置且文案写清。
2. **多步片段不给插入。** 片段里多条 `run` 步骤在 PowerShell 里能用 `;` 连，在 cmd 里不行；按 shell 判断连接符等于把片段语义复制一份到前端。与其猜，不如让它回片段页跑——那边有真队列和档案。
3. **复用 `preview` 接口而不是前端渲染。** 前端已经有 `renderTolerant` 的等价逻辑吗？没有，也不该有。secret 打码（`***`）只在服务端做过，前端再写一遍迟早漏。
4. **没复用 `RunFormModal`。** 它绑死了目标选择器（chips + reserved 置灰 + 多开），而终端里根本没有「目标」这个概念——会话已经决定了在哪台机器上。硬套会让用户填一堆用不上的东西。
5. **手机改成底部 sheet。** 第一版沿用桌面的居中弹窗，390 宽下底部提示被屏幕边缘切掉；改成全宽底部 sheet + 安全区留白后正常。

**已知缺口**

- **只认第一条命令**：多步片段直接禁用，而不是「插入前 N 条」。如果以后要支持，得先定连接符规则。
- 没有「最近用过」/ 收藏：片段多了之后每次都要搜。
- 不显示 `danger` 二次确认：插入不执行，风险低；但「插入并执行」那颗按钮对 danger 片段理论上该确认一次，现在没有。
- 列表没做虚拟滚动：16 条无所谓，涨到几百条会卡。
- 桌面窗口很窄（<720px）时面板和终端都在挤，没专门适配。


## 33. P6 实施记录：片段 CRUD + 结构化表单（2026-10-31）

**这一期做了什么**

| 块 | 具体 |
|---|---|
| 写入层 | 新增 `packages/core/src/snippet-write.ts`：`saveSnippet` / `deleteSnippet` / `safeSegment` / `snippetPath` / `serializeSnippet` / `verifySerialized`。路径守卫、原子写、序列化自检、mtime 冲突、id 唯一四件事全在这一层，路由只管把 JSON 收敛成 draft |
| 路由 | `GET /api/snippets/:id/detail`、`POST /api/snippets`、`PUT /api/snippets/:id`、`DELETE /api/snippets/:id`。`PUT` 的 `body.id` 与 URL 不同即改名（文件跟着搬） |
| 鉴权 | **方案 D**：删掉 `isLoopback(req.ip)` 那条放行分支，保留 `!token`。有 token 就一律校验（本机也不例外），没 token 时靠 `server.ts` 已强制的「只能绑 loopback」兜底 |
| 编辑器 | 新组件 `components/SnippetEditor.tsx`：id / 标题 / 分组（datalist）/ 目标 / shell / 标签 / danger / vars 行表 / steps 卡片（run / sleep / expect 三种分支）/ meta 键值行。删除是「点一次换文案、再点才删」 |
| 原文模式 | 编辑器顶部「表单 / 原文」两个 tab。原文用 `GET /api/snippets/:id/raw` 读盘上文本，`PUT .../raw` 逐字落盘——**不经过 `stringify`**，所以注释、字段顺序、`>` 折叠块全保住。左侧行号列与正文共用字号/行高/padding，滚动同步 |
| 另存副本 | 「另存副本」按 `<id>-copy` 新建一条。**不自动找不重复的 id**——撞了就让服务端回 409 说清楚，悄悄改成 `-copy2` 只会让人下次找不着 |
| 入口 | 顶栏 `＋` 新建（快捷键 `N`）、卡片右下角 `✎`（快捷键 `E`）、保存/删除后底部 toast 回执 |
| 验收脚本 | 新增 `npm run test:session-reap`：**真 60 秒**宽限期跑「没人连 / 连上后断开」两条回收路径，**不进 `npm test`**（跑一次 70s） |
| UI 工具 | `scripts/lib/token.mjs`：UI 脚本从 `.env` 读 token 并注入（方案 D 之后不注入就只会截到 401 横幅）。四个 UI 脚本全部接上 |

**验收实测**

| 项 | 结果 |
|---|---|
| `npm test` | **103 通过，0 失败**（原 66 + CRUD 28 + 原文 9 条） |
| 新建 | `POST` → 201，`snippets/状态/zz-probe-save.yaml` 落盘，索引立刻可见（不等 watcher 去抖） |
| 数字保持数字 | 接口传 `default: 1` / `choices: [1,2,3]`，落盘仍是 `default: 1`，没变成 `'1'` |
| 改名 | `PUT` body.id 换掉 → 200 `renamed=true`，旧文件消失、新文件在、索引无残留 |
| 冲突 | 旧 mtime → 409，且**文件内容一个字没动** |
| 覆盖 | 同路径保存前后各留一份 `.bak` |
| 删除 | 200，卡片消失，`snippets/.trash/zz-probe-save-<时间戳>.yaml.txt` 有副本，且不被当成片段加载（列表仍 16 条） |
| 穿越 | `id: "../../evil"` + `group: "../.."` → 落点仍在 `snippets/` 内（`.._` / `.._.._evil.yaml`） |
| 编辑器几何（桌面 1366×900） | 760×810 居中，`editor-grid` 两列 352+352，19 个输入控件 **0 溢出**，底部按钮 sticky（滚到顶仍可见） |
| 编辑器几何（真 390×844） | 宽 390 正好贴边，底部 sheet，变量行 2×3 成组，`docNoHScroll: true` |
| 原文保真 | 加一行 `#` 注释 → 保存 → 读回，注释还在；`onDisk.trim() === 提交文本.trim()`（**逐字一致**，这条只有原文路径能过） |
| 原文校验 | `id: [unclosed` → 400 且 body 含「第 1 行第 6 列」；文件内容一个字没动 |
| 原文改名 | 文本里改 `id` → 200 `renamed=true`，旧文件消失 |
| 另存副本 | 点一下生成 `<id>-copy`，内容一致，可单独删除 |
| UI 回归 | `npm run ui:editor` **26 项**，1366 与真 390 双过（含行号对齐：同 `font-size` / `line-height` / `padding-top`） |
| 体积 | 主包 gzip 55.92 → **60.04KB**（+4.12，编辑器进主包）；CSS 3.31 → 3.90（+0.59）；终端 chunk 仍 89.94 按需加载 |
| 会话回收（真 60s） | 两条路径都在 **62s** 内回收，日志 `grace-arm → grace-fire(kill=true) → kill(reason=grace)` 完整 |

**与设计/直觉不一样的取舍**

1. **编辑形态选了结构化表单，代价写清楚**：保存会重排整份 YAML，注释、字段顺序、引号风格都不保留（`meta.note` 的 `>` 折叠块会变成普通多行串）。内容保真，形式不保真。选它是因为字段多、手机上要能改；原文 YAML 编辑留到以后。
2. **`meta` 里非字符串的值在表单里不展示**：数字、对象、数组进 `hiddenMeta`，保存时原样带回。表单里没有合适的控件，而「把对象拍平成 `[object Object]`」这种静默损坏比「看不到」糟得多。**要改这些值就切「原文」**——这也是后来补原文模式的直接原因之一。
3. **`id` 是全库唯一，不只是目录内唯一**：第一版只检查目标文件是否已存在，于是「先建 `状态/smoke-new.yaml`、再建不带 group 的同 id」会落成两份。`loadSnippets()` 只保留先加载的那份、另一份 quarantine——界面看着正常，实际改了不生效。现在写前先扫一遍索引（ISSUE-022）。
4. **`assertInside` 的判断不能写 `startsWith('..')`**：一个叫 `.._` 的合法目录名也会命中。第一版就这么写的，被穿越用例当场抓出来（ISSUE-021）。
5. **`safeSegment` 把 `.` 也换掉**：`..` 在路径里是上跳、在 Windows 上是非法结尾，而 `.._` 这类残留名能绕过只检查前两个字符的判据。宁可用下划线。
6. **`mtimeMs` 冲突检测是「便宜但值钱」的一件**：编辑器开着的时候文件被 VS Code 改掉、被 `git pull` 覆盖，是真实会发生的。加它只花了 ~20 行，省下的是「一次保存吃掉别人半小时」。
7. **删除的二次确认不用 `window.confirm`**：项目里所有确认都是自己的弹窗；用 `confirm` 会阻塞事件循环、手机上是浏览器原生样式，和其余交互不像一个东西。
8. **`test:session-reap` 不进 `npm test`**：80 秒的测试没人会在提交前跑。它验证的是「60 秒这个量级上定时器仍会 fire」，主测试里的 800ms 缩短版验证的是「定时器逻辑对」——两件事，不能互相替代（ISSUE-020 的原始故障就是缩短版过了、真实时长没过）。
9. **两条写路径共用 `persist()`，但校验各自独立**：表单校验对象，原文校验文本（还要带行列号）。把落盘（目标定位 / mtime / id 占用 / `.bak` / 原子写 / 删旧文件）抽成同一个函数，是因为**这些事少做一样就是静默丢数据**；而校验不能合并，合并的结果必然是「原文也被 stringify」。
10. **原文模式的行号列不是装饰**：服务端报「第 12 行第 3 列」，没有行号用户只能自己数。行号与正文必须共用 `font-size` / `line-height` / `padding-top`，差一点第一行就错位——UI 回归里专门有一条断言钉它。

**已知缺口**

- ~~没有原文编辑~~ **已做（10-31 第二轮）**：编辑器切「原文」就是逐字编辑。表单模式仍然会重排——两条路径并存，各自说清楚。
- **保存即重排**：同一份内容改一个字，diff 可能是整段。想 diff 友好只能不做表单（或改成 `doc.setIn` 逐字段改，但 `steps` 是数组，增删一步必然整体重写）。
- **没有「复制片段」**：新建一条相似的还得从头填。
- **`meta` 的非字符串值在表单里不可编辑**：对象/数组进 `hiddenMeta` 原样带回，要改只能切「原文」。
- **手机顶栏隐藏了品牌名**：390 宽下「品牌名 + 4 个按钮 + 状态徽标」挤不下，tab 会被压到竖排。现在手机上只留 `{}`。
- **UI 脚本的视口一直是错的**：`Emulation.setDeviceMetricsOverride` 在 `--headless=new` 且 `mobile: true` 时，若不给 `screenWidth/screenHeight`，`innerWidth` 会落在真实窗口宽（427）而只有 `visualViewport` 是 390。这意味着 **2026-10-31 之前所有写「390 验收」的地方，实际量的是 427**。已补 `screenWidth/screenHeight`（ISSUE-024）；要量布局仍建议用 `mobile: false`（`npm run ui:editor` 就是这么做的）。

## 34. 维护期收尾（2026-10-31，不进新功能）

**背景**：P0–P6 完成后，`SnipDeck-PLAN.md` 的「待办」表四行全部划线。检查代码与 CI 后发现三处「不做不会立刻坏、但会慢慢烂」的地方。这一节记的是**没写进 plan 就顺手做掉**的部分；写进 plan 的三条（CI 接 smoke、§12-1 重写、定时执行入待定）在 `02-roadmap.md` §12。

| 项 | 做了什么 | 为什么 |
|---|---|---|
| `data/tmp` 174MB | `clean:tmp` 增加第三类清理：`pty-probe/node_modules`（P5 前置验证装过的 node-pty，63MB）。实清 **145MB**（8 个 Chrome profile 约 72MB + 依赖 63MB + 若干 `run-*.cmd`） | 原脚本只管 `run-*.cmd` 与 `*-profile`，而 P5 的探针目录里躺着一个 63MB 的依赖树。**探针脚本本身留着**（文档引用了它），只删依赖——需要时 `npm install` 重装 |
| CLI 只能跑不能看 | 新增 `snip cat <id>`（打印原文）与 `snip edit <id>`（`$VISUAL` / `$EDITOR`，缺省 notepad / vi） | `snip list` 只给摘要，想看一条片段到底写了什么只能去翻文件。`edit` 用 shell 执行是为了 `code -w`、`subl -n -w` 这类带参数的编辑器 |
| 跑完不知道结果 | `document.title` 反映最近一次运行：运行中 `⏳ 1/2 · SnipDeck`，结束 `✓ 2/2` / `✗ 1/2` | 手机锁屏或人在别的标签页，抽屉看不见。改标题不依赖任何权限，切回来一眼就知道 |

**一条被卡住的判断**：本来想用 `Notification` API 做真通知，发现它和 service worker 一样**只在安全上下文可用**——手机现在访问的是 `http://100.99.202.54:7878`，那条路走不通。所以「跑完通知」这件事实际被 HTTPS 卡着，标题变化只是退而求其次。这让 `02-roadmap.md` §12-1 那条决策的优先级更高了：**它不只是「要不要省 token」，还决定 PWA 与通知能不能真生效**。

**验收**：`snip cat open-shell` 打出完整原文（含 `>` 折叠块）；`npm run ui:shot -- <url> 1366 900 out.png "check-status"` 跑完后 `document.title` = `✓ 1/1 · SnipDeck`；`npm run clean:tmp -- --days 0` 释放 145.1MB，`data/tmp` 174MB → 24MB。
