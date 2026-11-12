/* Load synchronously before the SDK. Only the verified, argument-free catalog RPC is shared. */
(() => {
  'use strict';
  const root = globalThis;
  if (root.__dshModelCatalogBudget || typeof root.fetch !== 'function' || !root.location) return;
  const original = root.fetch;
  const deadlineMs = root.document?.querySelector?.('script[data-dsh-pocket-polyfill="1"]') ? 30000 : 8000;
  const maxBodyBytes = 2 * 1024 * 1024, maxCallers = 128;
  const stats = { requests: 0, shared: 0, completed: 0, timedOut: 0, cancelled: 0, failed: 0 };
  let current = null, disposed = false;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const fault = (name, message) => new DOMException(message, name);
  function match(input, init) {
    try {
      if ((typeof input !== 'string' && !(input instanceof URL)) || !init || init.method !== 'POST') return null;
      if (Object.keys(init).some(key => !['method', 'headers', 'body', 'signal'].includes(key))) return null;
      const url = new URL(String(input), root.document?.baseURI || root.location.href);
      if (url.origin !== root.location.origin || url.pathname !== '/api/session/modelCatalog' || url.search || url.hash || url.username || url.password) return null;
      const headers = new Headers(init.headers);
      if ([...headers].length !== 1 || headers.get('content-type') !== 'application/json') return null;
      if (typeof init.body !== 'string' || init.body.length > 16384 || new TextEncoder().encode(init.body).byteLength > 16384) return null;
      const message = JSON.parse(init.body);
      if (!exactKeys(message, ['type', 'rpcId', 'method', 'payload']) || message.type !== 'client-request' || message.method !== 'session/modelCatalog') return null;
      if (typeof message.rpcId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(message.rpcId)) return null;
      if (!exactKeys(message.payload, ['args']) || !exactKeys(message.payload.args, [])) return null;
      if (init.signal !== undefined && !(init.signal instanceof AbortSignal)) return null;
      return { rpcId: message.rpcId, signal: init.signal };
    } catch { return null; }
  }
  function remove(operation, caller) {
    operation.callers.delete(caller);
    caller.signal?.removeEventListener('abort', caller.onAbort);
  }
  function finish(operation, error, value) {
    if (operation.done) return;
    operation.done = true;
    clearTimeout(operation.timer);
    if (current === operation) current = null;
    for (const caller of operation.callers) {
      remove(operation, caller);
      if (error) caller.reject(error);
      else {
        try {
          const body = value.envelope ? JSON.stringify({ ...value.envelope, rpcId: caller.rpcId }) : value.body;
          caller.resolve(new Response(body, value.init));
        } catch { caller.reject(fault('DataError', '模型列表响应无法读取，请重试。')); }
      }
    }
  }
  function cancel(operation, error) {
    finish(operation, error);
    operation.controller.abort(error);
    operation.reader?.cancel().catch(() => {});
  }
  async function readResponse(response, operation) {
    if (operation.done) { await response.body?.cancel().catch(() => {}); return; }
    const reader = response.body?.getReader();
    operation.reader = reader;
    const chunks = []; let length = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (operation.done) { await reader.cancel().catch(() => {}); return; }
          if (done) break;
          length += value.byteLength;
          if (length > maxBodyBytes) throw fault('DataError', '模型列表响应过大，请检查供应商设置。');
          chunks.push(value);
        }
      } finally { operation.reader = null; reader.releaseLock(); }
    }
    if (operation.done) return;
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
    const init = { status: response.status, statusText: response.statusText, headers };
    if (!response.ok) return { body: bytes, init };
    if (headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw fault('DataError', '模型列表响应格式无效，请重试。');
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw fault('DataError', '模型列表响应格式无效，请重试。'); }
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== operation.rpcId || !record(envelope.result) ||
        (envelope.result.ok !== true && !(envelope.result.ok === false && record(envelope.result.error) && typeof envelope.result.error.code === 'string' && typeof envelope.result.error.message === 'string' && record(envelope.result.error.details)))) {
      throw fault('DataError', '模型列表响应关联无效，请重试。');
    }
    return { envelope, init };
  }
  function begin(input, init, matched) {
    const operation = { controller: new AbortController(), callers: new Set(), rpcId: matched.rpcId, done: false, timer: null };
    current = operation; stats.requests++;
    operation.timer = setTimeout(() => {
      stats.timedOut++;
      cancel(operation, fault('TimeoutError', '模型列表读取超时，请稍后手动重试。'));
    }, deadlineMs);
    Promise.resolve().then(() => {
      if (operation.done) return;
      return Reflect.apply(original, root, [input, { ...init, signal: operation.controller.signal }]);
    }).then(response => response && readResponse(response, operation)).then(value => {
      if (!operation.done) { stats.completed++; finish(operation, null, value); }
    }).catch(() => {
      if (!operation.done) { stats.failed++; cancel(operation, fault('NetworkError', '模型列表读取失败，请稍后手动重试。')); }
    });
    return operation;
  }
  function fetchWithBudget(input, init) {
    const matched = !disposed && match(input, init);
    if (!matched) return Reflect.apply(original, this, arguments);
    if (matched.signal?.aborted) return Promise.reject(matched.signal.reason || fault('AbortError', '模型列表读取已取消。'));
    if (current && current.callers.size >= maxCallers) return Promise.reject(fault('QuotaExceededError', '模型列表读取请求过多，请稍后重试。'));
    const operation = current || begin(input, init, matched);
    if (operation.callers.size) stats.shared++;
    return new Promise((resolve, reject) => {
      const caller = { resolve, reject, rpcId: matched.rpcId, signal: matched.signal, onAbort: null };
      caller.onAbort = () => {
        remove(operation, caller);
        reject(caller.signal.reason || fault('AbortError', '模型列表读取已取消。'));
        if (!operation.done && operation.callers.size === 0) {
          stats.cancelled++;
          cancel(operation, fault('AbortError', '模型列表读取已取消。'));
        }
      };
      operation.callers.add(caller);
      caller.signal?.addEventListener('abort', caller.onAbort, { once: true });
    });
  }
  root.fetch = fetchWithBudget;
  Object.defineProperty(root, '__dshModelCatalogBudget', { configurable: true, value: Object.freeze({
    status: () => ({ installed: !disposed, deadlineMs, maxBodyBytes, active: current ? 1 : 0, callers: current?.callers.size || 0, ...stats }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (root.fetch === fetchWithBudget) root.fetch = original;
      if (current) cancel(current, fault('AbortError', '模型列表读取已取消。'));
      if (root.__dshModelCatalogBudget === this) delete root.__dshModelCatalogBudget;
    }
  }) });
})();
