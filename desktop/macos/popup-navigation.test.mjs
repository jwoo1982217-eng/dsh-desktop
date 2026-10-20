import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {externalUrl, installPopupNavigation} from './app/popup-navigation.mjs';

class Contents extends EventEmitter {setWindowOpenHandler(handler) {this.open = handler;}}
const isLocal = value => {try {return new URL(value).origin === 'http://127.0.0.1:3080';} catch {return false;}};
function fixture(url='about:blank') {
  const parent=new Contents(), child={webContents:new Contents(),closed:false,isDestroyed(){return this.closed;},close(){this.closed=true;}}, calls=[];
  installPopupNavigation(parent,{isLocal,openExternal:value=>calls.push(value)});
  parent.emit('did-create-window',child,{url});
  return {parent,child,calls};
}
test('preopened login remains sandboxed, then hands its authorization URL to the system browser once',async()=>{
  const {parent,child,calls}=fixture(), policy=parent.open({url:'about:blank'});
  assert.equal(policy.action,'allow');assert.equal(policy.overrideBrowserWindowOptions.show,false);
  assert.deepEqual(policy.overrideBrowserWindowOptions.webPreferences,{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,partition:'persist:dsh'});
  let prevented=0;const event={preventDefault(){prevented++;}},url='https://platform.deepseek.com/oauth/authorize?state=fixture';
  child.webContents.emit('will-navigate',event,url);child.webContents.emit('will-redirect',event,url);
  await new Promise(setImmediate);assert.equal(prevented,2);assert.deepEqual(calls,[url]);assert.equal(child.closed,true);
});
test('cancel leaves no handoff, ordinary local windows and direct external links still work',()=>{
  const {parent,child,calls}=fixture();child.close();assert.deepEqual(calls,[]);
  assert.equal(parent.open({url:'http://127.0.0.1:3080/settings'}).action,'allow');
  assert.equal(parent.open({url:'https://example.com/help'}).action,'deny');assert.deepEqual(calls,['https://example.com/help']);
});
test('unsupported URLs and embedded credentials never leave the app',async()=>{
  for(const url of ['javascript:alert(1)','file:///etc/passwd','data:text/html,secret','https://user:pass@example.com/','dsh://callback']) {
    const {parent,child,calls}=fixture();assert.equal(externalUrl(url),false);assert.equal(parent.open({url}).action,'deny');
    let prevented=false;child.webContents.emit('will-navigate',{preventDefault(){prevented=true;}},url);await new Promise(setImmediate);
    assert.equal(prevented,true);assert.deepEqual(calls,[]);assert.equal(child.closed,true);
  }
});
