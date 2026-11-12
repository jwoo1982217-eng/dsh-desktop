const send=(res,status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
export function createHttp(connection,service,assets){
  return (req,res)=>{
    try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))return send(res,403,{ok:false,error:'仅限电脑本机'});
      const origin=new URL('http://'+req.headers.host);
      if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)return send(res,403,{ok:false,error:'请求来源无效'});
      const rejection=connection.requestRejection(req);
      if(rejection)return send(res,rejection===401?401:403,{ok:false,error:'请从已登录的 DSH 打开星图'});
      if((req.headers.origin&&req.headers.origin!==origin.origin)||(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])))return send(res,403,{ok:false,error:'请求来源无效'});
      if(req.method!=='GET')return send(res,405,{ok:false,error:'仅支持读取'});
      const url=new URL(req.url,origin);if(url.origin!==origin.origin)return send(res,403,{ok:false,error:'请求来源无效'});
      const asset=assets.get(url.pathname);if(asset)return send(res,200,asset.bytes,asset.type+'; charset=utf-8');
      if(url.pathname==='/meow-constellation/api/workspaces'){
        const all=service.page({includeAll:true});
        return send(res,200,{ok:true,current:'__all__',workspaces:[{path:'knowledge',name:'知识库',activeTotal:all.items.filter(n=>n.source==='知识库').length},{path:'summary',name:'记忆摘要',activeTotal:all.items.filter(n=>n.source==='记忆摘要').length}]});
      }
      if(url.pathname==='/meow-constellation/api/search'){
        const scope={__all__:'all',knowledge:'notes',summary:'summary'}[url.searchParams.get('scope')||'__all__'];if(!scope)throw Object.assign(Error('来源无效'),{status:400});
        return service.recall(url.searchParams.get('q'),{scope,limit:12,byteBudget:20000}).then(data=>send(res,200,{ok:true,...data}),e=>send(res,e.status||503,{ok:false,error:e.message}));
      }
      if(url.pathname==='/meow-constellation/api/memories'){
        const data=service.page({includeAll:url.searchParams.get('all')==='1',scope:url.searchParams.get('dir')||'__all__'});
        return send(res,200,url.searchParams.get('since')===data.mtime?{ok:true,unchanged:true,mtime:data.mtime}:data);
      }
      if(url.pathname==='/meow-constellation/api/read')return send(res,200,{ok:true,item:service.read(url.searchParams.get('id'),{offset:Number(url.searchParams.get('offset')||0)})});
      return send(res,404,{ok:false,error:'入口不存在'});
    }catch(e){return send(res,e.status||503,{ok:false,error:e.status?e.message:'知识库暂不可用，请稍后重试'});}
  };
}
