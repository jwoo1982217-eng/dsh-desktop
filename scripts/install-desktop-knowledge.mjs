import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
export function installDesktopKnowledge(profile,modules){
 const target=path.join(profile,'node_modules/dsh-local-knowledge'),staged=target+'.new-'+randomUUID();
 fs.mkdirSync(staged,{recursive:true,mode:0o700});
 fs.cpSync(path.join(root,'peer/knowledge-link'),path.join(staged,'knowledge-link'),{recursive:true});
 for(const name of ['protocol.mjs','relay.mjs','tunnel.mjs'])fs.copyFileSync(path.join(root,'peer',name),path.join(staged,name));
 fs.mkdirSync(path.join(staged,'memory-isolation'));fs.copyFileSync(path.join(root,'peer/memory-isolation/isolation.mjs'),path.join(staged,'memory-isolation/isolation.mjs'));
 const manifest={name:'dsh-local-knowledge',version:'0.1.0',type:'module',main:'knowledge-link/index.mjs',exports:{'.':'./knowledge-link/index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'},client:{inject:['@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-settings'],platform:'web'}}};
 fs.writeFileSync(path.join(staged,'package.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(staged,'cordis.patch.yml'),'- insert:\n    - id: dsh-local-knowledge\n      name: dsh-local-knowledge\n');
 const source=`window.__ModuleLoader__.load({id:'dsh-local-knowledge',factory:()=>{const inject=['slots'];function apply(ctx){for(const[id,label,src,order]of[['kb-memory','查记忆','/knowledge-link#memory',29],['knowledge-transfer','技能与经验传递','/knowledge-link#transfer',30]])ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id,label,order},()=>({$$typeof:Symbol.for('react.element'),type:'iframe',key:null,ref:null,_owner:null,props:{title:label,src,style:{width:'100%',height:'min(72dvh,760px)',minHeight:320,border:0}}})));}return{inject,apply};}});`;
 fs.writeFileSync(path.join(staged,'client.js'),source);
 for(const name of ['ws','yaml','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-credentials','@deepseek-ai/dsh-llm']){const link=path.join(staged,'node_modules',name);fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(path.join(modules,name),link);}
 const backup=target+'.old-'+randomUUID();let old=false;try{if(fs.existsSync(target)){fs.renameSync(target,backup);old=true;}fs.renameSync(staged,target);
 const file=path.join(profile,'package.json'),original=fs.readFileSync(file,'utf8'),p=JSON.parse(original);p.dependencies={...p.dependencies,'dsh-local-knowledge':'file:./node_modules/dsh-local-knowledge'};if(!p.dsh.profile.bundles.includes('dsh-local-knowledge'))p.dsh.profile.bundles.push('dsh-local-knowledge');if(fs.readFileSync(file,'utf8')!==original)throw Error('Profile 在安装时变化');fs.writeFileSync(file+'.knowledge-new',JSON.stringify(p,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.knowledge-new',file);if(old)fs.rmSync(backup,{recursive:true,force:true});return {target};
 }catch(e){fs.rmSync(staged,{recursive:true,force:true});fs.rmSync(target,{recursive:true,force:true});if(old)fs.renameSync(backup,target);throw e;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){console.log(JSON.stringify(installDesktopKnowledge(path.resolve(process.argv[2]),path.resolve(process.argv[3]))));}
