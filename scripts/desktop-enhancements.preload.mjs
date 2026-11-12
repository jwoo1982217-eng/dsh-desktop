// Real-core integration: redirect only candidate overlays; reuse all installed dependencies.
import './desktop-test-imports.mjs';
import {registerHooks,createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../desktop-runtime/package.json',import.meta.url)),replacements=new Map();
for(const name of ['dsh-compaction-basic','dsh-agent-instructions'])replacements.set(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href,new URL('../runtime/overlays/@deepseek-ai/'+name+'/lib/index.js',import.meta.url).href);
registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context),target=replacements.get(resolved.url);return target?{...resolved,url:target}:resolved;}});
