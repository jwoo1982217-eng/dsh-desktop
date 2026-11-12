import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {compareVersions, readReleases, installerAsset, downloadInstaller, desktopRepository, coreRepository} from './app/update-catalog.mjs';
import {createUpdateAction} from './app/updates.mjs';

const bytes = Buffer.from('verified local installer fixture');
function release(repository = desktopRepository, tag = 'v0.1.12') {
  const name = 'DSH-0.1.12-macOS-arm64.pkg';
  return {tag_name: tag, html_url: `https://github.com/${repository}/releases/tag/${tag}`, draft: false, assets: [{name, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`}]};
}
test('version order distinguishes numerical releases and prereleases', () => {
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.1-alpha.4'), 1);
  assert.equal(compareVersions('dsh-v0.2.2-rc.10', '0.2.2-rc.2'), 1);
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.10'), 1);
  assert.equal(compareVersions('0.2.2', '0.2.2'), 0);
  assert.equal(compareVersions('0.2.2-alpha.1', '0.2.2-alpha.1.1'), -1);
  assert.throws(() => compareVersions('0.2.2;open bad', '0.2.2'));
});
test('release reads are public, bounded, validate the origin, and sort by version', async () => {
  const fake = release(); const bad = {...release(desktopRepository, 'v9.9.9'), html_url: 'https://other.example/install'};
  const rows = await readReleases(desktopRepository, {fetcher: async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/${desktopRepository}/releases?per_page=10`);
    assert.equal(Object.hasOwn(options.headers, 'authorization'), false);
    return new Response(JSON.stringify([release(desktopRepository, 'v0.1.9'), fake, bad, {...fake, draft: true}]));
  }});
  assert.deepEqual(rows.map(x => x.tag_name), ['v0.1.12', 'v0.1.9']);
  await assert.rejects(readReleases('someone/unknown'), /来源/);
  await assert.rejects(readReleases(coreRepository, {fetcher: async () => new Response('[]', {status: 429})}), /HTTP 429/);
  await assert.rejects(readReleases(coreRepository, {fetcher: async () => new Response('x'.repeat(1024 ** 2 + 1))}), /大小/);
});
test('only matching custom packages with a published SHA-256 are installable', () => {
  assert.ok(installerAsset(release(), {platform: 'darwin', arch: 'arm64'}));
  assert.equal(installerAsset(release(coreRepository), {platform: 'darwin', arch: 'arm64'}), null);
  assert.equal(installerAsset(release(), {platform: 'darwin', arch: 'x64'}), null);
  const noHash = release(); delete noHash.assets[0].digest;
  assert.equal(installerAsset(noHash, {platform: 'darwin', arch: 'arm64'}), null);
  const traversal = release(); traversal.assets[0].name = '../DSH-0.1.12-macOS-arm64.pkg';
  assert.equal(installerAsset(traversal, {platform: 'darwin', arch: 'arm64'}), null);
});
test('actual download verifies bytes; a bad or partial update keeps the previous package and can retry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-update-check-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const target = path.join(directory, release().assets[0].name); await writeFile(target, 'old verified package');
  const options = {platform: 'darwin', arch: 'arm64'};
  await assert.rejects(downloadInstaller(release(), directory, {...options, fetcher: async () => new Response(Buffer.alloc(bytes.length, 0))}), /校验/);
  assert.equal(await readFile(target, 'utf8'), 'old verified package');
  assert.deepEqual(await readdir(directory), [path.basename(target)]);
  await assert.rejects(downloadInstaller(release(), directory, {...options, fetcher: async () => new Response(bytes.subarray(1))}), /校验/);
  const file = await downloadInstaller(release(), directory, {...options, fetcher: async () => new Response(bytes)});
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readdir(directory), [path.basename(target)]);
});
test('native action shows upstream versus custom availability, and only opens an installer after confirmation', async () => {
  const shown = [], opened = [], choices = [0, 0];
  const action = createUpdateAction({appVersion: '0.1.11', coreVersion: '0.2.1-alpha.4', cacheDirectory: '/fixture', getWindow: () => null,
    dialog: {showMessageBox: async options => {shown.push(options); return {response: choices.shift()};}},
    shell: {openPath: async file => {opened.push(file); return '';}, openExternal: async () => assert.fail('unexpected navigation')},
    releaseReader: async repository => repository === coreRepository ? [release(coreRepository, 'dsh-v0.2.2-rc.1')] : [release()],
    downloader: async () => '/fixture/verified.pkg'});
  await action(); assert.equal(shown[0].message, '有可安装的桌面更新');
  assert.match(shown[0].detail, /0.2.1-alpha.4/); assert.equal(shown[1].buttons[0], '下载');
  assert.deepEqual(opened, ['/fixture/verified.pkg']);
});
test('no adapted release never downloads the plain upstream package; errors allow retry', async () => {
  const shown = []; let failure = true, downloads = 0;
  const action = createUpdateAction({appVersion: '0.1.11', coreVersion: '0.2.1-alpha.4', cacheDirectory: '/fixture', getWindow: () => null,
    dialog: {showMessageBox: async options => {shown.push(options); return {response: options.cancelId ?? 0};}}, shell: {},
    releaseReader: async repository => {if (failure) throw Error('offline'); return repository === coreRepository ? [release(coreRepository, 'dsh-v0.2.2-rc.1')] : [];},
    downloader: async () => {downloads++;}});
  await action(); assert.equal(shown[0].message, '暂时无法完成更新');
  failure = false; await action(); assert.equal(shown[1].message, '官方核心有新版本');
  assert.match(shown[1].detail, /适配包/); assert.equal(downloads, 0);
});
