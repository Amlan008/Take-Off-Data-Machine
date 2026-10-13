/* Skew-T/log-P observed soundings. No remote dependencies or model profiles. */
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const finite = Number.isFinite;
  const bounds = {left:65,right:610,top:35,bottom:615};
  const y = (p) => bounds.bottom - Math.log(1050/p)/Math.log(1050/100)*(bounds.bottom-bounds.top);
  const x = (t,p) => bounds.left+(t+60)/110*(bounds.right-bounds.left)+.8*(bounds.bottom-y(p));
  const vapor = (t) => 6.112*Math.exp(17.67*t/(t+243.5));
  const dewpoint = (e) => 243.5*Math.log(e/6.112)/(17.67-Math.log(e/6.112));
  const path = (pairs) => pairs.map(([p,t],i)=>(i?'L':'M')+x(t,p).toFixed(2)+' '+y(p).toFixed(2)).join(' ');
  function moist(start) {
    // Pseudoadiabatic saturated liquid-water approximation; fine log-P steps.
    let t=start+273.15,p=1000; const result=[[p,start]], step=-.005;
    while(p>100) {
      const e=vapor(t-273.15),r=.622*e/Math.max(1,p-e);
      const slope=(287.05*t+2.5e6*r)/(1004+2.5e6**2*r*.622/(287.05*t*t));
      t+=slope*step;p*=Math.exp(step);result.push([p,t-273.15]);
    }
    return result;
  }
  function traces(levels,key) {
    let result='',segment=[],last=null;
    const flush=()=>{if(segment.length>1)result+='<path d="'+path(segment)+'"/>';else if(segment.length)result+='<circle cx="'+x(segment[0][1],segment[0][0])+'" cy="'+y(segment[0][0])+'" r="3"/>';segment=[];};
    for(const row of levels) {
      const p=row.level_hpa,t=row[key];
      if(!finite(p)||p<100||p>1050)continue;
      if(!finite(t)){flush();last=null;continue;}
      if(last!==null&&last-p>200)flush();
      segment.push([p,t]);last=p;
    }
    flush();return result;
  }
  function wind(row,yy) {
    const speed=row.wind_kt,dir=row.wind_from_deg;
    if(!finite(speed)||!finite(dir))return '';
    let n=Math.round(speed/5)*5,offset=0,shapes='<path d="M0 0V-28"/>';
    while(n>=50){shapes+='<path d="M0 '+(-28+offset)+'L12 '+(-22+offset)+'L0 '+(-16+offset)+'Z" fill="#182832"/>';n-=50;offset+=12;}
    while(n>=10){shapes+='<path d="M0 '+(-28+offset)+'L12 '+(-22+offset)+'"/>';n-=10;offset+=5;}
    if(n>=5)shapes+='<path d="M0 '+(-28+offset)+'L6 '+(-25+offset)+'"/>';
    if(speed<2.5)shapes='<circle r="3"/>';
    return '<g transform="translate(655 '+yy+') rotate('+dir+')" stroke="#182832" stroke-width="1.5" fill="none">'+shapes+'</g>';
  }
  function render(profile) {
    const levels=[...(profile.levels||[])].sort((a,b)=>b.level_hpa-a.level_hpa);
    let grid='',labels='',winds='';
    const pressure=Array.from({length:191},(_,i)=>1050-i*5).filter(p=>p>=100);
    for(let t=-100;t<=50;t+=10)grid+='<path d="'+path([[1050,t],[100,t]])+'" stroke="'+(t===0?'#83999c':'#d7cccc')+'"/>';
    for(let theta=230;theta<=470;theta+=10)grid+='<path d="'+path(pressure.map(p=>[p,theta*(p/1000)**.2854-273.15]))+'" stroke="#d6a990" stroke-dasharray="5 4"/>';
    for(let t=-20;t<=40;t+=5)grid+='<path d="'+path(moist(t))+'" stroke="#b3bcd6" stroke-dasharray="3 3"/>';
    for(const ratio of [.1,.2,.5,1,2,4,8,16])grid+='<path d="'+path(pressure.filter(p=>p>=400).map(p=>[p,dewpoint((ratio/1000)*p/(.622+ratio/1000))]))+'" stroke="#9dc3a8" stroke-dasharray="2 4"/>';
    for(const p of [1000,925,850,800,700,600,500,400,300,250,200,150,100]) {
      grid+='<path d="M65 '+y(p)+'H610" stroke="#b9b6ae"/>';
      labels+='<text x="57" y="'+(y(p)+4)+'" text-anchor="end">'+p+'</text>';
    }
    for(let t=-60;t<=50;t+=10)labels+='<text x="'+x(t,1050)+'" y="639" text-anchor="middle">'+t+'</text>';
    let lastY=-100;
    for(const row of [...levels].reverse()) {
      if(row.level_hpa<100||row.level_hpa>1050||!finite(row.wind_kt)||y(row.level_hpa)-lastY<32)continue;
      winds+=wind(row,y(row.level_hpa));lastY=y(row.level_hpa);
    }
    return '<svg viewBox="0 0 710 680" role="img" aria-label="Observed Skew-T log-pressure plot for '+esc(profile.station)+'" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="soundingClip"><rect x="65" y="35" width="545" height="580"/></clipPath></defs><rect width="710" height="680" fill="#faf6eb"/><g clip-path="url(#soundingClip)" fill="none" stroke-width=".8">'+grid+'</g><rect x="65" y="35" width="545" height="580" fill="none" stroke="#738389"/><g clip-path="url(#soundingClip)" fill="none" stroke="#c62828" stroke-width="2.5">'+traces(levels,'temperature_c')+'</g><g clip-path="url(#soundingClip)" fill="none" stroke="#087f4b" stroke-width="2.5">'+traces(levels,'dewpoint_c')+'</g><g font-family="sans-serif" font-size="11" fill="#263640">'+labels+'<text x="325" y="664" text-anchor="middle">Temperature (°C) · skewed isotherms</text><text x="16" y="325" transform="rotate(-90 16 325)" text-anchor="middle">Pressure (hPa) · logarithmic</text><text x="652" y="23" text-anchor="middle">Wind (kt)</text></g>'+winds+'</svg>';
  }
  let profiles=[];
  const dialog=document.getElementById('soundingDialog'), select=document.getElementById('soundingStation');
  function draw() {
    const profile=profiles[Number(select.value)];if(!profile)return;
    document.getElementById('soundingTitle').textContent='Skew-T · '+profile.station;
    document.getElementById('soundingMeta').textContent=profile.observed_at.replace('T',' ').replace('Z',' UTC')+' · '+profile.latitude.toFixed(2)+'°, '+profile.longitude.toFixed(2)+'° · '+profile.levels.length+' reported pressure levels';
    document.getElementById('soundingSvg').innerHTML=render(profile);
    document.getElementById('soundingTable').innerHTML=profile.levels.slice().sort((a,b)=>b.level_hpa-a.level_hpa).map(r=>'<tr>'+[r.level_hpa,r.temperature_c,r.dewpoint_c,r.relative_humidity_pct,r.wind_kt,r.wind_from_deg].map(v=>'<td>'+(finite(v)?v.toFixed(1):'—')+'</td>').join('')+'</tr>').join('');
    const usable=profile.levels.filter(r=>finite(r.temperature_c)&&finite(r.dewpoint_c));
    document.getElementById('soundingWarning').textContent=usable.length<3?'Insufficient paired temperature/dew-point levels; no complete profile can be shown.':'Reported levels only; missing values and gaps >200 hPa break the curves. No parcel ascent, CAPE or CIN calculation is shown.';
  }
  select.addEventListener('change',draw);
  document.getElementById('soundingClose').addEventListener('click',()=>dialog.close());
  window.SoundingPlot={render,x,y,moist,open(data,station,latitude,longitude) {
    profiles=(data.profiles||[]).filter(p=>p.levels?.length).sort((a,b)=>a.station.localeCompare(b.station));
    if(!profiles.length)throw new Error('No reported sounding profiles in this chart.');
    select.replaceChildren(...profiles.map((p,i)=>{const o=document.createElement('option');o.value=i;o.textContent=p.station+' · '+p.latitude.toFixed(1)+'°, '+p.longitude.toFixed(1)+'°';return o;}));
    const index=profiles.findIndex(p=>p.station===station&&Math.abs(p.latitude-latitude)<.02&&Math.abs(p.longitude-longitude)<.02);
    if(station!==undefined&&index<0)throw new Error('No retained profile matches this station and location.');
    select.value=String(Math.max(0,index));draw();if(!dialog.open)dialog.showModal();
  }};
})();
