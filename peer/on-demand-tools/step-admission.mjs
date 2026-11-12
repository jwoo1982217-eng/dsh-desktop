import {symbols} from '@deepseek-ai/cordis';

/** The newer SDK owns tool declarations and PTC bindings through the step's admitted set. */
export function installStepAdmission(ctx, visible) {
  // Cordis returns a fresh traceable function proxy on every service read.
  // Keep the owning descriptor, rather than comparing those transient proxies.
  const tools = ctx.tools[symbols.original] ?? ctx.tools;
  const descriptor = Object.getOwnPropertyDescriptor(tools, 'resolve');
  const original = tools.resolve;
  if (typeof original !== 'function') throw Error('当前核心不支持按需工具接口');
  async function resolve(context) {
    const admitted = await original.call(this, context);
    try {
      const names = new Set(visible(context.agent, [...admitted.view(context.agent).values()]).map(tool => tool.name));
      return {
        dispose: () => admitted.dispose(),
        view: scope => new Map([...admitted.view(scope)].filter(([name]) => names.has(name))),
      };
    } catch (error) { admitted.dispose(); throw error; }
  }
  Object.defineProperty(tools, 'resolve', {value: resolve, writable: true, configurable: true});
  ctx.effect(() => () => {
    if (tools.resolve !== resolve) return;
    if (descriptor) Object.defineProperty(tools, 'resolve', descriptor);
    else delete tools.resolve;
  }, 'on-demand step admission');
}
