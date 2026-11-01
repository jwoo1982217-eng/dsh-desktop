import {dirname,resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {validateCustomizationSource}=await import('../lib/customization-guard.js');
console.log(JSON.stringify(validateCustomizationSource(root, {verifySources:process.argv.includes('--source')})));
