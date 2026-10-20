Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

Name "DSH"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\DSH"
InstallDirRegKey HKCU "Software\DSH Desktop" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetDatablockOptimize on
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "DSH Desktop"
VIAddVersionKey /LANG=1033 "FileDescription" "DSH Windows Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "DSH Desktop"
!define MUI_ICON "${STAGE}/resources/icon.ico"
!define MUI_UNICON "${STAGE}/resources/icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 DSH 桌面版"
!define MUI_WELCOMEPAGE_TEXT "此安装包包含 DSH 及其运行环境，无需另装 Node.js。$\r$\n$\r$\n安装前请关闭 DSH 窗口。升级和卸载保留用户目录中的账号、聊天与记忆数据。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\DSH.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro CheckProgramFile PREFIX
Function ${PREFIX}CheckProgramFile
  Exch $1
  IfFileExists "$1" 0 done
  retry:
    System::Call 'kernel32::CreateFileW(w r1, i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r0'
    ${If} $0 == -1
      IfSilent busy
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "DSH 文件正在使用或没有写入权限。请关闭 DSH 后重试。" IDRETRY retry
      busy:
        SetErrorLevel 2
        Abort
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  done:
  Pop $1
FunctionEnd
!macroend
!insertmacro CheckProgramFile ""
!insertmacro CheckProgramFile "un."

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "此安装包需要 Windows 10 或更新版本。"
    Abort
  ${EndIf}
  SetShellVarContext current
FunctionEnd

Section "DSH" Main
  Push "$INSTDIR\DSH.exe"
  Call CheckProgramFile
  Push "$INSTDIR\resources\bin\node.exe"
  Call CheckProgramFile
  Push "$INSTDIR\resources\bin\opencode.exe"
  Call CheckProgramFile
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\DSH Desktop" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "DisplayName" "DSH"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "DisplayIcon" "$INSTDIR\DSH.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "EstimatedSize" ${SIZE_KB}
  CreateDirectory "$SMPROGRAMS\DSH"
  CreateShortcut "$SMPROGRAMS\DSH\DSH.lnk" "$INSTDIR\DSH.exe" "" "$INSTDIR\resources\icon.ico"
  CreateShortcut "$SMPROGRAMS\DSH\卸载 DSH.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\DSH.lnk" "$INSTDIR\DSH.exe" "" "$INSTDIR\resources\icon.ico"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Push "$INSTDIR\DSH.exe"
  Call un.CheckProgramFile
  Push "$INSTDIR\resources\bin\node.exe"
  Call un.CheckProgramFile
  Push "$INSTDIR\resources\bin\opencode.exe"
  Call un.CheckProgramFile
  Delete "$DESKTOP\DSH.lnk"
  RMDir /r "$SMPROGRAMS\DSH"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop"
  DeleteRegKey HKCU "Software\DSH Desktop"
  ; Delete only files listed in this release. Keep user-created files and DSH_HOME.
  !include "${DELETEFILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
