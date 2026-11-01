import ts from 'typescript'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath,pathToFileURL} from 'node:url'; import {createRequire, registerHooks} from 'node:module';
const root = process.env.DSH_SMOKE_PACKAGE_DIR ? path.resolve(process.env.DSH_SMOKE_PACKAGE_DIR) : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sdk = process.env.DSH_SMOKE_SDK_NODE_MODULES;
const hooks = sdk ? registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@deepseek-ai/')){const req=createRequire(path.join(path.resolve(sdk),'__jethub_smoke__.cjs'));return {url:new URL('file://'+req.resolve(specifier)).href,shortCircuit:true}} return next(specifier,context)}}) : undefined;
try {
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const exportFiles=[pkg.main,pkg.types];const collect=value=>{if(typeof value==='string'&&!value.includes('*'))exportFiles.push(value);else if(value&&typeof value==='object')Object.values(value).forEach(collect)};collect(pkg.exports);for(const file of exportFiles)if(file&&!fs.existsSync(path.resolve(root,file)))throw Error('missing package export: '+file);
 const imported=await import(pathToFileURL(path.join(root,'lib/index.js')).href);
 if(typeof imported.apply!=='function'||typeof imported.Config?.toJSON!=='function') throw Error('JetHub runtime exports incomplete');
 let checked=0;
 const visit=dir=>{for(const row of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,row.name);if(row.isDirectory())visit(file);else if(row.name.endsWith('.js')){const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS); const walk=node=>{let spec;if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))spec=node.moduleSpecifier;else if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)spec=node.arguments[0];if(spec&&ts.isStringLiteralLike(spec)&&spec.text.startsWith('.')){const target=path.resolve(path.dirname(file),spec.text);if(!fs.existsSync(target))throw Error('missing relative import: '+path.relative(root,target));checked++}ts.forEachChild(node,walk)};walk(source)}}};
 visit(path.join(root,'lib'));
 if(!fs.existsSync(path.join(root,'lib/qoder-auth-wasm.wasm')))throw Error('missing qoder WASM');
 console.log(JSON.stringify({ok:true,package:pkg.name,upstreamCommit:pkg.dshLocalIntegration.upstreamCommit,sdk:sdk??'build cache',relativeImports:checked,modelRequests:0,accountWrites:0}));
} finally {hooks?.deregister()}
