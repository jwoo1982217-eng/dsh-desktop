import { type AutoclawCredential } from './autoclaw.js';
/** 隔离目录优先；Mac 不使用 Windows 的 APPDATA 兜底。 */
export declare function resolveAutoclawAppData(custom?: string): string | undefined;
/** 只透传面向用户的固定文案，不透传系统命令输出、密钥或原始密文。 */
export declare class AutoclawLocalStorageError extends Error {
}
/**
 * 已与 Mac AutoClaw 2.1.1 的 safeStorage v10 文件实测核对：
 * PBKDF2-SHA1 / saltysalt / 1003 / 16，AES-128-CBC，16个空格IV。
 * 这是 safeStorage 文档，不是 Chromium cookie，不删除解密后的32字节。
 */
export declare function readMacAutoclawCredential(appDir: string): Promise<AutoclawCredential | undefined>;
//# sourceMappingURL=autoclaw-local-storage.d.ts.map