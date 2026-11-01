@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  dsh-providers-hub 一键启动/重启脚本
rem  未运行 -> 启动；已在运行 -> 停掉旧实例再启动（默认会重新构建）
rem
rem  用法：
rem    dev.bat              构建 + 启动/重启
rem    dev.bat --nobuild    只重启，跳过构建
rem    dev.bat --open       启动后自动打开浏览器
rem ============================================================

set "PORT=8123"
set "PROFILE=dev"
set "ROOT=%~dp0"
set "DSH=%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "OUT=%TEMP%\dsh-dev-out.log"
set "ERR=%TEMP%\dsh-dev-err.log"

set "DO_BUILD=1"
set "DO_OPEN=0"
for %%a in (%*) do (
  if /i "%%a"=="--nobuild" set "DO_BUILD=0"
  if /i "%%a"=="--open"    set "DO_OPEN=1"
)

if not exist "%DSH%" (
  echo [错误] 找不到 dsh CLI: %DSH%
  exit /b 1
)

rem ---------- 1. 构建 ----------
if "%DO_BUILD%"=="1" (
  echo [1/3] 构建中...
  pushd "%ROOT%"
  call pnpm build:all
  if errorlevel 1 (
    echo [错误] 构建失败，已中止启动
    popd
    exit /b 1
  )
  popd
) else (
  echo [1/3] 跳过构建
)

rem ---------- 2. 停止已运行实例 ----------
echo [2/3] 停止端口 %PORT% 上的旧实例...
set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr /i LISTENING') do (
  rem 只杀 node 进程，避免误伤占用同端口的其它程序
  tasklist /fi "PID eq %%p" /nh | findstr /i "node.exe" >nul
  if not errorlevel 1 (
    echo       停止 PID %%p
    taskkill /PID %%p /F >nul 2>&1
    set "KILLED=1"
  )
)
if "%KILLED%"=="1" (
  timeout /t 2 /nobreak >nul
) else (
  echo       没有运行中的实例
)

rem ---------- 3. 启动 ----------
echo [3/3] 启动 profile=%PROFILE% port=%PORT% ...
if exist "%OUT%" del /q "%OUT%" >nul 2>&1
if exist "%ERR%" del /q "%ERR%" >nul 2>&1

start "dsh-dev" /B node "%DSH%" --profile %PROFILE% --port %PORT% --host 127.0.0.1 --no-open > "%OUT%" 2> "%ERR%"

rem ---------- 4. 等待就绪 ----------
set "URL="
for /l %%i in (1,1,40) do (
  timeout /t 1 /nobreak >nul
  for /f "tokens=3" %%u in ('findstr /c:"http://" "%OUT%" 2^>nul') do set "URL=%%u"
  if defined URL goto :ready
)

echo [错误] 40 秒内未就绪，请检查日志：
echo       %ERR%
if exist "%ERR%" type "%ERR%"
exit /b 1

:ready
echo.
echo 已就绪： %URL%
if "%DO_OPEN%"=="1" start "" "%URL%"
echo 日志： %OUT%  /  %ERR%
echo 停止： for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING'^) do taskkill /PID %%p /F
exit /b 0
