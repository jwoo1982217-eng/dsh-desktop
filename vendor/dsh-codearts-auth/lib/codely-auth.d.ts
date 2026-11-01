/**
 * Codely（Unity 团结引擎）登录流程（**设备码轮询**）。
 *
 * ## 与其它 provider 的差异
 *
 * | provider | 登录方式 | 是否需要本地端口 |
 * |---|---|---|
 * | Qoder | PKCE 设备码轮询（`404` = 尚未授权） | 否 |
 * | Cline | WorkOS 设备码轮询（body `error` 字段） | 否 |
 * | **Codely** | **自有设备码轮询**（body `status` 字段） | **否** |
 *
 * ## 三步协议（2026-10-19 实测 / 逆向 codely-vscode 4.3.0 确认）
 *
 * ```
 * 1) POST https://codely.tuanjie.cn/auth/device/initiate
 *      Content-Type: application/json
 *      body: { provider: 'unity', client_name: 'codely-vscode', auth_from: 'vscode-codely' }
 *   → 200 { auth_request_token, user_code, verification_uri,
 *           verification_uri_complete, interval: 2, expires_in: 900 }
 *   （✅ 已实测 200，字段逐字来自真实响应）
 *
 * 2) GET /auth/device/poll?auth_request_token=<…>
 *   → 200 { status: 'pending' | 'slow_down' | 'authorized' | 'completed'
 *                        | 'denied' | 'expired', interval, … }
 *   → `authorized` 时附带 `authorization_code`
 *   （pending 形状 ✅ 实测：`{"status":"pending","error":"authorization_pending",…}`；
 *     状态机五分支来自官方插件源码 `pollDeviceAuthorization`）
 *
 * 3) POST /auth/device/exchange
 *      body: { authorization_code: <…> }
 *   → { access_token, refresh_token }
 *   （请求体键名与响应字段来自官方插件源码 `exchangeDeviceAuthorizationCode`
 *     与 `_refreshSession`；带令牌的响应尚未实测）
 * ```
 *
 * ## 凭据形态
 *
 * 落盘 JSON：`{ access_token, refresh_token, obtained_at, expires_at?, nickname? }`。
 * `nickname` 来自 `GET /auth/external/me`（Bearer，官方插件 `getUserInfo`
 * 源码确认返回 `{ username, email }`）——**尽力而为**：拿不到不阻塞登录，
 * 账号卡片退回显示账号 id（与 Qoder 的 `fetchQoderUserNickname` 同原则）。
 *
 * ✅ **令牌有效期已实测**（2026-10-19，真实凭据）：access_token / refresh_token
 * 都是 **JWT**，payload 自带 `exp`（秒）——实测 access ≈ iat + 365 天、
 * refresh ≈ iat + 3 年。落盘时用 {@link decodeCodelyJwtExpMs} 解码 access_token
 * 的 `exp` 写进 `expires_at`（ISO 字符串），账号池条目同步回填 `expiresAt`
 * ⇒ 卡片「有效期」行有真实读数（修复前恒显示「未知」）。
 *
 * ## 为什么暂不实现 refresh（给接线者的提醒）
 *
 * 官方插件有 `POST /auth/refresh {refresh_token}` → `{access_token, refresh_token}`
 * （源码 `_refreshSession` 确认）。但**续期分派**查 `authOf(auths, 'codely')`
 * （`JetHubAuths` 的键），而 registry 里 codely 仍是 `channel:false`
 * （聊天/目录适配器未接线）——现在导出一个无人调用的 refresh 函数，正是
 * 本仓库记过的「已导出却零调用点」陷阱（modelscope 的 `handleModelscopeRpc`）。
 * 等适配器接线、`channel` 翻 true、`JetHubAuths` 加键时再补
 * `refreshAccountCredential`（用这里的 `/auth/refresh` 报文），一并翻
 * `refreshable`。接线清单见 `provider-registry.ts` 里 codely 条目的注释。
 */
