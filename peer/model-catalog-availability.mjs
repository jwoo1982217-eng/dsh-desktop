// 目录读取沿用宿主的返回结构；单个供应商卡住时，其余分组仍可正常显示。
// 共享进行中的供应商读取，避免多个页面反复启动同一份远端目录请求。
const flights = new WeakMap();
function providerFlight(llm, id, read) {
  const adapter = llm.registration(id).adapter;
  let pending = flights.get(adapter);
  if (!pending) { pending = new Map(); flights.set(adapter, pending); }
  let flight = pending.get(id);
  if (!flight) {
    flight = Promise.resolve().then(read); pending.set(id, flight);
    const release = () => { if (pending.get(id) === flight) pending.delete(id); };
    void flight.then(release, release);
  }
  return flight;
}
function waitForCatalog(flight, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('模型目录暂未就绪，请稍后重试')), ms);
    flight.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export async function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection(), deadlineMs = 3000) {
	const providers = ctx.llm.listProviders();
	const catalog = await Promise.all(providers.map(async (provider) => {
		try {
			return await waitForCatalog(providerFlight(ctx.llm, provider.id, async () => {
			const models = await ctx.llm.listModels(provider.id);
			const entries = await Promise.all(models.map(async (model) => {
				const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
				const reasoning = resolved.reasoning === void 0 ? void 0 : {
					efforts: resolved.reasoning.efforts.map((effort) => ({
						id: effort.id,
						name: effort.name,
						...effort.description === void 0 ? {} : { description: effort.description }
					})),
					...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: resolved.reasoning.defaultEffort }
				};
				return {
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...reasoning === void 0 ? {} : { reasoning }
				};
			}));
			return {
				kind: "group",
				group: {
					id: provider.id,
					name: provider.name,
					models: entries
				}
			};
			}), deadlineMs);
		} catch (error) {
			return {
				kind: "failure",
				failure: {
					id: provider.id,
					name: provider.name,
					message: error instanceof Error ? error.message : String(error)
				}
			};
		}
	}));
	const groups = catalog.flatMap((item) => item.kind === "group" ? [item.group] : []).filter((group) => group.models.length > 0);
	return {
		default: { ...defaultSelection },
		routableProviders: groups.map((group) => group.id),
		groups,
		failures: catalog.flatMap((item) => item.kind === "failure" ? [item.failure] : [])
	};
}
// 同一控制器只安装一次；依赖重载时由最后一个持有者释放，保留其他插件的并发修改。
const patchKey = Symbol.for('dsh.peer.model-catalog.availability.v1');
export function acquireModelCatalog(controller) {
  let state = controller[patchKey];
  if (!state) {
    const original = controller.modelCatalog;
    const wrapper = function () { return buildModelCatalog(this.ctx); };
    state = { original, wrapper, owners: new Set() };
    controller[patchKey] = state; controller.modelCatalog = wrapper;
  }
  const owner = {}; state.owners.add(owner);
  return () => {
    state.owners.delete(owner);
    if (!state.owners.size) {
      if (controller.modelCatalog === state.wrapper) controller.modelCatalog = state.original;
      if (controller[patchKey] === state) delete controller[patchKey];
    }
  };
}
export function applyModelCatalogAvailability(ctx) {
  ctx.inject(['sessionController', 'llm', 'agentDefaultModel'], child => {
    child.effect(() => acquireModelCatalog(child.sessionController));
  });
}
