/**
 * TRAE 上游错误分类。
 *
 * 移植自 `trae2api/internal/upstream/client.go:19-92`（Go）的 `Classify()`
 * 与 `solosse.go:60-68` 的 `Kind()`。
 *
 * ## 与 Go 版的差异：只移植分类，不移植自动冷却状态机
 *
 * 与 `lobsterai-errors.ts` 的 D2 设计哲学一致：只把 HTTP 状态码 + 响应体
 * 判定为有限几类，供上层决定「该换号还是该报错」。不在这里引入自动冷却
 * 或账号禁用——那属于 `AccountPool` 的 `modelRateLimits` + Jet Hub UI 的
 * 「重测/重置」按钮的职责范围。
 *
 * ## 限流标记的落点
 *
 * 换号循环中，调用方本模块外处理，在发现 `hard-plan` / `soft-rate` 时
 * 调用 `accountPool.updateModelRateLimit(...)` 写入限流标记。
 *
 * ## 两个入口，别混用
 *
 * - {@link classifyTraeError}（HTTP 层）：输入是**响应体原文** ⇒ 只能做子串
 *   匹配 —— 正文里恰好出现 `1005` 不算证据，故 `hard-plan` 还要求 `plan` 关键词。
 * - {@link classifyTraeStreamCode}（流内 `event:error`）：输入是**结构化码**
 *   ⇒ 码本身就是证据，不要求 `plan`（`message` 可能为空）。
 */
/**
 * TRAE 上游错误类别。
 */
export type TraeErrorKind = 
/** 成功（HTTP < 400）。 */
'none'
/** Plan 权益不足（1005） → 长冷却（12h）。 */
 | 'hard-plan'
/** 429 软限流或频率超限（4011） → 短冷却（60s）。 */
 | 'soft-rate'
/** 会话终止：refresh_token / access_token 失效 → 需重新登录。 */
 | 'session-dead'
/** 配额超限（4008：ide_credits 耗尽）→ 等每日重置或签到。 */
 | 'quota-exceeded'
/** 404 → 短冷却且不累计 errCount。 */
 | 'not-found'
/** 5xx 上游故障。 */
 | 'server'
/** 其他 4xx / 业务错误。 */
 | 'client';
/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * 判定顺序（对齐 Go 端 `Classify` + `SOLOStreamError.Kind`）：
 *
 * 1. body 含 1005 + plan → hard-plan
 * 2. body 含 4008 → quota-exceeded（**先于 4011**，见实现处说明）
 * 3. body 含 4011 → soft-rate（频率超限）
 * 4. HTTP 401 + body 含 session-dead 标记 → session-dead（或直接 401）
 * 5. HTTP 429 → soft-rate
 * 6. HTTP 404 → not-found
 * 7. >= 500 → server
 * 8. >= 400 → client
 * 9. 否则 none
 *
 * @param status HTTP 状态码
 * @param body 响应体原文（JSON 或纯文本均可，只做子串匹配）
 */
