# SnipDeck · 路线图、风险、安全与待定项（§9 – §12）

> 总览 [../SnipDeck-PLAN.md](../SnipDeck-PLAN.md) · 设计 [01-design.md](01-design.md) · Issue 队列 [00-issues.md](00-issues.md) · 参考 [03-reference.md](03-reference.md) · 实施记录 [04-phases.md](04-phases.md) · 变更日志 [05-changelog.md](05-changelog.md)
>
> 覆盖原 `SnipDeck-PLAN.md` 的 **§9 – §12**：路线图与验收（P0–P5 及实际执行顺序）、风险与预案、安全模型、待定项。
>
> **章节编号全局不变**：文中 §0.x 见 `00-issues.md`，§1–§8 见 `01-design.md`，§13–§16 见 `03-reference.md`，§17–§22 见 `04-phases.md`。
>
> 改路线图时同步看一眼 §11 安全模型与 §12 待定项——`tailscale serve` 那条待定项挂着一个鉴权前置条件，不是纯排期问题。

---

## 9. 路线图与验收

| 期             | 内容                                                                                 | 验收标准（可自己动手验）                                                                   |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **P0** 技术验证   | Monorepo 骨架；exec 驱动 spawn `ahk.bat status` 跑通；Fastify + SSE 一条 run 事件流；`scripts/start-server.ps1` + `install-autostart.ps1`（登录时计划任务、读 `.env`、日志落 `data/logs/server.log`）。<br>注：`install-autostart.ps1` 因缺 BOM 曾完全不可执行（§0.9 ISSUE-017，2026-10-30 已修）；计划任务已于 **2026-10-30 08:04 注册并实测**（`State=Running`、health 直连 200，见 §16.1）   | `npm test` 全绿；手机走 Tailscale 打开网页，点 `check-instence` 看到实例表；服务重启后片段索引自动重建                      |
| **P1** 内核     | `core` 片段模型 + YAML 读写 + 索引 + 校验/quarantine；exec 驱动（双模式 + 串行队列 + 健康检查）；CLI；16 条存量迁移 | ✅ 2026-10-24 完成：`snip run` 带变量真的点中实例（notepad 回环实测）；改/删 YAML 1s 内索引变化；flag 为下拉（choices [0,1,2]）。记录见 §17 |
| **P2** Web 界面 | 片段面板 + 变量表单 + 运行抽屉 + 输出查看 + 队列可视化 + 手机布局 + PWA                                     | ✅ 2026-10-24 完成：手机 390×844 仿真下点卡片出表单（4 字段）、点只读片段出抽屉（7 行、完成 0.1s）；队列显示「排队 N / 等待 Xs」。记录见 §18 |
| **P2.5** 电脑端 UI | 桌面布局（左侧分组栏 + 多列网格 + 内容宽上限）；抽屉改**右侧全高面板**；输出区字体与排版重做（CJK 等宽栈、不折行、管道表对齐）；桌面快捷键 | ✅ 2026-10-29 完成：CDP 实测 1920/1366 无横向溢出、4 列、标题 nowrap、抽屉 720×全高（`top:0`）、`white-space:pre`；390 手机态不退化（单列、底部抽屉）。实施与偏差见 §20。**已稳定**：复验遗留 ISSUE-005（390 多目标头部折行）已修，回归见 §0.5 / `npm run ui:multi` |
| **P3** 多目标（数据结构） | `targets[]` 数组 + 目标选择器 + reserved 置灰 + **同目标多开**（串行、结果并列、事件按目标打标） | ✅ 2026-10-29 完成：选 2 个 `win-desktop` 得到两块并列面板（`win-desktop #1/#2`），事件带 `target`/`targetIndex` 且严格串行（冒烟实测总耗时 4.4s ≈ 单条 ×2）；`home-win` / `vps` 灰显、开流前 400。实施与偏差见 §21。**已稳定**：复验遗留 ISSUE-006 / 007 / 008 均已修（宽度 / 上限与错误呈现 / 可达性），回归见 §0.5。**跨机并列不在本期**，见 P5 |
| **P4** 打磨（**已完成 10-30**） | `expect` 条件步；从 shell 历史导入；运行历史落盘（`runs/<id>.jsonl`）+ `/api/runs` + 抽屉回放。*secret 变量 / danger 二次确认 / bridge 预览已在 P1–P2 落地* | 新机器上 30 分钟导入历史并跑通一条；`expect` 超时判失败；断开 SSE 后仍能回看上次运行。**实测见 §22** |
| **P5** 网页终端（**2026-10-30 重定义**） | 浏览器里的真终端：本机 ConPTY + SSH 会话，四段见 §9.1。旧的「驱动扩展」方案（local 驱动 / ssh exec / `insert`+`send`）已废弃 | 手机开 `/terminal` 敲 `dir` 有回显；关页面子进程回收干净；远端 SSH 可用。**设计与验收全在 [06-terminal.md](06-terminal.md)** |

