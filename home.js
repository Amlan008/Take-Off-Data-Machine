/* Lightweight launchpad: only the existing local chart manifest is fetched. */
(() => {
  const labels={current:'Current',partial:'Partial',delayed:'Delayed',unavailable:'Unavailable'};
  function expectedCycle(now,intervalHours,delayMinutes=30){const date=new Date(now.getTime()-delayMinutes*60000);date.setUTCHours(Math.floor(date.getUTCHours()/intervalHours)*intervalHours,0,0,0);return date;}
  function publication(entries,kind,now=new Date()){
    if(!Array.isArray(entries))return {state:'unavailable',label:labels.unavailable};
    const candidates=entries.filter(e=>e&&typeof e.valid_time==='string'&&Number.isFinite(Date.parse(e.valid_time))&&Date.parse(e.valid_time)<=now.getTime()+5*60000);
    if(!candidates.length)return {state:'unavailable',label:labels.unavailable};
    const entry=candidates.reduce((a,b)=>Date.parse(a.valid_time)>Date.parse(b.valid_time)?a:b);
    const valid=new Date(entry.valid_time),expected=expectedCycle(now,kind==='surface'?3:12);
    const state=valid<expected?'delayed':Array.isArray(entry.feed_errors)&&entry.feed_errors.length?'partial':'current';
    return {entry,valid,state,label:labels[state]};
  }
  function formatTime(date){return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(date).replace(',','')+'Z';}
  globalThis.HomePage={expectedCycle,publication,formatTime};
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  function clock(){const now=new Date();$('utcClock').textContent=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(now)+' UTC';$('utcClock').dateTime=now.toISOString();}
  clock();const clockInterval=setInterval(clock,30000);
  addEventListener('pagehide',()=>clearInterval(clockInterval),{once:true});
  for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{
    const filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    let visible=0;for(const card of document.querySelectorAll('[data-category]')){card.hidden=filter!=='all'&&card.dataset.category!==filter;if(!card.hidden)visible++;}
    $('workspaceGrid').classList.toggle('is-filtered',filter!=='all');$('filterResult').textContent=visible+' workspace'+(visible===1?'':'s')+' shown.';
  });
  let refreshing=false;
  async function refresh(){
    if(refreshing)return;refreshing=true;$('refreshData').disabled=true;$('dataStatus').textContent='Checking published chart metadata.';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch('assets/observation-charts/manifest.json',{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('Metadata unavailable');
      const data=await response.json();if(data.version!==1)throw Error('Unsupported metadata');const states=[];
      for(const kind of ['surface','upper']){
        const result=publication(data[kind],kind),time=$(kind+'Time'),state=$(kind+'State');time.textContent=result.valid?formatTime(result.valid):'No published time';
        if(result.valid)time.dateTime=result.valid.toISOString();else time.removeAttribute('datetime');state.textContent=result.label;state.dataset.state=result.state;
        state.title=result.state==='current'?'Latest expected observation cycle is published.':result.state==='partial'?'Latest cycle is published with source-feed warnings.':result.state==='delayed'?'A newer nominal observation cycle is expected; this is the latest published chart.':'No valid chart timestamp is available.';
        states.push((kind==='upper'?'Upper air':'Surface')+': '+time.textContent+', '+result.label+'.');
      }$('dataStatus').textContent=states.join(' ');
    }catch{
      for(const kind of ['surface','upper']){$(kind+'Time').textContent='Status unavailable';$(kind+'Time').removeAttribute('datetime');$(kind+'State').textContent='Unavailable';$(kind+'State').dataset.state='unavailable';}
      $('dataStatus').textContent='Chart publication status could not be checked. Workspace links remain available.';
    }finally{clearTimeout(timer);refreshing=false;$('refreshData').disabled=false;}
  }
  $('refreshData').addEventListener('click',refresh);refresh();
})();