export declare function classifyTraeError(status: number, body: string): TraeErrorKind;
/**
 * 按流内 `event:error` 的**结构化码**判定类别（**只查表，不猜文案**）。
 *
 * ## 为什么必须单独开一个入口，不能直接把它喂给 `classifyTraeError`
 *
 * 上面的 `classifyTraeError` 是**文案（子串）匹配**表：它的 `hard-plan` 判定
 * 要求 body 里**同时**出现 `1005` 与 `plan` 关键词（对齐 Go 端 `Classify`，
 * 且 `tests/unit/trae-errors.spec.ts` 显式锁死「仅 `{"code":1005}` 不判
 * hard-plan」）。那条限制是有理由的 —— 正文里**恰好出现**的数字 `1005` 不该
 * 被当成权益不足（同仓 `zcode-adapter.ts` 的裸子串判据就因此把两个可用账号
 * 换掉过，见其注释）。**故本函数不动那张文案表。**
 *
 * 但流内 `event:error` 给的是**上游明确下发的枚举码**（`code` 字段），不是
 * 正文里偶然出现的数字；而同一个事件里的 `message` **可能是空字符串**
 * —— 此时文案腿永远不满足，于是：
 *
 * - 判成 `'none'` ⇒ `traeCooldownFor` 取 **0ms** ⇒ 限流标记写在失败那一瞬间
 *   ⇒ 下次选号**立刻又选回同一个号**（换号形同虚设）；
 * - 池里所有账号都被该模型拒时（2026-10-24 真实报障：两个账号同被
 *   `kimi-k3.1-pro` 拒），外层如实抛 `trae:  (code=1005)`
 *   （`message` 为空 ⇒ 冒号后**两个空格**）并带 `'QUOTA_EXCEEDED'`，
 *   用户只看到「本轮运行失败」，而插件侧**一点退避都没有**。
 *
 * 故这里**只认这张表**：{@link TRAE_STREAM_ERROR_KINDS} 登记过的码直接给出
 * 类别（不要求 `plan` 关键词，也不看 `message`）。与本仓 `trae-credits.ts` 的
 * `200 + code === 1005` ⇒ `PlanLimit(12h)` 逐格一致 —— 那里同样**不要求**
 * `plan` 关键词。
 *
 * ## ⚠️ 表外码为什么返回 `undefined` 而不是回落文案表（2026-10-25 审计 F-02）
 *
 * 旧实现有「表外码 ⇒ `classifyTraeError(0, JSON.stringify({code,message}))`」
 * 的回落腿，它有两个问题：
 *
 * 1. **在生成路径上不可达** —— 唯一的调用点（`trae-adapter.ts` 的换号循环）
 *    前面已经用 {@link isRotatableTraeStreamCode}（**同一张表**）过滤过，
 *    能走到分类的码必然在表内；
 * 2. **它复活的正是本次要消灭的形态** —— 把 `{code,message}` 序列化成 JSON
 *    再喂**文案表**，那个「JSON 里没有 `plan` 字样 ⇒ 判 `none` ⇒ 冷却 0ms」
 *    的缺陷就是它造成的。
 *
 * ⇒ 死代码 + 复活旧缺陷形态，删掉。表外码由调用方决定兜底冷却
 * （`trae-adapter.ts` 用 `TRAE_RATE_LIMIT_FALLBACK_MS`）。本函数也因此
 * **不再需要 `message` 参数** —— 留着它只会让人以为文案仍参与判据。
 *
 * @param code 流内事件的 `code` 字段（结构化数值，**不做子串匹配**）
 * @returns 表内码的类别；**表外码返回 `undefined`**
 */
export declare function classifyTraeStreamCode(code: number): TraeErrorKind | undefined;
/**
 * 该流内错误码是否**值得换号**。
 *
 * 表内三个码（1005 / 4008 / 4011）都换号。`4001`（模型不可调用）**刻意不在
 * 表内** ⇒ 不换号：换账号也是同一个模型被拒，直接如实报错更省事。
 * `4006`（体积超限）同理不换号 —— 它另有专用出口
 * （`streamErrorCode` 归 `CONTEXT_WINDOW_EXCEEDED` 以触发溢出压缩）。
 */
export declare function isRotatableTraeStreamCode(code: number): boolean;
/**
 * 该类别是否应当触发「换下一个账号」。
 *
 * 除 `none` 外的每一类都换号，对齐 Go 端 handler 的每个分支都以 `continue` 结尾。
 */
export declare function shouldRotateTraeAccount(kind: TraeErrorKind): boolean;
/**
 * 该类别的失败是否应记为该模型的限流标记。
 *
 * 只包含真正需要冷却的类别：
 * - `hard-plan`：权益不足（可视为限流）
 * - `soft-rate`：短冷却
 * - `not-found`：短冷却
 * - `quota-exceeded`：配额超限（长冷却）
 *
 * `session-dead` 与 `server` / `client` 不记限流标记——它们不是限流。
 */
export declare function recordsTraeRateLimit(kind: TraeErrorKind): boolean;
/**
 * 该类别是否属于终态（重试无意义，只能重新登录）。
 */
export declare function isTraeTerminalError(kind: TraeErrorKind): boolean;
//# sourceMappingURL=trae-errors.d.ts.map