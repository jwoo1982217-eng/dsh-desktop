import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=new URL('../',import.meta.url);
const require=createRequire(new URL('../vendor/dsh-codearts-auth/package.json',import.meta.url));
export async function buildInstructionBudget(){
 const base=new URL('runtime/overlays/@deepseek-ai/dsh-agent-instructions/',root);
 const result=await require('esbuild').transform(await fs.readFile(new URL('src/upstream-render.ts',base),'utf8'),{loader:'ts',format:'esm',target:'es2022'});
 await fs.writeFile(new URL('lib/instruction-render.mjs',base),result.code);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await buildInstructionBudget();
