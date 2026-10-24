import path from 'node:path';

export const JETHUB_PACKAGE = 'dsh-providers-hub';
export const JETHUB_LEGACY_PACKAGE = 'dsh-codearts-auth';
export const JETHUB_NAMES = Object.freeze([JETHUB_PACKAGE, JETHUB_LEGACY_PACKAGE]);
export function isJetHubPackage(name) { return JETHUB_NAMES.includes(name); }

/** 仅迁移包名引用；账号、配置行 id、插件设置及其它依赖均保持不变。 */
export function migrateJetHubManifest(manifest, modules) {
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('缺少 dsh.profile.bundles，未生成迁移清单');
  const next = structuredClone(manifest);
  next.dependencies ??= {};
  delete next.dependencies[JETHUB_LEGACY_PACKAGE];
  next.dependencies[JETHUB_PACKAGE] = 'file:' + path.join(modules, JETHUB_PACKAGE);
  let seen = false;
  next.dsh.profile.bundles = next.dsh.profile.bundles.flatMap(name => {
    if (!isJetHubPackage(name)) return [name];
    if (seen) return [];
    seen = true;
    return [JETHUB_PACKAGE];
  });
  if (!seen) next.dsh.profile.bundles.push(JETHUB_PACKAGE);
  return next;
}
