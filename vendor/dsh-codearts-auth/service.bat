@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

rem ====================================================================
rem  dsh-providers-hub —— Windows 服务：打包 / 注册 / 启停 / 卸载
rem
rem  用途：把「指定程序」打包成可部署目录，并注册为 Windows 服务，
rem        以便在 Windows Server 上开机自启、无人值守运行。
rem
rem  两种模式：
rem    -Mode dsh     （默认）服务 = DSH 宿主（web profile）+ 本插件，
rem                           对外提供本机 OpenAI 兼容网关。
rem    -Mode custom  服务 = -Program 指定的任意可执行程序。
rem
rem  完整用法、前置条件与参数说明：service.bat help
rem ====================================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "REPO_ROOT=%SCRIPT_DIR%"
set "REPO_SLASH=%REPO_ROOT:\=/%"
set "TOOLS_DIR=%SCRIPT_DIR%\tools"
set "RUNNER_SRC=%SCRIPT_DIR%\service-runner.mjs"

rem ---------- 默认参数 ----------
set "CMD=help"
set "SVC_NAME=dsh-providers-hub"
set "SVC_DISPLAY=DSH Providers Hub"
set "SVC_DESC=DSH Providers Hub（dsh-providers-hub 插件 + 本机 OpenAI 兼容网关）"
set "MODE=dsh"
set "PORT=8123"
set "BIND_HOST=127.0.0.1"
set "GW_PORT=8326"
set "GW_HOST="
set "PROFILE=prod"
set "DSH_HOME=%ProgramData%\dsh-providers-hub\home"
set "INSTALL_DIR=%ProgramData%\dsh-providers-hub"
set "LOG_DIR="
set "START_TYPE=auto"
set "SVC_USER="
set "SVC_PASSWORD="
set "API_KEY="
set "PROGRAM="
set "PROGRAM_ARGS="
set "PROGRAM_DIR="
set "WORK_DIR="
set "NODE_EXE="
set "NSSM_EXE="
set "DSH_BIN="
set "OUT_DIR="
set "BUNDLE_DIR="
set "SVC_CWD="
set "PKG_VERSION=unknown"
set "NO_BUILD=0"
set "NO_DEPS=0"
set "NO_ZIP=0"
set "NO_START=0"
set "NO_PACKAGE=0"
set "NO_COPY=0"
set "SKIP_PLUGIN_INSTALL=0"
set "CREATE_PROFILE=0"
set "FORCE=0"
set "PURGE=0"
set "LOG_TAIL=50"
set "ENV_FILE=%TEMP%\dsh-providers-hub-svc-env.txt"
if exist "%ENV_FILE%" del /q "%ENV_FILE%" >nul 2>&1
rem `-env` 暂存区（2026-10-31 复审 B-2）：解析期只暂存，NODE_EXE 绑定后由
rem :flush_user_env 统一写入。
set "USER_ENV_N=0"

call :detect_version

