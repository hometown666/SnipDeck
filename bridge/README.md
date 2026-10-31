# bridge/ — 桌面执行端

SnipDeck 只负责「把命令交出去、把结果带回来」。真正在 Windows 桌面上执行的是这里的脚本，
通过一个**触发目录**（默认 `C:\ahk_trigger`）里的两个文本文件通信：

```
SnipDeck ──写──▶ <触发目录>\command.txt ──▶ listener.ahk 执行
SnipDeck ◀─读── <触发目录>\last_result.txt ◀──────┘
```

协议细节见 `docs/03-reference.md` §15，这里只说怎么装、改哪份。

## 三个文件

| 文件 | 运行在哪 | 干什么 |
|---|---|---|
| `listener.ahk` | AutoHotkey v2 常驻进程 | 收 `command.txt` → 执行 → 写 `last_result.txt` / `status.txt`。**必须常驻**，且要在桌面会话里（它要操作窗口） |
| `ahk.bat` | 每次调用起一个 cmd | CMD 侧客户端。SnipDeck 的 exec 驱动直接 `call` 它，它写文件、轮询结果、回显、返回退出码 |
| `ahk_cmd.ps1` | 被 `ahk.bat` 调用 | 写 UTF-8 / 处理中文路径。CMD 按 ANSI 读批处理，中文参数只能绕这一道 |

**「装在哪」和「从哪运行」是两件事。** 脚本放哪都行（`C:\ahk_trigger` 是默认，
也可以用计划任务指向别处），只要它读写的**触发目录**和 `ahk.bat` 里的一致。
本仓库两份都写死 `C:\ahk_trigger`；要换目录得同时改 `listener.ahk` 顶部与 `ahk.bat` 里的
`TriggerDir` / `AHK_TRIGGER`。

## 装

```bash
npm run doctor                       # 先看缺什么
npm run install:bridge               # 拷到 C:\ahk_trigger（已有的会先 .bak）
npm run install:bridge -- -DryRun    # 只看会做什么
npm run install:bridge -- -Start     # 装完顺手启动 listener
npm run install:bridge -- -Target "D:\somewhere"   # 装到别处
```

装完 `npm run doctor` 应该看到 `桥  bridge up`。

AutoHotkey **运行时不在本仓库**（第三方程序）。没装时 `doctor` 会提示：

```
winget install AutoHotkey.AutoHotkey
```

## 这份 listener 不含什么

仓库里的 `listener.ahk` 是**通用基线**：实例表（`status` / `kill` / `close` / `focus` / `click`）、
`runlog` 异步执行、`shell` 常驻壳、`screenshot`、`admin:` 提权前缀。

**已移除**：`cursor:*` 那一整套——`focus` / `agent` / `agent-toggle` / `new` / `paste` /
`paste:submit` / `send` / `send:new` / `history` / `switch` / `close-chat` / `converge-tabs` /
`fork` / `fork:palette` / `stop`，以及 `screenshot:cursor`、`WatchExes` 里的 `Cursor.exe`。
那是特定工作流的自动化，不是这个工具的能力。行数 **2119 → 1636**。

需要那些命令的话，在你自己的副本里加分支，然后**别再把它装回本仓库**。

## `broker.ahk` 不在本仓库

`listener.ahk` 里有 5 处提到 broker，它解决的是这个问题：

> listener 以管理员运行时，它 `Run` 出来的子进程也是管理员权限。
> 想让普通命令保持普通权限，就需要一个降权中转 —— 注册成计划任务
> `AHK-listener-broker`（RunLevel Limited），两边通过 `HKCU\Software\TxtTunnel`
> 交换 `UnelevReq` / `UnelevAck`。

**listener 以普通权限启动时，这条路径根本不会走到**，没有 broker 也能正常用。
只有在「提权 listener + 需要非提权子进程」的组合下才需要它，那时得自己补一个。

`TxtTunnel` 是历史键名，与项目无关，仅为兼容保留。

## 改哪份

**改仓库这份，然后 `npm run install:bridge` 覆盖本机。**

反过来（直接改本机那份）会造出两份不一样的 listener，下次装的时候不知道该信谁——
脚本会把它备份成 `*.bak.<时间戳>` 再覆盖，但那时候你已经分不清备份里哪份是想要的。

`npm run doctor` 会比对「仓库这份」和「已装那份」，不一致时打一条 `~ 版本` 提示。
**它只是提示，不判错**——如果你确实在本机加了自定义命令，那条提示就是预期内的；
怕的是它长期亮着然后没人再看，所以要么同步、要么明确知道自己在跑哪一版。

## 已知边界

- `TriggerDir` 写死为 `C:\ahk_trigger`（`listener.ahk` 与 `ahk.bat` 各一处）。
  要换目录得同时改这两个文件，`doctor` 与安装脚本默认也按这个路径检查。
- `ahk.bat` 的中文注释是 UTF-8，而 CMD 按 ANSI 读 `.bat` —— 注释会显示成乱码，
  **这不影响执行**（代码本身全是 ASCII，中文只出现在 `rem` 行）。
- `lnk` / `admin-lnk` 找的是**桌面**上的 `.lnk`（`[Environment]::GetFolderPath('Desktop')`，
  人人都有且是平铺的）。你的程序不放在桌面就设环境变量 `PROG_DIR` 指过去。
  `script` 子命令要的 `AHK_DIR` **没有默认值**：不是所有人都有这个目录，没设就明确报错，不猜。
