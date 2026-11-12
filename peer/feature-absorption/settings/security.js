(() => {
 if(window.__dshPhoneFeaturesFetch)return;const original=window.fetch.bind(window);let pending;
 const token=()=>pending??=original('/phone-features/csrf',{credentials:'same-origin',cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('增强功能需要重新认证');const value=await response.json();if(!/^[a-f0-9]{64}$/.test(value.token))throw Error('增强功能安全票据不可用');return value.token;}).catch(error=>{pending=undefined;throw error;});
 window.fetch=async(input,options={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href),method=String(options.method??(typeof input==='object'?input.method:undefined)??'GET').toUpperCase();if(url.origin===location.origin&&url.pathname.startsWith('/phone-features/')&&!['GET','HEAD','OPTIONS'].includes(method)){const headers=new Headers(options.headers??(typeof input==='object'?input.headers:undefined));headers.set('x-dsh-phone-features-csrf',await token());return original(input,{...options,headers,credentials:'same-origin'});}return original(input,options);};
 window.__dshPhoneFeaturesFetch={token};
})();
