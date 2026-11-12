const sameRoute = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;

/** Recover only an explicitly replaced model's failed request, never a tool or healthy stream. */
export function createRetryHandoff({getAgent, isRoot, createMessage, schedule = queueMicrotask}) {
  const states = new Map();
  let closed = false, handoffs = 0, failures = 0, last = null;
  function consider(session, state) {
    if (closed || state.queued || !state.retrying || !state.selected || !state.route || sameRoute(state.selected, state.route)) return;
    state.queued = true;
    schedule(() => {
      state.queued = false;
      if (closed || states.get(session.id) !== state || !state.retrying || !state.selected || sameRoute(state.selected, state.route)) return;
      try {
      const agent = getAgent(session.id);
      if (!agent || agent.session !== session || agent.status !== 'running' || !isRoot(agent)) return;
      const from = {...state.route}, to = {...state.selected};
      // Use the SDK's attributed model-selection notice, not an invented user instruction.
      const message = createMessage({
        content: [{type:'text', text:`[model changed: the previous ${from.provider}/${from.model} request failed; the user selected ${to.provider}/${to.model}. Continue the current task with the selected model. Keep completed tool results; do not repeat completed actions.]`}],
        source: {kind:'model-selection', form:'notice', summary:'失败请求已结束，按新选择的模型继续'},
      });
      state.retrying = false;
      agent.cancel({kind:'hook', reason:'model-switch-after-failed-request'}, {keepInbox:true});
      // send() after cancellation wakes a new turn; it never replays the old prompt or tool call.
      agent.followup(message);
      handoffs++;
      last = {sessionId:session.id, from, to, at:Date.now()};
      } catch {
        // Disposed agents and failed inbox writes must not crash the host or loop cancellation.
        state.retrying = false;
        failures++;
      }
    });
  }
  function observe(session, event, replay = false) {
    if (closed) return;
    if (event.type === 'session/disposed') { states.delete(session.id); return; }
    let state = states.get(session.id);
    if (!state) { state = {route:session.requestHeader?.()?.config ?? null, selected:null, retrying:false, queued:false}; states.set(session.id, state); }
    switch (event.type) {
      case 'request/header':
        state.route = event.data.header.config;
        state.selected = null;
        break;
      case 'model/selection':
        state.selected = event.data;
        break;
      case 'llm/retry':
        // Do not infer a model from the provider alone, or act on stale/mismatched history.
        state.retrying = state.route?.provider === event.data.provider;
        break;
      case 'step/start': case 'step/end': case 'turn/end': case 'assistant/message':
        state.retrying = false;
        break;
    }
    if (!replay) consider(session, state);
  }
  return {
    observe,
    seed(session) {
      for (const event of session.log ?? []) observe(session, event, true);
      const state = states.get(session.id);
      if (state) consider(session, state);
    },
    forget(session) { states.delete(session.id); },
    status() { return {handoffs, failures, last}; },
    close() { closed = true; states.clear(); },
  };
}
