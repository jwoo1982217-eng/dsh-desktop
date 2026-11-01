import {describe,it,expect,vi} from 'vitest'
import {OrcaTermAdapter} from '../../src/orcaterm-adapter.js'
// 客户端源码由宿主React基础库加载；本文件只执行纯窗口分流函数。
// @ts-expect-error 浏览器JS源没有独立声明文件
import {openAccountLoginWindow} from '../../plugin-src/client/account-login-window.js'

describe('定制目录与双端授权合同', () => {
  it('OrcaTerm真实静态目录遵守模型黑名单和provider关闭，恢复后可再枚举', async () => {
    let closed=false
    const disabled=new Set<string>()
    const adapter=new OrcaTermAdapter({resolveCredential:async()=>undefined,accountPool:{providerClosedFor:()=>closed,disabledModelsFor:()=>disabled} as any})
    const initial=await adapter.listModels('orcaterm')
    expect(initial.length).toBeGreaterThan(0)
    const id=String(initial[0].id);disabled.add(id)
    expect((await adapter.listModels('orcaterm')).some(model=>model.id===id)).toBe(false)
    expect(adapter.listAllModels().some(model=>model.id===id)).toBe(true)
    closed=true;expect(await adapter.listModels('orcaterm')).toEqual([])
    closed=false;disabled.clear();expect(await adapter.listModels('orcaterm')).toEqual(initial)
  })
  it('手机WorkBuddy通过原生WebView窗口处理器打开系统浏览器，不调用桌面服务', async () => {
    const token={closed:false,close:vi.fn()},open=vi.fn(()=>token),desktop=vi.fn()
    const result=await openAccountLoginWindow({provider:'workbuddy',loginUrl:'https://www.codebuddy.ai/login?fixture=1',browserWindow:{__dshPhonePresentation:true,open},isolatedLoginCall:desktop})
    expect(result).toBe(token);expect(open).toHaveBeenCalledTimes(1);expect(desktop).not.toHaveBeenCalled()
    expect(open.mock.calls[0][0]).toBe('https://www.codebuddy.ai/login?fixture=1')
  })
  it('桌面WorkBuddy保持独立普通浏览器和幂等关闭，其他渠道沿原窗口', async () => {
    const open=vi.fn(),desktop=vi.fn(async ({action}:any)=>action==='open'?{isolated:true,sessionId:'fixture',browserMode:'system'}:undefined)
    const result=await openAccountLoginWindow({provider:'workbuddy',loginUrl:'https://www.codebuddy.ai/login',browserWindow:{open},isolatedLoginCall:desktop})
    expect(open).not.toHaveBeenCalled();expect(result.closed).toBe(false)
    result.close();result.close();expect(result.closed).toBe(true)
    expect(desktop.mock.calls.filter(([request])=>request.action==='close')).toHaveLength(1)
    await openAccountLoginWindow({provider:'codearts',loginUrl:'https://example.invalid/login',browserWindow:{open}})
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('桌面错误浏览器模式明确失败并释放窗口，随后正确模式可以重试', async () => {
    const desktop=vi.fn(async({action}:any)=>action==='open'?{isolated:true,sessionId:'fixture',browserMode:'controlled'}:undefined)
    await expect(openAccountLoginWindow({provider:'workbuddy',loginUrl:'https://www.codebuddy.ai/login',browserWindow:{open:vi.fn()},isolatedLoginCall:desktop})).rejects.toThrow('普通浏览器模式')
    expect(desktop.mock.calls.some(([request])=>request.action==='close')).toBe(true)
  })
})
