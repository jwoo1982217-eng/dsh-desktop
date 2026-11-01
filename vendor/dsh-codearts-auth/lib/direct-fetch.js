/**
 * PR #483 的签名传输隔离：默认使用包内 undici，不读取 globalThis.fetch。
 * 出口选择仍复用 channel-fetch（插件出口 > 环境代理 > Windows 手动代理）。
 * direct 只表示不经过全局 fetch，并不表示忽略用户代理。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import { createChannelFetch } from './channel-fetch.js';
const signedRequestSignals = new AsyncLocalStorage();
/** 请求的取消上下文随异步调用传递；不跨请求或插件实例共享凭据。 */
export function withSignedRequestSignal(signal, run) {
    return signal ? signedRequestSignals.run(signal, run) : run();
}
/** 沿用 PR #483 的离线测试入口；生产代码不写入它，显式 fetchImpl 始终优先。 */
export const directLane = { fetch: null };
export function createDirectFetch(options = {}) {
    // 独立 Agent 同时避免其它插件修改 undici 的全局 dispatcher；仅销毁自己拥有的资源。
    const agent = new Agent();
    const lifetime = new AbortController();
    let closing;
    /**
     * **真正的底层发送**：只用本实例自带的 undici Agent，**绝不**再进全局
     * `directLane` / `fetchImpl` 注入点。
     *
     * ⚠️⚠️ 这是插件出口 relay 唯一该用的发送函数（2026-10-30 合并期实测打穿）：
     * 原实现把带注入判据的 `send` 交给 `outlet.fetchSigned(input, init, send)`，
     * 而 `send` 第一步就是 `options.fetchImpl ?? directLane.fetch` —— `directLane`
     * 是**模块级全局**，每次 `apply()` 都会 `attachDirectFetch(signedNetwork.fetch)`
     * 覆盖它 ⇒ **两个插件实例并发时，A 实例的请求被路由到 B 实例的出口**，
     * 线上症状是华为云 401 `wrong context or signature`（凭据与出口错配）。
     * 本文件模块头那句「避免重新进入全局 fetch」说的就是这件事，实现却没做到。
     */
    const rawSend = async (input, init) => {
        const dispatcher = init?.dispatcher ?? agent;
        let target = input;
        let requestInit = init;
        // Node 内置 Request 与包内 undici 的 Request 品牌不同，不能只做类型强转。
        if (input instanceof Request) {
            const request = new Request(input, init);
            target = request.url;
            requestInit = {
                method: request.method, headers: request.headers, body: request.body,
                signal: request.signal, redirect: request.redirect, credentials: request.credentials,
                cache: request.cache, integrity: request.integrity, keepalive: request.keepalive,
                mode: request.mode, referrer: request.referrer, referrerPolicy: request.referrerPolicy,
                ...(request.body ? { duplex: 'half' } : {}),
            };
        }
        return undiciFetch(target, { ...requestInit, dispatcher });
    };
    /**
     * 顶层发送：注入点优先（测试接缝 / 显式 fetchImpl），否则走本实例 rawSend。
     *
     * ⚠️⚠️ **带 `outlet` 的实例绝不能读全局 `directLane`**（2026-10-30 打回）：
     * `directLane` 是**模块级单槽**，每次 `apply()` 都会
     * `attachDirectFetch(signedNetwork.fetch)` 覆盖它 —— 于是同一进程里并存两个
     * 插件实例时，A 实例的请求会走 **B 的出口**（凭据与出口错配）。
     * 实测（`scripts/codearts-rpc-context-test.mjs`）：lane B 收到一条用
     * `FIXTURE_AK_A` 签名的请求，验签 401 `wrong context or signature`。
     *
     * 语义划分：
     * - **有 outlet** ⇒ 这个实例自带出口，调用方要的就是它，全局接缝与它无关；
     * - **无 outlet** ⇒ 模块级共享实例（供各家「默认直连」用），全局接缝才是
     *   它唯一的出口来源，保持原行为（离线测试也靠这条挂 stub）。
     */
    const injected = options.fetchImpl ?? (options.outlet === undefined ? directLane.fetch : undefined);
    const send = async (input, init) => {
        return injected ? injected(input, init) : rawSend(input, init);
    };
    const outlet = options.outlet;
    const network = createChannelFetch({
        ...options,
        fetchImpl: send,
        outlet: outlet && {
            active: () => outlet.active(),
            fetch: (input, init) => {
                if (!outlet.fetchSigned) {
                    throw new Error('所选插件出口尚未接入签名传输，请升级出口适配；请求未绕过该出口');
                }
                // 交**底层**发送函数，不能交给带注入判据的 `send`（见 `rawSend` 注释）。
                return outlet.fetchSigned(input, init, rawSend);
            },
        },
    });
    return {
        fetch: async (input, init) => {
            lifetime.signal.throwIfAborted();
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const requestSignal = signedRequestSignals.getStore();
            const signals = [signal, requestSignal, lifetime.signal].filter((item) => item !== undefined && item !== null);
            const combined = AbortSignal.any(signals);
            combined.throwIfAborted();
            return network.fetch(input, { ...init, signal: combined });
        },
        close() {
            if (!closing) {
                lifetime.abort(new DOMException('CodeArts 签名传输已停止', 'AbortError'));
                closing = Promise.allSettled([network.close(), agent.destroy()]).then(() => { });
            }
            return closing;
        },
    };
}
// credits RPC 的既有调用没有 fetch 参数；绑定默认传输使其与聊天共享所选出口。
// 每次挂载有独立所有权，旧挂载延迟卸载不能摘掉新挂载的传输。
const mounted = new Set();
export function attachDirectFetch(fetcher) {
    const binding = { fetch: fetcher };
    mounted.add(binding);
    return () => { mounted.delete(binding); };
}
let fallback;
export const directFetch = (input, init) => {
    const injected = directLane.fetch ?? [...mounted].at(-1)?.fetch;
    if (injected)
        return injected(input, init);
    fallback ??= createDirectFetch();
    return fallback.fetch(input, init);
};
/** 仅关闭无宿主挂载时惰性创建的传输；宿主实例由各自的 close 管理。 */
export async function closeDirectFetch() {
    const previous = fallback;
    fallback = undefined;
    await previous?.close();
}
//# sourceMappingURL=direct-fetch.js.map