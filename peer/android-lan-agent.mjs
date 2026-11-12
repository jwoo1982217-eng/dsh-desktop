import http from 'node:http';
import {Socket,isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {closeSync} from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const number=ip=>ip.split('.').reduce((value,part)=>(value*256+Number(part))>>>0,0);
export function wifiInterface(host,interfaces) {
  if(isIP(host)!==4||host.startsWith('127.'))return;
  const [a,b]=host.split('.').map(Number);
  if(!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168||a===169&&b===254))return;
  for(const [name,addresses]of Object.entries(interfaces)){
    if(!/^(?:wlan|wifi)\d+$/.test(name))continue;
    for(const row of addresses){
      if(row.internal||isIP(row.address)!==4||isIP(row.netmask)!==4)continue;
      const mask=number(row.netmask);
      if(mask!==0&&((number(row.address)&mask)>>>0)===((number(host)&mask)>>>0))return name;
    }
  }
}

/** Only a peer's literal IPv4 address on the current Wi-Fi subnet can use this agent. */
export function createPhysicalLanAgent(url,{platform=process.platform,arch=process.arch,interfaces=networkInterfaces,
  loadAddon=()=>require('./android-network/wifi-socket-arm64.node'),socket=options=>new Socket(options),close=closeSync}={}){
  if(platform!=='android'||arch!=='arm64'||url.protocol!=='http:')return null;
  const name=wifiInterface(url.hostname,interfaces());if(!name)return null;
  let addon;
  try{addon=loadAddon();if(typeof addon.openWifiSocket!=='function')return null;}catch{return null;}
  const agent=new http.Agent({proxyEnv:{},keepAlive:false});
  agent.physicalInterface=name;
  agent.createConnection=(options,callback)=>{
    let fd,owned;
    try{
      // An Agent is tied to this one carrier endpoint; never reuse it for another destination.
      if(options.host!==url.hostname||Number(options.port)!==Number(url.port||80))throw Error('LAN socket target changed');
      fd=addon.openWifiSocket(name);owned=socket({fd});fd=undefined;
      owned.connect({host:url.hostname,port:Number(url.port||80),family:4});return owned;
    }catch(error){
      if(fd!==undefined)close(fd);owned?.destroy();
      queueMicrotask(()=>callback(error));return undefined;
    }
  };
  return agent;
}
