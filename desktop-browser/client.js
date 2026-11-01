window.__ModuleLoader__.load({ id: 'dsh-desktop-browser', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const id = 'dsh-desktop-browser', kind = 'browser';
  const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions'];
  const agentId = 'dsh-desktop-browser-agent', agentKind = 'browser-agent';
  function agentPanel(address, sessionId) {
    const match = /^dsh-resource:\/\/browser-panel\/([^/?#]+)\/(mcp_[a-f0-9]{40})$/.exec(address || '');
    if (!match) return;
    try { if (sessionId !== undefined && decodeURIComponent(match[1]) !== sessionId) return; } catch { return; }
    return match[2];
  }
  function resultPanel(message, depth = 0) {
    if (message?.isError) return;
    for (const block of message?.content || []) {
      if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 256000) continue;
      try {
        const value = JSON.parse(block.text);
        if (value?.isError) continue;
        const panel = /^\/desktop-browser\?panel=(mcp_[a-f0-9]{40})$/.exec(value?.panelUrl || '')?.[1];
        if (panel && value.active && value.tabs?.some(tab => tab.id === value.active)) return panel;
        // Older MCP adapters retain the protocol content envelope in the log.
        if (depth === 0 && Array.isArray(value?.content)) {
          const nested = resultPanel({ content: value.content }, depth + 1);
          if (nested) return nested;
        }
      } catch {}
    }
  }
  /** Follow the selected Session's durable tool results, never page text or another Session's stream. */
  function watchAgentBrowser(ctx) {
    let binding, unsubscribe, revision = -1, candidate, queued = false, disposed = false;
    const calls = new Set(), handled = new Map();
    function acknowledged(sessionId) {
      if (!handled.has(sessionId)) {
        let seq = -1;
        try { const value = Number(sessionStorage.getItem('dsh.browser-presented.v1:' + sessionId)); if (Number.isSafeInteger(value) && value > 0) seq = value; } catch {}
        handled.set(sessionId, seq);
      }
      return handled.get(sessionId);
    }
    function present() {
      queued = false;
      const sessionId = binding?.sessionId;
      if (disposed || !candidate || ctx.sidebarRight.mounted.getSnapshot() !== sessionId ||
          candidate.seq <= acknowledged(sessionId)) return;
      try {
        ctx.sidebarRight.openResource('dsh-resource://browser-panel/' + encodeURIComponent(sessionId) + '/' + candidate.panel);
        handled.set(sessionId, candidate.seq);
        try { sessionStorage.setItem('dsh.browser-presented.v1:' + sessionId, String(candidate.seq)); } catch {}
      } catch { /* A Session store can still be adopting; its inventory update retries. */ }
    }
    function schedule() { if (!queued && !disposed) { queued = true; queueMicrotask(present); } }
    function update() {
      const snapshot = binding?.eventSource.getSnapshot();
      if (snapshot && snapshot.revision !== revision) {
        const first = revision < 0;
        revision = snapshot.revision;
        const reset = first || snapshot.change.kind === 'replace';
        if (reset) { calls.clear(); candidate = undefined; }
        const entries = reset ? snapshot.entries : snapshot.change.kind === 'append' ? snapshot.change.entries : [];
        for (const entry of entries) {
          if (entry.type !== 'event') continue;
          const event = entry.event;
          if (event.type === 'tool/call' && event.data.name === 'mcp__browser__open') calls.add(event.data.callId);
          if (event.type !== 'tool/result' || !calls.delete(event.data.message?.toolCallId)) continue;
          const panel = resultPanel(event.data.message);
          if (panel && Number.isSafeInteger(event.seq) && (!candidate || event.seq > candidate.seq)) candidate = { panel, seq: event.seq };
        }
      }
      schedule();
    }
    function bind() {
      const next = ctx.sessions.binding(ctx.sidebarRight.mounted.getSnapshot());
      if (next !== binding) {
        unsubscribe?.(); binding = next; revision = -1; candidate = undefined; calls.clear();
        unsubscribe = binding?.eventSource.subscribe(update);
      }
      update();
    }
    const stops = [ctx.sidebarRight.mounted.subscribe(bind), ctx.sidebarRight.openTabs.subscribe(bind), ctx.sessions.list.subscribe(bind)];
    bind();
    return () => { disposed = true; unsubscribe?.(); for (const stop of stops) stop(); };
  }
  function BrowserIcon() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
      h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z' }));
  }
  function BrowserBody({ useTabInfo, sessionId }) {
    const { tab } = useTabInfo();
    const managed = tab.kind === agentKind;
    const panel = managed ? agentPanel(tab.contentId, sessionId) : tab.id;
    const frame = React.useRef();
    const latest = React.useRef();
    const legacyNavigation = React.useRef();
    const legacyFrameRecovery = React.useRef();
    const deliveredVisibility = React.useRef();
    latest.current = tab;
    function syncVisibility() {
      const target = frame.current?.contentWindow;
      const document = frame.current?.contentDocument;
      const visible = latest.current.visible;
      if (!target || (deliveredVisibility.current?.document === document && deliveredVisibility.current.visible === visible)) return;
      deliveredVisibility.current = { document, visible };
      target.postMessage({ type: 'dsh-browser-visibility', visible }, location.origin);
    }
    function syncFrame() {
      const current = latest.current;
      const target = frame.current?.contentWindow;
      const document = frame.current?.contentDocument;
      // Client HMR may precede a Host restart. Protect AI-owned pages while an
      // older panel document still releases its owner on every pagehide.
      if (managed && target && document && !document.documentElement.hasAttribute('data-dsh-browser-managed') &&
          !document.documentElement.hasAttribute('data-dsh-browser-managed-compat')) {
        document.documentElement.setAttribute('data-dsh-browser-managed-compat', '');
        const originalFetch = target.fetch.bind(target);
        target.fetch = (input, options) => {
          if (input === '/desktop-browser/manage' && typeof options?.body === 'string' && options.body.includes('"release"')) {
            try {
              const request = JSON.parse(options.body);
              if (request.payload?.panel === panel && request.payload.method === 'release') {
                request.payload.method = 'pause';
                options = { ...options, body: JSON.stringify(request) };
              }
            } catch {}
          }
          return originalFetch(input, options);
        };
      }
      syncVisibility();
      if (managed) return;
      const url = current.navigation?.params?.url;
      if (typeof url === 'string') {
        const revision = current.navigation.revision;
        target?.postMessage({ type: 'dsh-browser-navigate', url, revision }, location.origin);
        // Client HMR can precede the host's next restart. Older panel documents
        // already have a validated navigation form; keep that instance usable.
        const document = frame.current?.contentDocument;
        const form = document?.getElementById('toolbar');
        const address = document?.getElementById('address');
        if (document?.readyState === 'complete' && !document.documentElement.hasAttribute('data-dsh-browser-navigation') && form && address &&
          (legacyNavigation.current?.document !== document || legacyNavigation.current.revision !== revision)) {
          legacyNavigation.current = { document, revision };
          address.value = url;
          form.requestSubmit();
          clearTimeout(legacyFrameRecovery.current);
          legacyFrameRecovery.current = setTimeout(async () => {
            // Older pages can discard their first cached frame during resize.
            // Once layout settles, restart capture for this pane if still blank.
            if (frame.current?.contentDocument !== document || !latest.current.visible ||
              document.getElementById('screen')?.hasAttribute('src') || !document.getElementById('tabs')?.children.length) return;
            const manage = async (method, payload = {}) => {
              const response = await fetch('/desktop-browser/manage', { method: 'POST', credentials: 'same-origin', signal: current.signal,
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(),
                  method: 'manage', payload: { panel: current.id, method, payload } }) });
              return (await response.json()).result?.value;
            };
            try {
              const state = await manage('status');
              if (!state?.active || !latest.current.visible || frame.current?.contentDocument !== document) return;
              await manage('pause', { id: state.active });
              if (latest.current.visible && frame.current?.contentDocument === document) await manage('resume', { id: state.active });
            } catch {}
          }, 600);
        }
      }
    }
    React.useEffect(() => {
      const ready = event => {
        if (event.source === frame.current?.contentWindow && event.origin === location.origin && event.data?.type === 'dsh-browser-ready') syncFrame();
      };
      window.addEventListener('message', ready);
      return () => { window.removeEventListener('message', ready); clearTimeout(legacyFrameRecovery.current); };
    }, [tab.id]);
    React.useEffect(syncFrame, [tab.id, tab.navigation?.revision, tab.navigation?.params?.url]);
    React.useEffect(syncVisibility, [tab.visible]);
    React.useEffect(() => {
      if (managed) return;
      const close = () => fetch('/desktop-browser/manage', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { panel: tab.id, method: 'release' } }) }).catch(() => {});
      tab.signal.addEventListener('abort', close, { once: true });
      return () => tab.signal.removeEventListener('abort', close);
    }, [tab.id, tab.signal, managed]);
    if (!panel) return h('div', { role: 'alert' }, '该网页不属于当前会话，请重新打开。');
    return h('iframe', { ref: frame, title: managed ? 'AI 浏览器' : '浏览器', src: '/desktop-browser?panel=' + encodeURIComponent(panel) + (managed ? '&managed=1' : ''),
      onLoad: syncFrame,
      style: { width: '100%', height: '100%', minHeight: 240, border: 0, flex: 1, display: 'block' }, 'data-dsh-browser-panel': '' });
  }
  function BrowserTitle() { return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(BrowserIcon), '浏览器'); }
  function apply(ctx) {
    ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind, title: () => '浏览器', guide: [{
      id: 'website', order: 30, title: () => '浏览网站', description: () => '在侧边栏打开网站', icon: BrowserIcon,
    }] }));
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: agentId, kind: agentKind, title: () => 'AI 网页',
      patterns: ['dsh-resource://browser-panel/**'], canOpen: address => Boolean(agentPanel(address)), keepMounted: true }));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, BrowserBody)));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, BrowserTitle)));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: agentId }, BrowserBody)));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: agentId }, () => h('span', null, 'AI 网页'))));
    ctx.effect(() => watchAgentBrowser(ctx));
  }
  return { inject, apply };
} });
