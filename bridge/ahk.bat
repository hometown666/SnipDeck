@echo off
rem =============================================================================
rem ahk.bat — CMD / Termius 前置命令库（所有操作集中在此）
rem 安装：copy 到 C:\ahk_trigger\ahk.bat
rem 用法：call C:\ahk_trigger\ahk.bat <子命令> [参数...]
rem =============================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "AHK_TRIGGER=C:\ahk_trigger"
rem Chinese defaults MUST NOT live in this .bat (CMD reads .bat as ANSI/GBK → 程序→绋嬪簭).
rem Defaults: ahk_cmd.ps1. Override: set PROG_DIR=... / set AHK_DIR=... (Unicode-safe console).
set "AHK_CMD_PS=%AHK_TRIGGER%\ahk_cmd.ps1"
if not exist "%AHK_CMD_PS%" set "AHK_CMD_PS=%~dp0ahk_cmd.ps1"

set "SUB=%~1"
if "%SUB%"=="" goto :help

if /i "%SUB%"=="help" goto :help
if /i "%SUB%"=="wait" goto :do_wait
if /i "%SUB%"=="send" goto :do_send
if /i "%SUB%"=="run" goto :do_run
if /i "%SUB%"=="lnk" goto :do_lnk
if /i "%SUB%"=="admin" goto :do_admin
if /i "%SUB%"=="status" goto :do_status
if /i "%SUB%"=="instances" goto :do_instances
if /i "%SUB%"=="focus" goto :do_focus
if /i "%SUB%"=="click" goto :do_click
if /i "%SUB%"=="close" goto :do_close
if /i "%SUB%"=="kill" goto :do_kill
if /i "%SUB%"=="runlog" goto :do_runlog
if /i "%SUB%"=="script" goto :do_script
if /i "%SUB%"=="shell" goto :do_shell

echo Unknown command: %SUB%
echo.
goto :help

rem ----- 内部：把 AHK_WRITE 写成 UTF-8（带 BOM）；纯 ASCII 指令可用；含中文路径请走 ahk_cmd.ps1 -----
:write_cmd
if not defined AHK_WRITE (
  echo write_cmd: AHK_WRITE empty
  exit /b 2
)
powershell -NoProfile -Command ^
  "$t='%AHK_TRIGGER%';" ^
  "$before=Get-Content (Join-Path $t 'last_result.txt') -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 1;" ^
  "if ($null -eq $before) { $before='' };" ^
  "Set-Content -LiteralPath (Join-Path $t 'wait_before.txt') -Value $before -Encoding Unicode -NoNewline;" ^
  "Set-Content -LiteralPath (Join-Path $t 'command.txt') -Value $env:AHK_WRITE -Encoding utf8"
set "ERR=%ERRORLEVEL%"
set "AHK_WRITE="
if not "%ERR%"=="0" (
  echo write_cmd: failed to write command.txt
  exit /b 2
)
exit /b 0

rem ----- 内部：用 ahk_cmd.ps1 写 command.txt（中文 PROG_DIR / 捷径名） -----
rem call :write_cmd_ps <action> <args...>   （%* 传给 ahk_cmd.ps1，避免中文 slot 参数被截断）
:write_cmd_ps
if not exist "%AHK_CMD_PS%" (
  echo write_cmd_ps: missing %AHK_CMD_PS%
  echo Copy AutoHotKey\ahk_cmd.ps1 to C:\ahk_trigger\
  exit /b 2
)
powershell -NoProfile -Command ^
  "$t='%AHK_TRIGGER%';" ^
  "$before=Get-Content (Join-Path $t 'last_result.txt') -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 1;" ^
  "if ($null -eq $before) { $before='' };" ^
  "Set-Content -LiteralPath (Join-Path $t 'wait_before.txt') -Value $before -Encoding Unicode -NoNewline"
powershell -NoProfile -ExecutionPolicy Bypass -File "%AHK_CMD_PS%" %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo write_cmd_ps: failed
  exit /b 2
)
exit /b 0

rem ----- 内部：见过 PEND 后非 PEND，或行相对 wait_before 已变（避免读到上一轮 OK） -----
:wait_core
if not defined TIMEOUT_SEC set "TIMEOUT_SEC=15"
powershell -NoProfile -Command ^
  "$t='%AHK_TRIGGER%'; $path=Join-Path $t 'last_result.txt'; $bf=Join-Path $t 'wait_before.txt';" ^
  "$before=Get-Content $bf -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 1;" ^
  "if ($null -eq $before) { $before=Get-Content $path -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 1 };" ^
  "if ($null -eq $before) { $before='' };" ^
  "$deadline=(Get-Date).AddSeconds([int]%TIMEOUT_SEC%); $seenPend=$false;" ^
  "do {" ^
  "  Start-Sleep -Milliseconds 80;" ^
  "  $line=Get-Content $path -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 1;" ^
  "  if (-not $line) { continue }" ^
  "  if ($line -match '^PEND\|') { $seenPend=$true; continue }" ^
  "  if (-not $seenPend -and $line -eq $before) { continue }" ^
  "  exit 0" ^
  "} while ((Get-Date) -lt $deadline);" ^
  "exit 1"
