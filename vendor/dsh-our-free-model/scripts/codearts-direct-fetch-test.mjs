/** CodeArts 离线传输回归：凭据和 TLS 身份均为公开测试夹具，只连接本机。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// 每次测试生成临时 TLS 身份；只信任该次回归的本地 CA，不发布私钥。
const tlsFixture = process.env.OFM_TEST_TLS_DIR ? {
  key: fs.readFileSync(path.join(process.env.OFM_TEST_TLS_DIR, 'key.pem'), 'utf8'),
  cert: fs.readFileSync(path.join(process.env.OFM_TEST_TLS_DIR, 'ca.pem'), 'utf8'),
} : null
if (!process.argv.includes('--trusted-fixture')) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-codearts-'))
  const ca = path.join(scratch, 'ca.pem')
  try {
    const keyFile = path.join(scratch, 'key.pem')
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    execFileSync('openssl', ['req', '-x509', '-new', '-sha256', '-days', '1', '-key', keyFile,
      '-out', ca, '-subj', '/CN=ofm-codearts-offline-fixture', '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:fixture.invalid,DNS:snap-access.cn-north-4.myhuaweicloud.com,DNS:opengw.developer.huaweicloud.com'],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    // Node 启动时读取附加 CA：仅该测试子进程信任夹具，TLS 校验始终开启。
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--trusted-fixture'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, CODEARTS_MODELS_CACHE_DIR: scratch,
        DSH_CHANNEL_PACK_STATE_DIR: scratch, DSH_HOME: scratch, OFM_TEST_TLS_DIR: scratch },
    })
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  }
  finally { fs.rmSync(scratch, { recursive: true, force: true }) }
} else {
  await verify()
  // 沿用既有离线测试入口，让常规回归同时覆盖真实插件的多上下文 RPC 接线。
  await import('./codearts-rpc-context-test.mjs')
}

async function verify() {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
  const ts = (await import('typescript')).default
  const llm = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(kernel)}
    export class LlmError extends Error { constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status } }`)
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-llm') return { url: llm, shortCircuit: true }
      if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
      if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
        const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
        if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
        }).outputText,
      }
      return next(url, context)
    },
  })
  const { createDirectFetch, directFetch, directLane, attachDirectFetch, closeDirectFetch } = await import('../vendor/channel-pack/src/direct-fetch.ts')
  const { CodeArtsAdapter } = await import('../vendor/channel-pack/src/llm-adapter.ts')
  const { fetchCodeArtsRemoteModels } = await import('../vendor/channel-pack/src/models.ts')
  const { fetchCodeArtsAccountInfoDetailed } = await import('../vendor/channel-pack/src/codearts-credits.ts')
  const { CodeArtsAuth } = await import('../vendor/channel-pack/src/service.ts')
  const { Agent, MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('undici')
  const credential = { access_key_id: 'FIXTUREAK', secret_access_key: 'FIXTURESECRET', security_token: 'FIXTURETOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() }
  const defaults = { credentialRef: 'FIXTURE', resolveCredential: async () => credential, refresh: async () => {} }
  const options = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'text', text: '中文签名 hello' }] }] }
  const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
  const savedFetch = globalThis.fetch, sockets = new Set(), servers = [], transports = [], releases = [], seen = [], proxyCalls = []
  const waiters = new Map()
  let nextError, globalCalls = 0, activeNetwork, checks = 0
  const frame = { choices: [{ delta: { content: 'fixture-ok' }, finish_reason: 'stop' }] }
  const sse = value => 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n'
  const watch = server => {
    servers.push(server)
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    return server
  }
  const listen = async server => { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); return server.address().port }
  const transport = settings => { const value = createDirectFetch({ environment: {}, platform: 'linux', ...settings }); transports.push(value); return value }
  const bind = network => { activeNetwork = network; releases.push(attachDirectFetch(network.fetch)) }
  const waitFor = name => new Promise(resolve => { waiters.set(name, resolve) })
  const check = async (name, run) => {
    let timer
    try {
      await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ': timed out')), 5000) })])
      checks++; console.log('ok  ' + name)
    } finally { clearTimeout(timer) }
  }
  const hash = body => createHash('sha256').update(body).digest('hex')
  // 服务端依据实际收到的字节及 SignedHeaders 独立验签，不调用生产签名函数。
  function validSignature(req, body) {
    const match = /^SDK-HMAC-SHA256 Access=FIXTUREAK,SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')
    if (!match || hash(body) !== req.headers['x-sdk-content-sha256']) return false
    const names = match[1].split(';'), url = new URL(req.url, 'https://' + req.headers.host)
    if (names.join(';') !== [...new Set(names)].sort().join(';')) return false
    // ⚠️ 服务端按 key 字典序重算 canonical query（上游 2026-10-29 真机实测：wire 顺序 != 字典序时
    // 只有「签名内排序」才 200）。本验签器此前按 wire 顺序拼，是它自己过时了，不是被测代码错。
    const canonicalQuery = url.search.slice(1).split('&').filter(Boolean)
      .map(pair => { const at = pair.indexOf('='); return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)] })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => k + '=' + v).join('&')
    const canonical = [req.method, url.pathname.replace(/\/?$/, '/'), canonicalQuery, names.map(name => name + ':' + (req.headers[name] ?? '')).join('\n'), '', match[1], hash(body)].join('\n')
    const expected = createHmac('sha256', credential.secret_access_key).update('SDK-HMAC-SHA256\n' + req.headers['x-sdk-date'] + '\n' + hash(canonical)).digest('hex')
    return expected === match[2] && req.headers['x-security-token'] === credential.security_token
  }
  async function serve(req, res) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (req.url.startsWith('/hold')) { waiters.get('hold')?.(); return }
    if (req.url.startsWith('/stream')) { res.once('close', () => waiters.get('streamClosed')?.()); res.writeHead(200); res.write('first'); return }
    if (req.url.startsWith('/plain')) { res.end(body.length ? body : 'plain'); return }
    const valid = validSignature(req, body)
    seen.push({ valid, body: body.toString(), headers: req.headers, method: req.method, url: req.url })
    if (!valid) { res.writeHead(401); res.end(JSON.stringify({ error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' })); return }
    if (req.url.endsWith('/chat/completions')) {
      res.setHeader('content-type', 'text/event-stream')
      res.end(sse(nextError === undefined ? frame : { error_code: nextError, error_msg: 'benefit not found' })); nextError = undefined
    // ⚠️ 2026-10-30 上游把 benefit 头判定收紧为「gateway/config 已确认的模型」：
    // 这里必须把测试模型播报成 benefit 模型，否则去头重试分支根本不会触发。
    } else if (req.url.includes('/gateway/config')) res.end(JSON.stringify({ result: { models: [{ model_id: 'deepseek-v4.1-flash', model_name: 'fixture' }] } }))
    else if (req.url.includes('/model/builtin')) res.end(JSON.stringify({ builtinModels: [{ model_id: 'fixture-builtin', model_name: 'fixture' }] }))
    else res.end(JSON.stringify({ package: { is_credit_package: true, package_name_cn: '隔离套餐' }, metrics: {} }))
  }
  const handler = (req, res) => { void serve(req, res).catch(error => res.destroy(error)) }
  const targetPort = await listen(watch(https.createServer(tlsFixture, handler)))
  const plainPort = await listen(watch(http.createServer(handler)))
  function proxy(secure) {
    const handler = (req, res) => {
      proxyCalls.push({ secure, method: req.method, url: req.url })
      const url = new URL(req.url)
      assert.equal(url.hostname, 'fixture.invalid')
      const upstream = http.request({ hostname: '127.0.0.1', port: plainPort, path: url.pathname, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', error => res.destroy(error)); req.pipe(upstream)
    }
    const server = watch(secure ? https.createServer(tlsFixture, handler) : http.createServer(handler))
    server.on('connect', (req, client, head) => {
      proxyCalls.push({ secure, method: 'CONNECT', url: req.url })
      assert.ok(['snap-access.cn-north-4.myhuaweicloud.com:443', 'opengw.developer.huaweicloud.com:443', 'fixture.invalid:443'].includes(req.url), 'CONNECT only targets local fixtures')
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy())
    })
    return server
  }
  const httpProxyPort = await listen(proxy(false)), httpsProxyPort = await listen(proxy(true))
  const httpProxy = 'http://127.0.0.1:' + httpProxyPort, httpsProxy = 'https://localhost:' + httpsProxyPort
  try {
    bind(transport({ environment: { HTTPS_PROXY: httpProxy } }))
    globalThis.fetch = (input, init) => {
      globalCalls++
      const body = init?.body ? JSON.stringify({ ...JSON.parse(init.body), injected_by_plugin: true }) : undefined
      return activeNetwork.fetch(input, { ...init, body })
    }
    await check('联装冲突可复现：全局 fetch 改写 body 后本地网关拒绝签名', async () => {
      const start = seen.length
      await assert.rejects(collect(new CodeArtsAdapter({ ...defaults, fetchImpl: (...args) => globalThis.fetch(...args) }).stream(options)))
      const chats = seen.slice(start).filter(row => row.method === 'POST')
      assert.ok(chats.length > 0); assert.ok(chats.every(row => !row.valid && JSON.parse(row.body).injected_by_plugin))
    })
    await check('默认聊天绕过全局 fetch，实际 TLS 请求体与 HMAC 签名一致', async () => {
      const before = globalCalls, start = seen.length
      const chunks = await collect(new CodeArtsAdapter(defaults).stream(options))
      assert.equal(globalCalls, before); assert.equal(seen.length, start + 1); assert.equal(seen.at(-1).valid, true)
      assert.ok(seen.at(-1).body.includes('中文签名')); assert.ok(chunks.some(row => row.type === 'block-end' && row.block?.text === 'fixture-ok'))
    })
    await check('模型目录、积分及认证服务的默认签名 GET 同样经过专用传输', async () => {
      const before = globalCalls, start = seen.length
      assert.deepEqual((await fetchCodeArtsRemoteModels(credential)).map(row => row.id), ['deepseek-v4.1-flash', 'fixture-builtin'])
      const account = await fetchCodeArtsAccountInfoDetailed(credential)
      assert.equal(account.ok, true); assert.equal(account.info.packageName, '隔离套餐')
      const ctx = { provide() {}, credentials: { resolve: async () => ({ value: JSON.stringify(credential) }) } }
      const service = new CodeArtsAuth(ctx)
      assert.equal((await service.refreshModels({ listAccountsByProvider: () => [{ credentialRef: 'FIXTURE' }] })).length, 2); service.stop()
      // ⚠️ 2026-10-30 上游接入 AgentCenter 动态窗口源后，这条链路多打 2 个签名 GET（5 → 7）。
      assert.equal(globalCalls, before); assert.equal(seen.length, start + 7); assert.ok(seen.slice(start).every(row => row.valid && row.method === 'GET'))
    })
    await check('显式 fetchImpl/fetcher 保留优先级，离线测试入口仍有效', async () => {
      let calls = 0
      await collect(new CodeArtsAdapter({ ...defaults, fetchImpl: async () => { calls++; return new Response(sse(frame)) } }).stream(options))
      const result = await fetchCodeArtsAccountInfoDetailed(credential, async () => { calls++; return Response.json({ package: { package_name_cn: '注入套餐' } }) })
      assert.equal(result.info.packageName, '注入套餐'); assert.equal(calls, 2)
      const saved = directLane.fetch
      try {
        directLane.fetch = async () => new Response('seam')
        assert.equal(await (await directFetch('https://never-dial.invalid/')).text(), 'seam')
        assert.equal(await (await transport({ fetchImpl: async () => new Response('explicit') }).fetch('https://never-dial.invalid/')).text(), 'explicit')
      } finally { directLane.fetch = saved }
    })
    await check('完整及字符串/数字 4004 仅摘 benefit 头重试一次，重签名仍有效', async () => {
      for (const code of ['4004', 4004, 'InferHub.4004.200']) {
        const start = seen.length; nextError = code
        await collect(new CodeArtsAdapter(defaults).stream(options))
        // ⚠️ 2026-10-30 上游在「去头降级」之前插入了一步「先领一次福利」（claim 幂等）：
        //   chat(带 benefit) → [POST benefit/claim] → chat(去头重放)
        // claim 是否真的发出取决于「本轮该模型是否已被远端确认/本进程学过」，
        // 因此这里按**语义**断言，不钉死请求条数（旧断言钉的是 claim 上线前的 2 条）。
        const rows = seen.slice(start)
        const chats = rows.filter(row => row.method === 'POST' && String(row.url).endsWith('/chat/completions'))
        assert.equal(chats.length, 2, `${code}: 失败后恰好重放一次`)
        assert.equal(chats[0].headers.maas_type, 'benefit', `${code}: 首次带 benefit`)
        assert.equal(chats[1].headers.maas_type, undefined, `${code}: 重放已去头`)
        assert.equal(chats[0].body, chats[1].body, `${code}: 正文一致`)
        assert.ok(rows.every(row => row.valid), `${code}: 重放仍签名有效`)
        assert.ok(rows.every(row => row.method !== 'POST' || String(row.url).endsWith('/chat/completions') || String(row.url).includes('/benefit/claim')), `${code}: 中间只允许 claim`)
      }
      for (const [model, code] of [[options.model, '14004'], ['GLM-5.2', '4004']]) {
        const start = seen.length; nextError = code
        await assert.rejects(collect(new CodeArtsAdapter(defaults).stream({ ...options, model }))); assert.equal(seen.slice(start).filter(row => row.method === 'POST').length, 1)
      }
    })
    await check('Windows HTTPS 系统代理及 HTTPS_PROXY 真实经过代理并保持签名', async () => {
      let reads = 0
      bind(transport({ platform: 'win32', readSystemProxy: async () => {
        reads++; return 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:9;https=127.0.0.1:' + httpProxyPort + '\nProxyOverride REG_SZ <local>;*.internal'
      } }))
      await collect(new CodeArtsAdapter(defaults).stream(options)); await collect(new CodeArtsAdapter(defaults).stream(options)); assert.equal(reads, 1)
      const start = proxyCalls.length
      bind(transport({ environment: { HTTPS_PROXY: httpsProxy } })); await collect(new CodeArtsAdapter(defaults).stream(options))
      assert.ok(proxyCalls.slice(start).some(row => row.secure && row.method === 'CONNECT')); assert.equal(seen.at(-1).valid, true)
    })
    await check('NO_PROXY、loopback 及显式 dispatcher 保留既有选择与资源所有权', async () => {
      const start = proxyCalls.length, url = 'http://127.0.0.1:' + plainPort + '/plain'
      const network = transport({ environment: { HTTP_PROXY: httpProxy } })
      assert.equal(await (await network.fetch(url)).text(), 'plain')
      const bypass = transport({ environment: { HTTP_PROXY: httpProxy, NO_PROXY: '*' }, fetchImpl: async (_url, init) => {
        assert.equal(init.dispatcher, undefined); return new Response('bypass')
      } })
      assert.equal(await (await bypass.fetch('http://fixture.invalid/plain')).text(), 'bypass')
      const dispatcher = new Agent()
      try { assert.equal(await (await network.fetch(url, { dispatcher })).text(), 'plain'); await network.close(); assert.equal(dispatcher.destroyed, false) }
      finally { await dispatcher.destroy() }
      assert.equal(proxyCalls.length, start)
    })
    await check('插件出口优先且使用隔离 send；旧出口缺接口时禁止绕过', async () => {
      const before = globalCalls, start = proxyCalls.length
      let calls = 0
      const network = transport({ environment: { HTTPS_PROXY: 'http://127.0.0.1:9' }, outlet: {
        active: () => true, fetch: async () => { throw new Error('unsafe outlet') },
        fetchSigned: (_input, init, send) => { calls++; assert.equal(init.redirect, 'error'); return send('http://127.0.0.1:' + plainPort + '/plain', { ...init, method: 'POST', body: 'selected outlet' }) },
      } })
      assert.equal(await (await network.fetch('https://fixture.invalid/')).text(), 'selected outlet'); assert.equal(calls, 1)
      assert.equal(globalCalls, before); assert.equal(proxyCalls.length, start)
      const legacy = transport({ outlet: { active: () => true, fetch: async () => { throw new Error('unsafe outlet') } } })
      await assert.rejects(legacy.fetch('https://fixture.invalid/'), error => /尚未接入签名传输/.test(error.cause?.message)); assert.equal(proxyCalls.length, start)
    })
    await check('预先取消、在途取消、超时、响应流取消及 Node Request 均生效', async () => {
      const network = transport(), url = 'http://127.0.0.1:' + plainPort
      const pre = new AbortController(), reason = new Error('fixture cancel'); pre.abort(reason)
      await assert.rejects(network.fetch(url + '/plain', { signal: pre.signal }), error => error === reason)
      const reached = waitFor('hold'), controller = new AbortController(), pending = network.fetch(url + '/hold', { signal: controller.signal })
      const rejected = assert.rejects(pending, error => error === reason)
      await reached; controller.abort(reason); await rejected
      await assert.rejects(network.fetch(url + '/hold', { signal: AbortSignal.timeout(80) }), { name: 'TimeoutError' })
      const streaming = new AbortController(), response = await network.fetch(url + '/stream', { signal: streaming.signal }), reader = response.body.getReader()
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
      const stopped = assert.rejects(reader.read(), { name: 'AbortError' }); streaming.abort(); await stopped
      assert.equal(await (await network.fetch(new Request(url + '/plain', { method: 'POST', body: 'native Request body' }))).text(), 'native Request body')
    })
    await check('关闭取消代理响应流、销毁自有连接，重复关闭安全且拒绝新请求', async () => {
      const streamClosed = waitFor('streamClosed')
      const network = transport({ environment: { HTTPS_PROXY: httpProxy } }), response = await network.fetch('https://fixture.invalid/stream'), reader = response.body.getReader()
      await reader.read(); const stopped = assert.rejects(reader.read(), { name: 'AbortError' })
      const closing = network.close(); assert.equal(network.close(), closing); await closing; await stopped; await streamClosed
      await assert.rejects(network.fetch('https://fixture.invalid/plain'), { name: 'AbortError' })
    })
    await check('独立 Agent 不受 undici 全局 dispatcher 改写影响', async () => {
      const original = getGlobalDispatcher(), blocked = new MockAgent(); blocked.disableNetConnect(); setGlobalDispatcher(blocked)
      try { assert.equal(await (await transport().fetch('http://127.0.0.1:' + plainPort + '/plain')).text(), 'plain') }
      finally { setGlobalDispatcher(original); await blocked.close() }
    })
    await check('旧挂载延迟卸载及重复卸载不会清除新挂载', async () => {
      const detachA = attachDirectFetch(async () => new Response('A')), detachB = attachDirectFetch(async () => new Response('B'))
      detachA(); assert.equal(await (await directFetch('http://fixture.invalid/')).text(), 'B'); detachB(); detachB()
      const shared = async () => new Response('shared')
      const first = attachDirectFetch(shared), second = attachDirectFetch(shared)
      first(); assert.equal(await (await directFetch('http://fixture.invalid/')).text(), 'shared'); second()
    })
    console.log('codearts-direct-fetch: ' + checks + ' checks passed (local fixtures only)')
  } finally {
    globalThis.fetch = savedFetch
    for (const release of releases.reverse()) release()
    await Promise.allSettled(transports.map(network => network.close())); await closeDirectFetch()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); hooks.deregister()
  }
}
