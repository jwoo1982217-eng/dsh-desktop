import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {buildModelCatalog} from '@deepseek-ai/dsh-api-session-controller';
import {createRetryHandoff} from './recovery.mjs';
import {BoundedModelCatalog} from './catalog.mjs';
import {installProxyFromEnvironment,proxyRouteFor} from '@deepseek-ai/dsh-http-proxy';
import {bypassFailedLocalProxy} from './network.mjs';

export const name = 'dsh-request-recovery';
export const inject = ['agents', 'connection', 'sessionController', 'llm', 'agentDefaultModel'];
export async function apply(ctx) {
  const network=await bypassFailedLocalProxy({routeFor:proxyRouteFor,install:installProxyFromEnvironment});
  const agents = ctx.agents;
  const recovery = createRetryHandoff({
    getAgent:id => agents.get(id),
    isRoot:agent => agents.roots().includes(agent),
    createMessage:createUserMessage,
  });
  ctx.on('session/event', (session, event) => recovery.observe(session, event));
  ctx.on('session/disposed', session => recovery.forget(session));
  for (const agent of agents.roots()) if (agent.status === 'running') recovery.seed(agent.session);
  const catalog = new BoundedModelCatalog({
    providers:()=>ctx.llm.listProviders(),
    selection:()=>ctx.agentDefaultModel.currentSelection(),
    load:(provider,selection)=>buildModelCatalog({llm:{
      listProviders:()=>[provider],
      listModels:id=>ctx.llm.listModels(id),
      resolveModelInfo:(id,model)=>ctx.llm.resolveModelInfo(id,model),
    }},selection),
  });
  const controller=ctx.sessionController, originalCatalog=controller.modelCatalog;
  const readCatalog=()=>catalog.read();
  controller.modelCatalog=readCatalog;
  ctx.on('llm/adapters-updated',()=>catalog.invalidate());
  ctx.connection.rpc.handle('/request-recovery', async (method) => {
    if (method !== 'status') throw Error('Unknown request-recovery method');
    return {ok:true, value:{...recovery.status(),pendingCatalog:catalog.status(),network:{applied:network.applied,reason:network.reason}}};
  });
  ctx.on('dispose', async () => {
    recovery.close();catalog.close();
    if(controller.modelCatalog===readCatalog)controller.modelCatalog=originalCatalog;
    await network.restore();
  });
}