执行顺序调整为 **P4 → P3 → P5**：P3 的卖点是「一条片段投多台」，但第二台可达主机只能靠 ssh（P5）——`home-win` 的 `local` 驱动是同一台机器，激活它也不产生「多台」。所以先做不依赖新驱动的 P4 打磨；P3 缩到数据模型 + 同目标多开（只有一个可选项时，选择器做了也看不出效果，等 P5 临近再补）；跨机并列的验收整条挪进 P5。P2.5 已于 10-29 完成，排在这两者之前。
>
> **2026-10-30 后补**：跨机并列随旧 P5 一起废弃——终端用「多个会话并排」满足同一诉求，不做「一条命令广播到多台」。理由见 [06-terminal.md](06-terminal.md) §23.2。

> **实际执行**：P2.5 之后先做了 P3（10-29 完成，见 §21），随后回补 §0.5 的四条问题（§0.6），P4 于 10-30 完成（见 §22）。P3 做完仍只有 `win-desktop` 一个可执行目标，选择器的价值确实要等 P5 才完全兑现——这段时间它最大的用处是「同一条命令连跑两次做对照」（比如点下坐标前后各看一次实例表）。

### 9.1 P5 网页终端（2026-10-30 重定义）

**旧的「驱动扩展」方案已整体废弃。** local 驱动（旧 P5.1，曾实装）、ssh exec 驱动 + 跨机并列（旧 P5.2）、`insert`/`send` 动词（旧 P5.3）全部砍掉；旧 P5.4 的 PTY + xterm 升为 P5 主体。已实装的 local 驱动代码撤进 `git stash` 留档（`P5.1 local 驱动…仅留档`），工作区回到 P4 状态，`npm test` 全绿。砍的理由见 [06-terminal.md](06-terminal.md) §23。

| 段 | 内容 | 状态 |
|---|---|---|
| **P5.1** | `SessionManager` + 本机 ConPTY（powershell / cmd）+ WS 通道 + 最小 xterm 页（能敲、能看、能 resize） | 未开工 |
| **P5.2** | 回滚缓冲（200KB）+ 断线重连 + 三条回收路径 + 手机快捷键盘 + 会话条 | 未开工 |
| **P5.3** | SSH 会话（`ssh2` 的 `shell()` channel，**不是 `exec()`**）+ `known_hosts` 校验 | 未开工 |
| **P5.4** | 片段宏注入当前终端（点一下发命令行，再点执行） | 未开工 |

**前置验证已完成（2026-10-30 实测，全部通过）**：node-pty 1.1.0 零编译装好（9s / 2 个包）；ConPTY 在 `SnipDeck-server` 同款计划任务会话里起得来（`SPAWN=ok 62ms`）；交互往返 **40ms**；kill 后子孙进程回收干净（`ORPHAN=NO`）。完整数据与复现脚本见 [06-terminal.md](06-terminal.md) §28。

**三条实现硬约束**：

1. **WS 的 `upgrade` 不进 `onRequest` hook** —— 必须单独校验 token，且**没有 loopback 豁免**。与 §12-1 是同一个坑，但终端漏了就是送 remote shell（见 06-terminal.md §25.2）。
2. **服务跑的不是 PATH 里那个 node**：实际是 `D:\node.js Symllink\node.exe` v22.17.1（ABI 127），而 `node -v` 给 22.22.2。原生模块按前者对齐，换大版本会让 `.node` 失配。
3. **kill 走 `taskkill /F /T /PID`**，不用 `p.kill()`（`AttachConsole failed` 噪音，见 06-terminal.md §25.4）。

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

（v0.1 的 ConPTY 风险随交互终端移出而消失；P5 重定义为网页终端后已重新评估——原生模块、ConPTY 会话、WS 鉴权三条都实测过，结论与数据见 06-terminal.md §28。）

---

## 11. 安全模型

- **网络边界靠 Tailscale**：只监听 Tailscale 接口（或 `tailscale serve` 拿 HTTPS + 身份头），不做公网端口映射。
- **单一 token 准入**：首次在本机 loopback 生成 token，手机扫码配对后写 cookie（搬 TxtTunnel 的做法）。
- **终端不吃 loopback 豁免**：WS 的 `upgrade` 事件不经过 Fastify 的 `onRequest` hook，必须单独校验 token；终端页即使从 `127.0.0.1` 访问也要带 token——反代一放行，豁免就等于送出 remote shell。会话 id 16 字节随机，泄露即等同于能力泄露。细节见 06-terminal.md §25.2。
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
4. ~~`runs/<runId>.jsonl` 与 `targets[]` 谁先做~~ → **已定**：`runs/*.jsonl` 归 P4（排障体验优先），`targets[]` 归 P3（数据结构），跨机并列随 P5 的 ssh 一起验收（**跨机并列后于 10-30 废弃**，见 §9.1）。
5. 网页终端的四条待定（`GET /api/sessions` 要不要暴露给片段坞页、SSH 凭据放哪、`driver: ssh` 要不要兼做 exec、旧 `spawn.ts` 抽取是否保留）见 [06-terminal.md](06-terminal.md) §29。

