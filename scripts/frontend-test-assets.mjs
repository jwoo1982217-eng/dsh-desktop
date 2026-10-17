import {readFile} from 'node:fs/promises';
import path from 'node:path';

/** 从同版正式入口发现资源与共享模块，避免升级后仍引用旧 hash 文件。 */
export async function frontendTestAssets(dist) {
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  const entry = /<script[^>]+src="\.\/([^\"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw Error('正式前端缺少模块入口');
  const frontend = await readFile(path.join(dist, entry), 'utf8');
  const boot = /const [\w$]+=globalThis\.dshDesktopBoot/.exec(frontend);
  const shared = /function ([\w$]+)\(\)\{return\{react:/.exec(frontend);
  if (!boot || !shared) throw Error('当前正式前端共享模块边界变化，请检查测试适配');
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.\/([^\"]+)"/g)].map(m => m[1]);
  if (!styles.length) throw Error('正式前端缺少样式资源');
  return {
    sharedFrontend: frontend.slice(0, boot.index) + `window.__TEST_SHARED__=${shared[1]}();\n`,
    css: (await Promise.all(styles.map(file => readFile(path.join(dist, file), 'utf8')))).join('\n'),
  };
}
