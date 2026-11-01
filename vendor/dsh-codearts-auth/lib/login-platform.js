/** Android 包既可能运行 Android Node，也可能运行手机自带的 Linux Node。 */
export function isAndroidRuntime() {
    return process.platform === 'android' || process.env.DSH_PHONE_ANDROID === '1' || !!process.env.ANDROID_ROOT;
}
/** 手机登录不探测桌面路径、浏览器数据库、DPAPI 或系统钥匙串。 */
export function desktopCredentialImportAvailable() {
    return !isAndroidRuntime();
}
//# sourceMappingURL=login-platform.js.map