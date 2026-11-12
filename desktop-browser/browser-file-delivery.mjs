/** 只把用户刚选择的文件交给原标签页；网页上传成功仍由网站自己的预览确认。 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function captureFileChooser(browser, tab, params) {
  const request = { requestId: randomUUID(), backendNodeId: params.backendNodeId, documentId: tab.documentId, multiple: params.mode === 'selectMultiple', accept: '', ready: false };
  tab.fileChooser = request;
  try {
    const { node } = await browser.send(tab, 'DOM.describeNode', { backendNodeId: params.backendNodeId });
    const attributes = node.attributes ?? [], index = attributes.indexOf('accept');
    if (index !== -1) request.accept = attributes[index + 1] ?? '';
  } catch { /* 网站删除了控件时，提交阶段会拒绝，不泄露网页或系统细节。 */ }
  if (tab.fileChooser === request && tab.documentId === request.documentId) { request.ready = true; browser.emit('fileChooser', tab.id); }
}

export function fileContext(tab, payload) {
  const { kind, requestId, point } = payload;
  if (!['input', 'paste', 'drop'].includes(kind)) throw Error('请选择文件上传方式');
  if (kind === 'input' && (!tab.fileChooser?.ready || tab.fileChooser.requestId !== requestId || tab.fileChooser.documentId !== tab.documentId)) throw Error('网页的文件选择请求已失效，请重新点击上传');
  if (kind === 'drop' && (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > (point.viewportWidth ?? tab.width) || point.y > (point.viewportHeight ?? tab.height))) throw Error('文件拖拽位置无效');
  return { documentId: tab.documentId, kind, requestId, ...(point ? { point } : {}) };
}

export function cancelFileChooser(tab, requestId) {
  if (tab.fileChooser?.requestId !== requestId) throw Error('文件选择请求已失效');
  // 不调用 setFileInputFiles([])：取消必须保留网页里原先选择的附件。
  tab.fileChooser = undefined;
}

export async function capturePasteTarget(browser, tab, context) {
  const result = await browser.send(tab, 'Runtime.evaluate', { expression: `(() => {
    let target = document.activeElement;
    while (target?.tagName === 'IFRAME') { try { target = target.contentDocument?.activeElement; } catch { target = null; } }
    return target && target !== target.ownerDocument.body && target !== target.ownerDocument.documentElement ? target : null;
  })()` });
  const objectId = result.result?.objectId;
  if (!objectId) throw Error('请先点击网页里的评论框，再粘贴图片；也可使用网页上传按钮');
  try {
    const { node } = await browser.send(tab, 'DOM.describeNode', { objectId });
    if (tab.documentId !== context.documentId) throw Error('网页已变化，请重新选择文件');
    return { ...context, pasteNodeId: node.backendNodeId };
  } finally { await browser.send(tab, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
}

export async function deliverBrowserFiles(browser, tab, context, files) {
  if (tab.documentId !== context.documentId) throw Error('网页已变化，请重新选择文件');
  if (context.kind === 'input') {
    fileContext(tab, context);
    const request = tab.fileChooser;
    if (!request.multiple && files.length !== 1) throw Error('网页只允许选择一个文件');
    await browser.send(tab, 'DOM.setFileInputFiles', { files: files.map(file => file.path), backendNodeId: request.backendNodeId });
    if (tab.fileChooser === request) tab.fileChooser = undefined;
  } else if (context.kind === 'drop') {
    const point = browser.pointerPoint(tab, context.point);
    const data = { items: [], files: files.map(file => file.path), dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      if (tab.documentId !== context.documentId) throw Error('网页已变化，请重新选择文件');
      await browser.send(tab, 'Input.dispatchDragEvent', { type, ...point, data });
    }
  } else {
    const data = await Promise.all(files.map(async file => ({ name: file.name, type: file.type, data: (await readFile(file.path)).toString('base64') })));
    if (tab.documentId !== context.documentId) throw Error('网页已变化，请重新选择文件');
    let objectId;
    try {
      const resolved = await browser.send(tab, 'DOM.resolveNode', { backendNodeId: context.pasteNodeId });
      objectId = resolved.object?.objectId;
      if (!objectId) throw Error('原评论框已变化');
      const result = await browser.send(tab, 'Runtime.callFunctionOn', {
        objectId, arguments: [{ value: data }], returnByValue: true,
        functionDeclaration: `function(files) {
          if (!this.isConnected) throw new Error('原评论框已变化');
          const view = this.ownerDocument.defaultView, transfer = new view.DataTransfer();
          for (const file of files) {
            const raw = atob(file.data), bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            transfer.items.add(new view.File([bytes], file.name, { type: file.type }));
          }
          this.dispatchEvent(new view.ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }));
          return true;
        }`,
      });
      if (result.exceptionDetails) throw Error('网页未接受图片');
    } catch {
      throw Error('原评论框已变化或未接受粘贴，请重新点击评论框或使用网页上传按钮');
    } finally { if (objectId) await browser.send(tab, 'Runtime.releaseObject', { objectId }).catch(() => {}); }
  }
  return { delivered: true, count: files.length, message: '文件已交给网页，请确认网页附件预览后再提交' };
}