/** Codely 服务基址（dashboard 与 API 同域）。 */
export declare const CODELY_API_BASE = "https://codely.tuanjie.cn";
/** provider id（与 `provider-registry.ts` 里 codely 条目的 id 逐字一致）。 */
export declare const CODELY_PROVIDER_ID = "codely";
/** 设备码发起端点。 */
export declare const CODELY_DEVICE_INITIATE_PATH = "/auth/device/initiate";
/** 设备码轮询端点（query 携带 `auth_request_token`）。 */
export declare const CODELY_DEVICE_POLL_PATH = "/auth/device/poll";
/** 授权码换令牌端点。 */
export declare const CODELY_DEVICE_EXCHANGE_PATH = "/auth/device/exchange";
/** 用户信息端点（Bearer，取昵称用，尽力而为）。 */
export declare const CODELY_ME_PATH = "/auth/external/me";
/** 单次 HTTP 请求超时（毫秒；与 cline 同款量级）。 */
export declare const CODELY_HTTP_TIMEOUT_MS = 30000;
/** 连续网络失败多少次后放弃轮询（与 cline 同款）。 */
export declare const CODELY_POLL_MAX_FAILURES = 5;
/** 轮询间隔下限（毫秒）：服务端可能下发 0，无节制轮询会被限流。 */
export declare const CODELY_POLL_MIN_INTERVAL_MS = 500;
/** 设备码默认有效期（毫秒；实测 `expires_in: 900`）。 */
export declare const CODELY_DEVICE_EXPIRES_MS = 900000;
/** 官方插件自报的身份头（源码 `getDefaultHeaders` 确认；鉴权端点带上无害且更像官方客户端）。 */
export declare const CODELY_USER_AGENT_HEADER = "codely-vscode/4.3.0";
/** 已落盘的 Codely 凭据（JSON 序列化后写入 ctx.credentials）。 */
export interface CodelyCredential {
    access_token: string;
    refresh_token: string;
    /** 取得时间（毫秒时间戳）。 */
    obtained_at: number;
    /**
     * access_token 的绝对过期时刻（ISO 8601 字符串）。
     *
     * 来自 JWT payload 的 `exp`（见 {@link decodeCodelyJwtExpMs}）；解码不出
     * 时**缺省**（绝不编造一个「看起来真实」的过期时间）。
     */
    expires_at?: string;
    /** 展示昵称（`/auth/external/me` 的 `username`，尽力而为，可能缺省）。 */
    nickname?: string;
}
/** 一次登录流程落定后的结果（供 `account.create` 分支回填账号池）。 */
export interface CodelyLoginOutcome {
    /** 已落盘的凭据（与写入 `ctx.credentials` 的 JSON 同源）。 */
    credential: CodelyCredential;
    /** access_token 的绝对过期时刻（毫秒时间戳；解码不出时 undefined）。 */
    expiresAt?: number;
    /** 展示昵称（用户信息端点失败时为 undefined）。 */
    nickname?: string;
}
/** {@link startCodelyDeviceLogin} 接受的选项。 */
export interface CodelyLoginFlowOptions {
    /**
     * 凭据落盘的**完整 ref**（调用方用 `credentialRef(refName)` 算好传入）。
     *
     * ⚠️ 传完整 ref 而不是 `refName`：本模块不 import 凭据命名空间逻辑，
     * 避免「一文件两套同义判据」。
     */
    ref: string;
    /** 凭据写入出口（宿主 `ctx.credentials` 的形状子集）。 */
    credentials: {
        set(ref: string, value: string): Promise<void>;
    };
    /** 使用的 fetch 实现；默认为全局 fetch（测试注入替身）。 */
    fetcher?: typeof fetch;
    /** 外部取消信号。 */
    signal?: AbortSignal;
}
/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedCodelyLoginFlow {
    /** 展示给用户的登录 URL（`verification_uri_complete`，带 user_code 免手输）。 */
    loginUrl: string;
    /** 设备码流程的用户码（UI 可提示「在浏览器里输入 XXXX」）。 */
    userCode?: string;
    /** 用户完成授权（或超时/失败）后落定的结果。 */
    result: Promise<CodelyLoginOutcome>;
    /** 取消登录（中止轮询）；**幂等**。 */
    close: () => Promise<void>;
}
/**
 * 从 Codely 的 JWT（access_token / refresh_token）里解码 `exp` claim。
 *
 * ## 为什么从 JWT 里读而不是等响应字段
 *
 * exchange 响应只给 `{access_token, refresh_token}`（官方插件源码确认，
 * **没有** `expires_in`）。但令牌本身是标准三段式 JWT，payload 自带
 * `exp`（秒）—— 2026-10-19 用真实凭据解码实测：access ≈ iat + 365 天、
 * refresh ≈ iat + 3 年。这是**上游自己签发**的权威过期时刻，不是猜测。
 *
 * ## 解析纪律
 *
 * - payload 用 base64url 解码（`-`/`_` 要先归一，且要补 `=` padding）；
 * - `exp` 缺失 / 非有限数 / ≤ 0 ⇒ 返回 `undefined` —— **绝不编造**一个
 *   过期时间（0 的语义是「已过期」，会让卡片红字，比「未知」更糟）；
 * - 只信结构，不信内容：不校验签名（我们只读 claim，不鉴权）。
 */
