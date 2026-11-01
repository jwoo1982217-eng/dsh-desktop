/** 华为云 SDK-HMAC-SHA256 请求签名 extraHeaders */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`)
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n')
}

/**
 * 解码失败（畸形 `%` 序列，如 `?a=100%`）时**原样返回**——签名函数绝不抛
 * （抛了会把一条本来能发的请求变成异常路径；值非标准转义时服务端对
 * canonical 的口径也无从对齐，保守按原文参与排序）。
 *
 * ⚠️⚠️ **只解 `%XX`，绝不解 `+`**（2026-10-30 四路审计 P2 D1 定案）：
 * `decodeURIComponent('a+b')` = `'a+b'`（**不**把 `+` 当空格），
 * 而表单语义（`application/x-www-form-urlencoded`）下 `+` **是**空格 ⇒
 * 若服务端按表单口径解析，我们签的 `a%2Bb`（字面加号）就与服务端眼里的
 * `a b`（空格）**分叉** ⇒ 验签失败。
 *
 * ⇒ 因此本函数**只**用于 `%XX` 的往返；`+` 一律**按字面**处理。
 * ⇒ 配套纪律：**上游 query 值必须在 `[A-Za-z0-9_.~-]` 安全集内**
 * （现网实测：uuid、模型 id、`msg`、`DESKTOP`、数字）。违反时本函数**不抛**，
 * 但 canonical 与服务端可能分叉 ⇒ 由调用方**在发请求前**自行校验值域。
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

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
export function isCanonicalQueryValueSafe(value: string): boolean {
  // 只允许：未编码的 ASCII 字母数字 + `_.-~`，或**已百分号编码**的 `%XX`。
  //
  // ⚠️⚠️ **未编码字符集必须覆盖 `encodeURIComponent` 的「不编码集」**
  // （2026-10-30 第二轮审计发现并修）：`encodeURIComponent` **不编码**
  // `A-Z a-z 0-9 - _ . ! ~ * ' ( )` ⇒ 若安全集漏了其中任何一个 ⇒
  // **本仓自己拼的 URL**（如 `queue/status?model=${encodeURIComponent(model)}`）
  // 会被这道闸门**静默丢弃** ⇒ 用户手填一个带 `!` / `(` 的模型 id ⇒
  // **排队状态查询永远失败**（而 chat 请求不走这道闸门 ⇒ 症状极隐蔽）。
  // ⇒ 安全集 = `encodeURIComponent` 的**完整不编码集** + `%XX`。
  return /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})*$/.test(value)
}

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
export function canonicalQueryOf(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (raw.length === 0) return ''
  const pairs: Array<[string, string]> = []
  for (const part of raw.split('&')) {
    if (part.length === 0) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const value = eq === -1 ? '' : part.slice(eq + 1)
    pairs.push([safeDecode(key), safeDecode(value)])
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

/**
 * 一个 URL 的**全部 query 值**是否落在安全集内（见
 * {@link isCanonicalQueryValueSafe}）。
 *
 * ⚠️ **键也要查**：键同样参与 canonical 的编码往返，键出安全集一样会分叉。
 * ⚠️ **裸键（无 `=`）也算安全**：服务端把它当空值 ⇒ canonical 侧也补 `=`
 *    ⇒ 两侧形态一致（实测 `?flag` → `flag=`）。
 */
export function isSignedQueryValueSafe(url: string): boolean {
  const qIndex = url.indexOf('?')
  if (qIndex === -1) return true
  const raw = url.slice(qIndex + 1)
  if (raw.length === 0) return true
  for (const part of raw.split('&')) {
    if (part.length === 0) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const value = eq === -1 ? '' : part.slice(eq + 1)
    if (!isCanonicalQueryValueSafe(key)) return false
    if (!isCanonicalQueryValueSafe(value)) return false
  }
  return true
}

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
export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  // ⚠️⚠️ **安全集闸门（唯一入口）** —— 抛错 ⇒ 调用方降级，绝不静默 401。
  if (!isSignedQueryValueSafe(urlStr)) {
    throw new Error(
      `华为云签名被拒：query 值不在安全集内（值含 '+'、空格、'&'、'=' 或畸形 '%'）`
      + `⇒ canonical 可能与服务端口径分叉 ⇒ 本次请求不发。URL=${urlStr.split('?')[0]}`,
    )
  }
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  // canonical query 必须 key 排序（见 canonicalQueryOf 的 2×2 实测定案）；
  // wire URL 原样发送，只改签名侧。
  const query = canonicalQueryOf(url.search)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = await sha256Hex(body)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  // 额外的签名头（如 glm-5.3-flash 的 maas_type: benefit）：与 Rust 参考实现
  // sign_request_huawei 的 extra_headers 一致，参与 canonical 计算并包含在
  // SignedHeaders 中，需原样随请求发送，否则服务端验签失败。
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  // GET 请求（排队状态轮询）不携带请求体，因此无 content-type。
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()

  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash)
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest))
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign))
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`)
  return headers
}
