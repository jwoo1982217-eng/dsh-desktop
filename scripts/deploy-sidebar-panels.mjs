// 侧边栏全局面板行：展开态不渲染，只在收起态图标列出现。
//
// 幂等：目标文件已含补丁则跳过；目标文件哈希既不是「原件」也不是「已打补丁」时中止，
//       避免覆盖并发修改（升级 DSH 后重新跑一次即可）。
// 原件备份与四件套产出在 build-delivery/sidebar-panels-20261107/。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = path.join(root, 'build-delivery/sidebar-panels-20261107');
const relative = '@deepseek-ai/dsh-client-ui-sidebar/lib/client.js';
const overlay = path.join(root, 'runtime/overlays', relative);
const live = path.join('/Applications/DSH.app/Contents/Resources/runtime/node_modules', relative);
const backup = path.join(artifact, 'client.js.live-before');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL = '0a0a32382391acee1a692cf7d2529a2669cc8cc23d4d83b446f6247c3c4562c4';
const PATCHED = 'e3bd950e17f19331a28fd54d1aec925fcec357379a702b7733334b75ada67698';
const FROM = '\t\t\t\t\tpanels.length > 0 && (0, react_jsx_runtime.jsxs)("nav", {';
const TO = '\t\t\t\t\t!wide && panels.length > 0 && (0, react_jsx_runtime.jsxs)("nav", {';

function patch(source, label) {
  const digest = sha(source);
  if (digest === PATCHED) { console.log(`${label}: 已打补丁，跳过`); return source; }
  if (digest !== ORIGINAL) throw new Error(`${label}: 哈希 ${digest} 既非原件也非已打补丁版本，中止`);
  const text = source.toString('utf8');
  if (text.split(FROM).length !== 2) throw new Error(`${label}: 锚点不唯一，中止`);
  const next = Buffer.from(text.replace(FROM, TO), 'utf8');
  console.log(`${label}: 已打补丁`);
  return next;
}

mkdirSync(artifact, { recursive: true });
if (!existsSync(live)) throw new Error(`找不到运行文件：${live}`);

// 1) 规范源码里的 overlay：先按原件生成备份，再打补丁
if (!existsSync(backup)) copyFileSync(live, backup);
const patched = patch(readFileSync(overlay), 'overlay');
writeFileSync(overlay, patched);

// 2) 实际运行文件
const liveBytes = readFileSync(live);
const applied = patch(liveBytes, 'live');
writeFileSync(live, applied);

// 3) 语法自检
execFileSync('/Applications/DSH.app/Contents/Resources/bin/node', ['--check', live], { stdio: 'pipe' });

const result = {
  overlay: { file: overlay, sha256: sha(readFileSync(overlay)) },
  live: { file: live, sha256: sha(readFileSync(live)) },
  backup: { file: backup, sha256: sha(readFileSync(backup)) },
  syntax: 'ok'
};
if (result.live.sha256 !== result.overlay.sha256) throw new Error('overlay 与运行文件不一致');
console.log(JSON.stringify(result, null, 2));