export declare function decodeCodelyJwtExpMs(token: string): number | undefined;
/**
 * 请求设备码授权（三步协议第 1 步）。
 *
 * 响应字段已实测（2026-10-19）：`auth_request_token` / `user_code` /
 * `verification_uri` / `verification_uri_complete` / `interval` / `expires_in`。
 * 缺 `auth_request_token` / `verification_uri` 任一即视为无效响应。
 */
export declare function requestCodelyDeviceAuthorization(options?: Pick<CodelyLoginFlowOptions, 'fetcher' | 'signal'>): Promise<{
    authRequestToken: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresMs: number;
    intervalMs: number;
}>;
/**
 * 轮询直到用户完成授权，拿到 `authorization_code`（三步协议第 2 步）。
 *
 * 状态机（对齐官方插件源码 `pollDeviceAuthorization`，逐分支核对）：
 * - `pending` → 按 interval 继续（**不是错误**：用户还没在浏览器里点授权）；
 * - `slow_down` → 退避 1 秒后继续（官方只沿用响应 interval；这里学 cline
 *   累积 +1s，被持续限流时能真正降速）；
 * - `authorized` → 取 `authorization_code` 返回；
 * - `completed` → 终态失败（授权码已被取走，必须重开登录）；
 * - `denied` / `expired` → 终态失败；
 * - 其它 status / 非 2xx → 终态失败；
 * - 网络失败容忍 {@link CODELY_POLL_MAX_FAILURES} 次连续失败。
 */
export declare function pollCodelyAuthorizationCode(authRequestToken: string, startIntervalMs: number, timeoutMs: number, options?: Pick<CodelyLoginFlowOptions, 'fetcher' | 'signal'>): Promise<string>;
/**
 * 用 `authorization_code` 换取令牌（三步协议第 3 步）。
 *
 * 请求体键是 snake_case `authorization_code`（官方插件源码逐字）。
 * 响应字段 `access_token` / `refresh_token`（同源确认；带真码的响应未实测）。
 */
export declare function exchangeCodelyAuthorizationCode(authorizationCode: string, options?: Pick<CodelyLoginFlowOptions, 'fetcher' | 'signal'>): Promise<{
    accessToken: string;
    refreshToken: string;
}>;
/**
 * 取用户昵称（**尽力而为**，失败不阻塞登录）。
 *
 * `GET /auth/external/me`（Bearer），官方插件 `getUserInfo` 源码确认返回
 * `{ username, email }`。端点本身未实测（需要真令牌）。
 */
export declare function fetchCodelyNickname(accessToken: string, options?: Pick<CodelyLoginFlowOptions, 'fetcher' | 'signal'>): Promise<string | undefined>;
/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * 与 {@link startClineLoginFlow} 同为「先拿 URL → 打开 → 后台轮询」的
 * 两步式：浏览器只在用户点击后的短暂窗口内允许 `window.open`，阻塞到
 * 授权完成才返回 URL 会让弹窗被拦截（AGENTS.md 记过 CodeArts 同类缺陷）。
 * 设备码授权请求本身是一次快速 POST，不涉及用户等待。
 *
 * ⚠️ 凭据由本函数在授权完成后**自己落盘**（`options.credentials.set`）——
 * 因为它没有 auth 服务实例可用（registry 里 codely `channel:false`，
 * `JetHubAuths` 无键）；调用方只负责账号池的占位与回填。
 */
export declare function startCodelyDeviceLogin(options: CodelyLoginFlowOptions): Promise<StartedCodelyLoginFlow>;
/**
 * 按 ref 读回已落盘的 Codely 凭据（**目录读取**用）。
 *
 * ⚠️ 参数是**完整 ref**（与 `CodelyLoginFlowOptions.ref` 同约定）：本模块不
 *    import 凭据命名空间逻辑，避免「一文件两套同义判据」（仓库既有红线），
 *    故由调用方用 `credentialRef(refName)` 算好后传入。
 *
 * ⚠️ **读不到一律返回 `undefined`，不抛错**：调用方是适配器目录路径，
 *    抛错会被 `listModels` 的调用方接不住（`dsh-llm` 直接 await 适配器方法），
 *    后果是面板「读取模型列表失败」（officeace 记过同款缺陷）。读不到时
 *    目录回退兜底表即可。
 *
 * @param ref - 完整凭据 ref。
 * @param credentials - 宿主 `ctx.credentials` 的形状子集。
 */
