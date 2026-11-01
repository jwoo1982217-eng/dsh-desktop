# 目标机引导安装脚本（由 scripts/build-bootstrap.mjs 打包时生成，占位符已替换）。
#
# 作用：在**目标服务器**上按需下载 DSH 宿主及其依赖闭包，并把本插件装进 profile。
#       产物本身不含 node_modules（体积因此从数百 MB 降到几 MB）。
#
# 不做什么：不下载/不导入任何账号数据 —— profile 的账号与设置请用
#           Jet Hub 设置页的「账号备份导入」恢复。
#
# 可重复执行：已装好的依赖会走 npm 的幂等路径；-Force 会重建 profile 骨架。
param(
  [string]$Profile = '@@PROFILE@@',
  [string]$Registry = '@@REGISTRY@@',
  [switch]$Force,
  [switch]$SkipVerify,
  [switch]$SkipNodeDownload,
  [string]$NodeMirror = '',
  [string]$NodeVersion = '@@NODE_VERSION@@'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = $PSScriptRoot
$homeDir = Join-Path $root 'home'
$profilesDir = Join-Path $homeDir 'profiles'
$pluginName = '@@PLUGIN_NAME@@'
$pluginVersion = '@@PLUGIN_VERSION@@'
$dshVersion = '@@DSH_VERSION@@'
$profileDir = Join-Path $profilesDir $Profile

function Info([string]$m) { Write-Output "[install] $m" }
function Warn([string]$m) { Write-Output "[install][警告] $m" }
function Die([string]$m) { Write-Output "[install][错误] $m"; exit 1 }

# ⚠️ 必须写**无 BOM** 的 UTF-8：
#    PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会带 BOM，而宿主的
#    readProfileManifest() 用 JSON.parse 读 profile/package.json，
#    BOM 会让它抛 `SyntaxError: Unexpected token '﻿'` 并直接退出（exit 1）——
#    实测表现为「start.cmd 打印完信息就退出，stderr 0 字节」。
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function WriteUtf8NoBom([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

Info '============================================================'
Info "dsh-providers-hub $pluginVersion —— 目标机引导安装"
Info '============================================================'
Info "产物目录  : $root"
Info "profile   : $Profile"
Info "宿主版本  : @deepseek-ai/dsh@$dshVersion（按需下载）"
Info ''

# ---------------------------------------------------------------- 1. node
# 三级回退：产物内置 -> 系统 PATH -> 自动下载官方便携版（zip，含 npm）。
# 下载成功后落到 runtime\node.exe，之后 start.cmd / service.bat 会自动用它，
# 不再依赖系统 PATH。
$runtimeDir = Join-Path $root 'runtime'
$nodeExe = Join-Path $runtimeDir 'node.exe'

if (Test-Path $nodeExe) {
  Info "[1/8] 使用产物内置 Node: $nodeExe"
} else {
  $sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sysNode) {
    $nodeExe = $sysNode.Source
    Info "[1/8] 使用系统 Node: $nodeExe"
  } else {
    if ($SkipNodeDownload) {
      Die '系统中找不到 node.exe，且指定了 -SkipNodeDownload。请安装 Node.js（^22.19.0 或 >=24）后重试。'
    }
    if (-not $NodeVersion) {
      Die '系统中找不到 node.exe，且产物未记录默认 Node 版本。请用 -NodeVersion v24.13.0 指定。'
    }

    $arch = 'win-x64'
    $zipName = "node-$NodeVersion-$arch.zip"
    $mirrors = @()
    if ($NodeMirror) { $mirrors += ($NodeMirror.TrimEnd('/') + "/$NodeVersion/$zipName") }
    $mirrors += "https://npmmirror.com/mirrors/node/$NodeVersion/$zipName"
    $mirrors += "https://nodejs.org/dist/$NodeVersion/$zipName"

    Info "[1/8] 系统中找不到 Node.js —— 自动下载 Node $NodeVersion（约 30 MB）..."
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    $ProgressPreference = 'SilentlyContinue'

    $tmpZip = Join-Path $env:TEMP ("dsh-" + $zipName)
    $downloaded = $false
    foreach ($url in $mirrors) {
      try {
        Info "      下载: $url"
        if (Test-Path $tmpZip) { Remove-Item -Force $tmpZip }
        (New-Object Net.WebClient).DownloadFile($url, $tmpZip)
        $mb = [math]::Round((Get-Item $tmpZip).Length / 1MB, 1)
        if ($mb -lt 10) { throw "文件只有 $mb MB，可能下到的是错误页" }
        Info "      完成: $mb MB"
        $downloaded = $true
        break
      } catch {
        Warn "      失败: $($_.Exception.Message)"
      }
    }
    if (-not $downloaded) {
      Die 'Node 下载失败。请手工安装 Node.js（^22.19.0 或 >=24），或用 -NodeMirror <镜像基址> 指定可用源。'
    }

    Info '      解压到 runtime\ ...'
    $tmpDir = Join-Path $env:TEMP ("dsh-node-" + $NodeVersion)
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    $inner = Join-Path $tmpDir "node-$NodeVersion-$arch"
    if (-not (Test-Path (Join-Path $inner 'node.exe'))) {
      Die "解压结果异常，找不到 node.exe: $inner"
    }
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Copy-Item -Path (Join-Path $inner '*') -Destination $runtimeDir -Recurse -Force
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue

    $nodeExe = Join-Path $runtimeDir 'node.exe'
    if (-not (Test-Path $nodeExe)) { Die "Node 解压后仍找不到: $nodeExe" }
    Info "[1/8] Node 已就位: $nodeExe（后续 start.cmd 会自动使用它）"
  }
}

$nodeVer = (& $nodeExe -v 2>$null)
if (-not $nodeVer) { Die "无法执行 node -v: $nodeExe" }
$nodeVer = $nodeVer.Trim()
Info "      node 版本: $nodeVer"
$vm = [regex]::Match($nodeVer, '^v(\d+)\.(\d+)\.')
if (-not $vm.Success) { Die "无法解析 node 版本: $nodeVer" }
$vMajor = [int]$vm.Groups[1].Value
$vMinor = [int]$vm.Groups[2].Value
# 与 package.json 的 engines 逐字对齐：^22.19.0 || >=24
# ⚠️ 23.x 不满足（`^22.19.0` 上界是 <23，`>=24` 下界是 24）—— 不能用 `-gt 22` 放行。
$versionOk = ($vMajor -ge 24) -or ($vMajor -eq 22 -and $vMinor -ge 19)
if (-not $versionOk) {
  Die "Node 版本不满足要求: $nodeVer（需要 ^22.19.0 或 >=24）"
}

# ---------------------------------------------------------------- 2. npm
# 优先用 node 安装目录里的 npm-cli.js（不依赖 PATH），否则退回 npm.cmd。
$npmCli = $null
$nodeDir = Split-Path $nodeExe
$candidates = @(
  (Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'),
  (Join-Path $nodeDir '..\lib\node_modules\npm\bin\npm-cli.js')
)
if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'npm\node_modules\npm\bin\npm-cli.js') }
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $npmCli = (Resolve-Path $c).Path; break }
}

