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
    React.useEffect(() => {
      frame.current?.contentWindow?.postMessage({ type: 'dsh-browser-visibility', visible: tab.visible }, location.origin);
    }, [tab.visible]);
    React.useEffect(() => {
      const close = () => fetch('/desktop-browser/manage', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { panel: tab.id, method: 'release' } }) }).catch(() => {});
      tab.signal.addEventListener('abort', close, { once: true });
      return () => tab.signal.removeEventListener('abort', close);
    }, [tab.id, tab.signal]);
    return h('iframe', { ref: frame, title: '浏览器', src: '/desktop-browser?panel=' + encodeURIComponent(tab.id),
      onLoad: () => frame.current?.contentWindow?.postMessage({ type: 'dsh-browser-visibility', visible: tab.visible }, location.origin),
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
