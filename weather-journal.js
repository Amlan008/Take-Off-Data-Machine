/* Weather Journal: one location, one combined forecast, a 30-minute device cache. */
(() => {
  const CACHE_KEY='weather-machine-journal-v2',LOCATION_KEY='weather-machine-location-v1',TTL=30*60*1000;
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const rounded=value=>finite(value)?Math.round(value):null;
  function locationValid(p){return p&&finite(p.latitude)&&finite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180&&typeof p.name==='string';}
  function zone(data){try{new Intl.DateTimeFormat('en',{timeZone:data.timezone});return data.timezone||'UTC';}catch{return 'UTC';}}
  function localHour(epoch,tz){return Number(new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(new Date(epoch*1000)));}
  function localDate(epoch,tz){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(epoch*1000));return ['year','month','day'].map(key=>parts.find(p=>p.type===key).value).join('-');}
  function forecastHeading(epoch,tz){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,weekday:'long',day:'numeric',month:'long'}).formatToParts(new Date(epoch*1000)),part=type=>parts.find(p=>p.type===type).value,n=Number(part('day')),suffix=n%100>=11&&n%100<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th');return 'Forecast of '+part('weekday')+', '+n+suffix+' '+part('month');}
  function hourlyRows(data,index=0){const h=data.hourly,tz=zone(data),day=data.daily.time[index];return h.time.map((time,i)=>({time,i})).filter(row=>index===0?row.time>=data.current.time:localDate(row.time,tz)===localDate(day,tz)).slice(0,index===0?24:Infinity);}
  function period(epoch,tz){const hour=localHour(epoch,tz);return hour<5||hour>=21?'tonight':hour<12?'this morning':hour<17?'this afternoon':'this evening';}
  function weather(code){
    if([95,96,99].includes(code))return {type:'thunder',label:'Thunderstorms',image:'rain',icon:'thunder'};
    if([71,73,75,77,85,86,56,57,66,67].includes(code))return {type:'snow',label:[56,57,66,67].includes(code)?'Freezing precipitation':'Snow',image:'snow',icon:'snow'};
    if([65,82].includes(code))return {type:'heavy',label:'Heavy rain',image:'rain',icon:'rain'};
    if([51,53,55,61,63,80,81].includes(code))return {type:'rain',label:[51,53,55].includes(code)?'Drizzle':'Rain showers',image:'rain',icon:'rain'};
    if([45,48].includes(code))return {type:'fog',label:'Fog',image:'fog',icon:'fog'};
    if(code===3)return {type:'overcast',label:'Overcast',image:'overcast',icon:'cloud'};
    if(code===1||code===2)return {type:'clouds',label:code===1?'Mainly clear':'Partly cloudy',image:'clouds',icon:'clouds'};
    if(code===0)return {type:'clear',label:'Clear skies',image:'clear',icon:'sun'};
    return {type:'unknown',label:'Conditions unavailable',image:'clouds',icon:'cloud'};
  }
  function message(data){
    const c=data.current,tz=zone(data),current=weather(c.weather_code),when=period(c.time,tz),h=data.hourly;
    const upcoming=h.time.map((time,i)=>({time,code:h.weather_code?.[i],rain:h.precipitation?.[i],gust:h.wind_gusts_10m?.[i]})).filter(p=>p.time>=c.time&&p.time<c.time+6*3600);
    const storm=current.type==='thunder'?{time:c.time}:upcoming.find(p=>weather(p.code).type==='thunder');
    const heavy=current.type==='heavy'||c.precipitation>=7.5?{time:c.time}:upcoming.find(p=>weather(p.code).type==='heavy'||p.rain>=7.5);
    const wind=c.wind_gusts_10m>=60?{time:c.time}:upcoming.find(p=>p.gust>=60);
    if(storm)return {lines:['Thunderstorms '+(storm.time===c.time?'in the forecast.':'possible '+period(storm.time,tz)+'.'),'Take care while going out.'],advice:'Head indoors if you hear thunder. Check local warnings before heading out.',image:'rain'};
    if(heavy)return {lines:['Heavy rain '+(heavy.time===c.time?'in the forecast.':'expected '+period(heavy.time,tz)+'.'),'Keep your umbrella close.'],advice:'Allow extra time, and avoid flooded roads.',image:'rain'};
    if(wind)return {lines:['A windy spell '+period(wind.time,tz)+'.','Take care while you’re out.'],advice:'Strong gusts may make exposed places uncomfortable.',image:current.image};
    if(current.type==='snow')return {lines:[current.label==='Snow'?'A little winter in the air.':'Freezing precipitation ahead.','An extra layer, and a little care.'],advice:'Watch for slippery paths and roads.',image:'snow'};
    if(c.temperature_2m>=35)return {lines:['A hot '+(when==='this morning'?'morning':when==='this afternoon'?'afternoon':'spell')+' ahead.','Keep some water close.'],advice:'Make time for shade, especially in the warmest hours.',image:current.image};
    if(c.temperature_2m<=5)return {lines:['A crisp '+(when==='this morning'?'start.':'spell ahead.'),'An extra layer helps.'],advice:'Wrap up warmly if you’re heading out.',image:current.image};
    if(current.type==='fog')return {lines:['A veil of mist.','Take your time out there.'],advice:'Visibility may be reduced; allow a little extra time.',image:'fog'};
    if(current.type==='rain')return {lines:['A few showers may pass through.','An umbrella could come in handy.'],advice:'Keep an eye on the hourly outlook before heading out.',image:'rain'};
    if(current.type==='unknown')return {lines:['Your local forecast.','A closer look at the sky.'],advice:'Some condition details are unavailable.',image:c.is_day===0?'night':'clouds'};
    if(current.type==='overcast')return {lines:['A blanket of cloud.','A quieter sky '+(when==='tonight'?'tonight.':'above.')],advice:'Your local outlook, a little closer to home.',image:'overcast'};
    if(c.is_day===0)return {lines:['The day settles.','A quieter sky tonight.'],advice:'Your overnight outlook, all in local time.',image:'night'};
    if(current.type==='clouds')return {lines:when==='this evening'?['A little cloud.','A gentler evening.']:when==='this morning'?['Some clouds above.','A softer start.']:['A little cloud.','A softer kind of afternoon.'],advice:'Your local outlook, a little closer to home.',image:'clouds'};
    if(current.type==='clear')return {lines:when==='this morning'?['Clear skies.','A bright beginning.']:when==='this evening'?['The clouds step aside.','The evening unfolds.']:['A little sunshine.','A brighter afternoon.'],advice:'Your local outlook, a little closer to home.',image:'clear'};
    return {lines:['Your local forecast.','A closer look at the sky.'],advice:'Some condition details are unavailable.',image:'clouds'};
  }
  function validate(data){if(!data||!finite(data.current?.time)||!finite(data.current.temperature_2m)||!Array.isArray(data.hourly?.time)||!Array.isArray(data.daily?.time)||!data.daily.time.length)throw Error('The forecast response is incomplete.');return data;}
  function dayForecast(data,index){
    if(!Number.isInteger(index)||index<1||index>=data.daily.time.length)throw Error('This forecast day is unavailable.');
    const rows=hourlyRows(data,index),h=data.hourly,d=data.daily,tz=zone(data);
    if(!rows.length)throw Error('Hourly forecasts are unavailable for this day.');
    const midday=rows.reduce((best,row)=>Math.abs(localHour(row.time,tz)-12)<Math.abs(localHour(best.time,tz)-12)?row:best,rows[0]);
    const maximum=field=>{const values=rows.map(row=>h[field]?.[row.i]).filter(finite);return values.length?Math.max(...values):null;};
    // Use the whole selected day, including overnight hazards, rather than today's six-hour window.
    const codes=rows.map(row=>h.weather_code?.[row.i]),dailyCode=d.weather_code?.[index];
    let code=codes.find(c=>weather(c).type==='thunder')??([95,96,99].includes(dailyCode)?dailyCode:undefined)??codes.find(c=>weather(c).type==='heavy')??dailyCode??h.weather_code?.[midday.i];
    if(['clear','clouds','overcast','rain'].includes(weather(code).type)&&maximum('precipitation')>=7.5)code=65;
    const current={time:midday.time,temperature_2m:d.temperature_2m_max?.[index],weather_code:code,is_day:1,precipitation:maximum('precipitation'),wind_gusts_10m:maximum('wind_gusts_10m')};
    const projected={...data,current,hourly:{...h,time:rows.map(r=>r.time),weather_code:rows.map(r=>h.weather_code?.[r.i]),precipitation:rows.map(r=>h.precipitation?.[r.i]),wind_gusts_10m:rows.map(r=>h.wind_gusts_10m?.[r.i])}};
    let copy=message(projected);const condition=weather(code);
    if(!['thunder','heavy'].includes(condition.type)&&current.precipitation<7.5){
      if(current.wind_gusts_10m>=60)copy={lines:['A windy day ahead.','Take care while you’re out.'],advice:'Strong gusts may make exposed places uncomfortable.',image:condition.image};
      else if(current.temperature_2m>5&&current.temperature_2m<35){
        if(condition.type==='clear')copy={lines:['Clear skies ahead.','A brighter day to look forward to.'],advice:'A little look ahead, all in local time.',image:'clear'};
        if(condition.type==='clouds')copy={lines:['A little cloud on the horizon.','A softer kind of day ahead.'],advice:'A little look ahead, all in local time.',image:'clouds'};
        if(condition.type==='overcast')copy={lines:['A blanket of cloud.','A quieter sky ahead.'],advice:'A little look ahead, all in local time.',image:'overcast'};
      }
    }
    return {rows,copy,condition,high:d.temperature_2m_max?.[index],low:d.temperature_2m_min?.[index],humidity:h.relative_humidity_2m?.[midday.i],gust:current.wind_gusts_10m,rain:d.precipitation_probability_max?.[index]??maximum('precipitation_probability'),time:d.time[index],heading:forecastHeading(d.time[index],tz)};
  }
  function key(p){return p.latitude.toFixed(2)+','+p.longitude.toFixed(2);}
  function createLoader({request=fetch,storage,now=()=>Date.now()}={}){
    let pending=null,blockedUntil=0,memory=null;
    function cached(p){
      if(memory&&memory.key===key(p)&&memory.fetchedAt<=now()&&now()-memory.fetchedAt<TTL)return {...memory,cached:true};
      try{const saved=JSON.parse(storage?.getItem(CACHE_KEY)||'null');if(saved&&saved.key===key(p)&&finite(saved.fetchedAt)&&saved.fetchedAt<=now()&&now()-saved.fetchedAt<TTL){memory={...saved,data:validate(saved.data)};return {...memory,cached:true};}}catch{}return null;
    }
    async function load(p){
      if(!locationValid(p))throw Error('Choose a valid location.');if(pending&&pending.key!==key(p))pending.controller.abort();const saved=cached(p);if(saved)return saved;
      if(now()<blockedUntil)throw Error('The weather service is busy. Please try again in a few minutes.');
      if(pending?.key===key(p))return pending.promise;
      pending?.controller.abort();const controller=new AbortController();
      const params=new URLSearchParams({latitude:p.latitude.toFixed(2),longitude:p.longitude.toFixed(2),current:'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',hourly:'temperature_2m,precipitation_probability,weather_code,is_day,precipitation,wind_gusts_10m,relative_humidity_2m',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',forecast_days:'5',timezone:'auto',timeformat:'unixtime',wind_speed_unit:'kmh'});
      const token={key:key(p),controller};token.promise=(async()=>{const timeout=setTimeout(()=>controller.abort(),15000);try{const response=await request('https://api.open-meteo.com/v1/forecast?'+params,{signal:controller.signal});if(!response.ok){if(response.status===429){blockedUntil=now()+Math.max(60000,(Number(response.headers?.get('Retry-After'))||60)*1000);throw Error('The weather service is busy. Please try again in a few minutes.');}throw Error('The forecast service is unavailable. Please try again later.');}const data=validate(await response.json()),result={key:key(p),data,fetchedAt:now(),cached:false};memory=result;try{storage?.setItem(CACHE_KEY,JSON.stringify(result));}catch{}return result;}finally{clearTimeout(timeout);if(pending===token)pending=null;}})();pending=token;return token.promise;
    }
    return {load,cached};
  }
  const api={weather,message,validate,locationValid,createLoader,period,key,TTL,localDate,forecastHeading,hourlyRows,dayForecast};
  if(typeof document==='undefined'){globalThis.WeatherJournal=api;return;}
  const $=id=>document.getElementById(id),root=$('weatherJournal');if(!root)return;
  let storage;try{storage=localStorage;}catch{}
  const loader=createLoader({storage});let selected=null,lastResult=null,generation=0,searchGeneration=0,fahrenheit=false,lastRefresh=0,selectedDay=0;
  const degree=value=>finite(value)?Math.round(fahrenheit?value*9/5+32:value)+'°':'—';
  const number=value=>finite(value)?Math.round(value):'—';
  const local=(epoch,tz,opts)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,...opts}).format(new Date(epoch*1000));
  const paths={sun:'<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',moon:'<path d="M19 15A8 8 0 0 1 9 5a8 8 0 1 0 10 10Z"/>',cloud:'<path d="M6 18a4 4 0 0 1-1-8 6 6 0 0 1 11-2 5 5 0 1 1 2 10Z"/>',rain:'<path d="M5 15a4 4 0 0 1 0-8 6 6 0 0 1 11-1 5 5 0 0 1 2 9H5m1 4-1 3m7-3-1 3m7-3-1 3"/>',thunder:'<path d="M5 15a4 4 0 0 1 0-8 6 6 0 0 1 11-1 5 5 0 0 1 2 9M13 12l-4 6h5l-4 6"/>',snow:'<path d="M6 14a4 4 0 0 1-1-8 6 6 0 0 1 11 0 4 4 0 1 1 2 8Zm1 4v4m-2-2h4m8-2v4m-2-2h4"/>',fog:'<path d="M4 11a4 4 0 0 1 1-7 6 6 0 0 1 11 2 4 4 0 0 1 4 5M2 15h20M5 19h14M8 23h8"/>',clouds:'<circle cx="16" cy="7" r="4"/><path d="m16 0 0 2m6 5h2m-4-4 2-2M5 20a4 4 0 1 1 0-8 5 5 0 0 1 10-1 5 5 0 1 1 2 9Z"/>',wind:'<path d="M2 8h13a3 3 0 1 0-3-3M2 12h18a3 3 0 1 1-3 3M2 16h7a3 3 0 1 1-3 3"/>',humidity:'<path d="M12 2C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-13Z"/>'};
  const icon=(name,day=true)=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+paths[!day&&['sun','clouds'].includes(name)?'moon':name]+'</svg>';
  function status(text,error=false){$('journalStatus').textContent=text;$('journalStatus').classList.toggle('error',error);}
  function render(result,p){
    lastResult=result;const d=result.data,c=d.current,tz=zone(d),future=selectedDay>0;
    let day=null;try{if(future)day=dayForecast(d,selectedDay);}catch(error){selectedDay=0;render(result,p);status(error.message,true);return;}
    const condition=day?day.condition:weather(c.weather_code),copy=day?day.copy:message(d),rows=day?day.rows:hourlyRows(d);
    root.dataset.weather=copy.image;root.dataset.night=String(!day&&c.is_day===0);root.querySelector('.journal-photo').style.backgroundImage='linear-gradient(100deg,#091c2a55,#0b1b220a),url("assets/weather-journal/'+copy.image+'.webp")';
    $('journalTitle').replaceChildren(...copy.lines.map((line,i)=>{const el=document.createElement(i?'em':'span');el.textContent=line;if(!i)el.append(document.createElement('br'));return el;}));
    $('journalPeriod').textContent=day?'A LITTLE LOOK AHEAD':c.is_day===0?'YOUR OVERNIGHT OUTLOOK':'THE REST OF YOUR DAY';$('journalGuidance').textContent=copy.advice;$('journalLocation').textContent=p.name;
    $('journalIcon').innerHTML=icon(condition.icon,day||c.is_day!==0);$('journalTemperature').textContent=degree(day?day.high:c.temperature_2m)+(fahrenheit?'F':'C');$('journalCondition').textContent=condition.label+(day?' · forecast high':'');$('journalFeels').hidden=!!day;$('journalFeels').textContent='Feels like '+degree(c.apparent_temperature);$('journalHighLow').textContent='High '+degree(day?day.high:d.daily.temperature_2m_max?.[0])+' / Low '+degree(day?day.low:d.daily.temperature_2m_min?.[0]);
    $('journalLocalTime').textContent=day?local(day.time,tz,{weekday:'long',day:'numeric',month:'long'}):local(c.time,tz,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'});$('journalLocalTime').dateTime=new Date((day?day.time:c.time)*1000).toISOString();
    const compass=finite(c.wind_direction_10m)?['N','NE','E','SE','S','SW','W','NW'][Math.round(c.wind_direction_10m/45)%8]+' ':'';
    const first=d.hourly.time.findIndex(time=>time>=c.time),rain=first>=0?d.hourly.precipitation_probability?.[first]:null;
    const facts=day?[['wind','Peak gust '+number(day.gust)+' km/h'],['humidity','Midday humidity '+number(day.humidity)+'%'],['rain','Rain '+number(day.rain)+'%']]:[['wind',compass+number(c.wind_speed_10m)+' km/h'],['humidity','Humidity '+number(c.relative_humidity_2m)+'%'],['rain','Rain '+number(rain)+'%']];
    $('journalFacts').replaceChildren(...facts.map(([name,text])=>{const el=document.createElement('span');el.innerHTML=icon(name);el.append(document.createTextNode(text));return el;}));
    $('journalHourlyTitle').textContent=day?day.heading:'Next 24 hours';$('journalBackNow').hidden=!day;
    $('journalHours').replaceChildren(...rows.map(({time,i})=>{const el=document.createElement('div');el.className='journal-hour';const label=document.createElement('span');label.textContent=local(time,tz,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const symbol=document.createElement('span');const w=weather(d.hourly.weather_code?.[i]);symbol.innerHTML=icon(w.icon,d.hourly.is_day?.[i]!==0);symbol.setAttribute('aria-label',w.label);const temp=document.createElement('strong');temp.textContent=degree(d.hourly.temperature_2m?.[i]);const prob=document.createElement('small');prob.textContent=number(d.hourly.precipitation_probability?.[i])+'% rain';el.append(label,symbol,temp,prob);return el;}));
    $('journalHours').scrollLeft=0;
    $('journalDays').replaceChildren(...d.daily.time.slice(0,5).map((time,i)=>{const el=document.createElement('button');el.type='button';el.className='journal-day';el.dataset.forecastDay=String(i);el.setAttribute('aria-pressed',String(selectedDay===i));el.setAttribute('aria-label',i===0?'Today · next 24 hours':forecastHeading(time,tz));const name=document.createElement('span');name.textContent=i===0?'Today':local(time,tz,{weekday:'short'});const symbol=document.createElement('span');const w=weather(d.daily.weather_code?.[i]);symbol.innerHTML=icon(w.icon);symbol.setAttribute('aria-label',w.label);const temperatures=document.createElement('span');temperatures.textContent=degree(d.daily.temperature_2m_max?.[i]);const low=document.createElement('small');low.textContent=degree(d.daily.temperature_2m_min?.[i]);temperatures.append(low);el.append(name,symbol,temperatures);return el;}));
    $('journalUpdated').textContent='Retrieved '+new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(result.fetchedAt))+' · '+(result.cached?'saved on this device':'local time');$('journalSource').textContent='· Best Match';
    $('journalForecast').hidden=false;$('journalNow').hidden=false;$('journalEmpty').hidden=true;$('journalStart').hidden=true;$('journalRefresh').hidden=false;
    status(day?day.heading+'. '+rows.length+' hourly forecasts for this local date. Images are illustrative; values are model guidance.':'Forecast valid '+local(c.time,tz,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})+'. Images are illustrative; current conditions are model-derived.');
  }
  async function choose(p){
    const id=++generation;selected=p;lastResult=null;selectedDay=0;$('journalLocation').textContent=p.name;$('journalTitle').textContent='A closer look at your sky.';$('journalGuidance').textContent='Your local forecast is on its way.';$('journalForecast').hidden=true;$('journalNow').hidden=true;$('journalEmpty').hidden=false;$('journalEmpty').querySelector('p').textContent='Looking up your sky…';$('journalEmpty').querySelector('span').textContent='Loading your local forecast.';status('Loading '+p.name+'…');
    try{const result=await loader.load(p);if(id!==generation)return;render(result,p);try{storage?.setItem(LOCATION_KEY,JSON.stringify(p));}catch{}}
    catch(error){if(id!==generation)return;$('journalTitle').textContent='A pause in the forecast.';$('journalGuidance').textContent='Let’s try again shortly.';status(error.name==='AbortError'?'The request took too long. Please try again.':error.message,true);$('journalEmpty').querySelector('p').textContent='Your forecast is taking a little longer.';$('journalEmpty').querySelector('span').textContent='Refresh the forecast or try another location.';$('journalRefresh').hidden=false;}
  }
  function openLocation(){if(!$('locationDialog').open)$('locationDialog').showModal();}
  $('journalLocationButton').addEventListener('click',openLocation);$('journalStart').addEventListener('click',openLocation);$('locationClose').addEventListener('click',()=>$('locationDialog').close());
  $('journalUnits').addEventListener('click',()=>{fahrenheit=!fahrenheit;$('journalUnits').textContent=fahrenheit?'°F / °C':'°C / °F';$('journalUnits').setAttribute('aria-label',fahrenheit?'Switch to Celsius':'Switch to Fahrenheit');if(lastResult)render(lastResult,selected);});
  $('journalDays').addEventListener('click',event=>{const button=event.target.closest('[data-forecast-day]');if(!button||!lastResult)return;selectedDay=Number(button.dataset.forecastDay);render(lastResult,selected);$('journalDays').querySelector('[data-forecast-day="'+selectedDay+'"]').focus({preventScroll:true});});
  $('journalBackNow').addEventListener('click',()=>{selectedDay=0;if(lastResult)render(lastResult,selected);$('journalDays').querySelector('[data-forecast-day="0"]')?.focus({preventScroll:true});});
  $('journalRefresh').addEventListener('click',()=>{if(!selected)return openLocation();if(Date.now()-lastRefresh<30000)return;lastRefresh=Date.now();choose(selected);});
  let searchController;
  $('locationSearch').addEventListener('submit',async event=>{
    event.preventDefault();const query=$('locationQuery').value.trim();if(query.length<2)return;const id=++searchGeneration;searchController?.abort();searchController=new AbortController();const controller=searchController,timer=setTimeout(()=>controller.abort(),10000);$('locationSearchStatus').textContent='Searching…';$('locationResults').replaceChildren();
    try{const response=await fetch('https://geocoding-api.open-meteo.com/v1/search?'+new URLSearchParams({name:query,count:'5',language:'en',format:'json'}),{signal:controller.signal});if(!response.ok)throw Error(response.status===429?'Search is busy. Please wait a minute before trying again.':'Location search is unavailable.');const data=await response.json();if(id!==searchGeneration)return;const places=(data.results||[]).filter(p=>locationValid(p));$('locationSearchStatus').textContent=places.length?'Choose your location.':'No matching locations. Try a nearby city or add the country.';
      $('locationResults').replaceChildren(...places.map(p=>{const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent=p.name;const detail=document.createElement('small');detail.textContent=[p.admin1,p.country].filter(Boolean).join(', ');button.append(detail);button.addEventListener('click',()=>{$('locationDialog').close();choose({latitude:p.latitude,longitude:p.longitude,name:[p.name,p.country].filter(Boolean).join(', ')});});li.append(button);return li;}));
    }catch(error){if(id===searchGeneration)$('locationSearchStatus').textContent=error.name==='AbortError'?'Search took too long. Please try again.':error.message;}finally{clearTimeout(timer);}
  });
  $('useMyLocation').addEventListener('click',()=>{
    if(!navigator.geolocation){$('locationSearchStatus').textContent='Location access is unavailable. Search for a city instead.';return;}
    $('useMyLocation').disabled=true;$('locationSearchStatus').textContent='Waiting for location permission…';
    navigator.geolocation.getCurrentPosition(position=>{$('useMyLocation').disabled=false;const latitude=Math.round(position.coords.latitude*100)/100,longitude=Math.round(position.coords.longitude*100)/100;$('locationDialog').close();choose({latitude,longitude,name:'Near your location'});},()=>{$('useMyLocation').disabled=false;$('locationSearchStatus').textContent='Location could not be accessed. You can search for a city instead.';},{enableHighAccuracy:false,timeout:10000,maximumAge:1800000});
  });
  try{const p=JSON.parse(storage?.getItem(LOCATION_KEY)||'null');if(locationValid(p))choose(p);}catch{}
})();