set "ERR=%ERRORLEVEL%"
type "%AHK_TRIGGER%\last_result.txt"
exit /b %ERR%

rem ----- 内部：等到 jobs\JID.exit 出现（JID / TIMEOUT_SEC 已设） -----
:wait_job_exit
if not defined TIMEOUT_SEC set "TIMEOUT_SEC=15"
if not defined JID (
  echo wait_job_exit: JID empty
  exit /b 2
)
powershell -NoProfile -Command ^
  "$deadline=(Get-Date).AddSeconds([int]%TIMEOUT_SEC%);" ^
  "$p='%AHK_TRIGGER%\jobs\!JID!.exit';" ^
  "do {" ^
  "  if (Test-Path -LiteralPath $p) { exit 0 }" ^
  "  Start-Sleep -Milliseconds 200" ^
  "} while ((Get-Date) -lt $deadline);" ^
  "exit 1"
exit /b %ERRORLEVEL%

rem ----- wait: 等到 last_result 非 PEND 再 type -----
:do_wait
set "TIMEOUT_SEC=%~2"
if "%TIMEOUT_SEC%"=="" set "TIMEOUT_SEC=15"
powershell -NoProfile -Command ^
  "$path='%AHK_TRIGGER%\last_result.txt';" ^
  "$deadline=(Get-Date).AddSeconds([int]%TIMEOUT_SEC%);" ^
  "do {" ^
  "  Start-Sleep -Milliseconds 80;" ^
  "  $line=Get-Content $path -Encoding Unicode -ErrorAction SilentlyContinue | Select-Object -Last 1;" ^
  "  if ($line -and $line -notmatch '^PEND\|') { exit 0 }" ^
  "} while ((Get-Date) -lt $deadline);" ^
  "exit 1"
set "ERR=%ERRORLEVEL%"
type "%AHK_TRIGGER%\last_result.txt"
exit /b %ERR%

rem ----- send: 写入任意原始命令并等待 -----
:do_send
if "%~2"=="" (
  echo Usage: ahk.bat send ^<command text^>
  exit /b 2
)
set "AHK_WRITE=%~2"
call :write_cmd
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

rem ----- run: 同 send（可读性别名） -----
:do_run
if "%~2"=="" (
  echo Usage: ahk.bat run ^<exe-or-path^>
  exit /b 2
)
set "AHK_WRITE=%~2"
call :write_cmd
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

rem ----- lnk: 启动 %%PROG_DIR%%\名字.lnk（路径在 ahk_cmd.ps1 里拼，避免 bat 中文乱码） -----
:do_lnk
if "%~2"=="" (
  echo Usage: ahk.bat lnk ^<shortcut-name^>
  echo   PROG_DIR from env if folder exists; else default in ahk_cmd.ps1
  exit /b 2
)
call :write_cmd_ps lnk "%~2"
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

rem ----- admin: admin 前缀；admin lnk 名 / admin kill slot / admin run ... / admin runlog ... -----
:do_admin
set "TIMEOUT_SEC=15"
if /i "%~2"=="lnk" (
  if "%~3"=="" (
    echo Usage: ahk.bat admin lnk ^<shortcut-name^>
    exit /b 2
  )
  call :write_cmd_ps admin-lnk "%~3"
  if errorlevel 1 exit /b 2
  call :wait_core
  exit /b %ERRORLEVEL%
)
if /i "%~2"=="kill" (
  if "%~3"=="" (
    echo Usage: ahk.bat admin kill ^<slot^>
    exit /b 2
  )
  call :write_cmd_ps slot-admin-kill %3 %4 %5 %6 %7 %8 %9
  if errorlevel 1 exit /b 2
  call :wait_core
  exit /b %ERRORLEVEL%
)
if /i "%~2"=="runlog" (
  call :do_runlog_admin %3 %4 %5 %6 %7 %8 %9
  exit /b %ERRORLEVEL%
)
if /i "%~2"=="shell" (
  set "AHK_WRITE=admin:shell"
  call :write_cmd
  if errorlevel 1 exit /b 2
  call :wait_core
  exit /b %ERRORLEVEL%
)
if /i "%~2"=="run" (
  if "%~3"=="" (
    echo Usage: ahk.bat admin run ^<exe-or-path^>
    exit /b 2
  )
  set "AHK_WRITE=admin:%~3"
  call :write_cmd
  if errorlevel 1 exit /b 2
  call :wait_core
  exit /b %ERRORLEVEL%
)
if "%~2"=="" (
  echo Usage: ahk.bat admin lnk^|kill^|run^|runlog^|shell ...
  exit /b 2
)
set "AHK_WRITE=admin:%~2"
call :write_cmd
if errorlevel 1 exit /b 2
call :wait_core
exit /b %ERRORLEVEL%