if ($npmCli) {
  Info "[2/8] 使用 npm: $npmCli"
  $runNpm = { param([string[]]$npmArgs) & $nodeExe $npmCli @npmArgs }
} else {
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) {
    Die '找不到 npm —— 请在目标机安装 Node.js 的完整发行版（含 npm），或用 package -WithNode 重新打包。'
  }
  Info "[2/8] 使用 npm: $($npmCmd.Source)"
  $runNpm = { param([string[]]$npmArgs) & $npmCmd.Source @npmArgs }
}

# ---------------------------------------------------------------- 3. 宿主依赖
Info "[3/8] 准备宿主依赖目录: $profilesDir"
New-Item -ItemType Directory -Force -Path $profilesDir | Out-Null

$hostPkgSrc = Join-Path $root 'host\package.json'
$hostLockSrc = Join-Path $root 'host\package-lock.json'
if (-not (Test-Path $hostPkgSrc)) { Die "产物缺少 host\package.json: $hostPkgSrc" }
Copy-Item -Force $hostPkgSrc (Join-Path $profilesDir 'package.json')

$dshBin = Join-Path $profilesDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
# -Force 也用来「强制重装依赖」—— 上一轮 install 跑到一半失败时，
# bin.js 可能已存在但依赖不全，只重建 profile 是修不好的。
$needInstall = $Force -or (-not (Test-Path $dshBin))
if ($needInstall) {
  $useCi = $false
  if (Test-Path $hostLockSrc) {
    Copy-Item -Force $hostLockSrc (Join-Path $profilesDir 'package-lock.json')
    $useCi = $true
  } else {
    Warn '产物未带 package-lock.json —— 将用 npm install（版本可能漂移，建议重新打包以带上 lock）'
  }

  $npmArgs = @()
  if ($useCi) { $npmArgs += 'ci' } else { $npmArgs += 'install' }
  # ⚠️ 绝不能加 --omit=peer：DSH 宿主的 peerDependencies 是它运行的一部分，
  #    漏掉会在启动瞬间 ERR_MODULE_NOT_FOUND（cordis-plugin-loader 等）。
  $npmArgs += @('--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error')
  if ($Registry) { $npmArgs += @('--registry', $Registry) }

  Info "[4/8] 下载宿主依赖（npm $($npmArgs[0])，首次约 1-3 分钟）..."
  Info "      registry: $(if ($Registry) { $Registry } else { '（npm 默认）' })"
  Push-Location $profilesDir
  try {
    & $runNpm $npmArgs
    $npmCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($npmCode -ne 0) {
    Die "npm $($npmArgs[0]) 失败（exit=$npmCode）。检查网络/代理，或用 -Registry 指定可用的 npm 镜像。"
  }
  if (-not (Test-Path $dshBin)) {
    Die "依赖已安装但找不到宿主入口: $dshBin"
  }
  Info '      宿主依赖安装完成'

  # ⚠️ 2026-10-31 审计（P2）：npm ci 带 --ignore-scripts 后，node-pty 等需要 install
  #    脚本的包不会跑 postinstall —— 缺 win32-x64 prebuild 则 PTY 运行时才炸。
  #    对照 build-standalone.mjs 的既有做法：装完后单独 rebuild node-pty。
  #    失败默认 Die（-SkipVerify 放行为 Warn —— 与本脚本的核验口径一致）。
  $ptyDir = Join-Path $profilesDir 'node_modules\node-pty'
  if (Test-Path $ptyDir) {
    $ptyPrebuilds = Join-Path $ptyDir 'prebuilds\win32-x64'
    $ptyHasNative = (Test-Path $ptyPrebuilds) -and (@(Get-ChildItem -Path $ptyPrebuilds -Filter '*.node' -ErrorAction SilentlyContinue).Count -gt 0)
    if (-not $ptyHasNative) {
      Info '      node-pty 缺少 win32-x64 prebuild，单独重建该包（仅它需要 install 脚本）...'
      $ptyNpmArgs = @('rebuild', 'node-pty', '--ignore-scripts=false', '--foreground-scripts', '--loglevel=error')
      Push-Location $profilesDir
      try {
        & $runNpm $ptyNpmArgs
        $ptyCode = $LASTEXITCODE
      } finally {
        Pop-Location
      }
      if ($ptyCode -ne 0) {
        if ($SkipVerify) {
          Warn "node-pty rebuild 失败（exit=$ptyCode，-SkipVerify 已忽略）—— PTY 相关功能可能不可用"
        } else {
          Die "node-pty rebuild 失败（exit=$ptyCode）。Windows 终端/PTY 功能会加载失败；可用 -SkipVerify 跳过。"
        }
      } else {
        Info '      node-pty rebuild 完成'
      }
    } else {
      Info '      node-pty 已带 win32-x64 prebuild'
    }
  }
} else {
  Info "[4/8] 宿主依赖已就绪，跳过下载（$dshBin）"
}

# ---------------------------------------------------------------- 4. peer 闭包核验
# ⚠️ 这不是可选项：宿主用 createRequire 从 installAnchor 解析这些包，
#    少一个就是启动瞬间 ERR_MODULE_NOT_FOUND / exit 1。
$peerScope = Join-Path $profilesDir 'node_modules\@deepseek-ai'
$mustHave = @('dsh', 'dsh-base', 'dsh-web-app', 'dsh-llm', 'cordis-plugin-loader')
$missing = @()
foreach ($name in $mustHave) {
  $probe = Join-Path $peerScope $name
  if (-not (Test-Path $probe)) { $missing += $name }
}
if ($missing.Count -gt 0) {
  if ($SkipVerify) {
    Warn "peer 闭包缺包（-SkipVerify 已忽略）: $($missing -join ', ')"
  } else {
    Die "peer 依赖闭包不完整，缺少: $($missing -join ', ')。这通常是 npm 用了 --omit=peer 或 --legacy-peer-deps 导致的。"
  }
} else {
  Info "[5/8] peer 依赖闭包完整（$($mustHave.Count) 项）"
}

# ---------------------------------------------------------------- 5. profile 骨架
Info "[6/8] 准备 profile: $profileDir"
$profileModules = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $profileModules | Out-Null

$manifestPath = Join-Path $profileDir 'package.json'
if ($Force -or -not (Test-Path $manifestPath)) {
  $manifest = [ordered]@{
    name = "dsh-profile-$Profile"
    private = $true
    dependencies = [ordered]@{ $pluginName = $pluginVersion }
    dsh = [ordered]@{
      profile = [ordered]@{
        bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', $pluginName)
        patchReload = 'startup'
      }
    }
  }
  WriteUtf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 8)
  Info "      已写入 $manifestPath"
} else {
  Info "      保留已有 $manifestPath（-Force 可重建）"
}

