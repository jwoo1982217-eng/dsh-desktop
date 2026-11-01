/**
 * 「面板入口」偏好的客户端状态与读写（**无 React、无组件依赖**）。
 *
 * 单独成文件是为了避开循环 import：`panel-entry.js` 需要 `JetHubPage`，
 * 而插件详情页的卡片又需要本状态 —— 三份模块若互相 import，esbuild 打包后
 * 会在模块初始化顺序上留下 TDZ 风险（真机表现是打开设置页白屏、控制台一条
 * `Cannot access 'X' before initialization`）。
 *
 * ## 取值语义
 *
 * 两个取值**严格互斥**，任一时刻只有一个入口存在：
 * - `'sidebar'` = 主导航里一行（`sidebar.panellist`），`settings.section` 注销；
 * - `'settings'` = 只剩「设置 → 插件 → Jet Hub」，主导航那一行注销。
 *
 * 模块内状态另有 `null`，表示**还没从宿主读到**（启动中）—— 它与 `'sidebar'`
 * 一样让侧栏行可见，否则每次启动那一行都会闪一下。
 *
 * 存宿主侧而不是浏览器本地存储：Web 端 origin 是 `http://127.0.0.1:<随机端口>`，
 * 换端口本地存储就清空，用户会看到「下拉自己变回默认」。客户端也不该读写浏览器存储
 * （本仓库有一条守卫在扫客户端源码里的存储 API 字面量）。
 */

/** `PanelEntry` 的两个合法取值（与宿主 `PANEL_ENTRY_VALUES` 必须逐字一致）。 */
const VALID_ENTRIES = ['sidebar', 'settings'];

/** 读不到宿主偏好时的兜底取值。 */
const FALLBACK_ENTRY = 'sidebar';

/**
 * `main` 槽的 key，同时也是 `sidebar.panellist` 的 id 与 `settings.section` 的 id。
 *
 * 宿主按「侧栏 id = 主面板 key」派发，三者不一致时界面看起来完全正常，
 * 只有点下去才会发现「面板没换」。
 */
export const JET_HUB_PANEL_KEY = 'jet-hub';

/**
 * 侧栏行在主导航里的位置。
 *
 * 现有占用：插件 0、插件市场 1、自动化任务 10、记忆系统 30 —— 取 20 落在
 * 自动化任务与记忆系统之间（Jet Hub 偏工具，不是会话入口）。
 */
export const JET_HUB_SIDEBAR_ORDER = 20;

/**
 * 读宿主偏好的超时（毫秒）。
 *
 * 超时按「仅侧栏」兜底：一次卡住的 RPC 不该把两处入口都藏掉，用户会以为插件没装好。
 */
const PANEL_ENTRY_READ_TIMEOUT_MS = 5000;

/**
 * 一次 `loadPanelEntry` 最多发几轮读请求（1 轮首读 + 重试）。
 *
 * ⚠️⚠️ **首读发生在 `apply()` 里，那时连接可能还没握手完**（2026-10-27 真机报障）：
 * 本插件是 `web` profile 里 60+ 个客户端插件之一，冷启动时 `apply()` 早于
 * `connection` 的握手完成，而 `connection.rpc.call()` 在 socket 就绪前**不会本地失败**，
 * 只是一直不 settle ⇒ 5s 超时信号到点 ⇒ 控制台一条
 * `[jet-hub] 读取面板入口偏好失败，按仅侧栏处理 TimeoutError: signal timed out`。
 *
 * 后果不止是那行噪音：偏好被永久降级成「仅侧栏」直到插件重载 —— 选了
 * 「仅设置页」的用户会看到侧栏多出一行、设置节消失。
 *
 * ⇒ 有界重试：`apply()` 期的一次瞬时超时不该等于「宿主真的答不上」。
 *   每轮都带自己的 5s 超时，间隔按轮次线性递增（200ms / 400ms），
 *   最坏 3 轮 ≈ 15.6s —— 冷启动握手远小于这个量级。
 */