rem ----- status: 刷新并显示 status + last_result -----
:do_status
set "AHK_WRITE=status"
call :write_cmd
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
echo --- status ---
type "%AHK_TRIGGER%\status.txt"
exit /b %ERRORLEVEL%

rem ----- instances -----
:do_instances
if exist "%AHK_TRIGGER%\instances.txt" (
  type "%AHK_TRIGGER%\instances.txt"
) else (
  echo instances.txt not found
  exit /b 1
)
exit /b 0

rem ----- focus / close / kill -----
rem Termius 常在中文 slot 间插空格，CMD 会拆成多参数；经 ahk_cmd.ps1 粘合并去空白
:do_focus
if "%~2"=="" (
  echo Usage: ahk.bat focus ^<slot^>
  exit /b 2
)
call :write_cmd_ps slot-focus %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

:do_close
if "%~2"=="" (
  echo Usage: ahk.bat close ^<slot^>
  exit /b 2
)
call :write_cmd_ps slot-close %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

:do_kill
if "%~2"=="" (
  echo Usage: ahk.bat kill ^<slot^>
  exit /b 2
)
call :write_cmd_ps slot-kill %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

rem ----- click slot x y -----
:do_click
if "%~2"=="" (
  echo Usage: ahk.bat click ^<slot^> ^<x^> ^<y^>
  exit /b 2
)
call :write_cmd_ps slot-click %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

rem ----- runlog [jobid] command...  若省略 jobid 则用环境变量 jobid 自增 -----
:do_runlog
if "%~2"=="" (
  echo Usage: ahk.bat runlog ^<cmd...^>
  echo    or: ahk.bat runlog job3 dir C:\
  exit /b 2
)
set "JID="
set "REST="
set "TIMEOUT_SEC=15"
echo %~2| findstr /r /i "^job[0-9][0-9]*$" >nul
if not errorlevel 1 (
  set "JID=%~2"
  set "REST=%~3"
  if not "%~4"=="" set "REST=!REST! %~4"
  if not "%~5"=="" set "REST=!REST! %~5"
  if not "%~6"=="" set "REST=!REST! %~6"
  if not "%~7"=="" set "REST=!REST! %~7"
  if not "%~8"=="" set "REST=!REST! %~8"
  if not "%~9"=="" set "REST=!REST! %~9"
) else (
  set "JFILE=%AHK_TRIGGER%\jobid.txt"
  set /a _j=0
  if exist "!JFILE!" set /p _j=<"!JFILE!"
  set /a _j+=1
  >"!JFILE!" echo !_j!
  set "JID=job!_j!"
  set "REST=%~2"
  if not "%~3"=="" set "REST=!REST! %~3"
  if not "%~4"=="" set "REST=!REST! %~4"
  if not "%~5"=="" set "REST=!REST! %~5"
  if not "%~6"=="" set "REST=!REST! %~6"
  if not "%~7"=="" set "REST=!REST! %~7"
  if not "%~8"=="" set "REST=!REST! %~8"
  if not "%~9"=="" set "REST=!REST! %~9"
)
if "!REST!"=="" (
  echo runlog: empty command
  exit /b 2
)
set "AHK_WRITE=runlog:!JID!|!REST!"
call :write_cmd
if errorlevel 1 exit /b 2
call :wait_core
echo --- waiting exit (!JID!) up to !TIMEOUT_SEC!s ---
call :wait_job_exit
echo --- log ---
if exist "%AHK_TRIGGER%\jobs\!JID!.log" type "%AHK_TRIGGER%\jobs\!JID!.log"
echo --- exit ---
if exist "%AHK_TRIGGER%\jobs\!JID!.exit" (
  type "%AHK_TRIGGER%\jobs\!JID!.exit"
) else (
  echo ^(still running; no .exit yet — later: type %%AHK_TRIGGER%%\jobs\!JID!.exit^)
)
exit /b %ERRORLEVEL%

