import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
/** Rebuildable, local-only index: excerpts remain literal source text. */
export class MemoryOrganizer{
  constructor(memory,home){this.memory=memory;this.file=path.join(home,'knowledge/workbench/derived.json');this.state={version:1,entries:{}};this.status={state:'idle',processed:0,method:'本地原文摘录与目录整理，无模型调用'};try{const v=JSON.parse(fs.readFileSync(this.file));if(v.version===1&&v.entries)this.state=v;}catch(e){if(e.code!=='ENOENT')this.status={...this.status,state:'failed',error:'整理索引损坏，可重新整理；原笔记未变'};}}
  entry(n){const e=this.state.entries[n.id];return e?.digest===n.digest?e:undefined;}
  schedule(){if(this.closed)return;clearTimeout(this.timer);this.timer=setTimeout(()=>void this.run(),1000);this.timer.unref?.();}
  async run(){if(this.running||this.closed)return this.status;this.running=true;this.status={state:'running',processed:0,method:'本地原文摘录与目录整理，无模型调用'};
    try{const kb=this.memory.services().kb,revision=kb.notes.state.revision;const notes=kb.notes.state.notes.filter(n=>!n.deletedAt),entries={};for(const n of notes){if(this.closed)return this.status;
      const lines=n.body.split('\n'),sections=[];let offset=0;for(let i=0;i<lines.length;i++){if(/^#{1,6}\s+/.test(lines[i])&&sections.length<40)sections.push({title:lines[i].replace(/^#+\s+/,''),line:i+1,offset});offset+=lines[i].length+1;}
      entries[n.id]=this.entry(n)||{digest:n.digest,revision:n.revision,excerpt:n.body.slice(0,500),sections,sourceKind:'literal-excerpt'};this.status.processed++;if(this.status.processed%20===0)await new Promise(r=>setImmediate(r));
    }
    // Original state may have advanced while yielding. Old entries are ignored by digest until next pass.
    const next={version:1,updatedAt:new Date().toISOString(),entries},tmp=this.file+'.'+randomUUID();fs.mkdirSync(path.dirname(this.file),{recursive:true});try{fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);}finally{fs.rmSync(tmp,{force:true});}this.state=next;this.status={...this.status,state:'done',updatedAt:next.updatedAt};if(kb.notes.state.revision!==revision)this.schedule();
    }catch(e){this.status={...this.status,state:'failed',error:'本地整理未完成，可重试；原笔记仍可查找'};}finally{this.running=false;}return this.status;
  }
  close(){this.closed=true;clearTimeout(this.timer);}
}
