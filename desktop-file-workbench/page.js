const GROUPS = [['internal', '自身文件', '▤'], ['workspace', '项目工作区', '▱'], ['shared', '共享目录', '↗']];
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const fileKey = (root, path) => JSON.stringify([root.id, root.generation, path]);
const isDirectory = entry => entry.kind === 'directory' || entry.kind === 'dir';
const join = (directory, name) => directory ? directory + '/' + name : name;
const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const samePlace = (a, b) => !!a && !!b && a.rootId === b.rootId && a.generation === b.generation && a.path === b.path;
const sizeLabel = bytes => !Number.isFinite(bytes) ? '—' : bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
const dateLabel = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; };
const abortError = error => error?.name === 'AbortError';

export function createWorkbench({ document: doc, window: win, fetch: request = win.fetch.bind(win), mount = doc.getElementById('app') }) {
  const state = { roots: [], csrf: '', limits: {}, ready: false, booting: false, bootError: '', place: null, entries: [], listing: false, listError: '', truncated: false, file: null, selected: null, drafts: new Map(), notice: '', error: '', search: null, query: '', content: false, imports: null };
  let placeGeneration = 0, readGeneration = 0, searchGeneration = 0, bootstrapGeneration = 0;
  let listController, readController, searchController, bootstrapController, modal = null, disposed = false;
  const pending = new Set(), listeners = [], objectURLs = new Set();
  const rootFor = place => state.roots.find(root => root.id === place?.rootId && root.generation === place.generation);
  const writable = root => root?.status === 'ready' && root.mode === 'read-write' && state.limits.providerAvailable !== false && state.limits.canWriteText !== false;
  const nativeAvailable = () => state.limits.providerAvailable !== false && state.limits.canNativeMutate !== false;
  const nativeWritable = root => writable(root) && nativeAvailable();
  const accessLabel = root => !writable(root) ? '只读' : nativeAvailable() ? '可读写' : '可编辑文本';
  const payload = (root, path = '') => ({ rootId: root.id, generation: root.generation, path });
  const dirtyFiles = () => [...state.drafts.values()].filter(file => file.dirty);
  function element(tag, attributes = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'class') node.className = value;
      else if (['value', 'checked', 'disabled', 'readOnly', 'hidden'].includes(key)) node[key] = value;
      else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(typeof child === 'object' ? child : doc.createTextNode(String(child)));
    return node;
  }
  const row = (...children) => element('div', { class: 'row' }, children);
  const button = (label, action, attributes = {}) => element('button', { type: 'button', onClick: () => safely(action), ...attributes }, label);
  const empty = (title, description, action) => element('div', { class: 'empty' }, element('span', { class: 'empty-mark', 'aria-hidden': 'true' }, '▱'), element('strong', {}, title), element('p', {}, description), action);
  const errorBox = (message, retry) => message && element('div', { class: 'error', role: 'alert' }, message, retry && row(button('重试', retry, { class: 'small' })));
  function listen(target, event, fn) { target.addEventListener(event, fn); listeners.push(() => target.removeEventListener(event, fn)); }
  function message(error) { return error?.message || '操作未完成，请重试。'; }
  async function safely(action) {
    try { await action(); } catch (error) { if (abortError(error) || disposed) return; state.error = message(error); render(); }
  }
  async function envelope(response) {
    let data;
    try { data = await response.json(); } catch { throw new Error(response.status === 401 ? '登录已失效，请重新打开 DSH 后重试。' : '文件服务返回异常（' + response.status + '），请重试。'); }
    if (!response.ok || data?.ok !== true) {
      const error = new Error(data?.error?.message || (response.status === 401 ? '登录已失效，请重新打开 DSH 后重试。' : '操作未完成（' + response.status + '），请重试。'));
      error.code = data?.error?.code; error.status = response.status; throw error;
    }
    return data.value;
  }
  async function manage(action, args = {}, signal) {
    return envelope(await request('/desktop-files/api/manage', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-DSH-Files-CSRF': state.csrf }, body: JSON.stringify({ action, ...args }), signal }));
  }
  async function exclusive(key, action) {
    if (pending.has(key)) return;
    pending.add(key); render();
    try { return await action(); } finally { pending.delete(key); if (!disposed) render(); }
  }
  async function bootstrap() {
    const generation = ++bootstrapGeneration;
    bootstrapController?.abort(); bootstrapController = new AbortController();
    state.booting = true; state.bootError = ''; render();
    try {
      const value = await envelope(await request('/desktop-files/api/bootstrap', { credentials: 'same-origin', signal: bootstrapController.signal }));
      if (disposed || generation !== bootstrapGeneration) return;
      state.csrf = value.csrf; state.roots = value.roots; state.limits = value.limits || {}; state.ready = true;
    } catch (error) { if (!abortError(error) && generation === bootstrapGeneration) state.bootError = message(error); }
    finally { if (generation === bootstrapGeneration && !disposed) { state.booting = false; render(); } }
  }
  async function refreshRoots() {
    await exclusive('roots', async () => {
      const value = await manage('roots.list'); state.roots = value.roots;
      if (state.place && !rootFor(state.place)) {
        clearRequests(); state.place = null; state.file = null; state.selected = null;
        state.notice = '目录映射已变更。未保存草稿仍保留在左侧。';
      }
    });
  }
  function clearRequests() {
    ++placeGeneration; ++readGeneration; ++searchGeneration;
    listController?.abort(); readController?.abort(); searchController?.abort();
  }
  async function navigate(root, path = '', openPath) {
    if (!root || root.status !== 'ready') { state.error = root?.message || '这个目录暂时不可用，请刷新目录后重试。'; render(); return; }
    clearRequests();
    state.place = { rootId: root.id, generation: root.generation, path };
    state.file = null; state.selected = null; state.entries = []; state.search = null; state.query = ''; state.listError = ''; state.error = '';
    render();
    const listing = loadList();
    if (openPath) openFile({ path: openPath, name: openPath.split('/').pop(), kind: 'file' });
    await listing;
  }
  async function loadList() {
    const place = { ...state.place }, generation = placeGeneration, root = rootFor(place);
    if (!root) return;
    listController?.abort(); const controller = listController = new AbortController();
    state.listing = true; state.listError = ''; render();
    try {
      const value = await manage('list', payload(root, place.path), controller.signal);
      if (disposed || generation !== placeGeneration || controller !== listController || !samePlace(place, state.place)) return;
      state.entries = [...value.entries].sort((a, b) => Number(isDirectory(b)) - Number(isDirectory(a)) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.path.localeCompare(b.path));
      state.truncated = value.truncated;
      if (state.selected) {
        const updated = state.entries.find(entry => entry.path === state.selected.path);
        if (updated) state.selected = updated;
      }
    } catch (error) { if (!abortError(error) && generation === placeGeneration && controller === listController) state.listError = message(error); }
    finally { if (generation === placeGeneration && controller === listController && !disposed) { state.listing = false; render(); } }
  }
  async function openFile(entry) {
    const root = rootFor(state.place); if (!root || entry.blocked) return;
    if (isDirectory(entry)) return navigate(root, entry.path);
    const generation = ++readGeneration, navigation = placeGeneration, key = fileKey(root, entry.path);
    readController?.abort(); const controller = readController = new AbortController();
    state.selected = entry; state.error = '';
    const draft = state.drafts.get(key);
    if (draft?.dirty) { state.file = draft; render(); return; }
    const file = { key, rootId: root.id, generation: root.generation, path: entry.path, name: entry.name, text: '', baseText: '', version: entry.version, loading: true, dirty: false, editable: false };
    state.file = file; render();
    try {
      const value = await manage('read', payload(root, entry.path), controller.signal);
      if (disposed || generation !== readGeneration || navigation !== placeGeneration || state.file !== file || file.dirty) return;
      Object.assign(file, { text: value.text, baseText: value.text, version: value.version, editable: value.editable === true, size: value.size, loading: false });
    } catch (error) { if (!abortError(error) && generation === readGeneration && navigation === placeGeneration && state.file === file) { file.error = message(error); file.loading = false; } }
    finally { if (generation === readGeneration && navigation === placeGeneration && !disposed) render(); }
  }
  function updateDraft(file, text) {
    file.text = text; file.dirty = file.version === null || text !== file.baseText; file.error = '';
    if (file.dirty) state.drafts.set(file.key, file); else state.drafts.delete(file.key);
    const save = mount.querySelector('[data-save]'); if (save) save.disabled = !file.dirty || file.saving || !writable(rootFor(filePlace(file)));
    const status = mount.querySelector('[data-editor-status]'); if (status) status.textContent = draftStatus(file);
    renderDrafts();
  }
  const filePlace = file => ({ rootId: file.rootId, generation: file.generation });
  const draftStatus = file => file.saving ? '正在保存…可继续编辑' : file.dirty ? '有未保存内容 · 切换目录会保留草稿，关闭页面前请保存或导出' : '已保存' + (file.size !== undefined ? ' · ' + sizeLabel(file.size) : '');
  async function saveFile(file) {
    if (!file || file.saving || !file.dirty) return;
    const root = rootFor(filePlace(file)); if (!writable(root)) throw new Error('当前目录不可写。编辑内容仍在草稿中，可以导出。');
    const text = file.text, version = file.version;
    if (typeof version !== 'string' && version !== null) throw new Error('文件版本尚未读取，请先重新打开文件。');
    file.saving = true; file.error = ''; render();
    try {
      const value = await manage('write', { ...payload(root, file.path), text, version });
      file.version = value.version; file.baseText = text; file.size = value.size; file.dirty = file.text !== text; file.conflict = false;
      if (!file.dirty) state.drafts.delete(file.key);
      if (samePlace(state.place, { ...filePlace(file), path: parentPath(file.path) })) await loadList();
    } catch (error) { file.error = message(error); file.conflict = error.status === 409; }
    finally { file.saving = false; if (!disposed) render(); }
  }
  function localDownload(blob, name) {
    const url = win.URL.createObjectURL(blob); objectURLs.add(url);
    const link = element('a', { href: url, download: name, hidden: true }); doc.body.append(link); link.click(); link.remove();
    win.setTimeout(() => { win.URL.revokeObjectURL(url); objectURLs.delete(url); }, 30000);
  }
  function downloadDraft(file) { localDownload(new win.Blob([file.text], { type: 'text/plain;charset=utf-8' }), file.name); }
  async function exportFile(entry = state.selected, root = rootFor(state.place)) {
    if (!entry || !root || !entry.version) throw new Error('尚未取得文件版本，请刷新目录后重试导出。');
    await exclusive('export:' + fileKey(root, entry.path), async () => {
      const ticket = await manage('export.prepare', { ...payload(root, entry.path), version: entry.version });
      const response = await request('/desktop-files/export/' + encodeURIComponent(ticket.id), { credentials: 'same-origin' });
      if (!response.ok) { await envelope(response); return; }
      localDownload(await response.blob(), ticket.filename);
      state.notice = '已准备下载：' + ticket.filename + '。';
    });
  }
  function openDraft(file) {
    const root = rootFor(filePlace(file));
    if (!root || root.status !== 'ready') { state.file = file; state.selected = null; state.notice = '原目录目前不可用，草稿可以导出保留。'; render(); return; }
    navigate(root, parentPath(file.path), file.path);
  }
  async function search() {
    const root = rootFor(state.place), place = { ...state.place }, navigation = placeGeneration, query = state.query.trim();
    if (!root || !query) return;
    const generation = ++searchGeneration; searchController?.abort(); const controller = searchController = new AbortController();
    state.search = { loading: true, matches: [], query, content: state.content }; render();
    try {
      const value = await manage('search', { ...payload(root, place.path), query, content: state.content }, controller.signal);
      if (disposed || generation !== searchGeneration || navigation !== placeGeneration || controller !== searchController) return;
      state.search = { ...value, query, loading: false };
    } catch (error) { if (!abortError(error) && generation === searchGeneration && navigation === placeGeneration) state.search = { query, matches: [], error: message(error) }; }
    finally { if (generation === searchGeneration && navigation === placeGeneration && !disposed) render(); }
  }
  function cancelSearch() { ++searchGeneration; searchController?.abort(); state.search = null; render(); }
  function copyPath() {
    const root = rootFor(state.place); if (!root) return;
    const separator = root.path.includes('\\') && !root.path.includes('/') ? '\\' : '/';
    const path = root.path.replace(/[\\/]$/, '') + (state.place.path ? separator + state.place.path.split('/').join(separator) : '');
    return win.navigator.clipboard?.writeText(path).then(() => { state.notice = '已复制当前目录路径。'; render(); }, () => showPath(path)) ?? showPath(path);
  }
  function showPath(path) { const box = element('input', { value: path, readOnly: true, 'aria-label': '当前目录路径' }); dialog('当前目录路径', element('div', {}, element('p', {}, '可以选择并复制下面的完整路径。'), box), [{ label: '完成', action: closeDialog }]); box.focus(); box.select(); }
  function closeDialog() { if (!modal) return; const previous = modal.previous; modal.node.remove(); modal = null; previous?.focus?.(); }
  function dialog(title, body, actions) {
    closeDialog(); const previous = doc.activeElement;
    const heading = element('h2', { id: 'files-dialog-title' }, title), error = element('div', { class: 'error', role: 'alert', hidden: true });
    const panel = element('section', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'files-dialog-title', tabIndex: -1 }, heading, body, error);
    const overlay = element('div', { class: 'overlay' }, panel); modal = { node: overlay, panel, error, previous, busy: false };
    const active = modal;
    const footer = element('footer', {}, actions.map(item => button(item.label, async () => {
      if (active.busy || modal !== active) return;
      active.busy = true; error.hidden = true;
      for (const node of footer.querySelectorAll('button')) node.disabled = true;
      try { await item.action(active); } catch (failure) { if (modal === active) { error.textContent = message(failure); error.hidden = false; } }
      finally { active.busy = false; for (const node of footer.querySelectorAll('button')) node.disabled = false; }
    }, { class: item.class || '', 'data-confirm': item.confirm ? '' : undefined })));
    panel.append(footer); doc.body.append(overlay);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !active.busy) { event.preventDefault(); closeDialog(); }
      if (event.key === 'Tab') {
        const nodes = [...panel.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(node => !node.disabled && node.tabIndex !== -1);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (doc.activeElement === first || doc.activeElement === panel)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    (panel.querySelector('input,select,textarea') || panel).focus(); return active;
  }
  const field = (label, control) => element('label', { class: 'field' }, label, control);
  function nameDialog(kind, entry) {
    const root = rootFor(state.place), place = { ...state.place }; if (!writable(root)) return;
    if (kind !== 'file' && !nativeWritable(root)) throw new Error('当前连接只支持文本编辑，暂不能新建目录或改名。');
    const input = element('input', { value: entry?.name || '', maxLength: 255, autocomplete: 'off', 'aria-label': '名称', 'data-focus': 'new-name' });
    const title = kind === 'directory' ? '新建目录' : kind === 'rename' ? '文件改名' : '新建文本文件';
    dialog(title, element('div', {}, element('p', {}, kind === 'file' ? '输入文件名后开始编辑，保存时创建文件。' : '在当前目录中整理文件。'), field('名称', input)), [
      { label: '取消', action: closeDialog },
      { label: kind === 'file' ? '开始编辑' : '确定', class: 'primary', confirm: true, action: async () => {
        const name = input.value.trim();
        if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name)) throw new Error('请输入单个有效名称，不要包含路径分隔符。');
        if (kind === 'file') {
          const path = join(place.path, name), key = fileKey(root, path);
          if (state.entries.some(item => item.path === path) || state.drafts.get(key)?.dirty) throw new Error('这个名称已存在，请换一个名称。');
          const file = { key, rootId: root.id, generation: root.generation, path, name, text: '', baseText: '', version: null, editable: true, dirty: true };
          ++readGeneration; readController?.abort(); state.file = file; state.drafts.set(key, file); state.selected = null; closeDialog(); render();
          mount.querySelector('[data-focus="editor"]')?.focus(); return;
        }
        if (kind === 'rename') {
          if (state.drafts.get(fileKey(root, entry.path))?.dirty) throw new Error('这个文件有未保存草稿，请先保存或导出草稿。');
          if (!entry.version) throw new Error('尚未取得文件版本，请刷新目录后重试。');
          await manage('rename', { ...payload(root, entry.path), to: join(place.path, name), version: entry.version });
          if (state.file?.path === entry.path && state.file.rootId === root.id) state.file = null;
        } else await manage('mkdir', payload(root, join(place.path, name)));
        closeDialog(); if (samePlace(place, state.place)) await loadList();
      } },
    ]);
  }
  function addShared() {
    const path = element('input', { placeholder: '/Users/…', autocomplete: 'off', 'aria-label': '共享目录路径' });
    const label = element('input', { placeholder: '例如：写作素材', maxLength: 100, 'aria-label': '共享目录名称' });
    const mode = element('select', { 'aria-label': '共享目录权限' }, element('option', { value: 'read-only' }, '只读 · 浏览与导出'), element('option', { value: 'read-write' }, '可读写 · 允许编辑与导入'));
    mode.value = 'read-only';
    dialog('添加共享目录', element('div', {}, element('p', {}, '选择你希望在这里使用的本机目录。添加前会再次确认路径与权限。'), field('目录完整路径', path), field('显示名称（可选）', label), field('使用权限', mode)), [
      { label: '取消', action: closeDialog },
      { label: '查看并确认', class: 'primary', action: async () => {
        if (!path.value.trim()) throw new Error('请输入目录的完整路径。');
        const value = await manage('roots.planAdd', { path: path.value.trim(), label: label.value.trim(), mode: mode.value });
        confirmShared(value);
      } },
    ]);
  }
  function confirmShared(plan) {
    const readWrite = plan.root.mode === 'read-write';
    const check = element('input', { type: 'checkbox', 'aria-label': '确认允许写入此目录' });
    dialog('确认共享目录', element('div', {}, element('p', {}, '请核对这个实际目录及其使用权限。'), element('strong', {}, plan.root.label), element('code', { class: 'plan-path' }, plan.root.path), element('p', {}, '权限：' + (readWrite ? '可读写，可编辑、新建和导入文件。' : '只读，可浏览、搜索和导出文件。')), readWrite && element('label', { class: 'check' }, check, '我确认允许在此目录中新建和修改文件。')), [
      { label: '取消', action: closeDialog },
      { label: '添加目录', class: 'primary', confirm: true, action: async () => {
        if (readWrite && !check.checked) throw new Error('请先勾选确认，允许写入这个目录。');
        const value = await manage('roots.add', { planId: plan.planId, confirm: true });
        closeDialog(); await refreshRoots(); await navigate(value.root); state.notice = '共享目录已添加。'; render();
      } },
    ]);
  }
  function removeShared(root) {
    dialog('解除共享目录', element('div', {}, element('p', {}, '解除后，这个目录将从文件区移除。原目录和文件会保留。'), element('code', { class: 'plan-path' }, root.path), element('p', {}, dirtyFiles().some(file => file.rootId === root.id) ? '此目录还有未保存草稿，解除后仍可从左侧导出。' : '可以之后重新添加这个目录。')), [
      { label: '取消', action: closeDialog },
      { label: '解除共享', class: 'danger', confirm: true, action: async () => {
        await manage('roots.remove', { rootId: root.id, generation: root.generation, confirm: true });
        closeDialog(); await refreshRoots(); state.notice = '已解除共享，原目录和文件已保留。'; render();
      } },
    ]);
  }
  async function importFiles(files, target) {
    if (pending.has('import')) return;
    const root = rootFor(target); if (!nativeWritable(root)) throw new Error('当前连接或目录不支持导入文件，请选择可写目录后重试。');
    const batch = Array.from(files); if (!batch.length) return;
    const failures = [], limit = Math.min(MAX_IMPORT_BYTES, state.limits.maxImportBytes || MAX_IMPORT_BYTES); let next = 0, done = 0;
    state.imports = { total: batch.length, done: 0, failures, target }; state.error = '';
    await exclusive('import', async () => {
      async function worker() {
        while (next < batch.length) {
          const file = batch[next++];
          try {
            if (file.size > limit) throw new Error('超过单文件 ' + sizeLabel(limit) + ' 上限。');
            if (!file.name || /[\\/\u0000-\u001f]/.test(file.name)) throw new Error('只支持具有有效名称的普通文件。');
            const params = new URLSearchParams({ rootId: root.id, generation: String(root.generation), path: target.path });
            await envelope(await request('/desktop-files/api/import?' + params, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-DSH-Files-CSRF': state.csrf, 'X-DSH-File-Name': encodeURIComponent(file.name) }, body: file }));
          } catch (error) { failures.push({ file, message: message(error) }); }
          state.imports.done = ++done; if (!disposed) render();
        }
      }
      await Promise.all([worker(), worker()]);
      if (samePlace(target, state.place)) await loadList();
      state.notice = '导入完成：' + (batch.length - failures.length) + ' 个成功' + (failures.length ? '，' + failures.length + ' 个未导入。' : '。');
    });
  }
  function chooseImport() {
    if (!nativeWritable(rootFor(state.place))) throw new Error('当前连接或目录不支持导入文件。');
    const target = { ...state.place }, input = element('input', { type: 'file', multiple: '', hidden: true }); doc.body.append(input);
    input.addEventListener('change', () => { safely(() => importFiles(input.files, target)); input.remove(); });
    input.addEventListener('cancel', () => input.remove()); input.click();
  }
  function conflictDialog(file) {
    dialog('重新读取文件', element('p', {}, '重新读取将用磁盘上的最新内容替换此处草稿。可以先取消并导出草稿。'), [
      { label: '取消', action: closeDialog },
      { label: '导出草稿', action: () => downloadDraft(file) },
      { label: '放弃草稿并读取', class: 'danger', action: async () => {
        const root = rootFor(filePlace(file)); if (!root) throw new Error('原目录目前不可用，草稿已保留。');
        // Keep the old draft until a fresh read has actually succeeded.
        const value = await manage('read', payload(root, file.path));
        Object.assign(file, { text: value.text, baseText: value.text, version: value.version, size: value.size, dirty: false, conflict: false, error: '', editable: value.editable === true });
        state.drafts.delete(file.key); closeDialog(); render();
      } },
    ]);
  }
  function renderDrafts() {
    const slot = mount.querySelector('[data-drafts]'); if (!slot) return;
    const files = dirtyFiles(); slot.replaceChildren(); slot.hidden = !files.length;
    if (files.length) slot.append(element('div', { class: 'group-title' }, '未保存草稿 · ' + files.length), ...files.map(file => button(file.name, () => openDraft(file), { class: 'draft-button', title: file.path })));
  }
  function sidebar() {
    return element('aside', { class: 'sidebar', 'aria-label': '文件目录' }, GROUPS.map(([kind, label, icon]) => {
      const roots = state.roots.filter(root => root.kind === kind);
      return element('section', { class: 'root-group' }, element('div', { class: 'group-title' }, label, kind === 'shared' && button('＋', addShared, { title: '添加共享目录', 'aria-label': '添加共享目录', disabled: !state.ready })), roots.length ? roots.map(root => button(element('span', { class: 'root-text' }, element('span', { class: 'root-label' }, root.label), element('small', {}, root.status !== 'ready' ? root.message || '暂不可用' : accessLabel(root))), () => navigate(root), { class: 'root-button' + (state.place?.rootId === root.id ? ' active' : ''), title: root.path, 'aria-pressed': state.place?.rootId === root.id })) : element('p', { class: 'sidebar-empty' }, state.ready ? kind === 'shared' ? '按需添加本机目录' : '暂无目录' : '正在读取…'));
    }), element('div', { class: 'draft-list', 'data-drafts': '', hidden: true }));
  }
  function breadcrumbs(root) {
    const parts = state.place.path ? state.place.path.split('/') : [];
    return element('nav', { class: 'breadcrumbs', 'aria-label': '当前目录' }, button(root.label, () => navigate(root), { class: !parts.length ? 'current' : '', 'aria-current': !parts.length ? 'page' : undefined }), parts.map((part, index) => [element('span', { class: 'crumb-separator', 'aria-hidden': true }, '›'), button(part, () => navigate(root, parts.slice(0, index + 1).join('/')), { class: index === parts.length - 1 ? 'current' : '', 'aria-current': index === parts.length - 1 ? 'page' : undefined })]));
  }
  function fileTools(root) {
    return element('div', { class: 'toolbar' },
      button('新文件', () => nameDialog('file'), { disabled: !writable(root) }),
      nativeAvailable() && button('新目录', () => nameDialog('directory'), { disabled: !nativeWritable(root) }),
      nativeAvailable() && button(pending.has('import') ? '正在导入…' : '导入文件', chooseImport, { disabled: !nativeWritable(root) || pending.has('import') }),
      !writable(root) ? element('small', {}, '当前仅支持浏览、搜索和导出') : !nativeAvailable() && element('small', {}, '当前连接支持文本编辑与新建'));
  }
  function listPanel(root) {
    const result = state.search;
    if (result) return element('section', { class: 'card', 'aria-label': '搜索结果' }, element('div', { class: 'list-header' }, element('span', {}, result.loading ? '正在搜索当前目录…' : '“' + result.query + '” · ' + result.matches.length + ' 个结果'), button(result.loading ? '取消' : '返回文件', cancelSearch, { class: 'small' })), result.error ? errorBox(result.error, search) : result.loading ? element('p', { class: 'loading', role: 'status' }, '正在查找，请稍候…') : element('div', { class: 'file-scroll' }, result.matches.length ? result.matches.map(match => button([element('strong', {}, match.path + (match.line ? ' · 第 ' + match.line + ' 行' : '')), match.snippet !== undefined && element('p', {}, match.snippet)], () => isDirectory(match) ? navigate(root, match.path) : navigate(root, parentPath(match.path), match.path), { class: 'search-result' })) : empty('没有找到匹配文件', '试试更短的关键词，或切换名称与内容搜索。')), result.truncated && element('p', { class: 'list-footer' }, '已达到本次搜索上限，请缩小目录或细化关键词。'), result.scanned !== undefined && element('p', { class: 'list-footer' }, '本次检查 ' + result.scanned + ' 项。'));
    return element('section', { class: 'card', 'aria-label': '当前目录文件' }, element('div', { class: 'list-header' }, element('span', {}, state.listing ? '正在读取目录…' : state.entries.length + ' 项'), button('刷新', loadList, { class: 'small', disabled: state.listing })), state.listError ? errorBox(state.listError, loadList) : element('div', { class: 'file-scroll', 'aria-busy': state.listing }, state.entries.length ? element('table', { class: 'files' }, element('thead', {}, element('tr', {}, element('th', {}, '名称'), element('th', { class: 'size' }, '大小'), element('th', { class: 'date' }, '修改时间'), element('th', { class: 'action' }, element('span', { class: 'visually-hidden' }, '操作')))), element('tbody', {}, state.entries.map(entry => element('tr', { class: [state.selected?.path === entry.path ? 'selected' : '', entry.blocked ? 'blocked' : ''].join(' ') }, element('td', {}, button([element('span', { class: 'file-kind', 'aria-hidden': true }, isDirectory(entry) ? '▱' : '▤'), element('span', { class: 'name' }, entry.name)], () => openFile(entry), { class: 'file-open', title: entry.blocked ? '此项目不可访问' : entry.name, disabled: !!entry.blocked })), element('td', { class: 'size' }, isDirectory(entry) ? '—' : sizeLabel(entry.size)), element('td', { class: 'date', title: entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '' }, dateLabel(entry.modifiedAt)), element('td', { class: 'action' }, !isDirectory(entry) && !entry.blocked && nativeWritable(root) && entry.version && button('改名', () => nameDialog('rename', entry), { class: 'rename-button', 'aria-label': '改名 ' + entry.name })))))) : state.listing ? element('p', { class: 'loading', role: 'status' }, '正在读取…') : empty('这个目录还是空的', writable(root) ? nativeAvailable() ? '新建文件，或导入本机文件开始整理。' : '新建文本文件，开始整理。' : '此目录以只读方式打开。')), state.truncated && element('p', { class: 'list-footer' }, '当前只显示部分项目，可用名称搜索查找文件。'));
  }
  function editorPanel() {
    const file = state.file;
    if (!file) return element('section', { class: 'card editor-placeholder' }, empty('选择文件，开始查看', '文本可以直接编辑；其他普通文件可以导出。未保存内容会保留为本页草稿。'));
    const root = rootFor(filePlace(file)), canWrite = writable(root) && file.editable;
    const exportEntry = file.version ? { path: file.path, version: file.version } : state.selected?.path === file.path ? state.selected : { path: file.path };
    return element('section', { class: 'card', 'aria-label': '文件预览与编辑' }, element('header', { class: 'editor-header' }, element('div', {}, element('h2', { class: 'editor-title' }, file.name), element('p', { class: 'editor-path' }, file.path)), row(file.dirty && button('导出草稿', () => downloadDraft(file), { class: 'small' }), button('导出文件', () => exportFile(exportEntry, root), { class: 'small', disabled: !root || !exportEntry.version || pending.has('export:' + file.key) }), file.editable && button(file.saving ? '保存中…' : '保存', () => saveFile(file), { class: 'primary small', 'data-save': '', disabled: !canWrite || !file.dirty || file.saving }))), file.conflict && element('div', { class: 'conflict' }, element('p', {}, '文件已在其他地方改变，保存没有覆盖原文件。你的编辑仍保留在这里。'), row(button('导出草稿', () => downloadDraft(file), { class: 'small' }), button('重新读取文件…', () => conflictDialog(file), { class: 'small' }))), file.error && element('div', { class: 'editor-error' }, errorBox(file.error, file.editable ? () => saveFile(file) : () => openFile(state.selected))), file.loading ? element('p', { class: 'loading', role: 'status' }, '正在读取文件…') : file.editable ? element('textarea', { class: 'editor-text', 'aria-label': '文件内容', 'data-focus': 'editor', spellcheck: 'false', value: file.text, readOnly: !canWrite, onInput: event => updateDraft(file, event.target.value), onKeyDown: event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); safely(() => saveFile(file)); } } }) : element('div', { class: 'editor-hint' }, '此文件暂不能作为文本预览。可以导出原文件查看。'), element('footer', { class: 'editor-status', 'data-editor-status': '', role: 'status' }, file.loading ? '读取后显示文件内容' : file.editable ? !canWrite && !file.dirty ? '只读 · ' + sizeLabel(file.size) : draftStatus(file) : '原文件保持不变'));
  }
  function render() {
    if (disposed) return;
    const focus = doc.activeElement, focusKey = focus?.getAttribute?.('data-focus'), selection = focusKey ? [focus.selectionStart, focus.selectionEnd, focus.scrollTop] : null;
    const root = rootFor(state.place);
    let body;
    if (!state.ready) body = element('main', { class: 'main' }, state.bootError ? errorBox(state.bootError, bootstrap) : element('p', { class: 'loading', role: 'status' }, '正在打开文件…'));
    else if (!state.place && !state.file) body = element('main', { class: 'main' }, state.error && errorBox(state.error), state.notice && element('p', { class: 'notice', role: 'status' }, state.notice), element('section', { class: 'card' }, empty('文件，放在顺手的地方', '从左侧选择自身文件、项目工作区，或添加一个本机共享目录。', button('添加共享目录', addShared, { class: 'primary' }))));
    else body = element('main', { class: 'main' }, state.error && errorBox(state.error), state.notice && element('div', { class: 'notice', role: 'status' }, row(element('span', {}, state.notice), button('收起', () => { state.notice = ''; render(); }, { class: 'small' }))), root && [element('div', { class: 'intro row between' }, breadcrumbs(root), row(element('span', { class: 'badge' }, accessLabel(root)), root.kind === 'shared' && button('解除共享', () => removeShared(root), { class: 'small' }))), element('div', { class: 'pathbar' }, element('code', { class: 'host-path', title: root.path + (state.place.path ? '/' + state.place.path : '') }, root.path + (state.place.path ? '/' + state.place.path : '')), button('复制路径', copyPath, { class: 'small' })), fileTools(root), element('form', { class: 'search-form', onSubmit: event => { event.preventDefault(); safely(search); } }, element('input', { type: 'search', value: state.query, placeholder: '搜索当前目录及子目录', 'aria-label': '搜索当前目录', 'data-focus': 'search', onInput: event => { state.query = event.target.value; } }), element('label', { class: 'check' }, element('input', { type: 'checkbox', checked: state.content, onChange: event => { state.content = event.target.checked; } }), '搜索文本内容'), element('button', { type: 'submit', disabled: !!state.search?.loading }, '搜索')), state.imports && (pending.has('import') ? element('p', { class: 'notice', role: 'status' }, '正在导入 ' + state.imports.done + ' / ' + state.imports.total + '…') : state.imports.failures.length ? element('div', { class: 'error', role: 'alert' }, state.imports.failures.map(failure => element('p', {}, failure.file.name + '：' + failure.message)), row(button('重试未导入文件', () => importFiles(state.imports.failures.map(item => item.file), state.imports.target), { class: 'small' }), button('收起', () => { state.imports = null; render(); }, { class: 'small' }))) : null)], element('div', { class: 'work-area' }, root && listPanel(root), editorPanel()));
    mount.replaceChildren(element('header', { class: 'top' }, element('div', { class: 'brand' }, element('span', { class: 'mark', 'aria-hidden': true }, '▱'), element('div', {}, element('h1', {}, '文件'), element('small', {}, '浏览、编辑和整理本机文件'))), row(button('刷新目录', refreshRoots, { disabled: !state.ready || pending.has('roots') }), button('添加共享目录', addShared, { disabled: !state.ready }))), element('div', { class: 'layout' }, sidebar(), body));
    renderDrafts();
    if (focusKey && !modal) {
      const target = [...mount.querySelectorAll('[data-focus]')].find(node => node.getAttribute('data-focus') === focusKey);
      if (target) { target.focus({ preventScroll: true }); if (selection?.[0] !== null && typeof target.setSelectionRange === 'function') target.setSelectionRange(selection[0], selection[1]); target.scrollTop = selection[2]; }
    }
  }
  function syncTheme() {
    try {
      if (win.parent === win) return;
      const parent = win.parent.document, body = parent.body, html = parent.documentElement;
      const styles = win.getComputedStyle(body), tokens = { '--bg': '--dsw-alias-bg-base', '--card': '--dsw-alias-bg-layer-1', '--ink': '--dsw-alias-label-primary', '--muted': '--dsw-alias-label-secondary', '--accent': '--dsw-alias-brand-primary', '--line': '--dsw-alias-border-primary' };
      const scheme = styles.colorScheme;
      doc.documentElement.dataset.theme = body.hasAttribute('data-ds-dark-theme') || scheme === 'dark' ? 'dark' : scheme === 'light' ? 'light' : '';
      for (const [target, source] of Object.entries(tokens)) { const value = styles.getPropertyValue(source).trim(); if (value) doc.documentElement.style.setProperty(target, value); else doc.documentElement.style.removeProperty(target); }
      const family = styles.getPropertyValue('--dsw-font-family').trim(); if (family) doc.documentElement.style.fontFamily = family;
    } catch { /* The system palette remains usable when opened on its own. */ }
  }
  const beforeUnload = event => { if (dirtyFiles().length) { event.preventDefault(); event.returnValue = ''; } };
  listen(win, 'beforeunload', beforeUnload);
  listen(win, 'focus', syncTheme);
  listen(win, 'message', event => { if (event.source === win.parent && event.origin === win.location.origin && ['dsh:appearance-mode', 'dsh:appearance-center'].includes(event.data?.type)) syncTheme(); });
  let themeObserver;
  try { if (win.parent !== win && win.MutationObserver) { themeObserver = new win.MutationObserver(syncTheme); themeObserver.observe(win.parent.document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] }); } } catch { /* Standalone pages follow the system. */ }
  syncTheme(); render();
  return { start: bootstrap, dispose() { disposed = true; clearRequests(); bootstrapController?.abort(); listeners.forEach(remove => remove()); themeObserver?.disconnect(); closeDialog(); objectURLs.forEach(url => win.URL.revokeObjectURL(url)); objectURLs.clear(); } };
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  const workbench = createWorkbench({ document, window }); workbench.start();
  window.addEventListener('pagehide', () => workbench.dispose(), { once: true });
}
