import Schema from '@deepseek-ai/schemastery';

export const name = 'legacy-subagent-tool-policy';
export const inject = ['tools'];
export const Config = Schema.object({deny: Schema.array(String).default([])});

/** 旧配置迁移后的子代理限制；单调 guard 同时覆盖普通工具和 PTC 调用。 */
export function apply(ctx, config) {
  const denied = new Set(config.deny);
  ctx.tools.guard(exec => exec.agent?.session?.header?.origin === 'subagent' && denied.has(exec.name)
    ? '旧版子代理工具限制：子代理不得调用 ' + exec.name
    : undefined);
}
