const palette = [['红色','#e75b64'],['橙色','#ed964b'],['黄色','#e6bf4f'],['绿色','#38956c'],['青色','#329ca4'],['蓝色','#497de2'],['紫色','#9566ce'],['粉色','#df8daf'],['白色','#ffffff'],['浅灰','#e8ecef'],['深灰','#30343b'],['黑色','#111318']];
export function colorControls(form) {
  for (const name of ['accent','background','foreground']) {
    const value = form.elements.namedItem(name), box = form.querySelector(`[data-color-control="${name}"]`);
    const picker = box.querySelector('input[type=color]'), status = box.querySelector('output');
    const update = color => { value.value=color; picker.value=color||({accent:'#497de2',background:'#ffffff',foreground:'#30343b'}[name]); status.textContent=color?'已选自定义颜色':'沿用主题'; };
    picker.addEventListener('input',()=>update(picker.value));
    for (const [label,color] of palette) {
      const button=document.createElement('button');button.type='button';button.className='color-swatch';button.style.backgroundColor=color;button.setAttribute('aria-label',label);button.title=label;
      button.addEventListener('click',()=>update(color));box.querySelector('.color-palette').append(button);
    }
    box.querySelector('[data-color-reset]').addEventListener('click',()=>update(''));
    box.refresh=()=>update(value.value);
  }
  return {refresh(){for(const box of form.querySelectorAll('[data-color-control]'))box.refresh();}};
}