$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
if ($Force -or -not (Test-Path $profilePatch)) {
  WriteUtf8NoBom $profilePatch "# dsh profile patch —— 用户层。插件自身的 patch 作为 bundle 层自动加载，无需在此声明。`n[]`n"
}
WriteUtf8NoBom (Join-Path $profileDir 'pnpm-workspace.yaml') "nodeLinker: hoisted`n"

$homePatch = Join-Path $homeDir 'cordis.patch.yml'
if (-not (Test-Path $homePatch)) {
  WriteUtf8NoBom $homePatch "# dsh home patch —— 机器级用户层（优先级高于 profile 自己的 patch）。`n[]`n"
}

# ---------------------------------------------------------------- 6. 安装插件本体
Info "[7/8] 安装插件 $pluginName@$pluginVersion -> profile"
$pluginSrc = Join-Path $root 'plugin'
if (-not (Test-Path (Join-Path $pluginSrc 'lib\index.js'))) {
  Die "产物缺少插件本体: $pluginSrc\lib\index.js"
}
$pluginDst = Join-Path $profileModules $pluginName
if (Test-Path $pluginDst) { Remove-Item -Recurse -Force $pluginDst }
Copy-Item -Recurse -Force $pluginSrc $pluginDst
Info "      $pluginDst"

