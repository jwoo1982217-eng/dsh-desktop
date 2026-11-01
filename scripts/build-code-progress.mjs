import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const {transform}=createRequire(path.join(root,'vendor/dsh-codearts-auth/package.json'))('esbuild');
export function withoutCodeProgress(source){
 return source.replace(/\/\/ DSH CODE PROGRESS BEGIN[\s\S]*?\/\/ DSH CODE PROGRESS END\n/g,'').replaceAll('}, DshProgressBashRow))','}, BashRow))').replaceAll('}, DshProgressFileRow);','}, FileMutationRow);');
}
export async function buildCodeProgress(){
 const runtime=path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-client-ui-tool');
 if(JSON.parse(await readFile(path.join(runtime,'package.json'))).version!=='0.2.1-alpha.4')throw Error('代码过程展示需要固定 alpha.4 前端');
 let original=await readFile(path.join(runtime,'lib/client.js'),'utf8');
 original=withoutCodeProgress(original);
 if(original.split('}, BashRow))').length!==2||original.split('}, FileMutationRow);').length!==3)throw Error('工具组件边界已改变，保留原版');
 const source=await readFile(path.join(root,'runtime/client-src/code-progress.jsx'),'utf8'),css=await readFile(path.join(root,'runtime/client-src/code-progress.css'),'utf8');
 const compiled=await transform(source,{loader:'jsx',jsxFactory:'react.createElement',jsxFragment:'react.Fragment',target:'es2022'});
 const injection=`// DSH CODE PROGRESS BEGIN\n${compiled.code}\nconst dshProgressStyle=document.createElement('style');dshProgressStyle.dataset.pluginCss='dsh-code-progress';dshProgressStyle.textContent=${JSON.stringify(css)};document.head.querySelector('style[data-plugin-css="dsh-code-progress"]')?.remove();document.head.appendChild(dshProgressStyle);\n// DSH CODE PROGRESS END\n`;
 original=original.replace('//#region lib/types/client/apply.js',injection+'//#region lib/types/client/apply.js').replaceAll('}, BashRow))','}, DshProgressBashRow))').replaceAll('}, FileMutationRow);','}, DshProgressFileRow);');
 const target=path.join(root,'runtime/overlays/@deepseek-ai/dsh-client-ui-tool/lib/client.js');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,original);return target;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await buildCodeProgress();console.log('Built live code progress overlay');}
