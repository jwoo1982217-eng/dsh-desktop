// 显示真实工具参数及结果。生成中的代码不代表已经写入或执行。
const DSH_CODE_PREVIEW_LIMIT = 65536;
const DSH_CODE_LANGUAGES = {py:'python',pyw:'python',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',kt:'kotlin',kts:'kotlin',java:'java',rs:'rust',go:'go',c:'c',h:'c',cpp:'cpp',hpp:'cpp',cs:'csharp',sh:'bash',zsh:'bash',bash:'bash',json:'json',jsonl:'json',yaml:'yaml',yml:'yaml',toml:'toml',xml:'xml',html:'html',css:'css',scss:'scss',md:'markdown',sql:'sql',swift:'swift',dart:'dart',rb:'ruby',php:'php'};
function dshCodeLanguage(file) {
  return DSH_CODE_LANGUAGES[String(file || '').split('.').pop().toLowerCase()] || 'text';
}
function dshCodeProgressData(toolName, block) {
  const args = block?.args;
  const read = key => typeof args?.textPrefix === 'function' ? args.textPrefix(key, DSH_CODE_PREVIEW_LIMIT) : undefined;
  const file = read('file_path') || read('path') || '';
  const field = toolName === 'bash' ? 'command' : toolName === 'edit' ? 'new_string' : 'content';
  let code = read(field);
  if (code === undefined) return null;
  // 单行目录/文本查询继续使用原终端卡，避免历史搜索把代码区铺满。
  if (toolName === 'bash' && !code.includes('\n') && /^\s*(?:pwd|ls|find|rg|grep|sed|cat|head|tail|wc|file|stat|du|uname)\b/.test(code)) return null;
  let lang = toolName === 'bash' ? 'bash' : dshCodeLanguage(file);
  let label = file || (toolName === 'bash' ? '本机命令' : '文件内容');
  // Python/Node 的 here-document 是实际要运行的脚本，直接高亮脚本正文。
  if (toolName === 'bash') {
    const script = code.match(/^(?:python(?:3(?:\.\d+)?)?|node)\s+[^\n]*?<<\s*['"]?([A-Za-z_][\w]*)['"]?[^\n]*\n/);
    if (script) {
      lang = code.startsWith('node') ? 'javascript' : 'python';
      code = code.slice(script[0].length).replace(new RegExp('\\n' + script[1] + '\\s*$'), '');
      label = lang === 'python' ? '运行 Python 脚本' : '运行 JavaScript 脚本';
    }
  }
  return {code, lang, label, truncated: args.stringExceeds?.(field, DSH_CODE_PREVIEW_LIMIT) === true};
}
function DshCodeProgress({toolName, block, state, output}) {
  const data = dshCodeProgressData(toolName, block);
  const [collapsed, setCollapsed] = react.useState(false);
  const code = react.useDeferredValue(data?.code ?? '');
  if (!data || (data.code === '' && toolName !== 'edit')) return null;
  const generating = state === 'preparing';
  const status = generating ? (toolName === 'bash' ? '正在生成命令 · 尚未执行' : '正在生成代码 · 尚未写入')
    : state === 'running' ? (toolName === 'bash' ? '正在执行' : '正在写入')
    : state === 'error' ? '执行失败' : state === 'stopped' ? '已停止'
    : toolName === 'bash' ? '执行完成' : '文件操作完成';
  const CodeBlock = _deepseek_ai_dsh_client_ui_primitives.CodeBlock;
  return <section className="dsh-code-progress" data-code-progress={toolName} data-state={state}>
    <button type="button" className="dsh-code-progress-heading" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
      <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      <span className="dsh-code-progress-path">{data.label}</span>
      <span className="dsh-code-progress-state" role="status">{status}</span>
    </button>
    {!collapsed && <div className="dsh-code-progress-content">
      {code === '' ? <p className="dsh-code-progress-note">本次替换内容为空</p> : <CodeBlock code={code} lang={data.lang} streaming={generating} lineNumbers copyLabel="复制显示的代码" copiedLabel="已复制"/>}
      {data.truncated && <p className="dsh-code-progress-note">大文件仅预览部分内容，可打开文件查看全部。</p>}
      {!generating && state !== 'running' && output !== null && output !== undefined && <div className="dsh-code-progress-result">
        <span>{state === 'error' ? '错误信息' : '实际执行结果'}</span>
        <pre>{String(output).slice(0,16384)}</pre>
      </div>}
    </div>}
  </section>;
}
function DshProgressFileRow(props) {
  const model = toolRowModel(props.toolName, props.block, props.cwd, props.home);
  return <react.Fragment><FileMutationRow {...props}/><DshCodeProgress {...props} state={model.state} output={model.output}/></react.Fragment>;
}
function DshProgressBashRow(props) {
  const model = toolRowModel(props.toolName, props.block);
  const terminal = terminalCardModel(props.block);
  const state = model.state === 'ok' && terminal !== null && terminalFailed(terminal) ? 'error' : model.state;
  return <react.Fragment><BashRow {...props}/><DshCodeProgress {...props} state={state} output={model.output}/></react.Fragment>;
}
