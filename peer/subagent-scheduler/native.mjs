// 适配已验证的 alpha.1 旧接口和 alpha.4/rc.1 activation 接口，不修改 SDK。
// Model selection happens before creation; prepared LLM requests are immutable.
export function installNativeSelection(ctx,scheduler){
 const provided=ctx.get('subagents'),service=provided[Symbol.for('cordis.original')]??provided,restore=[];
 const starts=typeof service.startActivation==='function'?['startActivation']:['start','startContinuable'];
 try { for(const method of [...starts,'sendMessage']){
  const original=service[method],descriptor=Object.getOwnPropertyDescriptor(service,method);
  if(method==='sendMessage'&&typeof original!=='function')continue;
  if(typeof original!=='function')throw Error('当前SDK缺少原生子代理入口：'+method);
  const wrapped=function(...args){
   if(method==='sendMessage'){
    // 关闭后拒绝向子代理派发后续工作，仍允许已运行的子代理向父代理回报。
    const [sender,target]=args;if(!scheduler.config.delegationEnabled&&!(typeof target==='string'&&sender?.session?.header?.parentSession===target))scheduler.assertDelegation();
    return original.apply(this,args);
   }
   const request=method==='start'?args[1]:args[0]?.request;
   scheduler.assertDelegation();
   const policy=request?.parent?.session&&ctx.get('sessionProjections')?.stateOf(request.parent.session,'subagentModelSelectionPolicy');
   const route=request?.agentOptions;
   if(typeof route?.provider!=='string'||!route.provider.length||typeof route?.model!=='string'||!route.model.length)throw Error('子代理需要明确选择 provider 和 model，不能自动继承主对话的账号线路。');
   scheduler.assertRoute(route);
   if(Array.isArray(policy)&&!policy.some(p=>p.provider===route.provider&&p.model===route.model))throw Error('子模型线路不在本会话授权列表：'+route.provider+'/'+route.model);
   return original.apply(this,args);
  };
  if(!Reflect.defineProperty(service,method,{value:wrapped,writable:true,configurable:true}))throw Error('当前SDK不能安装子代理路由适配');
  restore.push(()=>{if(service[method]===wrapped){if(descriptor)Object.defineProperty(service,method,descriptor);else delete service[method];}});
 }} catch(error) {for(const fn of restore.reverse())fn();throw error;}
 return ()=>{for(const fn of restore.reverse())fn();};
}