const PANEL_ENTRY_READ_ATTEMPTS = 3;

/**
 * 重试间隔基数（毫秒，第 n 轮重试等 `n × 本值`）。
 *
 * 只用来跨过握手窗口，不需要指数退避（总共才两轮重试）。
 */
const PANEL_ENTRY_RETRY_DELAY_MS = 200;

/** 等待若干毫秒（重试用）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 进程内的「面板入口」状态。
 *
 * `null` = **还没从宿主读到**（启动中）；`'sidebar'` / `'settings'` = 宿主的明确取值。
 */
let entry = null;

/** 最近一次读取是否失败（卡片据此显示降级文案，不据此禁用下拉）。 */
let readFailed = false;

/** 正在飞的那次读取（并发去重用；`null` = 没有在飞）。 */
let inflight = null;

/**
 * 写入次数（单调递增）。读取在**发起时**记下当时的值，回包时再比一次：
 * 若期间用户写入过，这个回包携带的是**写之前**的宿主状态，丢弃它。
 *
 * ⚠️ 不这么做的真实症状（2026-10-24 复核 I3 实测）：读请求在飞（慢）→ 用户选
 * 「仅设置页」写入成功 → 那个慢读回包带着写之前的 `'sidebar'` 到达 → 覆盖回
 * `'sidebar'`。界面表现为「刚改完又自己跳回去了」，而且会一直跳到下次读取为止。
 */
let writeSeq = 0;

/** 订阅者集合：卡片与两处槽位注册共用同一份状态。 */
const listeners = new Set();

/**
 * 把任意输入归一成合法取值。
 *
 * @param {unknown} raw
 * @returns {'sidebar' | 'settings' | null} 非法值返回 `null`
 */
function normalize(raw) {
  return typeof raw === 'string' && VALID_ENTRIES.includes(raw) ? raw : null;
}

/**
 * 当前取值（`null` = 还没读到宿主偏好）。
 *
 * ⚠️ 调用方要判断「该注册哪处入口」请用 {@link panelEntryShowsSidebar} /
 * {@link panelEntryShowsSettings}：它们已经把 `null` 的兜底方向算进去了。
 *
 * @returns {'sidebar' | 'settings' | null}
 */
export function panelEntry() {
  return entry;
}

/**
 * 侧栏行当前是否应当显示（`null` 视为显示）。
 *
 * @returns {boolean}
 */
export function panelEntryShowsSidebar() {
  return entry !== 'settings';
}

/**
 * 设置节当前是否应当显示。
 *
 * ⚠️ 只有**明确读到** `'settings'` 才返回 true：`null`（还没读到）按侧栏兜底，
 * 否则启动瞬间两处都不注册，用户会看到一片空白。
 *
 * @returns {boolean}
 */
export function panelEntryShowsSettings() {
  return entry === 'settings';
}

/**
 * 最近一次「读宿主偏好」是否失败。
 *
 * ⚠️ 只用于**提示**：失败时仍按「仅侧栏」兜底、下拉仍可点 —— 与网关面板
 * 「附属字段采集失败不该把用户挡在自救路径之外」同一取向。
 *
 * @returns {boolean}
 */
export function panelEntryReadFailed() {
  return readFailed;
}

/**
 * 订阅「面板入口」状态的变化（取值与读取失败标记都会触发）。
 *
 * @param {() => void} listener
 * @returns {() => void} 取消订阅
 */
export function subscribePanelEntry(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 广播一次状态变化。**无变化时不广播**，避免卡片与两处注册无谓重算。
 *
 * @param {'sidebar' | 'settings'} nextEntry 合法取值
 * @param {boolean} nextFailed
 */
function publish(nextEntry, nextFailed) {
  if (entry === nextEntry && readFailed === nextFailed) return;
  entry = nextEntry;
  readFailed = nextFailed;
  // 复制一份再遍历：监听器里可能自己退订（例如侧栏行被撤销）。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (caught) {
      console.error('[jet-hub] 面板入口监听器抛错', caught);
    }
  }
}

