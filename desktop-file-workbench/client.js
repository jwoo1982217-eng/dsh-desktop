window.__ModuleLoader__.load({
  id: 'dsh-desktop-file-workbench',
  factory: require => {
    const { createElement: h } = require('react');
    function Page() {
      return h('iframe', {
        src: '/desktop-files', title: '文件',
        style: { width: '100%', height: '100%', minHeight: '70dvh', border: 0, display: 'block' },
        'data-dsh-settings-embed': '',
      });
    }
    function Icon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z' }));
    }
    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'desktop-files' }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'desktop-files', label: '文件', order: 16 }, Icon));
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'desktop-files', label: '文件', order: 32 }, Page));
    }
    return { inject: ['slots'], apply };
  },
});
