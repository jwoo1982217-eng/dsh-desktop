import fs from 'node:fs/promises';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const root=new URL('../',import.meta.url),require=createRequire(new URL('../vendor/dsh-codearts-auth/package.json',import.meta.url));
export async function buildDesktopEnhancements(){
 const source=new URL('desktop-enhancements/client-src.jsx',root),output=new URL('desktop-enhancements/client.js',root);
 const result=await require('esbuild').transform(await fs.readFile(source,'utf8'),{loader:'jsx',format:'cjs',target:'es2022'});
 await fs.writeFile(output,`window.__ModuleLoader__.load({id:'dsh-desktop-enhancements',factory:(require)=>{\nconst module={exports:{}};const exports=module.exports;\n${result.code}\nreturn module.exports;}});\n`);
 return output;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await buildDesktopEnhancements();
