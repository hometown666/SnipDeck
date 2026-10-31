; listener.ahk — 桌面 Session 常驻：命令通道 + 回传闭环 + 实例表
;
; 这是 SnipDeck 的执行端：服务把命令写进 command.txt，这里收到后执行，
; 结果写回 last_result.txt（单次摘要）与 status.txt（桌面现状 + 实例表）。
; 协议见仓库 docs/03-reference.md §15，这里只列常用命令。
;
; 命令（写进 command.txt，一行一条）：
;   echo notepad.exe> C:\ahk_trigger\command.txt
;   echo admin:notepad.exe> C:\ahk_trigger\command.txt
;   echo status> C:\ahk_trigger\command.txt
;   echo kill:notepad#1> C:\ahk_trigger\command.txt
;   echo close:wechat#1> C:\ahk_trigger\command.txt
;   echo focus:wechat#2> C:\ahk_trigger\command.txt
;   echo click:wechat#2|140|520> C:\ahk_trigger\command.txt
;   echo screenshot> C:\ahk_trigger\command.txt          ; 主屏 PNG → screenshot.png
;   cmd:      echo runlog:job001^|dir C:\> C:\ahk_trigger\command.txt
;   PowerShell: Set-Content C:\ahk_trigger\command.txt 'runlog:job001|dir C:\'
;   admin+log:  Set-Content C:\ahk_trigger\command.txt 'admin:runlog:job002|whoami'
;   echo shell> C:\ahk_trigger\command.txt                  ; 可见 cmd /k，入表 shell#N
;   echo shell:shell#1^|npm start> C:\ahk_trigger\command.txt  ; focus + 粘贴 + Enter
;   echo shell:shell#1> C:\ahk_trigger\command.txt           ; 读 paste.txt 粘贴 + Enter
;
; 回传（AHK → SSH 用 type / Get-Content 读）：
;   C:\ahk_trigger\last_result.txt   本次命令摘要（run/kill/close/focus/click/shell）
;     受理后先写 PEND|...|pending|命令 ，完成后再写 OK/ERR（避免 Sleep 3 读到上一轮）
;   C:\ahk_trigger\status.txt        桌面进程/前台窗口 + instances 摘要
;   C:\ahk_trigger\instances.txt     实例表（slot 主键：pid/hwnd/exe/pro/ts）
;   C:\ahk_trigger\jobs\<id>.log     runlog 的 stdout+stderr
;   C:\ahk_trigger\jobs\<id>.exit    runlog 退出码（命令结束后由 wrapper 写入；非阻塞）
;
; runlog：异步 Run，立刻回传 OK|...|spawned|pid=...；不入 instances。
; 常驻服务：优先 shell（可见 cmd 入表，可 close/kill）；runlog+start 亦可。
;
; 实例表：RunPlain / shell 启动差集分配 slot；kill/close/focus/click 按 slot 操作。
; kill 使用 taskkill /F /T（进程树），便于关掉 shell 里拉起的子进程。
; click 坐标为相对窗口左上角（Window / Screen = WinGetPos + x,y）。
;
; 编码：command.txt 自动识别 UTF-8 / 系统 ANSI（CP0）；
; 回传写 UTF-16 LE（带 BOM）。Windows type / 多数终端能识别，
; 避免 UTF-8 被按 GBK 显示成「绋嬪簭」。PowerShell 用 -Encoding Unicode。
;
; 本机 ConsentPromptBehaviorAdmin=0 时 admin: 通常不弹 UAC；
; 若改回「始终通知」，无人在桌面点「是」则启动失败/卡住。
;
; listener 本身常以管理员自启（点提权窗 / UIPI）。子进程权限仍靠前缀区分：
;   无 admin: → 普通完整性（若 listener 已提权，则委托 Limited 的 broker.ahk）
;   admin:    → 提权启动（已提权则直接继承，否则 *RunAs）
; broker 由 install-listener-autostart.ps1 注册为 AHK-listener-broker（RunLevel Limited）
; 与 listener 经 HKCU\Software\TxtTunnel 交换 UnelevReq/UnelevAck
#Requires AutoHotkey v2.0
#SingleInstance Force
; 纯后台服务：不显示托盘图标（脚本仍常驻；排查时用任务管理器或计划任务 Stop）
#NoTrayIcon
Persistent

TriggerDir := "C:\ahk_trigger"
TriggerFile := TriggerDir "\command.txt"
ResultFile := TriggerDir "\last_result.txt"
StatusFile := TriggerDir "\status.txt"
InstancesFile := TriggerDir "\instances.txt"
PasteFile := TriggerDir "\paste.txt"
JobsDir := TriggerDir "\jobs"

; 回传 UTF-16 LE + BOM（CMD type 不依赖 chcp，不会把「程序」显示成「绋嬪簭」）
FileEnc := "UTF-16"

; status.txt 里额外探测的进程（可按需增删）
WatchExes := ["Weixin.exe", "WeChat.exe", "notepad.exe", "AutoHotkey64.exe", "AutoHotkey.exe"]
; 进程名快照缓存：WriteStatus 每轮要用 6 次「按名查进程」，
; 逐个 ProcessExist(name) 各做一次全量枚举（本机 390+ 进程时单次约 20ms）→ 每轮 120ms+ 空转。
; 改为一次 Toolhelp 快照 + 60s 复用，稳态下几乎零成本。
ProcNameCache := Map()
ProcNameCacheTick := 0
ProcNameCacheTTL := 60000

; slot → { slot, pid, hwnd, exe, pro, ts }
Instances := Map()
StatusBusy := false
; status.txt 的 last=：最近一次「业务」结果（不含 PEND / status|refreshed）
LastMeaningfulResult := ""
; 单调序号：避免同一秒内相同 OK 行与 Gateway before 比对撞车导致假 AHK_TIMEOUT
; 启动时从 last_result.txt 恢复上次 seq：listener 重启后序号继续前进，不会归零重来
ResultSeq := 0
try {
    if FileExist(ResultFile) {
        raw := FileRead(ResultFile, FileEnc)
        if RegExMatch(raw, "seq=(\d+)", &m)
            ResultSeq := Integer(m[1])
    }
} catch {
    ; 读不到 last_result 就回退 0：WriteResult 会 +1，不影响运行
}
; 运行日志（jobs\listener.log，UTF-16）：记录每条命令与结果；超 512KB 保留末尾约 400 行
ListenerLogFile := JobsDir "\listener.log"
ListenerLogMaxBytes := 512 * 1024
; 当前命令起始时刻（WriteResult 里算耗时）；0 = 非命令上下文（如 boot）
CmdStartTick := 0
; GcInstances 调用计数：hwnd 全量刷新约每 6 次一次（10s 周期约 60s），其余只查进程存活
GcCycle := 0

; status/instances 原子替换：失败重试 + FileCopy 兜底，绝不抛到定时器（避免 listener 弹窗退出）
AtomicReplaceFile(tmp, dest) {
    loop 3 {
        try {
            if FileExist(dest)
                try FileDelete(dest)
            FileMove(tmp, dest, 1)
            return true
        }
        try {
            FileCopy(tmp, dest, 1)
            try FileDelete(tmp)
            return true
        }
    }
    return false
}

; 追加一行运行日志；尽力而为，失败绝不抛（避免拖垮 listener）
LogLine(msg) {
    global ListenerLogFile, ListenerLogMaxBytes, FileEnc
    try {
        msg := StrReplace(msg, "`r", " ")
        msg := StrReplace(msg, "`n", " ")
        try {
            if (FileExist(ListenerLogFile) && FileGetSize(ListenerLogFile) > ListenerLogMaxBytes) {
                raw := FileRead(ListenerLogFile, FileEnc)
                lines := StrSplit(raw, "`n", "`r")
                n := lines.Length
                if (n > 400) {
                    out := ""
                    loop 400
                        out .= lines[n - 400 + A_Index] "`n"
                    FileDelete(ListenerLogFile)
                    FileAppend(out, ListenerLogFile, FileEnc)
                }
            }
        } catch {
            ; 截断失败不碍事：继续追加，日志最坏就是超限一点
        }
        FileAppend(FormatTime(, "yyyy-MM-dd HH:mm:ss") " " msg "`n", ListenerLogFile, FileEnc)
    } catch {
        ; 日志是尽力而为：失败绝不抛，避免拖垮 listener
    }
}

