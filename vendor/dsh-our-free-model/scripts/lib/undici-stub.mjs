// Minimal `undici` stand-in for the offline tests that import the channel pack's
// TypeScript sources directly (the shipped `pack.js` bundle inlines the real
// package). `opencode-proxy.ts` only constructs these when an account carries a
// proxy URL, so empty classes are enough to load the module graph.
export class Agent {}
export class Pool {}
export class ProxyAgent {}
export const Dispatcher = class Dispatcher {}

// 上游 opencode-proxy.ts 需要 undici 的 fetch（离线桩：不可用即抛，避免真实外呼）。
export const fetch = async () => { throw new Error('undici stub: network disabled in tests') }