export declare function readCodelyCredential(ref: string, credentials: {
    resolve(ref: string): Promise<{
        value?: string;
    } | undefined>;
}): Promise<CodelyCredential | undefined>;
/**
 * 换发 `cli_api_key` 的**结果**（带失败原因，2026-10-22 对抗审计 A1 修）。
 *
 * ## ⚠️⚠️ 为什么必须带原因，不能只返回 `undefined`
 *
 * 原签名是 `… | undefined`，而它在**任何**失败下都返回 `undefined`：
 * 401（凭据真失效）、5xx（上游故障）、`fetch` 抛异常（DNS 抖动 / 连接重置）、
 * 响应体缺 `cli_api_key`（协议变更）—— **四类完全不同的事挤成同一个值**。
 *
 * 调用方（`codely-adapter.ts` 的换号循环）因此**无法分档**，只能对全部情形做
 * 同一件事。原实现选的是「记一笔到次日 0 点的冷却 + 换号」，后果是：
 * 一次 5 秒的 DNS 抖动就把池里**每一个**账号锁到次日 0 点（实测 11.15 小时），
 * 而文案还告诉用户「访问令牌可能已过期，请**删除该账号**」（删除不可逆）。
 *
 * ⇒ 判据必须下沉到**这里**：只有本函数知道 HTTP 状态码与异常类型。
 *
 * ## 分档口径（每档对应调用方一个不同动作）
 *
 * | `kind` | 触发条件 | 调用方应做 |
 * |---|---|---|
 * | `ok` | 拿到非空 `cli_api_key` | 正常推理 |
 * | `credential` | **401 / 403** —— 该号的 access_token 确实不可用 | 换号 + 记账 |
 * | `transient` | 网络异常 / 5xx / 429 / 其它非 2xx | **不换号、不记账**，如实报错让用户重试 |
 * | `malformed` | 2xx 但缺 `cli_api_key`（协议变更） | 不换号、不记账，报内部错误 |
 *
 * ⚠️ **`transient` 绝不能进冷却记账**：那是「上游/网络此刻不好」，不是
 *   「这个账号不好」。记进去就等于把一次抖动变成一整天的封号。
 * ⚠️ **429 归 `transient` 而非 `credential`**：换发端点的 429 是网关限流，
 *   与「该号没额度」无关（额度问题在**推理**端点报 402，那条另有分档）。
 */
export type CodelyCliApiKeyResult = {
    kind: 'ok';
    cliApiKey: string;
    userId?: string;
} | {
    kind: 'credential';
    status: number;
} | {
    kind: 'transient';
    status?: number;
    reason: string;
} | {
    kind: 'malformed';
    reason: string;
};
/**
 * 换发推理用的 `cli_api_key`（`sk-…`）。
 *
 * ## 端点与实测（2026-10-20）
 *
 * `GET https://codely.tuanjie.cn/api/api-token/cli-api-key`
 * ——**必须 GET**（POST 回 405 `method is not allowed`），
 * Bearer = access_token，响应 `{ cli_api_key, user_id, rpm, tpm }`。
 *
 * ⚠️ 身份头用 `X-User-Agent: codely-vscode/4.3.0`（与目录端点同款；
 * 推理请求则要用 `codely-cli/…`，两份 UA 不能混 —— 见 `codely-sign.ts`）。
 *
 * ⚠️⚠️ **换发的 key 与推理时的 `Bearer` 必须是同一份**：签名由它派生
 * （`codelySigningKey`），用 A 的 key 签名配 B 的 Bearer 会 401。
 * 故本函数与适配器必须把返回值**成对**使用。
 *
 * ⚠️ 仍**不抛错**（调用方在推理路径上，抛错会把「换发失败」误报成「推理失败」），
 * 但返回 {@link CodelyCliApiKeyResult} 而不是裸 `undefined` —— 理由见该类型的注释。
 */
export declare function fetchCodelyCliApiKey(accessToken: string, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<CodelyCliApiKeyResult>;
//# sourceMappingURL=codely-auth.d.ts.map