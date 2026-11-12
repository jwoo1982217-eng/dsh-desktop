import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm} from 'node:fs/promises';
import path from 'node:path';

export const coreRepository = 'deepseek-ai/deepseek-harness';
export const desktopRepository = 'jwoo1982217-eng/dsh-desktop';
export const maxInstallerBytes = 1024 ** 3;

function version(value) {
  const match = /^(?:dsh-)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw Error('更新版本格式无效');
  return {numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? []};
}
export function compareVersions(left, right) {
  const a = version(left), b = version(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i]);
    if (numericA && numericB) return Math.sign(Number(a.pre[i]) - Number(b.pre[i]));
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}
export async function readReleases(repository, {fetcher = fetch, signal} = {}) {
  if (![coreRepository, desktopRepository].includes(repository)) throw Error('更新来源无效');
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=10`, {
    headers: {accept: 'application/vnd.github+json', 'user-agent': 'DSH-Desktop-Update'},
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw Error(`无法检查更新（HTTP ${response.status}），请稍后重试`);
  const data = await readBounded(response, 1024 ** 2);
  let rows;
  try { rows = JSON.parse(data.toString('utf8')); } catch { throw Error('更新服务返回了无效内容'); }
  if (!Array.isArray(rows)) throw Error('更新清单无效');
  return rows.filter(row => {
    try {
      version(row.tag_name);
      return !row.draft && row.html_url === `https://github.com/${repository}/releases/tag/${row.tag_name}`;
    } catch { return false; }
  }).sort((a, b) => compareVersions(b.tag_name, a.tag_name));
}
async function readBounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw Error('更新内容超过大小限制');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw Error('更新内容超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function installerAsset(release, {platform = process.platform, arch = process.arch} = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) return null;
  return release?.assets?.find(asset => {
    const expected = `https://github.com/${desktopRepository}/releases/download/${release.tag_name}/`;
    return typeof asset.name === 'string' && new RegExp(`^DSH-[0-9A-Za-z.-]+-macOS-${arch}\\.pkg$`).test(asset.name) &&
      asset.browser_download_url === expected + asset.name &&
      /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') &&
      Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxInstallerBytes;
  }) ?? null;
}
export async function downloadInstaller(release, directory, {fetcher = fetch, signal, platform, arch} = {}) {
  const asset = installerAsset(release, {platform, arch});
  if (!asset) throw Error('没有经过校验的本机定制版安装包');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const temporary = path.join(directory, randomUUID() + '.part');
  const target = path.join(directory, asset.name);
  let handle;
  try {
    const response = await fetcher(asset.browser_download_url, {
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15 * 60 * 1000)]),
    });
    if (!response.ok || Number(response.headers.get('content-length')) > asset.size) throw Error('更新包下载失败');
    handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > asset.size) throw Error('更新包大小不符');
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (bytes !== asset.size || 'sha256:' + hash.digest('hex') !== asset.digest) throw Error('更新包校验失败，未安装');
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, target);
    return target;
  } finally { await handle?.close(); await rm(temporary, {force: true}); }
}
