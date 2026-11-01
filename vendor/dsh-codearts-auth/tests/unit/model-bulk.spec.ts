import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { bulkButtonState } from '../../plugin-src/client/model-bulk.js'

/**
 * 模型列表「打开全部 / 关闭全部」按钮的可用性判定。
 *
 * 与 `account-order.spec.ts` 同理：组件本身无法在本仓库单测里渲染（react 不在
 * 依赖内），故把最容易写错的判定抽成纯函数。这里要锁的核心是
 * **「已经是目标状态时按钮必须禁用」** —— 否则用户点「打开全部」而全部本来就
 * 开着，会以为按钮失灵（没有任何可见变化）。
 */
describe('bulkButtonState（批量开关按钮可用性）', () => {
  const model = (id: string, disabled: boolean) => ({ id, name: id, disabled })

  it('全部打开时「打开全部」禁用、「关闭全部」可用', () => {
    const state = bulkButtonState([model('a', false), model('b', false)], false)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(false)
  })

  it('全部关闭时「关闭全部」禁用、「打开全部」可用', () => {
    const state = bulkButtonState([model('a', true), model('b', true)], false)
    expect(state.openAllDisabled).toBe(false)
    expect(state.closeAllDisabled).toBe(true)
  })

  it('混合状态下两个按钮都可用', () => {
    const state = bulkButtonState([model('a', true), model('b', false)], false)
    expect(state.openAllDisabled).toBe(false)
    expect(state.closeAllDisabled).toBe(false)
  })

  /**
   * 空列表：两个按钮都必须禁用。
   *
   * 「关闭全部」在空列表下尤其危险 —— 若放行，它会写入一个空的黑名单
   * （无副作用但会触发一次广播与落盘），而用户看到的是「点了没反应」。
   */
  it('列表为空时两个按钮都禁用', () => {
    const state = bulkButtonState([], false)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(true)
  })

  /** 批量提交进行中：两个按钮都禁用，避免并发提交互相覆盖。 */
  it('批量提交进行中时两个按钮都禁用', () => {
    const state = bulkButtonState([model('a', true), model('b', false)], true)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(true)
  })

  /** 列表尚未载入（null）时与空列表同语义，不能抛错。 */
  it('列表尚未载入时两个按钮都禁用', () => {
    const state = bulkButtonState(null, false)
    expect(state.openAllDisabled).toBe(true)
    expect(state.closeAllDisabled).toBe(true)
  })
})

/**
 * ⚠️ 客户端接线守卫（源码级）已于 2026-10-26 **删除**。
 *
 * 原 `describe('ModelListPanel 批量按钮接线')` 守的是模型列表弹窗顶部的
 * 「打开全部 / 关闭全部」工具条。该工具条按用户要求移除（它与分组头的
 * 「本组全开 / 本组全关」在界面上看着像重复），`jet-hub.js` 里的
 * `setAllDisabled` 与 `bulkButtonState` 调用点随之消失 ⇒ 那些断言已无对象可守。
 *
 * ⚠️ **`model-bulk.js` 本身没有废**：`model-groups.js` 的 `groupBulkStateFor`
 * 仍在用它算分组按钮的可用性，上面这组纯逻辑用例继续有效。
 *
 * ⚠️ **服务端 `model.setAllDisabled` 也没废**，另有两个入口在调它：
 * 账号停用/启用流程（`jet-hub.js` 的「账号已停用，但关闭模型失败」那条链）
 * 与供应商弹窗的「整家全开 / 全关」。删掉的只是这一个 UI 入口。
 *
 * ⚠️ 移除的代价（用户知情后仍选择删）：模型列表弹窗里再没有能一键清掉
 * 「已下线模型的历史关闭项」的入口 —— 分组按钮只删当前列表里本组那些 id，
 * 死键从此只能靠关闭/启用账号那条链或供应商弹窗去清。
 */
