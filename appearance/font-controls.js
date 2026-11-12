export function fontControls({manage,save,form,notice}) {
  const el=id=>document.getElementById(id),list=el('local-font-list'),sample=el('local-font-sample');
  let current,sequence=0,previewFace,selected,busy=false,fonts=[];
  const message=text=>{el('font-notice').textContent=text;};
  const button=(text,action)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',()=>action().catch(e=>message(e.message)));return b;};
  async function browse(directory) {
    const data=await manage({action:'font.browse',directory});current=data.directory;
    el('font-directory').textContent=current;
    const folders=el('font-folders');folders.replaceChildren();
    if(data.parent)folders.append(button('↰ 上一级',()=>browse(data.parent)));
    for(const folder of data.folders)folders.append(button('📁 '+folder.name,()=>browse(folder.path)));
    message(data.truncated?'这里只列出前 300 个文件夹。':'打开文件夹后，点击“扫描这个文件夹”。');
  }
  function options(fonts) {
    for(const key of ['uiFont','codeFont']) {
      const select=form.elements.namedItem(key),value=select.value;
      select.querySelectorAll('option[data-local-font]').forEach(e=>e.remove());
      for(const font of fonts) {const option=document.createElement('option');option.value='local:'+font.id;option.textContent=font.name;option.dataset.localFont='';select.append(option);}
      if(value.startsWith('local:')&&!fonts.some(f=>'local:'+f.id===value)){const option=document.createElement('option');option.value=value;option.textContent='已保存的本地字体';option.dataset.localFont='';select.append(option);}
      select.value=value;
    }
  }
  async function preview(font) {
    const id=++sequence;message('正在加载样张…');el('use-local-font').disabled=true;
    const face=new FontFace('dshPreview_'+font.id,`url("/appearance-center/font?id=${font.id}")`);
    let timer;
    try {
      await Promise.race([face.load(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('字体加载超时，请换一个字体')),10000);})]);
      if(id!==sequence)return;
      if(previewFace)document.fonts.delete(previewFace);document.fonts.add(face);previewFace=face;
      sample.style.fontFamily=`"${face.family}",sans-serif`;sample.hidden=false;selected=font;
      el('font-selected-name').textContent=font.name;el('use-local-font').disabled=false;message('样张已就绪，点击“用这个字体”应用。');sample.scrollIntoView({block:'center'});
    } catch(e) {if(id===sequence){selected=null;message('这个字体无法预览：'+e.message);}}
    finally {clearTimeout(timer);}
  }
  function render(data) {
    fonts=data.fonts;options(fonts);renderList();
    message(data.fonts.length?`找到 ${data.fonts.length} 个字体，点一条查看样张。${data.truncated?'仅列出前 300 个。':''}`:'这个文件夹没有可用字体，支持 TTF、OTF、TTC、WOFF、WOFF2。');
  }
  function renderList(){list.replaceChildren();const query=el('font-search').value.trim().toLocaleLowerCase();for(const font of fonts.filter(f=>f.name.toLocaleLowerCase().includes(query))){const row=button(font.name,()=>preview(font));row.className='local-font-row';list.append(row);}}
  el('font-search').addEventListener('input',renderList);
  el('browse-font-folder').addEventListener('click',async()=>{
    if(busy)return;busy=true;
    try {
      const data=await manage({action:'font.status'});render(data);
      const shortcuts=el('font-shortcuts');shortcuts.replaceChildren();
      for(const shortcut of data.shortcuts)shortcuts.append(button(shortcut.name,()=>browse(shortcut.path)));
      el('font-browser').hidden=false;await browse(data.directory);
    } catch(e){message('无法打开字体目录：'+e.message);el('font-browser').hidden=false;}
    finally{busy=false;}
  });
  el('scan-font-folder').addEventListener('click',async()=>{
    if(busy||!current)return;busy=true;el('scan-font-folder').disabled=true;
    try{render(await manage({action:'font.scan',directory:current}));}catch(e){message('扫描失败：'+e.message);}finally{busy=false;el('scan-font-folder').disabled=false;}
  });
  el('use-local-font').addEventListener('click',async()=>{
    if(!selected||busy)return;busy=true;el('use-local-font').disabled=true;
    try {const key=el('font-target').value;await save({action:'configure',options:{[key]:'local:'+selected.id}});}
    finally{busy=false;el('use-local-font').disabled=!selected;}
  });
  // Preserve stored local choices even before the browser has been opened.
  return {refresh(state){for(const key of ['uiFont','codeFont']) {const value=state.options[key];if(!value?.startsWith('local:'))continue;const select=form.elements.namedItem(key);if(![...select.options].some(o=>o.value===value)){const option=document.createElement('option');option.value=value;option.textContent='已保存的本地字体';option.dataset.localFont='';select.append(option);}}},dispose(){sequence++;if(previewFace)document.fonts.delete(previewFace);}};
}
