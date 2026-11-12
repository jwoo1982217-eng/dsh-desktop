export const name = 'dsh-desktop-core-compatibility';
export const inject = ['connection', 'webServer'];

/** Existing sidebar 0.26 only reads this old service's trusted-host list. */
export function apply(ctx) {
  if (!ctx.get('webRuntime')) ctx.provide('webRuntime', {
    get trustedHosts() { return ctx.connection.trustedHosts; },
  });
}
