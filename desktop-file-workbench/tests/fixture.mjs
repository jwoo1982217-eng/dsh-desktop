import { tmpdir as __publicTmpdir } from 'node:os';
import path from 'node:path';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {Context} from '@deepseek-ai/cordis';
import {LocalFileSystem} from '@deepseek-ai/dsh-fs-local';
import {FileWorkbench} from '../files.mjs';

const artifacts = (__publicTmpdir() + '/dsh-desktop-file-workbench-20261106/generated/backend-checks');
export async function fixture(t, options = {}) {
  await mkdir(artifacts, {recursive: true});
  const directory = await mkdtemp(path.join(artifacts, 'fixture-'));
  const home = path.join(directory, 'dsh-home'), workspace = path.join(directory, 'project'), shared = path.join(directory, 'shared');
  await Promise.all([home, workspace, shared].map(value => mkdir(value)));
  const entities = new Map([['project', {id: 'project', title: '真实项目', path: workspace}]]);
  const workspaceRegistry = {list: () => [...entities.values()], get: id => entities.get(id)};
  const fsProvider = new LocalFileSystem(new Context(), {cwd: home, diffBasisMaxBytes: 2 * 1024 * 1024});
  const service = new FileWorkbench({home, workspaceRegistry, fsProvider, ...options});
  t.after(async () => { await service.close(); await rm(directory, {recursive: true, force: true}); });
  const {roots} = await service.manage('roots.list');
  const root = roots.find(value => value.kind === 'workspace');
  const internal = roots.find(value => value.kind === 'internal');
  const payload = (file = '', extra = {}) => ({rootId: root.id, generation: root.generation, path: file, ...extra});
  return {directory, home, workspace, shared, entities, workspaceRegistry, fsProvider, service, root, internal, payload};
}

export async function addShared(service, shared, mode = 'read-only') {
  const plan = await service.manage('roots.planAdd', {path: shared, label: '共享测试', mode});
  const {root} = await service.manage('roots.add', {planId: plan.planId, confirm: true});
  return root;
}

export const code = (expected, status) => error => error.code === `files/${expected}` && error.expose === true && (!status || error.status === status) && !error.message.includes('/Users/');
