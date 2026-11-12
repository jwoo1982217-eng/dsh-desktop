/** The local HTTP proxy was verified unreachable while direct/TUN HTTPS remained healthy. */
export async function bypassFailedLocalProxy({routeFor,install,env=process.env}) {
  const route=routeFor(new URL('https://api.apigoto.com/v1/models'));
  if(!route.proxied)return {applied:false,reason:'already-direct',restore:async()=>{}};
  const proxy=new URL(route.proxy);
  if(!['127.0.0.1','localhost','[::1]'].includes(proxy.hostname)||proxy.port!=='1082')return {applied:false,reason:'different-proxy',restore:async()=>{}};
  const restore=await install({get(name){
    const value=['no_proxy','NO_PROXY'].includes(name)?'*':env[name];
    return value===undefined?undefined:{value};
  }},()=>{});
  return {applied:true,reason:'verified-local-proxy-failure',restore};
}
