/** Bound GUI catalog reads per provider; inference and selection validation stay with the SDK. */
export class BoundedModelCatalog {
  constructor({providers, load, selection, deadlineMs=2500, ttlMs=10000, now=Date.now}) {
    Object.assign(this,{providers,load,selection,deadlineMs,ttlMs,now});
    this.entries=new Map();this.generation=0;this.closed=false;
  }
  invalidate() { this.generation++;this.entries.clear(); }
  close() { this.closed=true;this.invalidate(); }
  status() {
    return [...this.entries].filter(([,entry])=>entry.pending).map(([provider,entry])=>({provider,waitingMs:this.now()-entry.startedAt}));
  }
  async read() {
    if(this.closed)return {default:{...this.selection()},routableProviders:[],groups:[],failures:[]};
    const providers=this.providers(), selected={...this.selection()};
    const rows=await Promise.all(providers.map(async provider=>{
      let entry=this.entries.get(provider.id);
      if(!entry || (!entry.pending && this.now()-entry.finishedAt>=this.ttlMs)){
        entry={startedAt:this.now(),pending:true,value:null};
        this.entries.set(provider.id,entry);
        entry.task=Promise.resolve().then(()=>this.load(provider,selected)).catch(()=>({groups:[],failures:[{id:provider.id,name:provider.name,message:'该来源模型列表读取失败，请稍后重试'}]})).then(value=>{
          entry.pending=false;entry.finishedAt=this.now();entry.value=value;
          return value;
        });
      }
      if(!entry.pending)return entry.value;
      let timer;
      try{
        return await Promise.race([entry.task,new Promise(resolve=>{
          timer=setTimeout(()=>resolve({groups:[],failures:[{id:provider.id,name:provider.name,message:'该来源模型列表响应较慢，其他来源已正常加载；稍后可重新加载'}]}),this.deadlineMs);
        })]);
      }finally{clearTimeout(timer);}
    }));
    const active=new Set(this.closed?[]:this.providers().map(provider=>provider.id));
    const groups=rows.flatMap(row=>row.groups??[]).filter(group=>active.has(group.id));
    return {default:selected,routableProviders:groups.map(group=>group.id),groups,failures:rows.flatMap(row=>row.failures??[]).filter(failure=>active.has(failure.id))};
  }
}
