import {readFile, writeFile, rename, rm, stat} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
export const behaviorCompatibilityVersion = '0.2.2-rc.1';
// Three-way comparison: exact npm alpha.4 publication -> deployed local delta -> rc.1.
// rc.1's model-switch pressure implementation and separate instruction budgets are retained.
export const behaviorClassification = Object.freeze({
  upstream: ['agent-instructions: separate global/project instruction chains', 'compaction-basic: proposed request-header pressure and old-model summary before switching'],
  ported: ['compaction-basic: bounded adaptive summaries, resumable completed batches, terminal/error checks, finite pressure-failure budget', 'llm-pi-ai: exact relay model image modalities and listed modalities; gateway quota/restriction classification and status', 'session-persistence-jsonl/session-query/session-query-sqlite/session-projection-cache/workspace: chat-history permanent-deletion integration', 'settings: legacy noema-memory owner alias'],
  notApplicableOnMac: ['fs-local: Android no-hard-link publication', 'session-persistence-jsonl: Android materialization/publication', 'node-addon-system/flock: Android native publication/loading', 'skill-filesystem: Android selected-skills roots', 'bash-local/bash-sandbox/sandbox/sandbox-local/tool-bash/tool-fs-search/directory-picker: Android executables, storage and permission explanations'],
  separatelyReviewed: ['experimental-agent-team/experimental-tool-agent-team: scheduler delegation gate and authorized teammate model routes'],
});
const patches = [
  {
    "file": "@deepseek-ai/dsh-llm-pi-ai/lib/index.js",
    "before": "1a3ae58f9b4493e15459cc5000ec80f21b5d3f4a9dea6ffb6bc28e5b8817ae8a",
    "after": "4ba20c33a59945fe1d3772030bb2edbc8d8573993b246fd21191356f3e27a63e",
    "changes": [
      [
        "/**\n* Disposition of every `OpenAICompletionsCompat` field.",
        "// Custom relay route keys have no built-in provider catalog. Reuse only exact\n// model IDs with an unambiguous modality declaration; explicit row settings win.\nlet relayInputCatalog;\nfunction relayModelInput(id, api) {\n if (relayInputCatalog === void 0) {\n  relayInputCatalog = new Map();\n  for (const provider of catalogProviders().keys()) for (const model of getBuiltinModels(provider)) {\n   if (!Array.isArray(model.input) || model.input.length === 0) continue;\n   const entries = relayInputCatalog.get(model.id) ?? [];\n   entries.push(model); relayInputCatalog.set(model.id, entries);\n  }\n }\n const all = relayInputCatalog.get(id) ?? [];\n const matching = all.filter(model => model.api === api);\n const candidates = matching.length > 0 ? matching : all;\n if (candidates.length === 0) return;\n const input = candidates[0].input;\n if (!candidates.every(model => model.input.length === input.length && input.every(value => model.input.includes(value)))) return;\n return [...input];\n}\nfunction listedInput(entry) {\n const value = entry?.inputModalities ?? entry?.input ?? entry?.architecture?.input_modalities ?? entry?.modalities?.input;\n if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) return;\n const input = [...new Set(value.filter(item => MODALITIES.includes(item)))];\n return input.length > 0 ? input : void 0;\n}\n/**\n* Disposition of every `OpenAICompletionsCompat` field."
      ],
      [
        "input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput],",
        "input: declaredInput(entry.input) ?? base?.input ?? relayModelInput(entry.id, api) ?? [...request.defaultInput],"
      ],
      [
        "function classifyPiAiError(message) {",
        "// pi-ai 将 HTTP 错误压成文本；只从固定前缀恢复状态，避免把正文里的数字当状态码。\nfunction piAiErrorStatus(message) {\n\tconst match = /^([45]\\d{2}):\\s/.exec(message);\n\treturn match === null ? void 0 : Number(match[1]);\n}\nfunction isGatewayQuotaError(message) {\n\tif (piAiErrorStatus(message) !== 429) return false;\n\ttry {\n\t\tconst body = JSON.parse(message.replace(/^429:\\s*/, \"\"));\n\t\tconst detail = body?.error ?? body;\n\t\t// APIGOTO 文档区分 42906/42907（额度耗尽）与 42901–42905/42908（可重试）。\n\t\treturn detail?.type === \"gateway_error\" && [\"42906\", \"42907\"].includes(String(detail.code));\n\t} catch {\n\t\treturn false;\n\t}\n}\n// 40303 是网关声明的临时限制，不是密钥失效；保留原说明及等待时间，也不立即重试。\nfunction gatewayTemporaryRestriction(message) {\n\tif (piAiErrorStatus(message) !== 403) return;\n\ttry {\n\t\tconst body = JSON.parse(message.replace(/^403:\\s*/, \"\"));\n\t\tconst detail = body?.error ?? body;\n\t\tif (detail?.type !== \"gateway_error\" || (detail.code !== \"40303\" && detail.code !== 40303)) return;\n\t\treturn typeof detail.message === \"string\" && detail.message.trim() !== \"\"\n\t\t\t? detail.message\n\t\t\t: \"上游暂时限制调用（40303），请稍后再试。\";\n\t} catch {\n\t\treturn;\n\t}\n}\nfunction classifyPiAiError(message) {"
      ],
      [
        "if (/\\b(?:401|403)\\b/.test(message)) return \"AUTH\";\n\tif (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;",
        "if (isQuotaExceededError(message) || isGatewayQuotaError(message)) return QUOTA_EXCEEDED_CODE;\n\tif (/\\b(?:401|403)\\b/.test(message)) return \"AUTH\";"
      ],
      [
        "const text = message.errorMessage ?? \"pi-ai stream error\";",
        "const text = message.errorMessage ?? \"pi-ai stream error\";\n\t\t\tconst restriction = gatewayTemporaryRestriction(text);"
      ],
      [
        "message: text,\n\t\t\t\t\tcode: classifyPiAiError(text)",
        "message: restriction ?? text,\n\t\t\t\t\tcode: restriction === void 0 ? classifyPiAiError(text) : \"UPSTREAM_RESTRICTED\",\n\t\t\t\t\t...piAiErrorStatus(text) === void 0 ? {} : { status: piAiErrorStatus(text) }"
      ],
      [
        "function readListing(body) {",
        "function readListing(body, api) {"
      ],
      [
        "\t\tmodels.push({\n\t\t\tid,\n\t\t\tname,",
        "\t\tconst inputModalities = listedInput(entry) ?? relayModelInput(id, api);\n\t\tmodels.push({\n\t\t\tid,\n\t\t\tname,"
      ],
      [
        "...maxTokens === void 0 ? {} : { maxTokens }\n\t\t});",
        "...maxTokens === void 0 ? {} : { maxTokens },\n\t\t\t...inputModalities === void 0 ? {} : { inputModalities }\n\t\t});"
      ],
      [
        "return readListing(body);",
        "return readListing(body, api);"
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-compaction-basic/lib/index.js",
    "before": "eafe4adbccc2b87377e4839f1a6093ebe1a0858caadc6c3dbffef19cb1dbc54b",
    "after": "a85659ade24c76cfce2b98add4b242a77f36a780a94269b4c09f4f884656f944",
    "changes": [
      [
        "import z from \"@deepseek-ai/schemastery\";",
        "import z from \"@deepseek-ai/schemastery\";\nimport {summarizeAdaptive} from \"./summary-runner.mjs\";"
      ],
      [
        "const maxTokens = config.maxTokens ?? headroomTokens;",
        "const maxTokens = config.maxTokens ?? Math.min(headroomTokens, 8192);"
      ],
      [
        "async function summarizeWithLlm(ctx, config, input, agent, signal) {\n\tconst latest = agent.session.requestHeader()?.config;\n\tconst configured = config.summarizationProvider.length === 0 ? void 0 : {\n\t\tprovider: config.summarizationProvider,\n\t\tmodel: config.summarizationModel\n\t};\n\tconst agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? {\n\t\tprovider: agent.options.provider,\n\t\tmodel: agent.options.model\n\t} : void 0;\n\tconst target = configured ?? latest ?? agentTarget;\n\tif (target === void 0) throw new Error(\"no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields\");\n\tconst assembler = new BlockAssembler();\n\tconst messages = [...input.messages, deepFreeze({\n\t\trole: \"user\",\n\t\tcontent: [{\n\t\t\ttype: \"text\",\n\t\t\ttext: COMPACTION_INSTRUCTION\n\t\t}]\n\t})];\n\tconst options = {\n\t\tprovider: target.provider,\n\t\tmodel: target.model,\n\t\tmessages,\n\t\ttoolHistory: agent.session.toolHistory(),\n\t\t...input.tools === void 0 ? {} : { tools: [...input.tools] },\n\t\tmaxTokens: config.maxTokens,\n\t\tsessionId: agent.session.id,\n\t\tpurpose: \"compaction\",\n\t\t...signal === void 0 ? {} : { signal }\n\t};\n\tfor await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);\n\tconst error = finishError(assembler.finish);\n\tif (error !== void 0) throw error;\n\tconst rawOutput = assembler.blocks();\n\tconst summary = summaryText(rawOutput);\n\tif (!summary.some((block) => block.text.trim().length > 0)) throw new Error(\"summarization produced no text summary content\");\n\treturn {\n\t\tsummary,\n\t\trawOutput,\n\t\tllmStreamCall: true,\n\t\tprovider: options.provider,\n\t\tmodel: options.model,\n\t\tmaxTokens: config.maxTokens,\n\t\t...assembler.usage === void 0 ? {} : { usage: assembler.usage }\n\t};\n}\n",
        "async function summarizeWithLlm(ctx, config, input, agent, signal) {\n\tsignal?.throwIfAborted();\n\tconst configured = config.summarizationProvider.length === 0 ? void 0 : {\n\t\tprovider: config.summarizationProvider, model: config.summarizationModel\n\t};\n\tconst target = configured ?? conversationTarget(agent);\n\tif (target === void 0) throw new Error(\"no provider/model available for summarization\");\n\tconst info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal);\n\treturn summarizeAdaptive({ctx, config, input, agent, signal, target, info,\n\t\tinstruction: COMPACTION_INSTRUCTION, finishError, summaryText});\n}\n"
      ],
      [
        "warnedPressureConfigTargets = /* @__PURE__ */ new Set();",
        "pressureFailures = /* @__PURE__ */ new WeakMap();"
      ],
      [
        "\t\tctx.on(\"agent/pre-step\", async ({ agent, signal }, next) => {\n\t\t\tif (!signal.aborted) try {\n\t\t\t\tconst result = await this.compactIfNeeded(agent, \"pressure\", signal);\n\t\t\t\tif (result !== null) logResult(result, \"step pressure\");\n\t\t\t} catch (error) {\n\t\t\t\tif (error instanceof TargetPressureConfigError) {\n\t\t\t\t\tif (this.warnedPressureConfigTargets.has(error.targetKey)) return next();\n\t\t\t\t\tthis.warnedPressureConfigTargets.add(error.targetKey);\n\t\t\t\t}\n\t\t\t\tconst message = error instanceof Error ? error.message : String(error);\n\t\t\t\tctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);\n\t\t\t}\n\t\t\treturn next();\n\t\t});\n",
        "\t\tctx.on(\"agent/pre-step\", async ({ agent, signal }, next) => {\n\t\t\tif (!signal.aborted) {\n\t\t\t\tconst target = conversationTarget(agent);\n\t\t\t\tconst policy = target === void 0 ? this.config : resolveTargetPolicy(this.config, target);\n\t\t\t\tif ((this.pressureFailures.get(agent) ?? 0) >= policy.compactionRetries + 1) throw new LlmError(\n\t\t\t\t\t\"本轮上下文压缩重试预算已用完，历史记录保留。\", \"COMPACTION_FAILED\");\n\t\t\t}\n\t\t\tif (!signal.aborted) try {\n\t\t\t\tconst result = await this.compactIfNeeded(agent, \"pressure\", signal);\n\t\t\t\tthis.pressureFailures.delete(agent);\n\t\t\t\tif (result !== null) logResult(result, \"step pressure\");\n\t\t\t} catch (error) {\n\t\t\t\tif (error instanceof TargetPressureConfigError) throw new LlmError(error.message, \"COMPACTION_CONFIGURATION\", {cause: error});\n\t\t\t\tconst message = error instanceof Error ? error.message : String(error);\n\t\t\t\tif (signal.aborted) return next();\n\t\t\t\tif (!(error instanceof TargetPressureConfigError)) {\n\t\t\t\t\tconst failures = (this.pressureFailures.get(agent) ?? 0) + 1;\n\t\t\t\t\tthis.pressureFailures.set(agent, failures);\n\t\t\t\t\tconst target = conversationTarget(agent);\n\t\t\t\t\tconst policy = target === void 0 ? this.config : resolveTargetPolicy(this.config, target);\n\t\t\t\t\tif (error.compactionUnsafe || failures >= policy.compactionRetries + 1) throw new LlmError(\n\t\t\t\t\t\t`上下文整理失败，本轮已停止（${failures} 次失败）。原历史与已完成分段保留；重试会续做匹配的分段，请查看原始错误。`,\n\t\t\t\t\t\t\"COMPACTION_FAILED\", {cause: error});\n\t\t\t\t}\n\t\t\t\tctx.logger.warn(`step compaction failed: ${message}; retry budget remains`);\n\t\t\t}\n\t\t\treturn next();\n\t\t});\n"
      ],
      [
        "if (status === \"idle\") this.overflowRetries.delete(agent);",
        "if (status === \"idle\") { this.overflowRetries.delete(agent); this.pressureFailures.delete(agent); }"
      ],
      [
        "\t\t\tresult = await this.compactRegion(range.start, range.end, agent, signal);\n\t\t\tmeasurement = meter.measure(agent.session, header);",
        "\t\t\ttry {\n\t\t\t\tresult = await this.compactRegion(range.start, range.end, agent, signal);\n\t\t\t} catch (error) {\n\t\t\t\tif (error instanceof Error && measurement.totalTokens >= info.context.contextWindow - reservedCompletionTokens(header, info.defaultMaxTokens)) error.compactionUnsafe = true;\n\t\t\t\tthrow error;\n\t\t\t}\n\t\t\tmeasurement = meter.measure(agent.session, header);"
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
    "before": "69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7",
    "after": "ab84b9243129692533097aa091774cfa99b547cb044e88eb7786ee91cd65f296",
    "changes": [
      [
        "\tasync stat(",
        "\tdecodeDeletionLog(buffer, compressed) {\n\t\tif (!compressed) return buffer.toString(\"utf8\");\n\t\tconst {frames, tornStart} = scanZstdFrames(buffer); if (tornStart !== undefined) throw new Error(\"聊天压缩记录不完整，请先修复记录再清理附件\");\n\t\tconst decoder = createZstdFrameDecoder();\n\t\ttry { const chunks = []; for (const chunk of decoder.decode(buffer, frames)) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString(\"utf8\"); } finally { decoder.close(); }\n\t}\n\tasync preparePermanentDeletion(ids) { for (const handle of [...this.tracker.openHandles]) if (ids.includes(handle.id)) await handle.close(); }\n\tasync removePermanently(header) {\n\t\tconst id = header.id;\n\t\tconst preparation = this.migrationPreparations.get(id); if (preparation) { preparation.controller.abort(); await preparation.promise.catch(() => {}); }\n\t\tconst handles = [...this.tracker.openHandles].filter(h => h.id === id);\n\t\tfor (const handle of handles) await handle.close();\n\t\tif (this.tracker.writers.has(id)) throw new Error(\"Session writer has not released\");\n\t\tthis.tracker.pending.delete(id); this.coldLogMemo.delete(id);\n\t\tconst directory = dirname(this.locate(header).path);\n\t\tif (basename(directory) !== id || !directory.startsWith(this.root + \"/\") || (await lstat(directory)).isSymbolicLink()) throw new Error(\"Unsafe session directory\");\n\t\tawait rm(directory, {recursive: true, force: true});\n\t}\n\tasync stat("
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-session-query/lib/index.js",
    "before": "76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939",
    "after": "bcd8f3098ffe379b8ae20a57fc9be359c8925e20c689f83ac09164522f49b059",
    "changes": [
      [
        "\tobserveSession(",
        "\tforgetPermanently(ids) { for (const id of ids) this._observations.cache.delete(id); }\n\tobserveSession("
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-session-query-sqlite/lib/index.js",
    "before": "dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0",
    "after": "66f8cd7a1a7c7e19f48d2e4106edaa15df98e5118fd5df2d744bb7ef932ef3e9",
    "changes": [
      [
        "\t_deleteSession(",
        "\tasync forgetPermanently(ids) {\n\t\tsuper.forgetPermanently(ids);\n\t\treturn this._serialized(undefined, async () => {\n\t\t\tif (!this._db) return;\n\t\t\tthis._db.exec(\"PRAGMA secure_delete = ON;\");\n\t\t\tfor (const id of ids) { this._deleteSession(\"persisted\", id); this._deleteSession(\"live\", id); }\n\t\t\tthis._db.exec(\"VACUUM; PRAGMA wal_checkpoint(TRUNCATE);\");\n\t\t});\n\t}\n\t_deleteSession("
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-workspace/lib/index.js",
    "before": "931ca0cb10c5102066c7723690a887f0e6e8e7ab0ffdee1a782686745b0b934f",
    "after": "f91a3d0ea6482dd019f825d6c736e1b2d2a608d8dccd243f7f62ca704e6f1c77",
    "changes": [
      [
        "\tunpinSession(",
        "\tasync forgetPermanently(sessionId) {\n\t\tawait this.unarchiveSession(sessionId); await this.unpinSession(sessionId);\n\t\tfor (const workspace of this.list()) await workspace.detachSession(sessionId);\n\t\tthis.headers.delete(sessionId); this.sessionPaths.delete(sessionId); this.invalidSessionPaths.delete(sessionId);\n\t}\n\tunpinSession("
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-session-projection-cache/lib/index.js",
    "before": "faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80",
    "after": "c9596f3d79ec3f15ae0ba9a55be1df900ec2e1da9c2c6aa60915d2754bad95a0",
    "changes": [
      [
        "\tdirty = /* @__PURE__ */ new Map();",
        "\tdeletedIds = new Set();\n\tasync removePermanently(id) { this.deletedIds.add(id); for (const [session] of this.dirty) if (session.id === id) { this.markClean(session); this.dirty.delete(session); } await this.requireTable().delete(id); }\n\tdirty = /* @__PURE__ */ new Map();"
      ],
      [
        "\tasync put(id, identity, rows) {",
        "\tasync put(id, identity, rows) {\n\t\tif (this.deletedIds.has(id)) return;"
      ]
    ]
  },
  {
    "file": "@deepseek-ai/dsh-settings/lib/index.js",
    "before": "041a2682ed77a7025ceb9bf659b80db8b788c338cd1aa644f0bcc6bc122a4091",
    "after": "e9e325593e3a4f751de08e07ac8ade196a5835b5199dd7797f34187bec494d42",
    "changes": [
      [
        "const LEGACY_SECTION_ENTRIES = {",
        "const LEGACY_SECTION_ENTRIES = {\n\t\"noema-memory\": \"dsh-noema\","
      ]
    ]
  }
];
const helpers = [
  {
    "file": "@deepseek-ai/dsh-compaction-basic/lib/summary-budget.mjs",
    "sha256": "52ddd7849c119c7c7028a8b5b576e390ae438c349b59ab2d92154b93bf9ca6c8"
  },
  {
    "file": "@deepseek-ai/dsh-compaction-basic/lib/summary-checkpoint.mjs",
    "sha256": "9f5909ccf1cc0ad17a49f5cb95da67b6c850dce5ea80df54d07296ebada0e275"
  },
  {
    "file": "@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs",
    "sha256": "17da3fb22dcd7b209424b2a64894023cf54cdff4e0a37e1aae4f05c1bda99404"
  }
];
export const behaviorCompatibilityFiles = Object.freeze([...patches.map(p => p.file), ...helpers.map(p => p.file)]);
const maybeRead = async file => { try {return await readFile(file);} catch (e) {if (e.code === 'ENOENT') return null; throw e;} };
const same = (a, b) => a === null ? b === null : b !== null && a.equals(b);
async function atomic(file, bytes) {
  const temporary = file + '.' + randomUUID();
  let mode = 0o644;
  try { mode = (await stat(file)).mode & 0o777; } catch (e) {if (e.code !== 'ENOENT') throw e;}
  try {await writeFile(temporary, bytes, {flag: 'wx', mode}); await rename(temporary, file);}
  finally {await rm(temporary, {force: true});}
}
/** All file identities are checked before any mutation. Unknown/partial edits are refused. */
export async function applyBehaviorCompatibility(runtime, {beforeWrite} = {}) {
  const modules = path.join(runtime, 'node_modules');
  const core = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (core.version !== behaviorCompatibilityVersion) throw Error('行为兼容层只适用于 DSH ' + behaviorCompatibilityVersion);
  const plans = [];
  for (const patch of patches) {
    const file = path.join(modules, patch.file), before = await readFile(file), hash = sha(before);
    if (hash === patch.after) continue;
    if (hash !== patch.before) throw Error('核心文件有未知改动，未覆盖：' + patch.file);
    let text = before.toString('utf8');
    for (const [from, to] of patch.changes) {
      if (text.split(from).length !== 2) throw Error('行为兼容补丁未唯一命中：' + patch.file);
      text = text.replace(from, to);
    }
    const after = Buffer.from(text);
    if (sha(after) !== patch.after) throw Error('行为兼容补丁输出不匹配：' + patch.file);
    plans.push({file, before, after});
  }
  for (const helper of helpers) {
    const source = new URL('../overlays/' + helper.file, import.meta.url), after = await readFile(source);
    if (sha(after) !== helper.sha256) throw Error('摘要辅助模块来源有未知改动：' + helper.file);
    const file = path.join(modules, helper.file), before = await maybeRead(file);
    if (before !== null && sha(before) !== helper.sha256) throw Error('摘要辅助模块有未知改动，未覆盖：' + helper.file);
    if (before === null) plans.push({file, before, after});
  }
  const applied = [];
  try {
    for (const [index, plan] of plans.entries()) {
      await beforeWrite?.({index, file: plan.file});
      if (!same(await maybeRead(plan.file), plan.before)) throw Error('行为兼容文件发生并发修改');
      await atomic(plan.file, plan.after); applied.push(plan);
    }
  } catch (error) {
    const failures = [];
    for (const plan of applied.reverse()) try {
      if (!same(await maybeRead(plan.file), plan.after)) throw Error('回退时发现并发修改：' + plan.file);
      if (plan.before === null) await rm(plan.file); else await atomic(plan.file, plan.before);
    } catch (e) {failures.push(e);}
    if (failures.length) throw new AggregateError([error, ...failures], '行为兼容失败且部分文件需要手动恢复');
    throw error;
  }
  return {version: behaviorCompatibilityVersion, changed: plans.length, files: behaviorCompatibilityFiles, classification: behaviorClassification};
}