rem ---------- 参数解析 ----------
:parse
if "%~1"=="" goto parse_done
if /i "%~1"=="-name"           ( set "SVC_NAME=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-displayname"    ( set "SVC_DISPLAY=%~2"   & shift & shift & goto parse )
if /i "%~1"=="-description"    ( set "SVC_DESC=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-mode"           ( set "MODE=%~2"          & shift & shift & goto parse )
if /i "%~1"=="-program"        ( set "PROGRAM=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-args"           ( set "PROGRAM_ARGS=%~2"  & shift & shift & goto parse )
if /i "%~1"=="-workdir"        ( set "WORK_DIR=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-port"           ( set "PORT=%~2"          & shift & shift & goto parse )
if /i "%~1"=="-host"           ( set "BIND_HOST=%~2"     & shift & shift & goto parse )
if /i "%~1"=="-gatewayport"    ( set "GW_PORT=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-gatewayhost"    ( set "GW_HOST=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-apikey"         goto opt_apikey
if /i "%~1"=="-profile"        ( set "PROFILE=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-dshhome"        ( set "DSH_HOME=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-dshbin"         ( set "DSH_BIN=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-node"           ( set "NODE_EXE=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-nssm"           ( set "NSSM_EXE=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-installdir"     ( set "INSTALL_DIR=%~2"   & shift & shift & goto parse )
if /i "%~1"=="-logdir"         ( set "LOG_DIR=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-outdir"         ( set "OUT_DIR=%~2"       & shift & shift & goto parse )
if /i "%~1"=="-bundledir"      ( set "BUNDLE_DIR=%~2"    & shift & shift & goto parse )
if /i "%~1"=="-user"           ( set "SVC_USER=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-password"       goto opt_password
if /i "%~1"=="-start"          ( set "START_TYPE=%~2"    & shift & shift & goto parse )
if /i "%~1"=="-env"            goto opt_env
if /i "%~1"=="-tail"           ( set "LOG_TAIL=%~2"      & shift & shift & goto parse )
if /i "%~1"=="-nobuild"        ( set "NO_BUILD=1"        & shift & goto parse )
if /i "%~1"=="-nodeps"         ( set "NO_DEPS=1"         & shift & goto parse )
if /i "%~1"=="-nozip"          ( set "NO_ZIP=1"          & shift & goto parse )
if /i "%~1"=="-nostart"        ( set "NO_START=1"        & shift & goto parse )
if /i "%~1"=="-nopackage"      ( set "NO_PACKAGE=1"      & shift & goto parse )
if /i "%~1"=="-nocopy"         ( set "NO_COPY=1"         & shift & goto parse )
if /i "%~1"=="-skipplugin"     ( set "SKIP_PLUGIN_INSTALL=1" & shift & goto parse )
if /i "%~1"=="-createprofile"  ( set "CREATE_PROFILE=1"  & shift & goto parse )
if /i "%~1"=="-force"          ( set "FORCE=1"           & shift & goto parse )
if /i "%~1"=="-purge"          ( set "PURGE=1"           & shift & goto parse )
if /i "%~1"=="-h"              goto parse_done
if /i "%~1"=="-help"           goto parse_done
rem 第一个非选项参数 = 命令
set "CMD=%~1"
shift
goto parse

rem ---- 值里可能带 '=' 的三个选项，单独处理 ----
rem ⚠️ 2026-10-31 复审 B-2 修：`-env` 在**解析期**被消费，而 %NODE_EXE% 此时必然
rem    还没绑定（-node / find_node / setup_standalone 全在解析之后）⇒ 直接调
rem    :add_env 恒失败且回归为静默丢配置。改为**先暂存**（USER_ENV_n），等
rem    NODE_EXE 绑定后由 :flush_user_env 统一写入（install_dsh / install_standalone
rem    两条流在 add_env 固定值之前各调一次；无需 -env 的调用零开销）。
:opt_env
call :maybe_join_arg3 "%~2" "%~3"
if "%JOINED%"=="1" shift
set /a USER_ENV_N+=1
set "USER_ENV_%USER_ENV_N%=%MV%"
shift
shift
goto parse

rem 把解析期暂存的 -env 值逐条写入 ENV_FILE（须在 %NODE_EXE% 绑定之后调用）。
rem 失败即 die —— 静默丢一个用户显式指定的环境变量，比安装失败更难排查。
:flush_user_env
if "%USER_ENV_N%"=="0" exit /b 0
set /a USER_ENV_I=1
:flush_user_env_loop
if %USER_ENV_I% gtr %USER_ENV_N% exit /b 0
call :add_env "%%USER_ENV_%USER_ENV_I%%%"
if errorlevel 1 exit /b 1
set /a USER_ENV_I+=1
goto flush_user_env_loop

:opt_apikey
call :maybe_join_arg3 "%~2" "%~3"
if "%JOINED%"=="1" shift
set "API_KEY=%MV%"
shift
shift
goto parse

:opt_password
call :maybe_join_arg3 "%~2" "%~3"
if "%JOINED%"=="1" shift
set "SVC_PASSWORD=%MV%"
shift
shift
goto parse

:parse_done
rem ⚠️ 目录参数若以反斜杠结尾，写进 set "VAR=值" 时 cmd 会把结尾的 \" 吃掉
rem    （实测得到 C:\dir" 这种坏值）—— 统一剥掉结尾反斜杠。
call :strip_trailing_slash DSH_HOME
call :strip_trailing_slash INSTALL_DIR
if "%LOG_DIR%"=="" set "LOG_DIR=%INSTALL_DIR%\logs"
if "%OUT_DIR%"=="" set "OUT_DIR=%INSTALL_DIR%\pkg"
if /i "%CMD%"=="package" set "OUT_DIR=%REPO_ROOT%\dist\dsh-providers-hub-%PKG_VERSION%"
if /i "%MODE%"=="standalone" if /i "%CMD%"=="package" set "OUT_DIR=%REPO_ROOT%\dist\standalone"
if /i "%MODE%"=="bootstrap" if /i "%CMD%"=="package" set "OUT_DIR=%REPO_ROOT%\dist\bootstrap"
call :strip_trailing_slash LOG_DIR
call :strip_trailing_slash OUT_DIR
call :strip_trailing_slash WORK_DIR
set "ZIP_FILE=%OUT_DIR%.zip"
if defined PROGRAM if not exist "%PROGRAM%" (
  for %%i in ("%PROGRAM%") do set "PROGRAM=%%~fi"
)
if defined PROGRAM for %%i in ("%PROGRAM%") do set "PROGRAM_NAME=%%~nxi"
if defined PROGRAM for %%i in ("%PROGRAM%") do set "PROGRAM_DIR=%%~dpi"
call :strip_trailing_slash PROGRAM_DIR

rem ---------- standalone 模式（独立产物：自带 Node 运行时 + 全部依赖）----------
rem ⚠️ 这里刻意用 goto 而不是括号块：cmd 在括号块内执行 `call :label` 时，
rem    标签查找会失效（报 "cannot find the batch label specified"）。
if /i "%MODE%"=="standalone" goto do_setup_standalone
if /i "%MODE%"=="bootstrap" goto do_setup_standalone
goto after_setup_standalone
:do_setup_standalone
call :setup_standalone
if errorlevel 1 exit /b 1
:after_setup_standalone

rem ---------- 分发 ----------
if /i "%CMD%"=="help"       goto cmd_help
if /i "%CMD%"=="check"      goto cmd_check
if /i "%CMD%"=="package"    goto cmd_package
if /i "%CMD%"=="install"    goto cmd_install
if /i "%CMD%"=="start"      goto cmd_start
if /i "%CMD%"=="stop"       goto cmd_stop
if /i "%CMD%"=="restart"    goto cmd_restart
if /i "%CMD%"=="status"     goto cmd_status
if /i "%CMD%"=="logs"       goto cmd_logs
if /i "%CMD%"=="uninstall"  goto cmd_uninstall
goto cmd_unknown

rem ====================================================================
rem  help
rem ====================================================================
:cmd_help
echo.
echo ============================================================
echo  dsh-providers-hub Windows 服务脚本
echo ============================================================
echo.
echo  用法: service.bat ^<命令^> [选项]
echo.
echo  命令:
echo    check       体检：管理员权限、node、pnpm、nssm、dsh 宿主、端口占用
echo    package     打包程序（构建插件 + 收集产物 + 生产依赖 + zip）
echo    install     打包 + 注册服务（可选立即启动）
echo    start       启动服务
echo    stop        停止服务
echo    restart     重启服务
echo    status      查看服务状态、监听端口与连通性
echo    logs        打印服务日志尾部（-tail 指定行数，默认 50）
echo    uninstall   停止并删除服务（-purge 连同安装目录一起删）
echo    help        本帮助
echo.
echo  选项:
echo    -name ^<服务名^>          服务注册名（默认 dsh-providers-hub）
echo    -displayname ^<显示名^>    服务管理器里显示的名称
echo    -description ^<描述^>      服务描述
echo    -mode dsh^|custom^|bootstrap^|standalone
echo                           dsh=DSH 宿主+本插件（默认）
echo                           custom=任意程序
echo                           bootstrap=引导产物：依赖由目标机 install.cmd 按需下载
echo                           （产物约 20MB，需目标机有 Node 与网络）
echo                           standalone=自包含产物：自带 Node 与全部 npm 依赖
echo                           （产物约 800MB，目标机完全离线可跑）
echo    -program ^<exe^>          custom 模式：可执行文件路径（必填）
echo    -args ^<参数字符串^>        custom 模式：程序参数（支持双引号分组）
echo    -workdir ^<目录^>          工作目录（默认取程序所在目录）
echo    -port ^<端口^>            服务监听端口（默认 8123）
echo    -host ^<地址^>            DSH Web UI 监听地址（默认 127.0.0.1）
echo    -gatewayport ^<端口^>     OpenAI 网关端口（默认 8326）
echo    -gatewayhost ^<地址^>     网关监听地址；留空=不设置该环境变量
echo    -apikey ^<密钥^>          网关 Bearer 密钥（写进服务环境变量）
echo    -profile ^<名称^>         DSH profile 名（默认 prod）
echo    -dshhome ^<目录^>         DSH_HOME（默认 %ProgramData%\dsh-providers-hub\home）
echo    -dshbin ^<bin.js^>        指定 dsh 宿主入口（默认自动探测）
echo    -node ^<node.exe^>        指定 node 可执行文件（默认自动探测）
echo    -nssm ^<nssm.exe^>        指定服务注册工具（默认 tools\nssm.exe 或 PATH）
echo    -installdir ^<目录^>      安装目录（默认 %ProgramData%\dsh-providers-hub）
echo    -logdir ^<目录^>          日志目录（默认 ^<installdir^>\logs）
echo    -outdir ^<目录^>          打包输出目录
echo    -bundledir ^<目录^>       standalone 模式：独立产物目录（install 时指定）
echo    -user ^<域\用户^>         服务运行账户（默认 LocalSystem）
echo    -password ^<密码^>        服务运行账户密码
echo    -start auto^|demand^|disabled   启动类型（默认 auto）
echo    -env ^<NAME=VALUE^>       追加环境变量（可重复）
echo.
echo  注意: 值里带 = 的实参（-env / -apikey / -password）请加引号，
echo        例如 -env "DSH_OPENAI_GATEWAY_API_KEY=abc=="
echo        （不加引号时 cmd 会在 = 处把实参拆成两个）
echo    -tail ^<行数^>            logs 输出行数
echo    -nobuild / -nodeps / -nozip / -nostart / -nopackage / -nocopy
echo    -skipplugin   跳过「把插件装进 profile」这一步
echo    -createprofile  profile 不存在时尝试用 --from-default-profile 初始化
echo    -force        服务已存在时覆盖其配置
echo    -purge        uninstall 时连同安装目录一起删除
echo.
echo  前置条件:
echo    1) Windows Server 2016+ / Windows 10+，注册服务必须【管理员身份】运行。
echo    2) Node.js 满足 ^22.19.0 或 ^>=24（打包与运行都需要）。
echo    3) pnpm（仅 package/install 需要；生产依赖可用 npm 装）。
echo    4) NSSM（服务注册工具）：https://nssm.cc/download
echo       放到 %SCRIPT_DIR%\tools\nssm.exe，或用 -nssm 指定路径。
echo    5) dsh 模式还需本机已装 DSH 宿主，且 DSH_HOME 下已有目标 profile。
echo.
echo  产物:
echo    %INSTALL_DIR%\service.conf        程序/参数/工作目录/环境变量
echo    %INSTALL_DIR%\service-runner.mjs  进程包装器（参数不经 cmd 解析，无引号坑）
echo    %INSTALL_DIR%\logs\               stdout / stderr 日志
echo    改完 service.conf 后执行 service.bat restart 生效。
echo.
echo  示例:
echo    service.bat check
echo    service.bat package
echo    service.bat install -Name dsh-hub -Profile prod -Port 8123
echo    service.bat install -Mode custom -Program "C:\app\server.exe" -Args "--port 9000"
echo    service.bat status
echo    service.bat logs -tail 200
echo    service.bat uninstall
echo.
exit /b 0

rem ====================================================================
rem  check
rem ====================================================================
:cmd_check
echo.
echo ============================================================
if /i "%MODE%"=="standalone" goto chk_standalone
if /i "%MODE%"=="bootstrap" goto chk_standalone
echo  [体检] 服务名=%SVC_NAME%  模式=%MODE%
echo ============================================================
rem 注意：下面刻意用 goto 而不是括号块 —— 括号块里的 %VAR% 会在进入块之前
rem 就被展开，读不到被调子过程刚刚 set 的值（如 DSH_BIN / SVC_EXISTS）。
call :is_admin
if errorlevel 1 goto chk_admin_no
echo  [OK] 管理员权限
goto chk_node
:chk_admin_no
echo  [!!] 管理员权限: 缺少 —— install / start / stop / uninstall 需要管理员
:chk_node
call :find_node
if errorlevel 1 goto chk_node_no
echo  [OK] node.exe = %NODE_EXE%
call :check_node_version
goto chk_pnpm
:chk_node_no
echo  [!!] node.exe: 未找到 —— 打包与运行都需要 Node.js
:chk_pnpm
where pnpm >nul 2>&1
if errorlevel 1 goto chk_pnpm_no
echo  [OK] pnpm
goto chk_nssm
:chk_pnpm_no
echo  [!!] pnpm: 未找到 —— package 步骤需要（也可用 npm 手工安装生产依赖）
:chk_standalone
echo.
echo ============================================================
echo  [体检] 服务名=%SVC_NAME%  模式=%MODE%
echo ============================================================
call :is_admin
if errorlevel 1 goto chk_sa_admin_no
echo  [OK] 管理员权限
goto chk_sa_node
:chk_sa_admin_no
echo  [!!] 管理员权限: 缺少 —— install / start / stop / uninstall 需要管理员
:chk_sa_node
if exist "%BUNDLE_DIR%\runtime\node.exe" goto chk_sa_node_ok
if /i "%MODE%"=="bootstrap" goto chk_sa_node_sys
echo  [!!] 产物缺少内置 Node: %BUNDLE_DIR%\runtime\node.exe
goto chk_sa_host
:chk_sa_node_sys
call :find_node
if errorlevel 1 goto chk_sa_node_nosys
echo  [OK] 未内置 Node，将使用系统 Node = %NODE_EXE%
goto chk_sa_host
:chk_sa_node_nosys
echo  [!!] 未内置 Node 且系统找不到 node.exe —— 请安装 Node.js（22.19+ 或 24）
goto chk_sa_host
:chk_sa_node_ok
echo  [OK] 产物内置 Node = %BUNDLE_DIR%\runtime\node.exe
:chk_sa_host
if exist "%BUNDLE_DIR%\home\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" goto chk_sa_host_ok
echo  [!!] 产物缺少 DSH 宿主入口: %BUNDLE_DIR%\home\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js
goto chk_sa_profile
:chk_sa_host_ok
echo  [OK] 产物内置 DSH 宿主
:chk_sa_profile
if exist "%BUNDLE_DIR%\home\profiles\%PROFILE%\package.json" goto chk_sa_profile_ok
echo  [!!] 产物里没有 profile %PROFILE%
goto chk_sa_nssm
:chk_sa_profile_ok
echo  [OK] 预置 profile = %PROFILE%（免 npm install）
:chk_sa_nssm
call :find_nssm
if not defined NSSM_EXE goto chk_sa_nssm_bad
echo  [OK] nssm = %NSSM_EXE%
goto chk_sa_end
:chk_sa_nssm_bad
echo  [!!] nssm.exe: 未找到 —— 注册服务需要它（https://nssm.cc/download）
:chk_sa_end
echo.
exit /b 0

:chk_nssm
call :find_nssm
if errorlevel 1 goto chk_nssm_bad
if defined NSSM_EXE goto chk_nssm_ok
echo  [!!] nssm.exe: 未找到 —— 注册服务需要它（start / stop / status 不需要）
call :nssm_hint
goto chk_mode
:chk_nssm_ok
echo  [OK] nssm.exe = %NSSM_EXE%
goto chk_mode
:chk_nssm_bad
echo  [!!] nssm.exe: 指定的路径无效
:chk_mode
if /i "%MODE%"=="custom" goto chk_custom
call :find_dsh
if errorlevel 1 goto chk_dsh_no
echo  [OK] dsh 宿主 = %DSH_BIN%
if exist "%DSH_HOME%\profiles\%PROFILE%\package.json" goto chk_profile_ok
echo  [!!] profile %PROFILE% 不存在（DSH_HOME=%DSH_HOME%）
echo       初始化: node "%DSH_BIN%" --profile %PROFILE% --from-default-profile web
goto chk_ports
:chk_profile_ok
echo  [OK] profile %PROFILE% 已存在于 %DSH_HOME%\profiles\%PROFILE%
goto chk_ports
:chk_dsh_no
echo  [!!] dsh 宿主: 未找到 —— 用 -dshbin 指定，或先装好 @deepseek-ai/dsh
goto chk_ports
:chk_custom
if not defined PROGRAM goto chk_custom_no
echo  [OK] 指定程序 = %PROGRAM%
goto chk_ports
:chk_custom_no
echo  [!!] custom 模式必须给 -program ^<exe^>
:chk_ports
call :check_port %PORT%
call :check_port %GW_PORT%
call :svc_exists
if "%SVC_EXISTS%"=="1" goto chk_svc_yes
echo  [--] 服务 %SVC_NAME% 尚未注册
goto chk_end
:chk_svc_yes
echo  [OK] 服务 %SVC_NAME% 已注册
:chk_end
echo.
exit /b 0

rem ====================================================================
rem  package
rem ====================================================================
:cmd_package
if /i "%MODE%"=="custom" goto pkg_custom
if /i "%MODE%"=="standalone" goto pkg_standalone
if /i "%MODE%"=="bootstrap" goto pkg_bootstrap
echo.
echo ============================================================
echo  [打包] dsh-providers-hub %PKG_VERSION%  -^>  %OUT_DIR%
echo ============================================================
if "%NO_BUILD%"=="0" (
  echo [1/5] 构建插件（pnpm build:all）...
  pushd "%REPO_ROOT%"
  call pnpm build:all
  if errorlevel 1 (
    popd
    call :die "构建失败（pnpm build:all），已中止打包"
    exit /b 1
  )
  popd
) else (
  echo [1/5] 跳过构建（-NoBuild）
)
if not exist "%REPO_ROOT%\lib\index.js" (
  call :die "缺少构建产物 lib\index.js，请先执行 pnpm build:all"
  exit /b 1
)
echo [2/5] 清理输出目录...
if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
mkdir "%OUT_DIR%" >nul 2>&1
if not exist "%OUT_DIR%" (
  call :die "无法创建输出目录: %OUT_DIR%"
  exit /b 1
)
echo [3/5] 收集产物（lib / locale / cordis.patch.yml）...
xcopy "%REPO_ROOT%\lib" "%OUT_DIR%\lib\" /E /I /Q /Y >nul
xcopy "%REPO_ROOT%\locale" "%OUT_DIR%\locale\" /E /I /Q /Y >nul
copy /y "%REPO_ROOT%\cordis.patch.yml" "%OUT_DIR%\" >nul
if not exist "%OUT_DIR%\lib\index.js" (
  call :die "复制产物失败"
  exit /b 1
)
rem 生成精简 package.json：剔除 scripts（含 prepare）与 devDependencies，
rem 否则在目标目录里 npm install 会触发 prepare 构建而失败。
node -e "const fs=require('fs');const s=process.argv[1],d=process.argv[2];const j=JSON.parse(fs.readFileSync(s,'utf8'));delete j.scripts;delete j.devDependencies;delete j.prepare;delete j.files;fs.writeFileSync(d,JSON.stringify(j,null,2)+'\n')" "%REPO_ROOT%\package.json" "%OUT_DIR%\package.json"
if errorlevel 1 (
  call :die "生成精简 package.json 失败"
  exit /b 1
)
if "%NO_DEPS%"=="0" (
  echo [4/5] 安装生产依赖（npm install --omit=dev --omit=peer）...
  pushd "%OUT_DIR%"
  call npm install --omit=dev --omit=peer --no-audit --no-fund --ignore-scripts
  if errorlevel 1 (
    popd
    call :die "生产依赖安装失败（离线服务器可加 -NoDeps 跳过）"
    exit /b 1
  )
  popd
) else (
  echo [4/5] 跳过依赖安装（-NoDeps）
)
if "%NO_ZIP%"=="0" (
  echo [5/5] 生成 zip: %ZIP_FILE%
  if exist "%ZIP_FILE%" del /q "%ZIP_FILE%"
  powershell -NoProfile -Command "Compress-Archive -Path '%OUT_DIR%\*' -DestinationPath '%ZIP_FILE%' -Force"
  if errorlevel 1 echo  [警告] zip 生成失败，可手工压缩 %OUT_DIR%
) else (
  echo [5/5] 跳过 zip（-NoZip）
)
echo.
echo [完成] 打包产物: %OUT_DIR%
echo        %ZIP_FILE%
echo  下一步（在目标服务器上）:
echo        1) node ^<dsh-bin^> plugin --profile %PROFILE% install "%OUT_DIR%"
echo        2) service.bat install -Profile %PROFILE% -NoPackage
echo.
exit /b 0

:pkg_bootstrap
echo.
echo ============================================================
echo  [打包] bootstrap 引导产物（依赖由目标机 install.cmd 按需下载）
echo ============================================================
set "BUILD_SCRIPT=%REPO_ROOT%\scripts\build-bootstrap.mjs"
if not exist "%BUILD_SCRIPT%" (
  call :die "缺少打包脚本: %BUILD_SCRIPT%"
  exit /b 1
)
set "SA_OUT=%OUT_DIR%"
if "%SA_OUT%"=="" set "SA_OUT=%REPO_ROOT%\dist\bootstrap"
if "%NO_BUILD%"=="1" (
  node "%BUILD_SCRIPT%" --out "%SA_OUT%" --profile "%PROFILE%" --skip-build
) else (
  node "%BUILD_SCRIPT%" --out "%SA_OUT%" --profile "%PROFILE%"
)
if errorlevel 1 (
  call :die "引导产物打包失败（node scripts\build-bootstrap.mjs）"
  exit /b 1
)
echo.
echo [完成] 产物目录: %SA_OUT%\dsh-providers-hub-%PKG_VERSION%-win-x64
echo        目标机：解压 -^> install.cmd（下载依赖）-^> start.cmd
echo        需要产物自带 Node 时改用：node scripts\build-bootstrap.mjs --with-node
echo.
exit /b 0

:pkg_standalone
echo.
echo ============================================================
echo  [打包] standalone 独立产物（自带 Node 运行时 + 全部 npm 依赖）
echo ============================================================
set "BUILD_SCRIPT=%REPO_ROOT%\scripts\build-standalone.mjs"
if not exist "%BUILD_SCRIPT%" (
  call :die "缺少打包脚本: %BUILD_SCRIPT%"
  exit /b 1
)
set "SA_OUT=%OUT_DIR%"
if "%SA_OUT%"=="" set "SA_OUT=%REPO_ROOT%\dist\standalone"
if "%NO_BUILD%"=="1" (
  if "%NO_ZIP%"=="0" (
    node "%BUILD_SCRIPT%" --out "%SA_OUT%" --profile "%PROFILE%" --skip-build --zip
  ) else (
    node "%BUILD_SCRIPT%" --out "%SA_OUT%" --profile "%PROFILE%" --skip-build
  )
) else (
  if "%NO_ZIP%"=="0" (
    node "%BUILD_SCRIPT%" --out "%SA_OUT%" --profile "%PROFILE%" --zip
  ) else (
    node "%BUILD_SCRIPT%" --out "%SA_OUT%" --profile "%PROFILE%"
  )
)
if errorlevel 1 (
  call :die "独立产物打包失败（node scripts\build-standalone.mjs）"
  exit /b 1
)
echo.
echo [完成] 产物目录: %SA_OUT%\dsh-providers-hub-%PKG_VERSION%-win-x64
echo        目标机解压后直接运行 start.cmd —— 无需 Node / npm / pnpm / 网络。
echo.
exit /b 0

:pkg_custom
echo.
echo ============================================================
echo  [打包] custom 模式  -^>  %INSTALL_DIR%\app
echo ============================================================
if not defined PROGRAM (
  call :die "custom 模式必须给 -program ^<exe^>"
  exit /b 1
)
if not exist "%PROGRAM%" (
  call :die "指定的程序不存在: %PROGRAM%"
  exit /b 1
)
if "%NO_COPY%"=="1" (
  echo [1/2] 跳过复制（-NoCopy），服务将直接运行原路径
) else (
  echo [1/2] 复制程序目录到 %INSTALL_DIR%\app ...
  call :copy_tree "%PROGRAM_DIR%" "%INSTALL_DIR%\app"
  if errorlevel 1 exit /b 1
)
echo [2/2] 完成
echo.
exit /b 0

rem ====================================================================
rem  install
rem ====================================================================
:cmd_install
echo.
echo ============================================================
echo  [安装] 服务 %SVC_NAME%
echo ============================================================
call :require_admin
if errorlevel 1 exit /b 1
call :require_nssm
if errorlevel 1 exit /b 1
call :find_node
if errorlevel 1 exit /b 1

if /i "%MODE%"=="custom" goto install_custom
if /i "%MODE%"=="standalone" goto install_standalone
if /i "%MODE%"=="bootstrap" goto install_standalone

rem ---- dsh 模式 ----
call :find_dsh
if errorlevel 1 exit /b 1

if "%NO_PACKAGE%"=="0" (
  echo [1/5] 打包...
  call :do_package
  if errorlevel 1 exit /b 1
) else (
  echo [1/5] 跳过打包（-NoPackage），沿用 %OUT_DIR%
)
if not exist "%OUT_DIR%\package.json" (
  call :die "打包目录缺少 package.json: %OUT_DIR%（去掉 -NoPackage 或先执行 package）"
  exit /b 1
)

echo [2/5] 安装插件到 profile %PROFILE% ...
call :install_plugin
if errorlevel 1 exit /b 1

echo [3/5] 生成服务配置...
set "WORK_DIR=%DSH_HOME%\profiles\%PROFILE%"
if not exist "%WORK_DIR%" set "WORK_DIR=%INSTALL_DIR%"
rem 用户的 -env 暂存此刻已可写入（NODE_EXE 已绑定）—— 须在固定值之前，让用户
rem 显式指定的值排在后面（service.conf 读取顺序：后写覆盖前写）。
call :flush_user_env
if errorlevel 1 exit /b 1
call :add_env "DSH_HOME=%DSH_HOME%"
if errorlevel 1 exit /b 1
call :add_env "DSH_OPENAI_GATEWAY_ENABLED=1"
if errorlevel 1 exit /b 1
call :add_env "DSH_OPENAI_GATEWAY_PORT=%GW_PORT%"
if errorlevel 1 exit /b 1
if defined GW_HOST call :add_env "DSH_OPENAI_GATEWAY_HOST=%GW_HOST%"
if errorlevel 1 exit /b 1
if defined API_KEY call :add_env "DSH_OPENAI_GATEWAY_API_KEY=%API_KEY%"
if errorlevel 1 exit /b 1
call :check_gateway_host
rem 路径可能带空格 —— 在配置里用双引号分组，由包装器负责还原 argv
set "CONF_PROGRAM=%NODE_EXE%"
set "CONF_ARGS="%DSH_BIN%" --profile %PROFILE% --host %BIND_HOST% --port %PORT% --no-open"
set "CONF_CWD=%WORK_DIR%"
call :write_conf
if errorlevel 1 exit /b 1

echo [4/5] 注册服务...
call :nssm_register
if errorlevel 1 exit /b 1

echo [5/5] 启动服务...
if "%NO_START%"=="1" (
  echo  跳过启动（-NoStart）
) else (
  call :do_start
  if errorlevel 1 exit /b 1
)
call :print_summary
echo.
exit /b 0

rem ---- custom 模式 ----
:install_standalone
echo.
echo ============================================================
echo  [安装] 服务 %SVC_NAME%（%MODE% 产物）
echo ============================================================
call :require_admin
if errorlevel 1 exit /b 1
call :require_nssm
if errorlevel 1 exit /b 1

rem ⚠️ 2026-10-31 审计（P1）：install -BundleDir 指向完整产物时旧版仍会走打包
rem    （在目标机上 scripts\build-bootstrap.mjs 不存在 → 直接 die；在打包机上会把
rem    新产物打到无关的 %INSTALL_DIR%\pkg\）。现在检测产物里核心文件是否已就位：
rem    bootstrap 的核心是 plugin\lib\index.js，standalone 的核心是预置 profile 里
rem    的插件 lib\index.js。二者都在时自动跳过打包（-Force 保留「强制重打包」语义）。
rem
rem ⚠️⚠️ 2026-10-31 复审 B-1 修：standalone 检测不能一条 for /d 同时在两个路径段
rem    放 * —— cmd 的 FOR 通配**只展开最后一段**，中段通配静默零匹配（本机
rem    cmd 10.0.26100 实测 30+ 组对照），首版因此恒不命中、standalone 仍走打包。
rem    修法：双层循环，每层只对**末段**用通配；内层判据是「该目录下有插件自己的
rem    lib\index.js」（对齐 build-standalone.mjs:509 的真实布局
rem    home\profiles\<profile>\node_modules\<plugin>\lib），并要求该 profile 有
rem    package.json（2 级上溯 = profile 级；首版写 4 级指向不存在的 home\package.json）。
rem    插件目录名不写死：任何 node_modules 下带 lib\index.js 的包都算 —— 宿主
rem    @deepseek-ai\dsh 也带 lib\index.js，但它与 profile 级 package.json 的组合
rem    恰好等价于「宿主已就位」，同样是「产物完整」的合法证据，不引入误判。
set "SA_BUNDLE_COMPLETE=0"
if exist "%BUNDLE_DIR%\plugin\lib\index.js" set "SA_BUNDLE_COMPLETE=1"
if "%SA_BUNDLE_COMPLETE%"=="0" if exist "%BUNDLE_DIR%\home\profiles" (
  for /d %%p in ("%BUNDLE_DIR%\home\profiles\*") do (
    if exist "%%p\package.json" for /d %%d in ("%%p\node_modules\*") do (
      if exist "%%d\lib\index.js" set "SA_BUNDLE_COMPLETE=1"
    )
  )
)
if "%SA_BUNDLE_COMPLETE%"=="1" if "%FORCE%"=="0" (
  echo [1/4] 产物目录已含完整产物，自动跳过打包（等价 -NoPackage；加 -Force 可强制重打包）
  goto install_standalone_conf
)
if "%NO_PACKAGE%"=="0" (
  echo [1/4] 生成独立产物（自带 Node + 全部依赖）...
  call :cmd_package
  if errorlevel 1 exit /b 1
) else (
  echo [1/4] 跳过打包（-NoPackage），沿用 %BUNDLE_DIR%
)

:install_standalone_conf
echo [2/4] 生成服务配置...
set "WORK_DIR=%BUNDLE_DIR%"
set "CONF_PROGRAM=%NODE_EXE%"
set "CONF_ARGS="%BUNDLE_DIR%\home\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile %PROFILE% --host %BIND_HOST% --port %PORT% --no-open"
set "CONF_CWD=%BUNDLE_DIR%"
rem 用户的 -env 暂存此刻已可写入（NODE_EXE 已绑定）——理由同 install_dsh 流。
call :flush_user_env
if errorlevel 1 exit /b 1
call :add_env "DSH_HOME=%BUNDLE_DIR%\home"
if errorlevel 1 exit /b 1
call :add_env "DSH_OPENAI_GATEWAY_ENABLED=1"
if errorlevel 1 exit /b 1
call :add_env "DSH_OPENAI_GATEWAY_PORT=%GW_PORT%"
if errorlevel 1 exit /b 1
if defined GW_HOST call :add_env "DSH_OPENAI_GATEWAY_HOST=%GW_HOST%"
if errorlevel 1 exit /b 1
if defined API_KEY call :add_env "DSH_OPENAI_GATEWAY_API_KEY=%API_KEY%"
if errorlevel 1 exit /b 1
call :write_conf
if errorlevel 1 exit /b 1

echo [3/4] 注册服务...
call :nssm_register
if errorlevel 1 exit /b 1

echo [4/4] 启动服务...
if "%NO_START%"=="1" (
  echo  跳过启动（-NoStart）
) else (
  call :do_start
  if errorlevel 1 exit /b 1
)
call :print_summary
echo.
exit /b 0

:install_custom
if not defined PROGRAM (
  call :die "custom 模式必须给 -program ^<exe^>"
  exit /b 1
)
if "%NO_PACKAGE%"=="0" (
  echo [1/5] 打包（复制程序）...
  call :do_package
  if errorlevel 1 exit /b 1
) else (
  echo [1/5] 跳过打包（-NoPackage）
)
echo [2/5] 生成服务配置...
set "SVC_PROGRAM=%PROGRAM%"
if "%NO_COPY%"=="0" goto custom_rel
goto custom_conf
:custom_rel
rem 打包后程序落在 installdir\app\ 下（PROGRAM_DIR 就是程序所在目录）
if exist "%INSTALL_DIR%\app\%PROGRAM_NAME%" set "SVC_PROGRAM=%INSTALL_DIR%\app\%PROGRAM_NAME%"
:custom_conf
if not defined WORK_DIR set "WORK_DIR=%PROGRAM_DIR%"
set "CONF_PROGRAM=%SVC_PROGRAM%"
set "CONF_ARGS=%PROGRAM_ARGS%"
set "CONF_CWD=%WORK_DIR%"
rem custom 模式同样 flush 用户的 -env（NODE_EXE 可能仍未绑定 —— write_conf
rem 内部会做最后一次 PATH 兜底；flush 失败即中止，不静默丢）。
call :flush_user_env
if errorlevel 1 exit /b 1
call :write_conf
if errorlevel 1 exit /b 1

echo [3/5] 注册服务...
call :nssm_register
if errorlevel 1 exit /b 1

echo [4/5] 启动服务...
if "%NO_START%"=="1" (
  echo  跳过启动（-NoStart）
) else (
  call :do_start
  if errorlevel 1 exit /b 1
)
call :print_summary
echo.
exit /b 0

rem ====================================================================
rem  start / stop / restart
rem ====================================================================
:cmd_start
call :require_admin
if errorlevel 1 exit /b 1
call :find_nssm
if errorlevel 1 exit /b 1
call :do_start
exit /b %ERRORLEVEL%

:cmd_stop
call :require_admin
if errorlevel 1 exit /b 1
call :find_nssm
if errorlevel 1 exit /b 1
call :do_stop
exit /b %ERRORLEVEL%

:cmd_restart
call :require_admin
if errorlevel 1 exit /b 1
call :find_nssm
if errorlevel 1 exit /b 1
call :do_stop
call :do_start
exit /b %ERRORLEVEL%

rem ====================================================================
rem  status
rem ====================================================================
:cmd_status
echo.
echo ============================================================
echo  [状态] 服务 %SVC_NAME%
echo ============================================================
call :svc_exists
if "%SVC_EXISTS%"=="0" (
  echo  服务未注册。
  exit /b 0
)
sc query "%SVC_NAME%"
echo.
echo --- 注册信息 ---
sc qc "%SVC_NAME%"
echo.
echo --- 端口监听 ---
netstat -ano | findstr /i "LISTENING" | findstr /c:":%PORT% "
if errorlevel 1 echo   (端口 %PORT% 未在监听)
netstat -ano | findstr /i "LISTENING" | findstr /c:":%GW_PORT% "
if errorlevel 1 echo   (网关端口 %GW_PORT% 未在监听)
echo.
echo --- 连通性 ---
powershell -NoProfile -Command "try{$c=[Net.Sockets.TcpClient]::new();$c.Connect('127.0.0.1',%GW_PORT%);$c.Close();'  网关端口 %GW_PORT% 可连接'}catch{'  网关端口 %GW_PORT% 不可连接'}"
echo.
echo --- 日志 ---
echo   %LOG_DIR%\stdout.log
echo   %LOG_DIR%\stderr.log
echo.
exit /b 0

rem ====================================================================
rem  logs
rem ====================================================================
:cmd_logs
echo.
echo ============================================================
echo  [日志] %LOG_DIR%（尾部 %LOG_TAIL% 行）
echo ============================================================
if not exist "%LOG_DIR%\stdout.log" if not exist "%LOG_DIR%\stderr.log" (
  echo  没有日志文件：服务可能从未启动过。
  exit /b 0
)
echo --- stdout ---
powershell -NoProfile -Command "Get-Content -Path '%LOG_DIR%\stdout.log' -Tail %LOG_TAIL% -Encoding UTF8 -ErrorAction SilentlyContinue"
echo --- stderr ---
powershell -NoProfile -Command "Get-Content -Path '%LOG_DIR%\stderr.log' -Tail %LOG_TAIL% -Encoding UTF8 -ErrorAction SilentlyContinue"
echo.
exit /b 0

rem ====================================================================
rem  uninstall
rem ====================================================================
:cmd_uninstall
echo.
echo ============================================================
echo  [卸载] 服务 %SVC_NAME%
echo ============================================================
call :require_admin
if errorlevel 1 exit /b 1
call :find_nssm
if errorlevel 1 exit /b 1
call :svc_exists
if "%SVC_EXISTS%"=="0" (
  echo  服务未注册，无需卸载。
  goto uninstall_purge
)
if defined NSSM_EXE (
  call "%NSSM_EXE%" stop "%SVC_NAME%" >nul 2>&1
  call "%NSSM_EXE%" remove "%SVC_NAME%" confirm
  if errorlevel 1 (
    echo  nssm remove 失败，改用 sc delete ...
    sc delete "%SVC_NAME%"
  )
) else (
  echo  未找到 nssm，直接用 sc delete ...
  sc stop "%SVC_NAME%" >nul 2>&1
  sc delete "%SVC_NAME%"
)
call :svc_exists
if "%SVC_EXISTS%"=="1" (
  call :die "服务删除失败，请检查是否被其它进程占用"
  exit /b 1
)
echo  已删除服务 %SVC_NAME%
:uninstall_purge
if "%PURGE%"=="1" (
  echo  清理安装目录 %INSTALL_DIR% ...
  if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"
  echo  已清理
) else (
  echo  保留安装目录与数据：%INSTALL_DIR%
  echo  （加 -purge 可一并删除；DSH_HOME 下的账号池数据请自行确认后再删）
)
echo.
exit /b 0

rem ====================================================================
rem  子过程
rem ====================================================================

:die
echo.
echo [错误] %~1
echo.
exit /b 1

:require_admin
call :is_admin
if errorlevel 1 (
  echo [错误] 需要管理员权限：请右键本脚本 -^>「以管理员身份运行」
  exit /b 1
)
exit /b 0

:is_admin
net session >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:detect_version
set "PKG_VERSION=unknown"
for /f "usebackq delims=" %%v in (`node -p "try{require('%REPO_SLASH%/package.json').version}catch(e){''}" 2^>nul`) do set "PKG_VERSION=%%v"
if not defined PKG_VERSION set "PKG_VERSION=unknown"
exit /b 0

:add_env
rem ⚠️ 2026-10-31 审计（P1）：这里曾经用裸 `node`（PATH），而 install 前已把产物内
rem    node.exe 绑定进 %NODE_EXE%。干净目标机上 PATH 没有 node → append 静默失败、
rem    环境变量丢失（DSH_HOME / 网关端口 / API_KEY 等），症状极难排查。
rem    改用 %NODE_EXE%，并在 %NODE_EXE% 未绑定/文件不存在时显式失败。
if not defined NODE_EXE goto add_env_no_node
if not exist "%NODE_EXE%" goto add_env_no_node
"%NODE_EXE%" -e "const fs=require('fs');const f=process.env.ENV_FILE;fs.appendFileSync(f,process.argv[1]+String.fromCharCode(10),'utf8')" "%~1"
if errorlevel 1 (
  echo [错误] add_env 写入失败: %~1
  exit /b 1
)
exit /b 0
:add_env_no_node
echo [错误] add_env 找不到 node.exe（%%NODE_EXE%% 未绑定）——无法写入环境变量 %~1
exit /b 1

rem 去掉变量值结尾的反斜杠（%1=变量名）
:strip_trailing_slash
if not defined %~1 exit /b 0
call set "SV=%%%~1%%"
call set "SLAST=%%SV:~-1%%"
if "%SLAST%"=="\" call set "%~1=%%SV:~0,-1%%"
exit /b 0

rem standalone / bootstrap 模式初始化：定位产物目录、校验完整性、绑定 Node
rem   standalone = 完全离线产物（自带 node.exe + 全部 node_modules）
rem   bootstrap  = 引导产物（依赖由 install.cmd 按需下载；Node 可自带也可用系统）
:setup_standalone
if "%BUNDLE_DIR%"=="" (
  if /i "%MODE%"=="bootstrap" (
    set "BUNDLE_DIR=%REPO_ROOT%\dist\bootstrap\dsh-providers-hub-%PKG_VERSION%-win-x64"
  ) else (
    set "BUNDLE_DIR=%REPO_ROOT%\dist\standalone\dsh-providers-hub-%PKG_VERSION%-win-x64"
  )
)
call :strip_trailing_slash BUNDLE_DIR
rem package 命令下产物还没生成 —— 跳过存在性校验（由 pkg_standalone 负责产出）
if /i "%CMD%"=="package" exit /b 0

rem ---- Node：产物内置优先；bootstrap 允许退回系统 Node ----
if not exist "%BUNDLE_DIR%\runtime\node.exe" goto sa_node_not_builtin
set "NODE_EXE=%BUNDLE_DIR%\runtime\node.exe"
goto sa_node_done
:sa_node_not_builtin
if /i not "%MODE%"=="bootstrap" goto sa_node_missing
call :find_node
if errorlevel 1 goto sa_node_missing
goto sa_node_done
:sa_node_missing
call :die "产物未内置 Node 且未指定/找不到 node.exe: %BUNDLE_DIR%\runtime\node.exe"
exit /b 1
:sa_node_done

rem ---- 宿主入口：bootstrap 未执行 install.cmd 时这里不存在 ----
if exist "%BUNDLE_DIR%\home\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" goto sa_entry_ok
if /i "%MODE%"=="bootstrap" (
  call :die "依赖尚未安装: %BUNDLE_DIR%\home\profiles —— 请先在产物目录执行 install.cmd"
) else (
  call :die "产物缺少 DSH 宿主入口: %BUNDLE_DIR%\home\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
)
exit /b 1
:sa_entry_ok

rem 产物打包时用的 profile 名可能与当前 -profile 不同 —— 自动对齐到产物里实际存在的那个
if not exist "%BUNDLE_DIR%\home\profiles\%PROFILE%\package.json" (
  for /d %%d in ("%BUNDLE_DIR%\home\profiles\*") do (
    if exist "%%~dpdpackage.json" set "PROFILE=%%~nxd"
  )
)
if not exist "%BUNDLE_DIR%\home\profiles\%PROFILE%\package.json" (
  call :die "产物里找不到可用的 profile: %BUNDLE_DIR%\home\profiles"
  exit /b 1
)
set "DSH_HOME=%BUNDLE_DIR%\home"
set "SVC_CWD=%BUNDLE_DIR%"
if exist "%BUNDLE_DIR%\runtime\service-runner.mjs" set "RUNNER_SRC=%BUNDLE_DIR%\runtime\service-runner.mjs"
exit /b 0

rem cmd 把 name=value 形式的实参传给批处理时，会在 '=' 处把它拆成两个
rem （实测：-env TEST_PORT=18999 会变成 %2=TEST_PORT、%3=18999）。
rem 这里在被拆开时把它粘回去 —— 用户忘了加引号也能用。
rem ⚠️ 判「串里是否含等号」不能用 set 的字符串替换写法（cmd 解析不了），要用 for /f。
:maybe_join_arg3
set "JOINED=0"
set "MV=%~1"
call :has_eq "%~1"
if "%HAS_EQ%"=="1" exit /b 0
if "%~2"=="" exit /b 0
set "MV3=%~2"
if "%MV3:~0,1%"=="-" exit /b 0
set "MV=%~1=%~2"
set "JOINED=1"
exit /b 0

rem %1=待检查的串；结果放 HAS_EQ（1=含 '='）
:has_eq
set "HAS_EQ=0"
for /f "tokens=1,* delims==" %%a in ("%~1") do if not "%%b"=="" set "HAS_EQ=1"
set "HE=%~1"
if "%HE:~-1%"=="=" set "HAS_EQ=1"
exit /b 0

:find_node
if defined NODE_EXE (
  if exist "%NODE_EXE%" exit /b 0
  echo [错误] 指定的 node.exe 不存在: %NODE_EXE%
  exit /b 1
)
for %%f in (node.exe) do if not "%%~$PATH:f"=="" (
  set "NODE_EXE=%%~$PATH:f"
  exit /b 0
)
echo [错误] 找不到 node.exe，请安装 Node.js（^22.19.0 或 ^>=24）或用 -node 指定
exit /b 1

:check_node_version
set "NV="
for /f "usebackq delims=" %%v in (`node -v 2^>nul`) do set "NV=%%v"
if not defined NV (
  echo  [!!] 无法执行 node -v
  exit /b 0
)
set "NV_STR=%NV:~1%"
set "NV_MAJOR="
set "NV_MINOR=0"
for /f "tokens=1,2 delims=." %%a in ("%NV_STR%") do (
  set "NV_MAJOR=%%a"
  set "NV_MINOR=%%b"
)
rem 没有次版本号时 for 不会给 %%b —— 补个默认值，否则后面的比较会变成语法错误
if not defined NV_MAJOR (
  echo  [!!] 无法解析 node 版本: %NV%
  exit /b 0
)
if not defined NV_MINOR set "NV_MINOR=0"
if %NV_MAJOR% gtr 24 (
  echo  [OK] Node %NV%
  exit /b 0
)
if %NV_MAJOR% equ 24 (
  echo  [OK] Node %NV%
  exit /b 0
)
if %NV_MAJOR% equ 22 if %NV_MINOR% geq 19 (
  echo  [OK] Node %NV%
  exit /b 0
)
echo  [!!] Node %NV% 不满足 engines（需要 ^22.19.0 或 ^>=24）
exit /b 0

:find_nssm
rem 只探测不报错：找不到时 NSSM_EXE 保持为空（start/stop 可退回用 sc）
if defined NSSM_EXE (
  if exist "%NSSM_EXE%" exit /b 0
  call :die "指定的 nssm.exe 不存在: %NSSM_EXE%"
  exit /b 1
)
if exist "%TOOLS_DIR%\nssm.exe" (
  set "NSSM_EXE=%TOOLS_DIR%\nssm.exe"
  exit /b 0
)
for %%f in (nssm.exe) do if not "%%~$PATH:f"=="" (
  set "NSSM_EXE=%%~$PATH:f"
  exit /b 0
)
exit /b 0

:require_nssm
call :find_nssm
if errorlevel 1 exit /b 1
if defined NSSM_EXE exit /b 0
call :die "找不到 nssm.exe（服务注册工具）
       下载: https://nssm.cc/download
       放到 %TOOLS_DIR%\nssm.exe ，或用 -nssm 指定完整路径
       （start/stop/status 不需要它，只有注册服务需要）"
exit /b 1

:nssm_hint
echo        下载: https://nssm.cc/download
echo        放到 %TOOLS_DIR%\nssm.exe ，或用 -nssm 指定完整路径
exit /b 0

:find_dsh
if defined DSH_BIN (
  if exist "%DSH_BIN%" exit /b 0
  echo [错误] 指定的 dsh 入口不存在: %DSH_BIN%
  exit /b 1
)
if exist "%DSH_HOME%\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  set "DSH_BIN=%DSH_HOME%\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
  exit /b 0
)
if exist "%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  set "DSH_BIN=%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
  exit /b 0
)
for %%f in (dsh.cmd dsh.exe dsh) do if not "%%~$PATH:f"=="" (
  set "DSH_BIN=%%~$PATH:f"
  set "DSH_IS_CMD=1"
  exit /b 0
)
echo [错误] 找不到 DSH 宿主（@deepseek-ai/dsh）
echo        可用 -dshbin 指向 ...\node_modules\@deepseek-ai\dsh\lib\bin.js
echo        或确保 dsh 命令在 PATH 中
exit /b 1

:svc_exists
set "SVC_EXISTS=0"
sc query "%SVC_NAME%" >nul 2>&1
if not errorlevel 1 set "SVC_EXISTS=1"
exit /b 0

:check_port
set "CHK_PORT=%~1"
netstat -ano | findstr /i "LISTENING" | findstr /c:":%CHK_PORT% " >nul
if errorlevel 1 (
  echo  [--] 端口 %CHK_PORT% 空闲
) else (
  echo  [!!] 端口 %CHK_PORT% 已被占用 —— 换端口或先停掉占用进程
)
exit /b 0

:check_gateway_host
if not defined GW_HOST (
  echo  [提示] 未指定 -gatewayhost：网关默认只监听 127.0.0.1。
  echo         需要对外提供服务请用 -gatewayhost ^<本机具体 IP^>，
  echo         或在设置页打开「允许局域网访问」。
  exit /b 0
)
if /i "%GW_HOST%"=="0.0.0.0" goto gw_wildcard
if /i "%GW_HOST%"=="::" goto gw_wildcard
if /i "%GW_HOST%"=="[::]" goto gw_wildcard
if /i "%GW_HOST%"=="::0" goto gw_wildcard
exit /b 0
:gw_wildcard
echo  [警告] -gatewayhost 给了通配地址 %GW_HOST%：插件的 fail-closed 闸门会拒绝它，
echo         网关将不会启动（不会静默绑全部网卡）。
echo         正解: 填本机某个具体接口地址，或用设置页的「允许局域网访问」开关。
exit /b 0

:copy_tree
set "CP_SRC=%~1"
set "CP_DST=%~2"
if not exist "%CP_SRC%" (
  echo [错误] 源目录不存在: %CP_SRC%
  exit /b 1
)
if not exist "%CP_DST%" mkdir "%CP_DST%" >nul 2>&1
xcopy "%CP_SRC%" "%CP_DST%\" /E /I /Q /Y >nul
if errorlevel 2 (
  echo [错误] 复制失败: %CP_SRC% -^> %CP_DST%
  exit /b 1
)
exit /b 0

:do_package
call :cmd_package
exit /b %ERRORLEVEL%

:install_plugin
if "%SKIP_PLUGIN_INSTALL%"=="1" (
  echo  跳过插件安装（-skipplugin）
  exit /b 0
)
if not exist "%DSH_HOME%\profiles\%PROFILE%\package.json" (
  if "%CREATE_PROFILE%"=="1" (
    echo  profile %PROFILE% 不存在，尝试用 --from-default-profile 初始化...
    node "%DSH_BIN%" --profile %PROFILE% --from-default-profile web --help >nul 2>&1
  )
  if not exist "%DSH_HOME%\profiles\%PROFILE%\package.json" (
    call :die "目标 profile 不存在: %DSH_HOME%\profiles\%PROFILE% —— 请先执行 node %DSH_BIN% --profile %PROFILE% --from-default-profile web ，或用 -dshhome 指向已有 profile 的 DSH_HOME"
    exit /b 1
  )
)
where pnpm >nul 2>&1
if errorlevel 1 (
  call :die "未找到 pnpm：「安装插件到 profile」这一步需要 pnpm；可加 -skipplugin 跳过，并手工执行 node %DSH_BIN% plugin --profile %PROFILE% install %OUT_DIR%"
  exit /b 1
)
node "%DSH_BIN%" plugin --profile %PROFILE% install "%OUT_DIR%"
if errorlevel 1 (
  call :die "插件安装到 profile 失败（dsh plugin --profile %PROFILE% install）"
  exit /b 1
)
echo  插件已安装到 profile %PROFILE%
exit /b 0

:write_conf
rem ⚠️ 2026-10-31 审计（P1）：这里曾用 `where node.exe` 预检 + 裸 `node -e` 生成 conf。
rem    standalone/bootstrap 产物专为无 Node 服务器设计，install 前已把产物内（或系统）
rem    node.exe 绑进 %NODE_EXE% —— 依赖 PATH 会让「明明有内置 Node 却因 PATH 干净而 die」，
rem    且 die 的提示语（让用户 -node）与真实病因（脚本内部用了裸 node）对不上。
rem    现在只用 %NODE_EXE%；它未绑定时才退回 PATH 探测（保住 dsh/custom 模式老行为）。
if defined NODE_EXE if exist "%NODE_EXE%" goto write_conf_node_ok
rem %NODE_EXE% 为空/失效：最后一次机会从 PATH 找（老 dsh 模式可能没走 find_node）
call :find_node
if errorlevel 1 (
  call :die "找不到 node.exe —— 生成 service.conf 需要它（standalone 模式请用 -node 指定产物内的 runtime\node.exe）"
  exit /b 1
)
:write_conf_node_ok
rem 入参（由调用方 set 好，避免 call 的二次展开吃掉引号）：
rem   CONF_PROGRAM  可执行文件
rem   CONF_ARGS     参数串（支持双引号分组）
rem   CONF_CWD      工作目录
set "CONF_DIR=%INSTALL_DIR%"
if not exist "%CONF_DIR%" mkdir "%CONF_DIR%" >nul 2>&1
if not exist "%RUNNER_SRC%" (
  call :die "缺少包装器: %RUNNER_SRC%"
  exit /b 1
)
copy /y "%RUNNER_SRC%" "%CONF_DIR%\service-runner.mjs" >nul
if errorlevel 1 (
  call :die "复制包装器失败: %RUNNER_SRC% -^> %CONF_DIR%\service-runner.mjs"
  exit /b 1
)
rem ⚠️ 配置必须用 node 写（UTF-8）：cmd 的 echo 写的是 OEM 码页，
rem 路径里带中文时会与包装器的 UTF-8 读取对不上。
rem ⚠️ node 的实参走 UTF-16，所以中文路径不会在 cmd 这一层被破坏。
"%NODE_EXE%" -e "const fs=require('fs');const out=process.argv[1];let body=['# generated by service.bat; edit and run: service.bat restart','program='+(process.env.CONF_PROGRAM||''),'args='+(process.env.CONF_ARGS||''),'cwd='+(process.env.CONF_CWD||'')];const ef=process.env.ENV_FILE;if(ef&&fs.existsSync(ef)){const extra=fs.readFileSync(ef,'utf8').split(/\r?\n/).filter(function(s){return s!==''}).map(function(s){return 'env.'+s});if(extra.length)body=body.concat(extra)}fs.writeFileSync(out,body.join('\n')+'\n','utf8')" "%CONF_DIR%\service.conf"
if errorlevel 1 (
  call :die "生成 service.conf 失败"
  exit /b 1
)
echo  配置已写入 %CONF_DIR%\service.conf
exit /b 0

:nssm_register
call :svc_exists
if "%SVC_EXISTS%"=="1" (
  if "%FORCE%"=="0" (
    call :die "服务 %SVC_NAME% 已存在。加 -force 覆盖配置，或先执行 service.bat uninstall"
    exit /b 1
  )
  echo  服务已存在，按 -force 覆盖其配置
  goto nssm_configure
)
call "%NSSM_EXE%" install "%SVC_NAME%" "%NODE_EXE%"
if errorlevel 1 (
  call :die "nssm install 失败"
  exit /b 1
)
:nssm_configure
rem ⚠️ 2026-10-31 审计（P2）：Application（服务程序本体）只在 nssm install 时设置，
rem    -force 覆盖配置时若两次 install 之间换了 -node（例如换用产物内置 Node），
rem    服务仍指向旧程序。这里显式重设：dsh/standalone/bootstrap 模式为 %NODE_EXE%，
rem    custom 模式为 %SVC_PROGRAM%。
set "NSSM_APPLICATION=%NODE_EXE%"
if /i "%MODE%"=="custom" set "NSSM_APPLICATION=%SVC_PROGRAM%"
call "%NSSM_EXE%" set "%SVC_NAME%" Application "%NSSM_APPLICATION%" >nul
rem 参数里的引号必须保留（路径可能带空格），故用三重引号写法。
call "%NSSM_EXE%" set "%SVC_NAME%" AppParameters """%INSTALL_DIR%\service-runner.mjs""" >nul
call "%NSSM_EXE%" set "%SVC_NAME%" DisplayName "%SVC_DISPLAY%" >nul
call "%NSSM_EXE%" set "%SVC_NAME%" Description "%SVC_DESC%" >nul
if not defined SVC_CWD set "SVC_CWD=%INSTALL_DIR%"
call "%NSSM_EXE%" set "%SVC_NAME%" AppDirectory "%SVC_CWD%" >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppStdout "%LOG_DIR%\stdout.log" >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppStderr "%LOG_DIR%\stderr.log" >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppRotateFiles 1 >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppRotateBytes 10485760 >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppRotateSeconds 86400 >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppThrottle 1500 >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppRestartDelay 5000 >nul
call "%NSSM_EXE%" set "%SVC_NAME%" AppExit Default Restart >nul
if /i "%START_TYPE%"=="auto"     call "%NSSM_EXE%" set "%SVC_NAME%" Start SERVICE_AUTO_START >nul
if /i "%START_TYPE%"=="demand"   call "%NSSM_EXE%" set "%SVC_NAME%" Start SERVICE_DEMAND_START >nul
if /i "%START_TYPE%"=="disabled" call "%NSSM_EXE%" set "%SVC_NAME%" Start SERVICE_DISABLED_START >nul
if defined SVC_USER (
  call "%NSSM_EXE%" set "%SVC_NAME%" ObjectName "%SVC_USER%" >nul
  if defined SVC_PASSWORD call "%NSSM_EXE%" set "%SVC_NAME%" Password "%SVC_PASSWORD%" >nul
)
echo  服务已注册：%SVC_NAME%
exit /b 0

:do_start
call :svc_exists
if "%SVC_EXISTS%"=="0" (
  call :die "服务 %SVC_NAME% 未注册，请先执行 service.bat install"
  exit /b 1
)
if defined NSSM_EXE (
  call "%NSSM_EXE%" start "%SVC_NAME%"
) else (
  sc start "%SVC_NAME%" >nul
)
if errorlevel 1 (
  sc query "%SVC_NAME%" | findstr /i "RUNNING" >nul
  if not errorlevel 1 (
    echo  服务已在运行
    exit /b 0
  )
  call :die "启动服务失败，查看日志: %LOG_DIR%\stderr.log"
  exit /b 1
)
call :wait_port %PORT% 30
if errorlevel 1 (
  echo  [警告] 等待端口 %PORT% 超时，服务可能仍在启动；请看日志 %LOG_DIR%\stdout.log
) else (
  echo  服务已启动，端口 %PORT% 已在监听
)
exit /b 0

:do_stop
call :svc_exists
if "%SVC_EXISTS%"=="0" (
  echo  服务未注册，无需停止
  exit /b 0
)
if defined NSSM_EXE (
  call "%NSSM_EXE%" stop "%SVC_NAME%"
) else (
  sc stop "%SVC_NAME%" >nul
)
if errorlevel 1 (
  sc query "%SVC_NAME%" | findstr /i "STOPPED" >nul
  if not errorlevel 1 (
    echo  服务已停止
    exit /b 0
  )
  call :die "停止服务失败"
  exit /b 1
)
echo  服务已停止
exit /b 0

:wait_port
set "WAIT_PORT=%~1"
set /a WAIT_N=0
:wait_port_loop
set /a WAIT_N+=1
timeout /t 2 /nobreak >nul
netstat -ano | findstr /i "LISTENING" | findstr /c:":%WAIT_PORT% " >nul
if not errorlevel 1 exit /b 0
if %WAIT_N% geq %~2 exit /b 1
goto wait_port_loop

:print_summary
echo.
echo ============================================================
echo  [完成] 服务 %SVC_NAME% 已就绪
echo ============================================================
echo   服务名    : %SVC_NAME%
echo   显示名    : %SVC_DISPLAY%
echo   启动类型  : %START_TYPE%
echo   运行程序  : %CONF_PROGRAM% %CONF_ARGS%
if not defined SVC_CWD set "SVC_CWD=%INSTALL_DIR%"
echo   工作目录  : %SVC_CWD%
echo   安装目录  : %INSTALL_DIR%
echo   配置      : %INSTALL_DIR%\service.conf
echo   日志      : %LOG_DIR%\stdout.log
echo                %LOG_DIR%\stderr.log
if /i "%MODE%"=="dsh" (
  echo   DSH_HOME  : %DSH_HOME%
  echo   Web UI    : http://%BIND_HOST%:%PORT%
  echo   OpenAI 网关: http://%BIND_HOST%:%GW_PORT%/v1
  echo   账号池数据: %DSH_HOME%\jet-hub\state.json
)
echo.
echo   常用命令:
echo     service.bat status
echo     service.bat logs -tail 200
echo     service.bat restart
echo     service.bat uninstall
echo.
exit /b 0

:cmd_unknown
echo.
echo [错误] 未知命令: %CMD%
echo        用 service.bat help 查看可用命令
echo.
exit /b 1
