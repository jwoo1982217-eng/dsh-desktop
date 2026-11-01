/** 华为云 SDK-HMAC-SHA256 请求签名 extraHeaders */
export declare function sha256Hex(data: Uint8Array): Promise<string>;
export declare function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string>;
export declare function buildCanonicalRequest(method: string, uri: string, query: string, headers: Map<string, string>, payloadHash: string): string;
/**
 * query **值**是否落在「三种编码口径逐字节相同」的安全集内。
 *
 * ⚠️⚠️ 这是 `canonicalQueryOf` 的**配套护栏**（2026-10-30 审计 P2 D1）：
 * 在安全集内，原样 / `encodeURI` / `encodeURIComponent` 三种口径**逐字节相同**
 * ⇒ 我们与服务端不可能分叉；出了安全集（`+`、空格、`&`、`=`、`%`）则
 * **可能**分叉 ⇒ 应当**拒绝发这个请求**（宁可退化，也不要静默 401）。
 *
 * ⚠️ **安全集是「往返幂等」的那个集**（实测逐个形态核对）：
 *
 * | wire 值 | decode → encode | 幂等？ | 判据 |
 * |---|---|---|---|
 * | `abc` | `abc` | ✅ | 安全 |
 * | `a%2Bb` | `a%2Bb` | ✅ | **安全**（`%2B` 解成 `+`、再编回 `%2B` ⇒ 逐字节相同） |
 * | `a%20b` | `a%20b` | ✅ | **安全**（同上） |
 * | `a+b` | `a%2Bb` | ❌ | **不安全**（裸 `+` 在表单语义下是空格 ⇒ 与服务端分叉） |
 * | `a b` | `a%20b` | ❌ | **不安全**（裸空格） |
 * | `a=b` | `a%3Db` | ❌ | **不安全**（`=` 会被重编码） |
 * | `a&b` | `a%26b` | ❌ | **不安全**（`&` 会被重编码） |
 * | `a%b` | `a%25b` | ❌ | **不安全**（畸形 `%` 序列；`safeDecode` 兜底返回原文） |
 *
 * ⇒ 判据 = 「**已百分号编码**的字符安全（`%XX` 形态），**裸**的
 *   `+` / 空格 / `&` / `=` / 裸 `%` 不安全」。
 *
 * ⚠️ **裸 `+` 是最危险的一个**：它在表单语义下是**空格**，而
 * `decodeURIComponent` **不解** `+`（只解 `%XX`）⇒ 我们把它当字面加号、
 * 服务端把它当空格 ⇒ 两侧算出**不同的 canonical** ⇒ `401 verify ak sk
 * signature fail`。
 */
