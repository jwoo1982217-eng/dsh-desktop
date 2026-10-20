window.__ModuleLoader__.load({ id: 'dsh-desktop-browser', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const id = 'dsh-desktop-browser', kind = 'browser';
  const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
  function BrowserIcon() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
      h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z' }));
  }
  function BrowserBody({ useTabInfo }) {
    const { tab } = useTabInfo();
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
      syncVisibility();
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
      const close = () => fetch('/desktop-browser/manage', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { panel: tab.id, method: 'release' } }) }).catch(() => {});
      tab.signal.addEventListener('abort', close, { once: true });
      return () => tab.signal.removeEventListener('abort', close);
    }, [tab.id, tab.signal]);
    return h('iframe', { ref: frame, title: '浏览器', src: '/desktop-browser?panel=' + encodeURIComponent(tab.id),
      onLoad: syncFrame,
      style: { width: '100%', height: '100%', minHeight: 240, border: 0, flex: 1, display: 'block' }, 'data-dsh-browser-panel': '' });
  }
  function BrowserTitle() { return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(BrowserIcon), '浏览器'); }
  function apply(ctx) {
    ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind, title: () => '浏览器', guide: [{
      id: 'website', order: 30, title: () => '浏览网站', description: () => '在侧边栏打开网站', icon: BrowserIcon,
    }] }));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, BrowserBody)));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, BrowserTitle)));
  }
  return { inject, apply };
} });