for d in [TriggerDir, JobsDir] {
    if !DirExist(d)
        DirCreate(d)
}

LoadInstances()
GcInstances(true)
WriteResult("OK", "boot", "listener started")
WriteStatus()
SetTimer(CheckTrigger, 250)
SetTimer(WriteStatus, 10000)

CheckTrigger() {
    global TriggerFile, CmdStartTick
    if !FileExist(TriggerFile)
        return
    ; 整段包 try：WriteResult/业务抛错时绝不能弹框卡死，否则后续全 AHK_TIMEOUT
    try {
        cmd := NormalizeCmd(ReadTriggerCommand(TriggerFile))
        try FileDelete(TriggerFile)
        if (cmd = "")
            return
        ; 只取首行：避免 command.txt 未截断/编码尾巴把 shell 变成「shell\0垃圾」
        if (nl := InStr(cmd, "`n"))
            cmd := NormalizeCmd(SubStr(cmd, 1, nl - 1))
        if (cmd = "")
            return

        CmdStartTick := A_TickCount
        LogLine("recv: " cmd)

        asAdmin := false
        if RegExMatch(cmd, "i)^admin:\s*(.+)$", &m) {
            cmd := NormalizeCmd(m[1])
            asAdmin := true
        }
        if (cmd = "")
            return

        ; status：PEND→OK 供 wait 握手；last_result 可写 refreshed，但 status.txt 的 last= 仍用业务结果
        if (StrLower(cmd) = "status") {
            WriteResult("PEND", "pending", "status")
            WriteResult("OK", "status", "refreshed")
            WriteStatus()
            return
        }

        ; 先作废上一轮结果，避免固定 Sleep 3 读到旧 OK/boot
        WriteResult("PEND", "pending", cmd)

        if RegExMatch(cmd, "i)^runlog:\s*([^|]+)\|\s*(.+)$", &m) {
            RunLogged(NormalizeCmd(m[1]), NormalizeCmd(m[2]), asAdmin)
            WriteStatus()
            return
        }

        if (StrLower(cmd) = "shell") {
            OpenShell(asAdmin)
            WriteStatus()
            return
        }
        if RegExMatch(cmd, "i)^shell:\s*(.+)$", &m) {
            ShellTypeCmd(NormalizeCmd(m[1]))
            WriteStatus()
            return
        }

        if RegExMatch(cmd, "i)^kill:\s*(.+)$", &m) {
            KillSlot(NormalizeCmd(m[1]), asAdmin)
            WriteStatus()
            return
        }
        if RegExMatch(cmd, "i)^close:\s*(.+)$", &m) {
            CloseSlot(NormalizeCmd(m[1]))
            WriteStatus()
            return
        }
        if RegExMatch(cmd, "i)^focus:\s*(.+)$", &m) {
            FocusSlot(NormalizeCmd(m[1]))
            WriteStatus()
            return
        }
        if RegExMatch(cmd, "i)^click:\s*([^|]+)\|(-?\d+)\|(-?\d+)$", &m) {
            ClickSlot(NormalizeCmd(m[1]), Integer(m[2]), Integer(m[3]))
            WriteStatus()
            return
        }
        if RegExMatch(cmd, "i)^screenshot$") {
            ScreenshotCmd()
            WriteStatus()
            return
        }

        RunPlain(cmd, asAdmin)
        WriteStatus()
    } catch as e {
        try WriteResult("ERR", "listener", "CheckTrigger", e.Message)
    }
}

; CMD echo 常为系统 ANSI；PowerShell Set-Content 常为 UTF-8。按 BOM / 能否落到真实路径自动选。
ReadTriggerCommand(path) {
    buf := ""
    try buf := FileRead(path, "RAW")
    catch {
        try return NormalizeCmd(FileRead(path, "CP0"))
        return ""
    }
    if (buf.Size = 0)
        return ""

    ; UTF-8 BOM
    if (buf.Size >= 3
        && NumGet(buf, 0, "UChar") = 0xEF
        && NumGet(buf, 1, "UChar") = 0xBB
        && NumGet(buf, 2, "UChar") = 0xBF) {
        return NormalizeCmd(StrGet(buf.Ptr + 3, buf.Size - 3, "UTF-8"))
    }
    ; UTF-16 LE BOM
    if (buf.Size >= 2
        && NumGet(buf, 0, "UChar") = 0xFF
        && NumGet(buf, 1, "UChar") = 0xFE) {
        return NormalizeCmd(StrGet(buf.Ptr + 2, buf.Size - 2, "UTF-16"))
    }

    utf8 := NormalizeCmd(StrGet(buf, "UTF-8"))
    cp0 := NormalizeCmd(StrGet(buf, "CP0"))
    if (utf8 = cp0)
        return utf8

    scoreU := ScoreCommandCandidate(utf8)
    scoreC := ScoreCommandCandidate(cp0)
    if (scoreC > scoreU)
        return cp0
    if (scoreU > scoreC)
        return utf8

    ; 字节序列本身是合法 UTF-8 时优先 UTF-8（PowerShell）；否则 CP0（经典 CMD）
    if (IsUtf8Buffer(buf))
        return utf8
    return cp0
}

ScoreCommandCandidate(cmd) {
    if (cmd = "")
        return 0
    if (StrLower(cmd) = "status")
        return 10
    if RegExMatch(cmd, "i)^(kill|close|focus):\s*[\w\- ]+#\s*\d+$")
        return 40
    if RegExMatch(cmd, "i)^click:\s*[\w\- ]+#\s*\d+\|-?\d+\|-?\d+$")
        return 40
    if RegExMatch(cmd, "i)^screenshot$")
        return 40
    if RegExMatch(cmd, "i)^shell(?::.+)?$")
        return 40
    if RegExMatch(cmd, "i)^runlog:\s*([^|]+)\|\s*(.+)$", &m) {
        body := NormalizeCmd(m[2])
        return FileExist(body) ? 100 : (InStr(cmd, Chr(0xFFFD)) ? 1 : 20)
    }
    if InStr(cmd, Chr(0xFFFD))
        return 1
    if FileExist(cmd)
        return 100
    ; 看起来像带盘符路径但文件不存在 → 编码很可能错了
    if RegExMatch(cmd, "i)^[a-z]:\\")
        return 5
    ; 纯 ASCII 命令（notepad.exe 等）两种编码相同
    if !RegExMatch(cmd, "[^\x09\x0A\x0D\x20-\x7E]")
        return 50
    return 20
}

IsUtf8Buffer(buf) {
    i := 0
    while (i < buf.Size) {
        c := NumGet(buf, i, "UChar")
        if (c <= 0x7F) {
            i += 1
            continue
        }
        if ((c & 0xE0) = 0xC0) {
            if (i + 1 >= buf.Size || (NumGet(buf, i + 1, "UChar") & 0xC0) != 0x80)
                return false
            i += 2
            continue
        }
        if ((c & 0xF0) = 0xE0) {
            if (i + 2 >= buf.Size
                || (NumGet(buf, i + 1, "UChar") & 0xC0) != 0x80
                || (NumGet(buf, i + 2, "UChar") & 0xC0) != 0x80)
                return false
            i += 3
            continue
        }
        if ((c & 0xF8) = 0xF0) {
            if (i + 3 >= buf.Size
                || (NumGet(buf, i + 1, "UChar") & 0xC0) != 0x80
                || (NumGet(buf, i + 2, "UChar") & 0xC0) != 0x80
                || (NumGet(buf, i + 3, "UChar") & 0xC0) != 0x80)
                return false
            i += 4
            continue
        }
        return false
    }
    return true
}

