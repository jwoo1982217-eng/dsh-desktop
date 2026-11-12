import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Backend} from './backend.mjs';

const fail=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
export function parseDaemonArgs(argv){
 const values={};for(let i=0;i<argv.length;i+=2){const flag=argv[i];fail(['--home','--runtime','--node','--port'].includes(flag)&&!Object.hasOwn(values,flag)&&typeof argv[i+1]==='string'&&!argv[i+1].startsWith('--'),'DAEMON_ARGUMENT_INVALID');values[flag]=argv[i+1];}
 for(const flag of ['--home','--runtime','--node'])fail(values[flag]&&path.isAbsolute(values[flag])&&!/[\0\r\n]/.test(values[flag]),'DAEMON_PATH_INVALID');
 const port=values['--port']===undefined?3080:Number(values['--port']);fail(Number.isSafeInteger(port)&&port>0&&port<=65535&&String(port)===(values['--port']??'3080'),'DAEMON_PORT_INVALID');
 return {home:path.resolve(values['--home']),runtime:path.resolve(values['--runtime']),node:path.resolve(values['--node']),port};
}
function pidExists(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}

/** Same Backend/state file as the GUI; no windows, model calls, new launchd policy or URL logging. */
export function createDesktopDaemon(options,{backendFactory=value=>new Backend(value),pidAlive=pidExists,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=timer=>clearTimeout(timer),checkEveryMs=30000}={}){
 fail(Number.isSafeInteger(checkEveryMs)&&checkEveryMs>0&&checkEveryMs<=60000,'DAEMON_CHECK_INTERVAL_INVALID');
 // Never forward the backend's launch URL or diagnostics into daemon stdout/stderr.
 const backend=backendFactory({...options,cwd:options.cwd??process.cwd(),log:()=>{}});
 let mode='idle',starting=null,closing=null,finished=false,stopping=false,timer=null,reusedPid=null,exitCode=null,resolveDone;
 const done=new Promise(resolve=>{resolveDone=resolve;});
 const clear=()=>{if(timer!==null){cancel(timer);timer=null;}};
 const status=()=>({mode,owned:backend.owned===true,pid:mode==='reused'?reusedPid:backend.child?.pid??null,checkEveryMs:mode==='reused'?checkEveryMs:0,exitCode});
 const finish=code=>{if(finished)return;finished=true;clear();backend.removeListener?.('unavailable',unavailable);mode='stopped';exitCode=code;resolveDone(code);};
 function close(code,waitStart){if(closing)return closing;stopping=true;clear();mode='stopping';closing=(async()=>{try{if(backend.owned)await backend.stop();if(waitStart&&starting)await starting.catch(()=>{});if(backend.owned)await backend.stop();finish(code);}catch{finish(code===0?1:code);}})();return closing;}
 function unavailable(){if(!stopping&&!finished)void close(1,false);}
 backend.on('unavailable',unavailable);
 function watch(){clear();if(stopping||finished||mode!=='reused')return;
  // Keep this timeout referenced: a daemon borrowing an existing core must stay alive.
  timer=schedule(()=>{timer=null;if(stopping||finished)return;let alive;try{alive=pidAlive(reusedPid);}catch{void close(1,false);return;}if(alive){watch();return;}void attempt();},checkEveryMs);
 }
 function attempt(){if(stopping||finished)return Promise.resolve(status());if(starting)return starting;clear();mode='starting';
  starting=(async()=>{try{const state=await backend.start();if(stopping||finished)return status();fail(state&&Number.isInteger(state.pid)&&state.pid>1,'DAEMON_BACKEND_STATE_INVALID');if(state.reused===true){reusedPid=state.pid;mode='reused';watch();}else{reusedPid=null;mode='owned';}return status();}catch{if(!stopping&&!finished)void close(1,false);return status();}finally{starting=null;}})();return starting;
 }
 return {done,status,start(){return mode==='owned'||mode==='reused'?Promise.resolve(status()):attempt();},stop(){return finished?Promise.resolve():close(0,true);}};
}

export async function runDesktopDaemon(argv=process.argv.slice(2),processObject=process){
 const options=parseDaemonArgs(argv),daemon=createDesktopDaemon(options),stop=()=>{void daemon.stop();};
 processObject.on('SIGTERM',stop);processObject.on('SIGINT',stop);
 try{await daemon.start();return await daemon.done;}finally{processObject.removeListener('SIGTERM',stop);processObject.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{process.exitCode=await runDesktopDaemon();}catch{process.stderr.write('DSH_DAEMON_START_FAILED\n');process.exitCode=1;}
}