:do_runlog_admin
set "JID="
set "REST="
set "TIMEOUT_SEC=15"
echo %~1| findstr /r /i "^job[0-9][0-9]*$" >nul
if not errorlevel 1 (
  set "JID=%~1"
  set "REST=%~2"
  if not "%~3"=="" set "REST=!REST! %~3"
  if not "%~4"=="" set "REST=!REST! %~4"
  if not "%~5"=="" set "REST=!REST! %~5"
  if not "%~6"=="" set "REST=!REST! %~6"
  if not "%~7"=="" set "REST=!REST! %~7"
  if not "%~8"=="" set "REST=!REST! %~8"
) else (
  set "JFILE=%AHK_TRIGGER%\jobid.txt"
  set /a _j=0
  if exist "!JFILE!" set /p _j=<"!JFILE!"
  set /a _j+=1
  >"!JFILE!" echo !_j!
  set "JID=job!_j!"
  set "REST=%~1"
  if not "%~2"=="" set "REST=!REST! %~2"
  if not "%~3"=="" set "REST=!REST! %~3"
  if not "%~4"=="" set "REST=!REST! %~4"
  if not "%~5"=="" set "REST=!REST! %~5"
  if not "%~6"=="" set "REST=!REST! %~6"
  if not "%~7"=="" set "REST=!REST! %~7"
  if not "%~8"=="" set "REST=!REST! %~8"
)
set "AHK_WRITE=admin:runlog:!JID!|!REST!"
call :write_cmd
if errorlevel 1 exit /b 2
call :wait_core
echo --- waiting exit (!JID!) up to !TIMEOUT_SEC!s ---
call :wait_job_exit
echo --- log ---
if exist "%AHK_TRIGGER%\jobs\!JID!.log" type "%AHK_TRIGGER%\jobs\!JID!.log"
echo --- exit ---
if exist "%AHK_TRIGGER%\jobs\!JID!.exit" (
  type "%AHK_TRIGGER%\jobs\!JID!.exit"
) else (
  echo ^(still running; no .exit yet — later: type %%AHK_TRIGGER%%\jobs\!JID!.exit^)
)
exit /b %ERRORLEVEL%

rem ----- script: 启动 %%AHK_DIR%%\名字.ahk -----
:do_script
if "%~2"=="" (
  echo Usage: ahk.bat script ^<name-without-.ahk^>
  exit /b 2
)
call :write_cmd_ps script "%~2"
if errorlevel 1 exit /b 2
set "TIMEOUT_SEC=15"
call :wait_core
exit /b %ERRORLEVEL%

rem ----- shell: 开可见 cmd /k（入表 shell#N）；或往 slot 粘贴命令+Enter -----
rem   ahk.bat shell
rem   ahk.bat shell shell#1 "cd /d D:\path && npm start"
:do_shell
set "TIMEOUT_SEC=15"
if "%~2"=="" (
  set "AHK_WRITE=shell"
  call :write_cmd
  if errorlevel 1 exit /b 2
  call :wait_core
  exit /b %ERRORLEVEL%
)
if "%~3"=="" (
  echo Usage: ahk.bat shell
  echo        ahk.bat shell ^<slot^> "command..."
  exit /b 2
)
rem Unicode-safe: command goes to paste.txt via ahk_cmd.ps1; command.txt = shell:<slot>
call :write_cmd_ps shell-type "%~2" "%~3"
if errorlevel 1 exit /b 2
call :wait_core
exit /b %ERRORLEVEL%

:help
echo.
echo ahk.bat — SSH/Termius CMD helpers for listener bridge
echo.
echo   ahk.bat wait [sec]              wait until last_result not PEND
echo   ahk.bat send "raw command"      write command.txt + wait
echo   ahk.bat run ^<path-or-exe^>        same as send
echo   ahk.bat lnk ^<name^>               run %%PROG_DIR%%\name.lnk
echo   ahk.bat admin lnk ^<name^>         admin: start lnk
echo   ahk.bat admin run ^<path^>
echo   ahk.bat admin kill ^<slot^>
echo   ahk.bat admin shell             admin: open visible cmd shell
echo   ahk.bat status                  refresh + show status
echo   ahk.bat instances               type instances.txt
echo   ahk.bat focus^|close^|kill ^<slot^>
echo   ahk.bat click ^<slot^> ^<x^> ^<y^>
echo   ahk.bat runlog [jobN] ^<cmd...^>   spawn async; wait .exit up to 15s
echo   ahk.bat admin runlog [jobN] ^<cmd...^>
echo   ahk.bat script ^<name^>            run %%AHK_DIR%%\name.ahk
echo   ahk.bat shell                   open visible cmd /k as shell#N
echo   ahk.bat shell ^<slot^> "cmd..."    paste cmd + Enter into shell slot
echo.
echo Long-lived services: prefer ahk.bat shell then type; kill uses process tree.
echo runlog: does NOT enter instances; use for short jobs or start-and-detach.
echo Env: PROG_DIR=%PROG_DIR%  (if unset/invalid, ahk_cmd.ps1 default)
echo      AHK_DIR=%AHK_DIR%
echo      AHK_CMD_PS=%AHK_CMD_PS%
echo.
exit /b 0