NormalizeCmd(s) {
    s := Trim(s, " `t`r`n`u{FEFF}")
    if (StrLen(s) >= 2 && SubStr(s, 1, 1) = '"' && SubStr(s, -1) = '"')
        s := Trim(SubStr(s, 2, -1), " `t`r`n")
    return s
}

; Termius / 部分终端会在中文 slot 间插空格（「微 信 #1」）。匹配前压掉空白。
CompactSlot(s) {
    s := NormalizeCmd(s)
    s := StrReplace(s, " ", "")
    s := StrReplace(s, "`t", "")
    s := StrReplace(s, "`u{00A0}", "") ; NBSP
    return s
}

QuotePath(p) {
    p := NormalizeCmd(p)
    if (p = "" || (SubStr(p, 1, 1) = '"' && SubStr(p, -1) = '"'))
        return p
    if InStr(p, " ") || InStr(p, "`t")
        return '"' p '"'
    return p
}

; 提权 listener → 普通完整性：委托 Limited broker（broker.ahk）
; 经 HKCU\Software\TxtTunnel 传参（避免 High/Medium 文件完整性互斥）
RunAsMedium(launch, workDir := "", hide := false) {
    regKey := "HKCU\Software\TxtTunnel"
    id := Format("{1}-{2}", A_TickCount, Random(1000, 9999))
    try RegWrite("", "REG_SZ", regKey, "UnelevAck")
    body := Format("id={1}`nhide={2}`ndir={3}`ncmd={4}"
        , id, hide ? "1" : "0", workDir, launch)
    try RegWrite(body, "REG_SZ", regKey, "UnelevReq")
    catch as e
        throw Error("broker registry write failed: " e.Message)
    deadline := A_TickCount + 8000
    loop {
        ack := ""
        try ack := Trim(RegRead(regKey, "UnelevAck"))
        if (ack != "" && RegExMatch(ack, "i)id=\Q" id "\E")) {
            try RegWrite("", "REG_SZ", regKey, "UnelevAck")
            if RegExMatch(ack, "i)^OK\|") {
                pid := 0
                if RegExMatch(ack, "i)\|pid=(\d+)", &m)
                    pid := Integer(m[1])
                return pid
            }
            err := "broker failed"
            if RegExMatch(ack, "i)\|err=(.+)$", &m)
                err := Trim(m[1])
            throw Error(err)
        }
        if A_TickCount >= deadline
            throw Error("broker timeout (is AHK-listener-broker running?)")
        Sleep 100
    }
}

; asAdmin → 要提权；listener 已提权则直接继承，否则 *RunAs
; listener 已提权且非 admin → broker 降权；否则普通 Run
RunLaunch(launch, workDir := "", asAdmin := false, hide := false) {
    pid := 0
    opt := hide ? "Hide" : ""
    if asAdmin {
        if A_IsAdmin
            Run(launch, workDir, opt, &pid)
        else
            Run("*RunAs " launch, workDir, opt, &pid)
        return pid
    }
    if A_IsAdmin
        return RunAsMedium(launch, workDir, hide)
    Run(launch, workDir, opt, &pid)
    return pid
}

; .lnk 经 ShellExecute 时 Run 拿不到 PID；解析出目标再启动
ResolveShortcut(lnk) {
    info := { target: "", args: "", dir: "" }
    try {
        sc := ComObject("WScript.Shell").CreateShortcut(lnk)
        info.target := NormalizeCmd(sc.TargetPath)
        info.args := Trim(sc.Arguments)
        info.dir := NormalizeCmd(sc.WorkingDirectory)
    }
    return info
}

SanitizePro(name) {
    name := StrLower(RegExReplace(String(name), "i)\.exe$", ""))
    ; 保留汉字：否则「微信#1」会被剥成「微信」，与别的 slot 撞名
    name := RegExReplace(name, "[^\w\x{4e00}-\x{9fff}]+", "_")
    name := Trim(name, "_")
    return name != "" ? name : "app"
}