export declare function isCanonicalQueryValueSafe(value: string): boolean;
/**
 * 把 wire query 规范成 **key 排序** 的 canonical query（SDK-HMAC-SHA256 要求）。
 *
 * ## 为什么必须排序（2026-10-29 真机 2×2 实测定案）
 *
 * AgentCenter `/v1/agent-center/agents/useragents?offset=0&limit=100` 上，
 * **唯一**失败的组合是「wire URL 按 offset,limit 顺序 + 签名也按该顺序」⇒
 * `401 verify ak sk signature fail`；改成签名内排序后 200，且 wire URL 的
 * 顺序无关（服务端按**自己收到的参数排序后**重算 canonical）。四轮重复 4/4
 * 确定性。这符合华为云官方文档「CanonicalQuery 是按 key 字典序排列」的口径。
 *
 * ## 为什么现在才改 / 波及面（全部核对过）
 *
 * 本 signer 此前把 `url.search` **原样**拼进 canonical —— 对无 query 的请求
 * （chat / builtin / gateway/config / benefit claim / ops delivery）是无操作；
 * 对排序恰好等于字典序的请求也是无操作（`queue/status?model=X&task_id=Y`：m < t）。
 * ⇒ 统一排序对既有调用方**零行为变化**，
 * 只有 AgentCenter 这类「wire 顺序 ≠ 字典序」的多参数 GET 需要它。
 *
 * ⚠️ **更正**（2026-10-30 审计 P3 D9）：原注释在这里列了
 * `credit/usage?type=msg&id=…` 作为「已核对的既有调用方」——**本仓库没有这个
 * 请求**（`grep -rn "credit/usage" src/` 只命中两处**注释**，零代码路径；
 * 它是 IDE 侧的端点，本仓未实现）⇒ 它**不在波及面内**，也不构成「排序
 * 与它无关」的证据。已删除该例。
 *
 * ⚠️ 只重排**签名里**的 query，wire URL 保持原样（调用方仍按原 URL 发请求）。
 * 值的再编码用 `encodeURIComponent`：现网全部 query 值都在
 * `[A-Za-z0-9_.-]` 安全集内（uuid、模型 id、`msg`、`DESKTOP`、数字），
 * 三种编码口径（原样/encodeURI/encodeURIComponent）在此集合上逐字节相同。
 *
 * ⚠️ **安全集之外**（`+`、空格、`&`、`=`、`%`）⇒ canonical 可能与服务端
 * 分叉 ⇒ **调用方必须先用 {@link isCanonicalQueryValueSafe} 校验**，
 * 不安全就**不发这个请求**（见 `src/models.ts` 的 `fetchSignedGet`）。
 */
export declare function canonicalQueryOf(search: string): string;
/**
 * 一个 URL 的**全部 query 值**是否落在安全集内（见
 * {@link isCanonicalQueryValueSafe}）。
 *
 * ⚠️ **键也要查**：键同样参与 canonical 的编码往返，键出安全集一样会分叉。
 * ⚠️ **裸键（无 `=`）也算安全**：服务端把它当空值 ⇒ canonical 侧也补 `=`
 *    ⇒ 两侧形态一致（实测 `?flag` → `flag=`）。
 */
export declare function isSignedQueryValueSafe(url: string): boolean;
/**
 * 签名一个华为请求；返回需合并到请求中的头映射。
 *
 * ⚠️⚠️⚠️ **query 值不在安全集内 ⇒ 抛错**（2026-10-30 第二轮审计 P1 N-3 修）。
 *
 * ⚠️ **为什么下沉到这一层**：安全集闸门原先只在 `src/models.ts` 的
 * `fetchSignedGet` 里 ⇒ **4 条带 query 的签名 GET 只盖了 1 条**
 * （`queue/status`、`ops/delivery`、benefit claim 那几条**不过闸门**）
 * ⇒ 同一个 signer **两条腿两套防护口径**。
 *
 * ⇒ 现在判据在**签名器内部** ⇒ **所有**经它的请求都受保护
 * （`src/models.ts` 的三个 GET + `src/codearts-credits.ts` 的两个 POST +
 * `src/llm-adapter.ts` 的 chat 与 queue/status）。
 *
 * ⚠️ **抛错的后果**：调用方（`fetchSignedGet` / `signedSnapRequest`）的
 * `try/catch` 会把它变成「这次请求没发出去」⇒ 目录/积分退化为**上一次成功
 * 的值**或**空** ⇒ **静默降级**而非崩溃。⇒ 抛错是**安全**的方向
 * （宁可少一个请求，也不要静默 401）。
 *
 * ⚠️ **现网不会触发**：本仓构造的 query 值全部在安全集内（实测 10/10 安全：
 * `encodeURIComponent` 恒产安全集内的字符）⇒ 这道闸是**纯防御**，
 * 防的是「上游改口径 / 用户手填特殊字符」。
 */
export declare function signRequestHuawei(ak: string, sk: string, securityToken: string, method: string, urlStr: string, body: Uint8Array, extraHeaders?: Readonly<Record<string, string>>): Promise<Map<string, string>>;
//# sourceMappingURL=sign.d.ts.map