/* Shared preference: no network requests and no changes to scientific colour scales. */
(() => {
  const choices={midnight:'Midnight',daylight:'Daylight',mist:'Mist',forest:'Forest',sandstone:'Sandstone'};
  function valid(value){return Object.hasOwn(choices,value)?value:'midnight';}
  function apply(value){document.documentElement.dataset.theme=valid(value);document.documentElement.style.colorScheme=['daylight','mist','sandstone'].includes(valid(value))?'light':'dark';}
  let selected='midnight';try{selected=valid(localStorage.getItem('weather-machine-theme'));}catch{}apply(selected);
  function mount(){
    const host=document.querySelector('.masthead,.desk-masthead,.workspace-masthead,.app-nav');if(!host)return;
    const label=document.createElement('label');label.className='theme-choice';
    const text=document.createElement('span');text.textContent='Theme';const select=document.createElement('select');select.setAttribute('aria-label','Website theme');
    Object.entries(choices).forEach(([value,name])=>{const option=document.createElement('option');option.value=value;option.textContent=name;select.append(option);});
    select.value=selected;select.addEventListener('change',()=>{selected=valid(select.value);apply(selected);try{localStorage.setItem('weather-machine-theme',selected);}catch{}});
    label.append(text,select);host.append(label);
    addEventListener('storage',event=>{if(event.key==='weather-machine-theme'){selected=valid(event.newValue);select.value=selected;apply(selected);}});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