; 快捷方式名优先（WeChat.lnk → wechat），否则用 exe 名
ProFromLaunch(cmd, targetExe) {
    path := StrReplace(NormalizeCmd(cmd), "/", "\")
    if RegExMatch(path, "i)\.lnk$") {
        SplitPath(path, , , , &nameNoExt)
        return SanitizePro(nameNoExt)
    }
    if (targetExe != "")
        return SanitizePro(targetExe)
    SplitPath(path, &leaf)
    if RegExMatch(leaf, "i)\.exe$")
        return SanitizePro(leaf)
    return SanitizePro(leaf != "" ? leaf : "app")
}

GetPidsByName(exeName) {
    pids := Map()
    if (exeName = "")
        return pids
    q := StrReplace(exeName, "'", "''")
    try {
        for proc in ComObjGet("winmgmts:\\.\root\cimv2").ExecQuery(
            "SELECT ProcessId FROM Win32_Process WHERE Name='" q "'") {
            try pids[Integer(proc.ProcessId)] := true
        }
    }
    return pids
}

GetChildPids(parentPid) {
    kids := []
    if !parentPid
        return kids
    try {
        for proc in ComObjGet("winmgmts:\\.\root\cimv2").ExecQuery(
            "SELECT ProcessId FROM Win32_Process WHERE ParentProcessId=" Integer(parentPid)) {
            try kids.Push(Integer(proc.ProcessId))
        }
    }
    return kids
}

; 同名多窗时取可见面积最大的顶层窗
GetMainHwndForPid(pid) {
    if !pid
        return 0
    best := 0
    bestArea := -1
    try {
        for hwnd in WinGetList("ahk_pid " pid) {
            try {
                if !DllCall("IsWindowVisible", "ptr", hwnd, "int")
                    continue
                WinGetPos(, , &w, &h, "ahk_id " hwnd)
                area := (w > 0 && h > 0) ? w * h : 0
                if (area > bestArea) {
                    bestArea := area
                    best := hwnd
                }
            }
        }
    }
    return best
}

; 本进程 + 子进程（Win11 cmd 窗常在 conhost 上）；供 WaitBoundPid 早退，避免空等到满超时
ResolveHwndForPid(pid) {
    if !pid
        return 0
    hwnd := GetMainHwndForPid(pid)
    if hwnd
        return hwnd
    for child in GetChildPids(pid) {
        hwnd := GetMainHwndForPid(child)
        if hwnd
            return hwnd
    }
    return 0
}

; 优先返回「已有窗口」的新进程；避免 Win11 记事本等启动器 PID 秒退导致实例被 GC 掉
WaitBoundPid(exeName, beforePids, hintPid := 0, timeoutMs := 8000) {
    deadline := A_TickCount + timeoutMs
    candidates := Map()
    if (hintPid && !beforePids.Has(Integer(hintPid)))
        candidates[Integer(hintPid)] := true

    loop {
        curr := GetPidsByName(exeName)
        for p, _ in curr {
            if !beforePids.Has(p)
                candidates[p] := true
        }
        ; 启动器的子进程（可能同名，也可能稍后才进 Name 查询）
        seed := []
        for p, _ in candidates
            seed.Push(p)
        for p in seed {
            for child in GetChildPids(p) {
                candidates[child] := true
                try {
                    cname := ProcessGetName(child)
                    if (cname != "" && StrLower(cname) = StrLower(exeName) && !beforePids.Has(child))
                        candidates[child] := true
                }
            }
        }

        ; 优先：仍存活且已有主窗（含 conhost 子窗，否则 shell 几乎每次空等满 8s）
        for p, _ in candidates {
            if !ProcessExist(p)
                continue
            if ResolveHwndForPid(p)
                return p
        }

        if A_TickCount >= deadline
            break
        Sleep 200
    }

    ; 超时：仍存活的候选（排除已死的启动器）
    alive := []
    for p, _ in candidates {
        if ProcessExist(p)
            alive.Push(p)
    }
    if (alive.Length = 1)
        return alive[1]
    if (alive.Length > 1) {
        ; 多个时优先非 hint（子进程更可能是真应用）
        for p in alive {
            if (p != hintPid)
                return p
        }
        return alive[1]
    }
    if (hintPid && ProcessExist(hintPid))
        return hintPid
    return 0
}

WaitHwndForPid(pid, timeoutMs := 8000) {
    if !pid
        return 0
    deadline := A_TickCount + timeoutMs
    loop {
        hwnd := ResolveHwndForPid(pid)
        if hwnd
            return hwnd
        if A_TickCount >= deadline
            return 0
        Sleep 200
    }
}

AllocSlot(pro) {
    global Instances
    used := Map()
    for slot, row in Instances {
        if (row.pro = pro && RegExMatch(slot, "i)^\Q" pro "\E#(\d+)$", &m))
            used[Integer(m[1])] := true
    }
    n := 1
    while used.Has(n)
        n++
    return pro "#" n
}

UpsertInstance(slot, pid, hwnd, exe, pro) {
    global Instances
    Instances[slot] := {
        slot: slot,
        pid: Integer(pid),
        hwnd: Integer(hwnd),
        exe: exe,
        pro: pro,
        ts: FormatTime(, "yyyy-MM-dd HH:mm:ss")
    }
    SaveInstances()
}

RemoveInstance(slot) {
    global Instances
    if !Instances.Has(slot)
        return false
    Instances.Delete(slot)
    SaveInstances()
    return true
}

; 查 slot（大小写不敏感；忽略空白）；刷新 hwnd；进程已死则删行并返回 ""
ResolveSlot(slot) {
    global Instances
    slot := NormalizeCmd(slot)
    compact := CompactSlot(slot)
    key := ""
    if Instances.Has(slot)
        key := slot
    else if (compact != "" && Instances.Has(compact))
        key := compact
    else {
        want := StrLower(compact)
        for s, _ in Instances {
            if (StrLower(s) = StrLower(slot) || CompactSlot(StrLower(s)) = want) {
                key := s
                break
            }
        }
    }
    if (key = "")
        return ""
    row := Instances[key]
    if !ProcessExist(row.pid) {
        RemoveInstance(key)
        return ""
    }
    hwnd := GetMainHwndForPid(row.pid)
    if (hwnd && hwnd != row.hwnd) {
        row.hwnd := hwnd
        Instances[key] := row
        SaveInstances()
    } else if (!hwnd && row.hwnd && WinExist("ahk_id " row.hwnd)) {
        ; 主窗扫描暂空，但表内 hwnd 仍有效
        hwnd := row.hwnd
    } else if !hwnd {
        hwnd := row.hwnd
    }
    row.hwnd := Integer(hwnd)
    return row
}

; 抢焦点；tapCenter=true 时再点客户区中心（控制台常需）；soft=true 时抬窗即可（不因 WinActive 误杀）
ForceFocusHwnd(hwnd, tapCenter := false, soft := false) {
    if !hwnd || !WinExist("ahk_id " hwnd)
        return false
    if WinGetMinMax("ahk_id " hwnd) = -1
        WinRestore("ahk_id " hwnd)

    DllCall("AllowSetForegroundWindow", "int", -1)
    fg := DllCall("GetForegroundWindow", "ptr")
    ; 前台是 VS Code 系编辑器 / 终端时 AttachThreadInput 易导致 WinActive 一直为假（窗已抬起却判失败）
    useAttach := true
    if fg {
        try {
            fgExe := WinGetProcessName("ahk_id " fg)
            if RegExMatch(fgExe, "i)^(Code|WindowsTerminal|powershell|pwsh|cmd|Conhost)\.exe$")
                useAttach := false
        }
    }
    curTid := DllCall("GetCurrentThreadId", "uint")
    fgTid := DllCall("GetWindowThreadProcessId", "ptr", fg, "ptr", 0, "uint")
    tgtTid := DllCall("GetWindowThreadProcessId", "ptr", hwnd, "ptr", 0, "uint")

    if useAttach {
        if fgTid
            DllCall("AttachThreadInput", "uint", curTid, "uint", fgTid, "int", true)
        if tgtTid && tgtTid != fgTid
            DllCall("AttachThreadInput", "uint", curTid, "uint", tgtTid, "int", true)
    }

    DllCall("BringWindowToTop", "ptr", hwnd)
    DllCall("SetForegroundWindow", "ptr", hwnd)
    try WinActivate("ahk_id " hwnd)
    WinWaitActive("ahk_id " hwnd, , 1.2)

    if useAttach {
        if fgTid
            DllCall("AttachThreadInput", "uint", curTid, "uint", fgTid, "int", false)
        if tgtTid && tgtTid != fgTid
            DllCall("AttachThreadInput", "uint", curTid, "uint", tgtTid, "int", false)
    }

    if tapCenter {
        WinGetPos(&x, &y, &w, &h, "ahk_id " hwnd)
        if w > 0 && h > 0 {
            ScreenPointerClick(x + Max(40, w // 2), y + Max(40, h // 2))
            Sleep 80
            DllCall("SetForegroundWindow", "ptr", hwnd)
        }
    }

    if WinActive("ahk_id " hwnd)
        return true
    fgNow := DllCall("GetForegroundWindow", "ptr")
    if (fgNow = hwnd)
        return true
    ; 控制台前台常是子窗 / 同 PID
    if fgNow {
        fgPid := 0
        tgtPid := 0
        DllCall("GetWindowThreadProcessId", "ptr", fgNow, "uint*", &fgPid)
        DllCall("GetWindowThreadProcessId", "ptr", hwnd, "uint*", &tgtPid)
        if fgPid && tgtPid && fgPid = tgtPid
            return true
    }
    return soft && !!WinExist("ahk_id " hwnd)
}

GetCursorScreenPos(&x, &y) {
    pt := Buffer(8, 0)
    if !DllCall("GetCursorPos", "ptr", pt)
        return false
    x := NumGet(pt, 0, "int")
    y := NumGet(pt, 4, "int")
    return true
}

; 探测目标是否比 listener「更高权」。非提权 AHK 读提权进程 token 常 Access Denied。
; 返回: "self"=本进程似乎已提权 / "elevated"=目标像提权 / "medium"=两边都像普通 / "unknown"
ProbeTargetPrivilege(pid) {
    selfElev := false
    try selfElev := !!(A_IsAdmin)
    if selfElev
        return "self"
    if !pid
        return "unknown"
    ; TOKEN_QUERY=0x0008 ; PROCESS_QUERY_LIMITED_INFORMATION=0x1000
    hProc := DllCall("OpenProcess", "uint", 0x1000, "int", 0, "uint", pid, "ptr")
    if !hProc {
        err := A_LastError
        ; 5 = ACCESS_DENIED → 典型 UIPI：目标更高完整性
        return err = 5 ? "elevated" : "unknown"
    }
    hTok := 0
    ok := DllCall("advapi32\OpenProcessToken", "ptr", hProc, "uint", 0x0008, "ptr*", &hTok)
    DllCall("CloseHandle", "ptr", hProc)
    if !ok || !hTok {
        return A_LastError = 5 ? "elevated" : "unknown"
    }
    elev := 0
    len := 0
    ; TokenElevation = 20
    if DllCall("advapi32\GetTokenInformation", "ptr", hTok, "int", 20, "uint*", &elev, "uint", 4, "uint*", &len)
        result := elev ? "elevated" : "medium"
    else
        result := A_LastError = 5 ? "elevated" : "unknown"
    DllCall("CloseHandle", "ptr", hTok)
    return result
}

; AHK Click() 在本机部分环境会「回 OK 但光标不动」。用 SetCursorPos + mouse_event / SendInput 兜底。
; button: "left" | "right"
ScreenPointerClick(sx, sy, button := "left") {
    sx := Integer(sx)
    sy := Integer(sy)
    beforeX := 0, beforeY := 0, afterX := 0, afterY := 0
    GetCursorScreenPos(&beforeX, &beforeY)

    clip := Buffer(16, 0)
    DllCall("GetClipCursor", "ptr", clip)
    clipL := NumGet(clip, 0, "int"), clipT := NumGet(clip, 4, "int")
    clipR := NumGet(clip, 8, "int"), clipB := NumGet(clip, 12, "int")
    ; Expand clip to whole virtual screen if locked small (remote/airmouse tools sometimes clip)
    vx := DllCall("GetSystemMetrics", "int", 76) ; SM_XVIRTUALSCREEN
    vy := DllCall("GetSystemMetrics", "int", 77)
    vw := DllCall("GetSystemMetrics", "int", 78)
    vh := DllCall("GetSystemMetrics", "int", 79)
    DllCall("ClipCursor", "ptr", 0) ; release clip

    CoordMode("Mouse", "Screen")
    okPos := DllCall("SetCursorPos", "int", sx, "int", sy)
    Sleep 40
    ; SendInput absolute move + click (more reliable than legacy mouse_event alone)
    absX := vw > 1 ? Round((sx - vx) * 65535 / (vw - 1)) : 0
    absY := vh > 1 ? Round((sy - vy) * 65535 / (vh - 1)) : 0
    SendInputClick(absX, absY, button)

    Sleep 40
    if !GetCursorScreenPos(&afterX, &afterY) {
        afterX := -1
        afterY := -1
    }
    if (afterX >= 0 && (Abs(afterX - sx) > 8 || Abs(afterY - sy) > 8)) {
        okPos := DllCall("SetCursorPos", "int", sx, "int", sy) || okPos
        Sleep 20
        try {
            MouseMove(sx, sy, 0)
            Click(button = "right" ? "Right" : "Left")
        }
        Sleep 30
        GetCursorScreenPos(&afterX, &afterY)
    }
    moved := (afterX >= 0 && Abs(afterX - sx) <= 12 && Abs(afterY - sy) <= 12)
    return {
        moved: moved,
        setPos: !!okPos,
        before: beforeX "," beforeY,
        after: afterX "," afterY,
        screen: sx "," sy,
        clip: clipL "," clipT "," clipR "," clipB,
        virt: vx "," vy "," vw "," vh
    }
}

; INPUT = type(DWORD) + mi(MOUSEINPUT) ; 32-bit packing via Buffer
; button: "left" (default) | "right"
SendInputClick(absX, absY, button := "left") {
    ; INPUT_MOUSE=0 ; MOUSEEVENTF_MOVE=1 ABSOLUTE=0x8000
    ; LEFTDOWN=2 LEFTUP=4 ; RIGHTDOWN=8 RIGHTUP=16
    flagsMove := 0x0001 | 0x8000
    if (button = "right") {
        flagsDown := 0x0008 | 0x8000
        flagsUp := 0x0010 | 0x8000
    } else {
        flagsDown := 0x0002 | 0x8000
        flagsUp := 0x0004 | 0x8000
    }
    cb := A_PtrSize = 8 ? 40 : 28
    buf := Buffer(cb * 3, 0)
    loop 3 {
        i := A_Index - 1
        off := i * cb
        NumPut("uint", 0, buf, off) ; type = INPUT_MOUSE
        dx := absX, dy := absY
        flags := flagsMove
        if (A_Index = 2)
            flags := flagsDown
        else if (A_Index = 3)
            flags := flagsUp
        if A_PtrSize = 8 {
            NumPut("int", dx, buf, off + 8)
            NumPut("int", dy, buf, off + 12)
            NumPut("uint", 0, buf, off + 16) ; mouseData
            NumPut("uint", flags, buf, off + 20)
            NumPut("uint", 0, buf, off + 24) ; time
            NumPut("uptr", 0, buf, off + 32) ; dwExtraInfo
        } else {
            NumPut("int", dx, buf, off + 4)
            NumPut("int", dy, buf, off + 8)
            NumPut("uint", 0, buf, off + 12)
            NumPut("uint", flags, buf, off + 16)
            NumPut("uint", 0, buf, off + 20)
            NumPut("uptr", 0, buf, off + 24)
        }
    }
    DllCall("SendInput", "uint", 3, "ptr", buf, "int", cb)
}

KillSlot(slot, asAdmin := false) {
    row := ResolveSlot(slot)
    if !IsObject(row) {
        WriteResult("ERR", "kill", slot, "slot not found or process dead")
        return
    }
    pid := row.pid
    key := row.slot
    try {
        ; /T：杀进程树（shell 里 npm/node 等子进程一并清掉）
        tk := Format('{1} /c taskkill /F /T /PID {2}', A_ComSpec, pid)
        if asAdmin {
            ; 提权启动的进程需 *RunAs，否则非提权 taskkill 会杀不掉
            RunWait("*RunAs " tk, , "Hide")
        } else {
            RunWait(tk, , "Hide")
            if ProcessExist(pid) {
                ProcessClose(pid)
                Sleep 300
            }
        }
        Sleep 200
        dead := !ProcessExist(pid)
        if dead
            RemoveInstance(key)
        detail := "pid=" pid " dead=" (dead ? 1 : 0) " tree=1"
        if asAdmin
            detail .= " admin=1"
        WriteResult(dead ? "OK" : "ERR", "kill", key, detail)
    } catch as e {
        WriteResult("ERR", "kill", key, e.Message)
    }
}

CloseSlot(slot) {
    row := ResolveSlot(slot)
    if !IsObject(row) {
        WriteResult("ERR", "close", slot, "slot not found or process dead")
        return
    }
    key := row.slot
    hwnd := row.hwnd
    pid := row.pid
    isShell := (StrLower(row.pro) = "shell")
        || RegExMatch(String(row.exe), "i)^cmd\.exe$")
    escalated := false
    try {
        if (!hwnd || !WinExist("ahk_id " hwnd)) {
            hwnd := GetMainHwndForPid(pid)
            if hwnd {
                row.hwnd := hwnd
                global Instances
                Instances[key] := row
                SaveInstances()
            }
        }
        if (hwnd && WinExist("ahk_id " hwnd))
            WinClose("ahk_id " hwnd)
        else if pid
            WinClose("ahk_pid " pid)

        deadline := A_TickCount + 2500
        while ProcessExist(pid) && A_TickCount < deadline
            Sleep 100

        ; 壳里跑着 npm 等时 WinClose 常被忽略 / 卡在 Terminate batch job?
        if ProcessExist(pid) && isShell {
            if (hwnd && WinExist("ahk_id " hwnd)) {
                ForceFocusHwnd(hwnd, true, true)
                Sleep 80
                SendEvent "^c"
                Sleep 400
                SendEvent "^c"
                Sleep 600
                if WinExist("ahk_id " hwnd)
                    WinClose("ahk_id " hwnd)
            }
            deadline := A_TickCount + 2500
            while ProcessExist(pid) && A_TickCount < deadline
                Sleep 100
        }

        ; shell 软关仍活着：升格 taskkill /T（与 kill 同级，避免 close 对常驻服务无效）
        if ProcessExist(pid) && isShell {
            tk := Format('{1} /c taskkill /F /T /PID {2}', A_ComSpec, pid)
            RunWait(tk, , "Hide")
            Sleep 200
            escalated := true
        }

        dead := !ProcessExist(pid)
        if dead
            RemoveInstance(key)
        detail := Format("pid={1} hwnd={2} dead={3}", pid, hwnd, dead ? 1 : 0)
        if escalated
            detail .= " escalated=kill"
        if (!dead)
            detail .= " (still running; use kill:" key ")"
        WriteResult(dead ? "OK" : "ERR", "close", key, detail)
    } catch as e {
        WriteResult("ERR", "close", key, e.Message)
    }
}

FocusSlot(slot) {
    global Instances
    row := ResolveSlot(slot)
    if !IsObject(row) {
        WriteResult("ERR", "focus", slot, "slot not found or process dead")
        return
    }
    key := row.slot
    hwnd := row.hwnd
    if (!hwnd || !WinExist("ahk_id " hwnd)) {
        hwnd := GetMainHwndForPid(row.pid)
        if hwnd {
            row.hwnd := hwnd
            Instances[key] := row
            SaveInstances()
        }
    }
    if !hwnd {
        WriteResult("ERR", "focus", key, "pid=" row.pid " no hwnd")
        return
    }
    ok := ForceFocusHwnd(hwnd, false)
    WriteResult(ok ? "OK" : "ERR", "focus", key
        , "pid=" row.pid " hwnd=" hwnd " active=" (ok ? 1 : 0))
}

ClickSlot(slot, relX, relY) {
    global Instances
    row := ResolveSlot(slot)
    if !IsObject(row) {
        WriteResult("ERR", "click", slot, "slot not found or process dead")
        return
    }
    key := row.slot
    ; 优先当前主窗，避免表内旧 hwnd（提权应用常有多窗）
    hwnd := GetMainHwndForPid(row.pid)
    if !hwnd
        hwnd := row.hwnd
    if (!hwnd || !WinExist("ahk_id " hwnd)) {
        WriteResult("ERR", "click", key, "pid=" row.pid " no hwnd")
        return
    }
    if (hwnd != row.hwnd) {
        row.hwnd := hwnd
        Instances[key] := row
        SaveInstances()
    }
    priv := ProbeTargetPrivilege(row.pid)
    try {
        ForceFocusHwnd(hwnd, false)
        Sleep 80
        WinGetPos(&wx, &wy, , , "ahk_id " hwnd)
        sx := wx + relX
        sy := wy + relY
        hit := ScreenPointerClick(sx, sy)
        detail := Format(
            "pid={1} hwnd={2} x={3} y={4} screen={5} moved={6} setPos={7} cursor={8}->{9} priv={10}",
            row.pid, hwnd, relX, relY, hit.screen, hit.moved ? 1 : 0, hit.setPos ? 1 : 0, hit.before, hit.after, priv)
        if (!hit.moved && (priv = "elevated" || !A_IsAdmin)) {
            detail .= " hint=UIPI: target may be elevated; run listener as admin (same as airmouse)"
        }
        ; 目标提权且未移动 → 明确失败原因
        if (!hit.moved && priv = "elevated" && !A_IsAdmin)
            WriteResult("ERR", "click", key, detail)
        else
            WriteResult(hit.moved ? "OK" : "ERR", "click", key, detail)
    } catch as e {
        WriteResult("ERR", "click", key, e.Message)
    }
}

; 刷新仍存活实例的 hwnd；删掉已退出进程。persist=true 时写盘。
GcInstances(persist := false) {
    global Instances, GcCycle
    GcCycle += 1
    ; hwnd 全量刷新约每 60s 一次；focus/click 经 ResolveSlot 即时刷新并落盘
    refreshHwnd := Mod(GcCycle, 6) = 0
    changed := false
    dead := []
    for slot, row in Instances {
        if !ProcessExist(row.pid) {
            dead.Push(slot)
            continue
        }
        if (refreshHwnd) {
            hwnd := GetMainHwndForPid(row.pid)
            if (hwnd && hwnd != row.hwnd) {
                row.hwnd := hwnd
                Instances[slot] := row
                changed := true
            }
        }
    }
    for slot in dead {
        Instances.Delete(slot)
        changed := true
    }
    if (persist && changed)
        SaveInstances()
    return changed
}

LoadInstances() {
    global Instances, InstancesFile, FileEnc
    Instances := Map()
    if !FileExist(InstancesFile)
        return
    raw := ""
    try raw := FileRead(InstancesFile, FileEnc)
    catch {
        try raw := FileRead(InstancesFile, "UTF-8")
        catch
            return
    }
    for line in StrSplit(raw, "`n", "`r") {
        line := Trim(line)
        if (line = "" || SubStr(line, 1, 1) = "#")
            continue
        ; slot|pid|hwnd|exe|pro|ts
        parts := StrSplit(line, "|")
        if (parts.Length < 5)
            continue
        slot := Trim(parts[1])
        ; 允许中文 pro（AHK 的 \w 偏 ASCII）。用单引号正则，避免 "" 与 <> 解析炸脚本。
        if (slot = "" || !RegExMatch(slot, '^[^|\\/:*?"<>\r\n]+#\d+$'))
            continue
        if InStr(slot, " ") || InStr(slot, "`t")
            continue
        try {
            Instances[slot] := {
                slot: slot,
                pid: Integer(Trim(parts[2])),
                hwnd: Integer(Trim(parts[3])),
                exe: Trim(parts[4]),
                pro: Trim(parts[5]),
                ts: parts.Length >= 6 ? Trim(parts[6]) : ""
            }
        }
    }
}

SaveInstances() {
    global Instances, InstancesFile, FileEnc
    lines := "# slot|pid|hwnd|exe|pro|ts`n"
    ; 稳定顺序：按 slot 名排序
    keys := []
    for slot, _ in Instances
        keys.Push(slot)
    ; 简单插入排序（实例数很少）
    loop keys.Length - 1 {
        i := A_Index
        loop keys.Length - i {
            j := A_Index
            if (StrCompare(keys[j], keys[j + 1]) > 0) {
                tmp := keys[j]
                keys[j] := keys[j + 1]
                keys[j + 1] := tmp
            }
        }
    }
    for slot in keys {
        row := Instances[slot]
        lines .= row.slot "|" row.pid "|" row.hwnd "|" row.exe "|" row.pro "|" row.ts "`n"
    }
    tmp := InstancesFile ".tmp"
    try FileDelete(tmp)
    FileAppend(lines, tmp, FileEnc)
    AtomicReplaceFile(tmp, InstancesFile)
}

FormatInstancesBlock() {
    global Instances
    if (Instances.Count = 0)
        return "instances=0`n"
    lines := "instances=" Instances.Count "`n"
    keys := []
    for slot, _ in Instances
        keys.Push(slot)
    loop keys.Length - 1 {
        i := A_Index
        loop keys.Length - i {
            j := A_Index
            if (StrCompare(keys[j], keys[j + 1]) > 0) {
                tmp := keys[j]
                keys[j] := keys[j + 1]
                keys[j + 1] := tmp
            }
        }
    }
    for slot in keys {
        row := Instances[slot]
        lines .= "inst." slot "=pid=" row.pid " hwnd=" row.hwnd " exe=" row.exe "`n"
    }
    return lines
}

RunPlain(cmd, asAdmin := false) {
    try {
        launch := cmd
        workDir := ""
        extra := ""
        targetExe := ""
        if (RegExMatch(cmd, "i)\.lnk$") && FileExist(cmd)) {
            info := ResolveShortcut(cmd)
            if (info.target != "") {
                launch := QuotePath(info.target)
                if (info.args != "")
                    launch .= " " info.args
                workDir := info.dir
                extra := " target=" info.target
                SplitPath(info.target, &targetExe)
            }
        } else if RegExMatch(cmd, "i)\.exe(?:\s|$)") {
            if RegExMatch(NormalizeCmd(cmd), "i)([^\\/:*?`"<>|]+\.exe)", &m)
                targetExe := m[1]
        }

        ; .ahk/.bat 等不是进程名，不能拿去 WMI Name= 差集（否则会绑错/超时）
        if (targetExe != "" && !RegExMatch(targetExe, "i)\.exe$"))
            targetExe := ""

        pro := ProFromLaunch(cmd, targetExe)
        ; 启动前快照：有明确 exe 才做差集（双开关键）
        beforePids := targetExe != "" ? GetPidsByName(targetExe) : Map()

        unelevated := (A_IsAdmin && !asAdmin)
        pid := RunLaunch(launch, workDir, asAdmin, false)

        bindExe := targetExe
        boundPid := 0
        boundHwnd := 0
        slot := ""

        if (bindExe != "") {
            boundPid := WaitBoundPid(bindExe, beforePids, pid, 8000)
        } else if pid {
            ; .ahk / 无 exe 名：直接用 Run 返回的 PID，并反查进程名
            boundPid := pid
            bindExe := ProcessGetName(pid)
            if (bindExe = "")
                bindExe := "unknown"
        } else if unelevated {
            ; Explorer 降权无 PID：短等任意新进程不现实；无 exe 名则无法绑 slot
        }

        if boundPid {
            boundHwnd := WaitHwndForPid(boundPid, bindExe != "unknown" ? 8000 : 3000)
            ; 启动器/短命 PID 常无窗：排除后再找「有主窗」的新进程（双开第二实例）
            if (!boundHwnd && bindExe != "" && bindExe != "unknown") {
                beforePids[Integer(boundPid)] := true
                retryPid := WaitBoundPid(bindExe, beforePids, 0, 6000)
                if retryPid {
                    boundPid := retryPid
                    boundHwnd := WaitHwndForPid(boundPid, 6000)
                }
            }
            ; 无主窗不入表，避免 hwnd=0 幽灵 slot（进程稍后秒退）
            if boundHwnd {
                slot := AllocSlot(pro)
                UpsertInstance(slot, boundPid, boundHwnd, bindExe, pro)
            }
        }

        detail := "pid=" (boundPid ? boundPid : (pid ? pid : ""))
        if (slot != "")
            detail .= " slot=" slot
        if boundHwnd
            detail .= " hwnd=" boundHwnd
        if (!slot && (boundPid || pid))
            detail .= " unbound=1"
        if asAdmin
            detail .= " admin=1"
        else if unelevated
            detail .= " medium=1"
        detail .= extra
        WriteResult("OK", "run", cmd, detail)
    } catch as e {
        WriteResult("ERR", "run", cmd, e.Message)
    }
}

; 可见 cmd /k，pro=shell → slot shell#N；供常驻服务软/硬关
; 唯一 title 枚举绑窗；禁止走 WMI 差集（满桌 cmd 时 GetPidsByName/GetChildPids 会卡死 → 永久 PEND）
OpenShell(asAdmin := false) {
    try {
        comspec := A_ComSpec
        SplitPath(comspec, &exeName)
        if (exeName = "")
            exeName := "cmd.exe"
        uniq := Format("ahk-shell-{}", A_TickCount)
        launch := Format('"{1}" /k title {2}', comspec, uniq)
        unelevated := (A_IsAdmin && !asAdmin)
        pid := RunLaunch(launch, "", asAdmin, false)

        boundPid := pid ? pid : 0
        boundHwnd := WaitHwndByTitle(uniq, 5000)

        slot := ""
        if (boundPid && boundHwnd) {
            slot := AllocSlot("shell")
            UpsertInstance(slot, boundPid, boundHwnd, exeName, "shell")
        }

        detail := "pid=" (boundPid ? boundPid : "")
        if (slot != "")
            detail .= " slot=" slot
        if boundHwnd
            detail .= " hwnd=" boundHwnd
        if (!slot && (boundPid || boundHwnd))
            detail .= " unbound=1"
        if asAdmin
            detail .= " admin=1"
        else if unelevated
            detail .= " medium=1"
        detail .= " title=" uniq
        WriteResult(slot ? "OK" : "ERR", "shell", "open", detail)
    } catch as e {
        WriteResult("ERR", "shell", "open", e.Message)
    }
}

; 按标题子串找可见顶层窗（不用 WMI；提权 listener 也能看到 medium 控制台）
WaitHwndByTitle(substr, timeoutMs := 5000) {
    if (substr = "")
        return 0
    deadline := A_TickCount + timeoutMs
    loop {
        try {
            for hwnd in WinGetList() {
                try {
                    if !DllCall("IsWindowVisible", "ptr", hwnd, "int")
                        continue
                    title := WinGetTitle("ahk_id " hwnd)
                    if (title != "" && InStr(title, substr))
                        return hwnd
                }
            }
        }
        if A_TickCount >= deadline
            return 0
        Sleep 100
    }
}

; spec = "shell#1|command" 或 "shell#1"（后者读 paste.txt）
ShellTypeCmd(spec) {
    global Instances
    slot := ""
    text := ""
    if RegExMatch(spec, "^([^|]+)\|(.*)$", &m) {
        slot := NormalizeCmd(m[1])
        text := RegExReplace(m[2], "^[\r\n]+|[\r\n]+$", "")
    } else {
        slot := NormalizeCmd(spec)
        text := ReadPasteText()
    }
    if (slot = "") {
        WriteResult("ERR", "shell", "type", "empty slot")
        return
    }
    if (text = "") {
        WriteResult("ERR", "shell", slot, "empty command / paste.txt")
        return
    }

    row := ResolveSlot(slot)
    if !IsObject(row) {
        WriteResult("ERR", "shell", slot, "slot not found or process dead")
        return
    }
    key := row.slot
    hwnd := row.hwnd
    if (!hwnd || !WinExist("ahk_id " hwnd)) {
        hwnd := GetMainHwndForPid(row.pid)
        if hwnd {
            row.hwnd := hwnd
            Instances[key] := row
            SaveInstances()
        }
    }
    if !hwnd {
        WriteResult("ERR", "shell", key, "pid=" row.pid " no hwnd")
        return
    }
    try {
        ; 控制台常需点一下客户区；soft：窗已抬起但 WinActive 仍假时不中止粘贴
        focused := ForceFocusHwnd(hwnd, true, true)
        Sleep 120
        ; 粘贴前再抢一次前台（被别的窗口抢走时会失败）
        DllCall("AllowSetForegroundWindow", "int", -1)
        DllCall("SetForegroundWindow", "ptr", hwnd)
        try WinActivate("ahk_id " hwnd)
        Sleep 80
        A_Clipboard := ""
        Sleep 40
        A_Clipboard := text
        if !ClipWait(1.5) {
            WriteResult("ERR", "shell", key, "clipboard empty")
            return
        }
        Sleep 60
        SendEvent "^v"
        Sleep 200
        SendEvent "{Enter}"
        WriteResult("OK", "shell", key
            , Format("pid={1} hwnd={2} chars={3} typed=1 focus={4}"
                , row.pid, hwnd, StrLen(text), focused ? 1 : 0))
    } catch as e {
        WriteResult("ERR", "shell", key, e.Message)
    }
}

ProcessGetName(pid) {
    q := Integer(pid)
    try {
        for proc in ComObjGet("winmgmts:\\.\root\cimv2").ExecQuery(
            "SELECT Name FROM Win32_Process WHERE ProcessId=" q) {
            return String(proc.Name)
        }
    }
    return ""
}

RunLogged(jobId, realCmd, asAdmin := false) {
    global JobsDir, FileEnc
    jobId := RegExReplace(jobId, "[^\w\-]", "_")
    if (jobId = "") {
        WriteResult("ERR", "runlog", realCmd, "empty job id")
        return
    }
    logPath := JobsDir "\" jobId ".log"
    exitPath := JobsDir "\" jobId ".exit"
    try FileDelete(logPath)
    try FileDelete(exitPath)

    ; /v:on + !ERRORLEVEL!：命令结束后由 wrapper 自己写 .exit，listener 不 RunWait，避免卡死。
    ; .exit 为控制台编码一行数字（非 UTF-16）；完成信号是 .exit 出现，不是再次改写 last_result。
    wrapper := Format('{1} /v:on /c (({2}) > "{3}" 2>&1) & (echo !ERRORLEVEL!>"{4}")',
        A_ComSpec, realCmd, logPath, exitPath)
    try {
        SplitPath(A_ComSpec, &exeName)
        if (exeName = "")
            exeName := "cmd.exe"
        beforePids := GetPidsByName(exeName)
        unelevated := (A_IsAdmin && !asAdmin)
        pid := RunLaunch(wrapper, "", asAdmin, true)
        if (!pid && unelevated)
            pid := WaitBoundPid(exeName, beforePids, 0, 4000)
        detail := "spawned pid=" pid " log=" logPath
        if asAdmin
            detail .= " admin=1"
        else if unelevated
            detail .= " medium=1"
        WriteResult("OK", "runlog", jobId, detail)
    } catch as e {
        try FileAppend(e.Message "`n", logPath, FileEnc)
        try FileAppend("-1`n", exitPath, "CP0")
        WriteResult("ERR", "runlog", jobId, e.Message)
    }
}

ReadPasteText() {
    global PasteFile, FileEnc
    if !FileExist(PasteFile)
        return ""
    txt := ""
    try txt := FileRead(PasteFile, FileEnc)
    catch {
        try txt := FileRead(PasteFile, "UTF-8")
        catch
            return ""
    }
    txt := RegExReplace(txt, "^\x{FEFF}")
    return txt
}

ScreenshotCmd() {
    global TriggerDir
    out := TriggerDir "\screenshot.png"
    ; 写到 .ps1 再跑：避免 -Command 引号被吞；且不用 ProcessWaitClose(PID)
    ; （AHK v2：进程已退出时 ProcessWaitClose 立刻返回 0，会被误判成 timeout）
    ps1 := TriggerDir "\_screenshot.ps1"
    psBody := "Add-Type -AssemblyName System.Windows.Forms,System.Drawing`r`n"
        . "$ErrorActionPreference='Stop'`r`n"
        . "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds`r`n"
        . "$i=New-Object Drawing.Bitmap $b.Width,$b.Height`r`n"
        . "$g=[Drawing.Graphics]::FromImage($i)`r`n"
        . "$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)`r`n"
        . "$i.Save('" out "',[Drawing.Imaging.ImageFormat]::Png)`r`n"
        . "$g.Dispose();$i.Dispose()`r`n"
    try {
        try FileDelete(ps1)
        FileAppend(psBody, ps1, "UTF-8")
        psPid := 0
        Run('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' ps1 '"', , "Hide", &psPid)
        ; 限时 < Gateway screenshot 超时(20s)：避免占住 CheckTrigger 拖垮后续命令
        if psPid {
            deadline := A_TickCount + 15000
            while ProcessExist(psPid) {
                if (A_TickCount >= deadline) {
                    try ProcessClose(psPid)
                    WriteResult("ERR", "screenshot", "powershell timeout")
                    return
                }
                Sleep 50
            }
        }
        if FileExist(out)
            WriteResult("OK", "screenshot", out)
        else
            WriteResult("ERR", "screenshot", "file missing")
    } catch as e {
        WriteResult("ERR", "screenshot", e.Message)
    }
}


WriteResult(ok, kind, detail, extra := "") {
    global ResultFile, FileEnc, LastMeaningfulResult, ResultSeq, CmdStartTick
    ; Critical：避免 WriteStatus 定时器打断原子替换，导致 Gateway 读锁挂死
    Critical "On"
    try {
        ResultSeq += 1
        ts := FormatTime(, "yyyy-MM-dd HH:mm:ss")
        line := Format("{1}|{2}|{3}|{4}", ok, ts, kind, detail)
        if (extra != "")
            line := Format("{1}|{2}", line, extra)
        ; seq 必须在：Gateway 用整行 !== before；同一秒同命令也会变
        line := Format("{1}|seq={2}", line, ResultSeq)
        out := line . "`n"
        tmp := ResultFile ".tmp"
        written := false
        loop 10 {
            try {
                try FileDelete(tmp)
                FileAppend(out, tmp, FileEnc)
                if AtomicReplaceFile(tmp, ResultFile) {
                    written := true
                    break
                }
            }
            Sleep 30
        }
        try FileDelete(tmp)
        ; 落盘失败也不抛：抛出会弹框卡死 listener，后续全超时
        if written {
            if (ok != "PEND" && StrLower(kind) != "status")
                LastMeaningfulResult := line
        } else if (ok != "PEND" && StrLower(kind) != "status") {
            ; 至少让 status.txt 的 last= 能前进，便于排查
            LastMeaningfulResult := line
        }
        ; 运行日志：结果 + 耗时（PEND 不记；boot 等无命令上下文时 elapsed=-1）
        if (ok != "PEND") {
            d := (StrLen(detail) > 120) ? SubStr(detail, 1, 120) "..." : detail
            el := CmdStartTick ? (A_TickCount - CmdStartTick) : -1
            LogLine(Format("result: {1}|{2}|{3} elapsed={4}ms{5}", ok, kind, d, el, written ? "" : " WRITE_FAILED"))
        }
        return written
    } finally {
        Critical "Off"
    }
}

; 全量进程名快照（一次 Toolhelp 枚举，结果按 TTL 缓存）
; 只读进程名，不碰窗口；供 WriteStatus 的 watch 探测复用。
; 失败（拿不到快照）返回空 Map，调用方回退到逐个 ProcessExist。
SnapshotProcNames() {
    global ProcNameCache, ProcNameCacheTick, ProcNameCacheTTL
    if (ProcNameCacheTick && (A_TickCount - ProcNameCacheTick) < ProcNameCacheTTL)
        return ProcNameCache
    set := Map()
    h := DllCall("CreateToolhelp32Snapshot", "uint", 2, "uint", 0, "ptr")
    if (h && h != -1) {
        size := (A_PtrSize = 8) ? 568 : 556
        off := (A_PtrSize = 8) ? 44 : 36
        buf := Buffer(size, 0)
        NumPut("uint", size, buf, 0)
        if DllCall("Process32FirstW", "ptr", h, "ptr", buf) {
            loop 2000 {
                nm := StrGet(buf.Ptr + off, 260, "UTF-16")
                if (nm != "")
                    set[StrLower(nm)] := true
                if !DllCall("Process32NextW", "ptr", h, "ptr", buf)
                    break
            }
        }
        DllCall("CloseHandle", "ptr", h)
    }
    if (set.Count) {
        ProcNameCache := set
        ProcNameCacheTick := A_TickCount
    }
    return set
}

WriteStatus() {
    global StatusFile, ResultFile, WatchExes, FileEnc, StatusBusy, LastMeaningfulResult
    if StatusBusy
        return
    StatusBusy := true
    try {
        GcInstances(true)
        lines := ""
        lines .= "ts=" FormatTime(, "yyyy-MM-dd HH:mm:ss") "`n"
        lines .= "listener=ok`n"
        lines .= "admin=" (A_IsAdmin ? "1" : "0") "`n"
        ; 最近一次业务结果（含 ERR）；不含 status|refreshed / PEND
        lastLine := LastMeaningfulResult
        if (lastLine = "") {
            try {
                lastRaw := FileRead(ResultFile, FileEnc)
                cand := Trim(StrSplit(lastRaw, "`n", "`r")[1])
                if (cand != "" && !RegExMatch(cand, "i)^PEND\|") && !RegExMatch(cand, "i)\|status\|refreshed"))
                    lastLine := cand
            }
        }
        if (lastLine != "")
            lines .= "last=" lastLine "`n"
        try
            lines .= "foreground=" WinGetTitle("A") "`n"
        catch
            lines .= "foreground=`n"
        procNames := SnapshotProcNames()
        for exe in WatchExes {
            name := RegExReplace(exe, "i)\.exe$", "")
            ; 快照拿不到时回退逐名探测，宁可慢也不能误报 stopped
            running := procNames.Count ? procNames.Has(StrLower(exe)) : ProcessExist(exe)
            lines .= name "=" (running ? "running" : "stopped") "`n"
        }
        lines .= FormatInstancesBlock()
        tmp := StatusFile ".tmp"
        try FileDelete(tmp)
        FileAppend(lines, tmp, FileEnc)
        AtomicReplaceFile(tmp, StatusFile)
    } catch {
        ; status 为尽全力回传，写失败不拖垮 listener
    } finally {
        StatusBusy := false
    }
}
