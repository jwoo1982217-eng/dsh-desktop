import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {performDesktopUpdate} from '../runtime/pocket-update/adapter.mjs';

const report=path.resolve(process.argv[2]??'build-delivery/pocket-update-verification');await mkdir(report,{recursive:true,mode:0o700});
const home=await mkdtemp(path.join(os.tmpdir(),'Pocket 实际升级 '));
const profile=path.join(home,'profiles/web'),target=path.join(profile,'node_modules/dsh-pocket');
await mkdir(path.dirname(target),{recursive:true});
await cp(path.resolve('desktop-runtime/node_modules/dsh-pocket'),target,{recursive:true});
await symlink(path.resolve('desktop-runtime/node_modules'),path.join(target,'node_modules'),'dir');
const original=JSON.stringify({private:true,dependencies:{'dsh-pocket':'file:/previous',unrelated:'file:/keep'},dsh:{profile:{bundles:['dsh-pocket','unrelated']}}});
await writeFile(path.join(profile,'package.json'),original);
const result=await performDesktopUpdate({home,profile:'web',packageDirectory:target,coreEntry:path.resolve('desktop-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')});
const current=JSON.parse(await readFile(path.join(target,'package.json')));
const p=JSON.parse(await readFile(path.join(profile,'package.json')));
const receipt={home,result,version:current.version,unrelatedPreserved:p.dependencies.unrelated==='file:/keep',hostRestarted:false};
await writeFile(path.join(report,'real-install.json'),JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify(receipt));
assert.equal(result.ok,true,result.error);assert.equal(current.version,'2.12.0');assert.equal(receipt.unrelatedPreserved,true);assert.equal(result.autoRestart,false);
