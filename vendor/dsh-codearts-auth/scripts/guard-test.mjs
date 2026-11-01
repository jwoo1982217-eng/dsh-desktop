import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url'; import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';
import {validateCustomizationSource,inheritCustomizationContract} from '../lib/customization-guard.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const contract=JSON.parse(fs.readFileSync(path.join(root,'customization-contract.json'),'utf8'));const before=createHash('sha256').update(fs.readFileSync(path.join(root,'lib/account-rotation.js'))).digest('hex');const candidate=fs.mkdtempSync(path.join(root,'.guard-check-含空格-'));let checks=0;
try {
 assert.equal(validateCustomizationSource(root, {verifySources:true}).ok,true);checks++;
 for(const file of ['package.json','customization-contract.json',...Object.keys(contract.sourceFingerprints),...Object.keys(contract.runtimeFingerprints)]){const dest=path.join(candidate,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest)}
 assert.equal(inheritCustomizationContract(root,candidate).ok,true);checks++;
 fs.writeFileSync(path.join(candidate,'用户额外文件.txt'),'preserve');assert.equal(inheritCustomizationContract(root,candidate).ok,true);checks++;
 const critical=path.join(candidate,'lib/account-rotation.js');const saved=fs.readFileSync(critical);fs.appendFileSync(critical,'\n// unknown upstream replacement\n');assert.throws(()=>inheritCustomizationContract(root,candidate),/未经复核/);checks++;
 fs.writeFileSync(critical,saved);assert.equal(inheritCustomizationContract(root,candidate).ok,true);checks++;
 const missing={...contract,requiredProviders:contract.requiredProviders.filter(id=>id!=='codely')};fs.writeFileSync(path.join(candidate,'customization-contract.json'),JSON.stringify(missing));assert.throws(()=>inheritCustomizationContract(root,candidate),/丢失渠道 codely/);checks++;
 fs.writeFileSync(path.join(candidate,'customization-contract.json'),JSON.stringify(contract));fs.rmSync(path.join(candidate,'src/zcode-sources.ts'));assert.throws(()=>validateCustomizationSource(candidate, {verifySources:true}),/文件缺失/);checks++;
 assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'lib/account-rotation.js'))).digest('hex'),before);checks++;
 console.log(JSON.stringify({ok:true,checks,normal:true,extraFilesPreserved:true,unknownReplacementRejected:true,missingProviderRejected:true,missingSourceRejected:true,recovery:true,installedUnchanged:true}));
} finally {fs.rmSync(candidate,{recursive:true,force:true})}