# 插件依赖：产物里若带了 plugin/node_modules 就直接用；没带则按需下载。
$pluginModules = Join-Path $pluginDst 'node_modules'
$pluginPkg = Get-Content (Join-Path $pluginDst 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$pluginDeps = @()
if ($pluginPkg.dependencies) { $pluginDeps = @($pluginPkg.dependencies.PSObject.Properties.Name) }
if ($pluginDeps.Count -gt 0 -and -not (Test-Path $pluginModules)) {
  $pluginNpmArgs = @('install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error')
  if ($Registry) { $pluginNpmArgs += @('--registry', $Registry) }
  Info "      插件依赖缺失，按需下载: $($pluginDeps -join ', ')"
  Push-Location $pluginDst
  try {
    & $runNpm $pluginNpmArgs
    $pluginCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($pluginCode -ne 0) {
    Die "插件依赖安装失败（exit=$pluginCode）"
  }
} elseif ($pluginDeps.Count -gt 0) {
  Info "      插件依赖已随产物内置（$($pluginDeps.Count) 个）"
}

# ---------------------------------------------------------------- 7. native 核验
if ($SkipVerify) {
  Info '[8/8] 跳过原生模块核验（-SkipVerify）'
} else {
  Info '[8/8] 核验原生模块（当前平台 .node 二进制）...'
  $nodeFiles = Get-ChildItem -Path $profilesDir, $pluginDst -Recurse -Filter '*.node' -ErrorAction SilentlyContinue
  if (-not $nodeFiles -or $nodeFiles.Count -eq 0) {
    Warn '没找到任何 .node 文件 —— 若某 provider 需要 sharp/koffi，运行时才会暴露问题'
  } else {
    $bad = @()
    foreach ($f in $nodeFiles) {
      # ⚠️ 2026-10-31 审计（P2）：第二条正则（'^.*\\(linux|darwin)\\-'）要求
      #    「反斜杠+linux+反斜杠+连字符」，实际路径形如 ...\prebuilds\linux-x64\...
      #    —— 恒不命中的死正则，删除。只保留第一条段式判据。
      if ($f.FullName -match '[-_](linux|darwin|freebsd)[-_]') { $bad += $f.FullName }
    }
    if ($bad.Count -gt 0) {
      # ⚠️ 2026-10-31 审计（P2）：旧版这里只 Warn —— 检查没有牙。发现非 Windows
      #    平台的 .node 默认 Die（-SkipVerify 放行），否则传输/跨平台 lock 造成的
      #    错误产物在目标机上完全不可见。
      $msg = "发现非 Windows 平台的 .node 文件（$($bad.Count) 个），可能是跨平台 lock 造成的:"
      if ($SkipVerify) {
        Warn "$msg（-SkipVerify 已忽略）"
      } else {
        Die $msg
      }
      $bad | Select-Object -First 5 | ForEach-Object { Warn "  $_" }
    }
    Info "      共 $($nodeFiles.Count) 个 .node（Windows 侧）"
  }
}

# ---------------------------------------------------------------- 完成
Info ''
Info '============================================================'
Info '安装完成'
Info '============================================================'
Info "启动：$(Join-Path $root 'start.cmd')"
Info "注册服务：service.bat install -Mode bootstrap -BundleDir `"$root`" -Profile $Profile"
Info ''
Info '下一步（二选一）：'
Info '  1) 浏览器打开 Web UI，在 Jet Hub 设置页走登录流程；'
Info '  2) 无浏览器环境：在别处导出「账号备份」JSON，导入到本机的 Jet Hub 设置页。'
Info ''
exit 0
