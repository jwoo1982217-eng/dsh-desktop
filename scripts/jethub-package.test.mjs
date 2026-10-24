import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateJetHubManifest, isJetHubPackage, JETHUB_PACKAGE, JETHUB_LEGACY_PACKAGE } from './jethub-package.mjs';

test('改名保持用户其它依赖/插件/配置，旧别名不得重复激活账号池', () => {
  const original = { dependencies: { [JETHUB_LEGACY_PACKAGE]: 'file:/old', owned: 'file:/owned' }, dsh: { profile: { bundles: ['before', JETHUB_LEGACY_PACKAGE, 'after', JETHUB_PACKAGE], owned: { value: 7 } } }, custom: ['keep'] };
  const before = JSON.stringify(original);
  const next = migrateJetHubManifest(original, '/offline/node_modules');
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(next.dsh.profile.bundles, ['before', JETHUB_PACKAGE, 'after']);
  assert.equal(next.dependencies.owned, original.dependencies.owned);
  assert.equal(next.dependencies[JETHUB_PACKAGE], 'file:/offline/node_modules/dsh-providers-hub');
  assert.equal(Object.hasOwn(next.dependencies, JETHUB_LEGACY_PACKAGE), false);
  assert.deepEqual(next.dsh.profile.owned, original.dsh.profile.owned);
  assert.deepEqual(next.custom, original.custom);
  assert.deepEqual(migrateJetHubManifest(next, '/offline/node_modules'), next);
});

test('缺失旧引用可新增；相似名字不是别名；损坏配置拒收且原件不变', () => {
  const input = { dsh: { profile: { bundles: ['my-dsh-codearts-auth'] } } };
  assert.deepEqual(migrateJetHubManifest(input, '/modules').dsh.profile.bundles, ['my-dsh-codearts-auth', JETHUB_PACKAGE]);
  assert.equal(isJetHubPackage('my-dsh-codearts-auth'), false);
  const invalid = { dsh: { profile: { bundles: 'wrong' } } }; const before = JSON.stringify(invalid);
  assert.throws(() => migrateJetHubManifest(invalid, '/modules'), /未生成迁移/);
  assert.equal(JSON.stringify(invalid), before);
});