/**
 * 组装读取用的 AbortSignal。
 *
 * ⚠️⚠️ **必须自己造超时，不能只依赖 `AbortSignal.timeout`**（2026-10-24 审计 M1）。
 *
 * `build.mjs` 的 esbuild `target: ['chrome100']`，而 `AbortSignal.timeout` 是
 * **Chrome 103+ / Node 17.3+** 才有的 API。原实现「没有该 API 就返回 `undefined`」
 * 等于**把超时保护整个摘掉**：宿主 RPC 永不 settle 时 `loadPanelEntry` 永久挂起，
 * 叠加 `inflight` 复用 ⇒ 后续每次读取都复用那个永不 settle 的 Promise，
 * **此后永远读不到宿主真实值**。
 *
 * 修法：有原生 API 就用（更精确）；没有就用 `AbortController` + `setTimeout`
 * 等价实现 —— 后者只需 `AbortController`（Chrome 66+），覆盖面足够。
 *
 * @returns {AbortSignal | undefined}
 */
function readSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(PANEL_ENTRY_READ_TIMEOUT_MS);
  }
  // 老内核兜底：自建超时。`AbortController` 也不存在时只能放弃信号，退化为「可能
  // 悬挂」；但这种内核连 fetch 的取消都不支持，已超出本插件的运行基线。
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  // ⚠️ 触发后清掉定时器，避免每次读取都留一个悬挂 timer（Node 侧还会让进程晚退）。
  const timer = setTimeout(() => controller.abort(), PANEL_ENTRY_READ_TIMEOUT_MS);
  if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
    // Node 下不阻止进程退出；浏览器里 timer 是 number，走不到这里。
    timer.unref();
  }
  controller.signal?.addEventListener?.('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/**
 * 从宿主读一次「面板入口」偏好（只读，不写回）。
 *
 * 调用点有三处且**都必要**：侧栏行注册前、设置节注册前、卡片挂载时。前两处
 * 只关心取值，第三处还要把「读取失败」标记显示出来。
 *
 * ⚠️ **并发去重**：三处都在 `apply` / 挂载时立即调用，不去重就要打三次宿主 RPC，
 * 而且三次回包顺序不定会多广播两次无谓重渲染。
 *
 * ⚠️ **有界重试**（2026-10-27）：首读发生在 `apply()`，那时 `connection` 可能还没
 * 握手完，`connection.rpc.call()` 不会本地失败、只是一直不 settle ⇒ 5s 超时到点
 * ⇒ 偏好被永久降级成「仅侧栏」。现在最多 3 轮、间隔 200ms / 400ms，只在**全部
 * 轮次都失败**时才打一次 warn。详见 {@link PANEL_ENTRY_READ_ATTEMPTS}。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @returns {Promise<'sidebar' | 'settings'>} 读到的值；失败时沿用当前状态（兜底仅侧栏）
 */
export function loadPanelEntry(rpcCall) {
  // 已有在飞的请求就复用：复用同一份 Promise，调用方拿到的值与「自己发一次」
  // 逐字节一致（同一个网络回包）。
  if (inflight !== null) return inflight;
  // ⚠️ 发起时记下写入序号：回包时若它变了，说明期间用户改过，本回包已过期。
  const seqAtStart = writeSeq;
  const task = (async () => {
    /** 最后一轮的失败原因；只有**全部轮次都失败**才把它报出去。 */
    let lastError;
    for (let attempt = 1; attempt <= PANEL_ENTRY_READ_ATTEMPTS; attempt += 1) {
      try {
        const result = await rpcCall('panelEntry.get', {}, readSignal());
        // ⚠️ 防倒灌（复核 I3）：期间有写入就丢弃本次读回包 —— 它携带的是写之前
        //    的宿主状态，落地会覆盖用户刚做的选择。
        if (writeSeq !== seqAtStart) return entry ?? FALLBACK_ENTRY;
        const next = normalize(result?.entry);
        if (next !== null) {
          // 宿主明确给了合法值：清掉失败标记。
          publish(next, false);
        } else {
          // 回包形状不对：按读取失败处理，但仍保持当前（默认仅侧栏）方向。
          // ⚠️ 形状不对**不重试** —— 宿主已经答了，只是答得不对，再问三次也一样。
          publish(entry ?? FALLBACK_ENTRY, true);
        }
        return entry ?? FALLBACK_ENTRY;
      } catch (caught) {
        lastError = caught;
        // 期间用户写入过 ⇒ 本次读已过期，不必再试（写成功已给出权威值）。
        if (writeSeq !== seqAtStart) return entry ?? FALLBACK_ENTRY;
        if (attempt >= PANEL_ENTRY_READ_ATTEMPTS) break;
        // ⚠️ 等待与退避都在 `writeSeq` 判据之后：用户一写入就立刻停，别再空转两轮。
        await delay(PANEL_ENTRY_RETRY_DELAY_MS * attempt);
        if (writeSeq !== seqAtStart) return entry ?? FALLBACK_ENTRY;
      }
    }
    console.warn(
      `[jet-hub] 读取面板入口偏好失败，按仅侧栏处理（已重试 ${PANEL_ENTRY_READ_ATTEMPTS - 1} 次）`,
      lastError,
    );
    // 失败标记同理：期间若用户写入成功，不该再挂一个「读失败」的降级文案。
    if (writeSeq === seqAtStart) publish(entry ?? FALLBACK_ENTRY, true);
    return entry ?? FALLBACK_ENTRY;
  })();
  inflight = task;
  // ⚠️⚠️ 清理**必须挂在 async 体外面**（2026-10-24 复核 C2）。
  //
  //    先前的写法把它放在 async 体的 `finally` 里，而 `inflight = task` 在
  //    IIFE **之后**才执行 —— `rpcCall` 若**同步**抛错，`finally` 会先跑
  //    （`inflight = null`），随后被 `inflight = task` 覆盖 ⇒ 一个已 settle 的
  //    Promise 永久留在 `inflight` 上，此后每次 `loadPanelEntry` 都复用它、
  //    再也**不发请求**、也永远读不到宿主的新值。
  //    生产里 `rpcCall` 是 async 函数（同步抛错会变成 rejected Promise），所以
  //    实际难以触发；但测试替身就是普通函数，且这段逻辑本身不该对入参形态敏感。
  //
  //    双参 `then` 同时覆盖 resolve 与 reject；`inflight === task` 判等是为了
  //    不误清一次「已经换成新请求」的 inflight。
  const clear = () => {
    if (inflight === task) inflight = null;
  };
  void task.then(clear, clear);
  return task;
}

/**
 * 写回「面板入口」偏好，并以宿主返回值更新本地状态。
 *
 * ⚠️ **不猜默认值**：只有宿主明确回合法取值才更新；失败直接抛给调用方
 * （卡片要能回滚并提示用户 —— 静默改本地状态会造成「下拉看着改了、重启后
 * 又变回来」）。
 *
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 * @param {'sidebar' | 'settings'} next
 * @returns {Promise<'sidebar' | 'settings'>} 宿主确认后的值
 */
export async function setPanelEntry(rpcCall, next) {
  const result = await rpcCall('panelEntry.set', { entry: next });
  const confirmed = normalize(result?.entry);
  if (confirmed === null) {
    throw new Error('面板入口偏好没有返回合法 entry');
  }
  // ⚠️ 序号只在**写入成功**后递增：失败时用户的意图没落地，在飞的读回包仍然
  //    有效（它带的就是真实的旧值），不该被丢弃。
  writeSeq += 1;
  publish(confirmed, false);
  return confirmed;
}
