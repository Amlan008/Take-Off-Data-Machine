const MODEL_CATALOG = [
  ['gfs_global', 'GFS Global'], ['icon_global', 'ICON Global'], ['ecmwf_ifs04', 'ECMWF IFS'],
  ['gem_global', 'GEM Global'], ['jma_gsm', 'JMA GSM'], ['ukmo_global', 'UKMO Global'],
  ['meteofrance_arpege_world', 'ARPEGE World'], ['cma_grapes_global', 'CMA GRAPES'], ['bom_access_global', 'ACCESS Global']
];
function regionalModels(lat,lon){
  const inBox=(a,b,c,d)=>lat>=a&&lat<=b&&lon>=c&&lon<=d, models=[];
  if(inBox(20,55,-130,-60)) models.push(['hrrr_conus','HRRR CONUS'],['nbm_conus','NBM CONUS'],['nam_conus','NAM CONUS']);
  if(inBox(24,84,-25,45)) models.push(['icon_eu','ICON Europe'],['meteofrance_arpege_europe','ARPEGE Europe']);
  if(inBox(45,56,5,16)) models.push(['icon_d2','ICON D2'],['chmi_aladin_central_europe','CHMI ALADIN']);
  if(inBox(41,52,-6,10)) models.push(['meteofrance_arome_france','AROME France']);
  if(inBox(49,61,-11,3)) models.push(['ukmo_uk_2km','UKMO UK 2 km']);
  if(inBox(55,72,-12,35)) models.push(['metno_nordic','MET Nordic'],['dmi_harmonie_arome_europe','DMI HARMONIE']);
  if(inBox(41,52,-5,12)) models.push(['knmi_harmonie_arome_europe','KNMI HARMONIE']);
  if(inBox(42,48,5,17)) models.push(['geosphere_arome_austria','GeoSphere AROME']);
  if(inBox(45,48,5,11)) models.push(['meteoswiss_icon_ch1','MeteoSwiss ICON CH1']);
  if(inBox(42,84,-142,-50)) models.push(['gem_regional','GEM Regional'],['gem_hrdps_continental','GEM HRDPS']);
  if(inBox(24,46,123,147)) models.push(['jma_msm','JMA MSM']);
  if(inBox(33,39,124,132)) models.push(['kma_ldps','KMA LDPS']);
  return models;
}
const MODEL_META={gfs_global:{resolution:'~13 km',refresh:'Hourly'},icon_global:{resolution:'~11 km',refresh:'6-hourly'},ecmwf_ifs04:{resolution:'~25 km',refresh:'6-hourly'},gem_global:{resolution:'~15 km',refresh:'12-hourly'},jma_gsm:{resolution:'~20 km',refresh:'6-hourly'},ukmo_global:{resolution:'~10 km',refresh:'6-hourly'},meteofrance_arpege_world:{resolution:'~25 km',refresh:'6-hourly'},cma_grapes_global:{resolution:'~25 km',refresh:'12-hourly'},bom_access_global:{resolution:'~25 km',refresh:'12-hourly'}};
const VARS = 'temperature_2m,wind_direction_10m,wind_speed_10m,surface_pressure,precipitation';
const SETTINGS = {
  temp: {label:'Temperature', key:'temperature_2m', unit:'°C'},
  direction: {label:'Wind direction', key:'wind_direction_10m', unit:'°'},
  speed: {label:'Wind speed', key:'wind_speed_10m', unit:'kt'},
  pressure: {label:'Surface pressure', key:'surface_pressure', unit:'hPa'},
  precip: {label:'Precipitation', key:'precipitation', unit:'mm / 30 min'}
};
let state = { models: [], ensemble: [], selected: null, chart: null, parameter: 'temp', airport: '' };
const $ = id => document.getElementById(id);
const utcInput = date => date.toISOString().slice(0,16);
const isoHour = date => date.toISOString().slice(0,13) + ':00';
const toUtc = value => new Date(value + 'Z');
const fmt = date => new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(date).replace(',', '');
const clampDirection = n => ((n % 360) + 360) % 360;
const angleDiff = (target, source) => ((target - source + 540) % 360) - 180;
const circularMean = values => weightedCircularMean(values, values.map(()=>1));

function setDefaults(){ const now=new Date(); now.setUTCMinutes(0,0,0); const start=new Date(now.getTime()+60*60*1000), end=new Date(start.getTime()+6*60*60*1000); $('start').value=utcInput(start); $('end').value=utcInput(end); }
function notice(message, type=''){ $('notice').textContent=message; $('notice').className='notice '+type; }
const isFilePreview=location.protocol==='file:';
function queryUrl(host, lat, lon, start, end, model){ const source=host.includes('historical')?'historical':'forecast'; const p=new URLSearchParams({latitude:lat,longitude:lon,timezone:'GMT',start_date:start.toISOString().slice(0,10),end_date:end.toISOString().slice(0,10),models:model,wind_speed_unit:'kn',hourly:VARS}); p.set('source',source); return `/api/open-meteo?${p}`; }
function liveForecastRangeUrl(lat,lon,start,end,model){
  // Near "now", date-only start_date/end_date requests can be interpreted on
  // the opposite side of midnight by the upstream API. Ask for a small rolling
  // range instead, then retain only the user's exact UTC window locally.
  const now=Date.now(), day=24*3600e3;
  const pastDays=Math.max(0,Math.min(3,Math.ceil((now-start.getTime())/day)));
  const forecastDays=Math.max(1,Math.min(16,Math.ceil((end.getTime()-now)/day)+2));
  const p=new URLSearchParams({source:'forecast',latitude:lat,longitude:lon,timezone:'GMT',past_days:String(pastDays),forecast_days:String(forecastDays),models:model,wind_speed_unit:'kn',hourly:VARS});
  return `/api/open-meteo?${p}`;
}
function weatherNextUrl(lat,lon,start,end,past=false){ const p=new URLSearchParams({source:'ensemble',latitude:lat,longitude:lon,timezone:'GMT',models:'google_weathernext2_ensemble',wind_speed_unit:'kn',hourly:VARS}); if(past){p.set('past_days','3');p.set('forecast_days','0');}else{p.set('start_date',start.toISOString().slice(0,10));p.set('end_date',end.toISOString().slice(0,10));} return `/api/open-meteo?${p}`; }

async function fetchJson(url){ const res=await fetch(url); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`); return res.json(); }
async function getMetars(icao){
  const data=await fetchJson(`/api/metar?icao=${encodeURIComponent(icao)}`);
  if(!Array.isArray(data)||!data.length) throw new Error('No METAR observations returned for this ICAO code in the last 72 hours.');
  const observations=data.map(m=>({
    time:metarDate(m.obsTime || m.reportTime || m.receiptTime), temp:num(m.temp), direction:num(m.wdir), variableWind:!Number.isFinite(num(m.wdir)), speed:num(m.wspd),
    pressure:metarPressure(m.altim), raw:String(m.rawOb || m.raw_text || m.rawText || ''), lat:num(m.lat), lon:num(m.lon), name:m.name || m.site || m.icaoId || icao
  })).filter(m=>!Number.isNaN(m.time.getTime())).sort((a,b)=>a.time-b.time);
  resolveVariableWinds(observations);
  markTransientTemperatureEvents(observations);
  const location=observations.find(m=>Number.isFinite(m.lat)&&Number.isFinite(m.lon));
  if(!location) throw new Error('AWC returned METARs but no station coordinates.');
  return {observations, location};
}
function markTransientTemperatureEvents(observations){
  // A shower can cool an aerodrome sharply without revealing a persistent model
  // error.  Mark those reports so they do not dominate the long-lived bias.
  observations.forEach((o,index)=>{
    const previous=[...observations.slice(0,index)].reverse().find(p=>Number.isFinite(p.temp)&&o.time-p.time<=3*3600e3);
    const hours=previous?(o.time-previous.time)/36e5:Number.NaN;
    const coolingRate=previous&&hours>0?(o.temp-previous.temp)/hours:0;
    const rain=/(?:^|\s)(?:[-+]?RA|[-+]?SHRA|[-+]?TSRA|[-+]?DZ|[-+]?FZRA|VCSH)(?:\s|$)/.test(o.raw);
    const recentlyTransient=previous?.transientCooling && hours<=2;
    o.transientCooling=rain || coolingRate<=-.75 || recentlyTransient;
  });
}
// Use NaN for absent values: Number.isFinite(null) is true in JavaScript and would
// otherwise make a missing METAR field look like a zero-valued observation.
const num=v => v === null || v === undefined || v === '' ? Number.NaN : Number(v);
const metarDate=v=>{ const numeric=Number(v); return Number.isFinite(numeric) && numeric>1e8 ? new Date(numeric<1e12?numeric*1000:numeric) : new Date(v); };
const metarPressure=v => { const n=num(v); return n && n<100 ? n*33.8639 : n; };
function nearestMetar(observations, date){ return observations.reduce((best,o)=>!best || Math.abs(o.time-date)<Math.abs(best.time-date)?o:best,null); }
function resolveVariableWinds(observations){
  // AWC represents VRB wind as a non-numeric wdir. Reconstruct only its direction;
  // the observed wind speed is retained. Circular interpolation prevents 350°→010°
  // from taking the long way around the compass.
  const actual=observations.map((o,i)=>Number.isFinite(o.direction)?i:null).filter(i=>i!==null);
  if(!actual.length) return;
  observations.forEach((o,i)=>{
    if(Number.isFinite(o.direction)) return;
    const previous=[...actual].reverse().find(j=>j<i), next=actual.find(j=>j>i);
    if(previous!==undefined && next!==undefined){
      const span=observations[next].time-observations[previous].time;
      const ratio=span ? (o.time-observations[previous].time)/span : .5;
      o.direction=clampDirection(observations[previous].direction+angleDiff(observations[next].direction,observations[previous].direction)*ratio);
    } else if(previous!==undefined) o.direction=observations[previous].direction;
    else if(next!==undefined) o.direction=observations[next].direction;
  });
}
function unpackModel(data, id, name){
  const h=data.hourly; if(!h?.time) throw new Error('missing hourly response');
  return {id,name,points:h.time.map((time,i)=>({time:new Date(time+'Z'),temperature_2m:num(h.temperature_2m?.[i]),wind_direction_10m:num(h.wind_direction_10m?.[i]),wind_speed_10m:num(h.wind_speed_10m?.[i]),surface_pressure:num(h.surface_pressure?.[i]),precipitation:num(h.precipitation?.[i])}))};
}
function unpackWeatherNext(data){
  const h=data.hourly; if(!h?.time) throw new Error('WeatherNext hourly response missing');
  const suffixes=Object.keys(h).filter(k=>k.startsWith('temperature_2m_member')).map(k=>k.slice('temperature_2m'.length));
  const members=suffixes.length?suffixes:[''];
  return members.map((suffix,index)=>({id:`google_weathernext2${suffix||'_mean'}`,name:`WeatherNext 2 ${suffix?`member ${index+1}`:'ensemble mean'}`,points:h.time.map((time,i)=>({time:new Date(time+'Z'),temperature_2m:num(h[`temperature_2m${suffix}`]?.[i] ?? h.temperature_2m?.[i]),wind_direction_10m:num(h[`wind_direction_10m${suffix}`]?.[i] ?? h.wind_direction_10m?.[i]),wind_speed_10m:num(h[`wind_speed_10m${suffix}`]?.[i] ?? h.wind_speed_10m?.[i]),surface_pressure:num(h[`surface_pressure${suffix}`]?.[i] ?? h.surface_pressure?.[i]),precipitation:num(h[`precipitation${suffix}`]?.[i] ?? h.precipitation?.[i])}))}));
}
function poolWeatherNext(members){
  if(!members.length) return null; const times=[...new Set(members.flatMap(m=>m.points.map(p=>p.time.getTime())))].sort((a,b)=>a-b);
  const blend=(key,points)=>mean(points.map(p=>p[key])); const corrected=(key,points)=>mean(points.map(p=>p[key]));
  const pooled={id:'google_weathernext2',name:`Google WeatherNext 2 (${members.length} members)`,points:times.map(t=>{const ps=members.map(m=>m.points.find(p=>p.time.getTime()===t)).filter(Boolean);return {time:new Date(t),temperature_2m:blend('temperature_2m',ps),wind_direction_10m:circularMean(ps.map(p=>p.wind_direction_10m)),wind_speed_10m:blend('wind_speed_10m',ps),surface_pressure:blend('surface_pressure',ps),precipitation:blend('precipitation',ps)}})};
  pooled.corrected=times.map(t=>{const ps=members.map(m=>m.corrected.find(p=>p.time.getTime()===t)).filter(Boolean);return {time:new Date(t),temperature_2m:corrected('temperature_2m',ps),wind_direction_10m:circularMean(ps.map(p=>p.wind_direction_10m)),wind_speed_10m:corrected('wind_speed_10m',ps),surface_pressure:corrected('surface_pressure',ps),precipitation:corrected('precipitation',ps)}});
  pooled.bias={mae:{temp:mean(members.map(m=>m.bias.mae.temp)),direction:mean(members.map(m=>m.bias.mae.direction)),speed:mean(members.map(m=>m.bias.mae.speed)),pressure:mean(members.map(m=>m.bias.mae.pressure))},residuals:{temp:members.flatMap(m=>m.bias.residuals.temp),direction:members.flatMap(m=>m.bias.residuals.direction),speed:members.flatMap(m=>m.bias.residuals.speed),pressure:members.flatMap(m=>m.bias.residuals.pressure)}};
  return pooled;
}
async function weatherNextModel(lat,lon,calibrationStart,calibrationEnd,start,end,observations){
  const calibration=unpackWeatherNext(await fetchJson(weatherNextUrl(lat,lon,calibrationStart,calibrationEnd,true))); calibration.forEach(m=>{m.bias=calculateBias(m,observations);m.corrected=correct(m).corrected;});
  const forecast=unpackWeatherNext(await fetchJson(weatherNextUrl(lat,lon,start,end))); const matched=forecast.map(m=>{const old=calibration.find(c=>c.id===m.id);if(!old) return null;m.bias=old.bias;m.corrected=correct(m).corrected;return m;}).filter(Boolean);
  return poolWeatherNext(matched);
}
function calculateBias(model, observations){
  const residuals={temp:[],direction:[],speed:[],pressure:[]};
  model.points.forEach(p=>{ const o=nearestMetar(observations,p.time); if(!o) return; const ageHours=(Date.now()-p.time)/36e5;
    // Rain-cooled temperatures are real observations, but are short-lived local
    // anomalies. Keep a little information while preventing them from becoming
    // a large, persistent bias applied throughout a later dry forecast.
    if(Number.isFinite(p.temperature_2m)&&Number.isFinite(o.temp)) residuals.temp.push({value:o.temp-p.temperature_2m,ageHours,persistentWeight:o.transientCooling ? .15 : 1});
    if(Number.isFinite(p.wind_direction_10m)&&Number.isFinite(o.direction)) residuals.direction.push({value:angleDiff(o.direction,p.wind_direction_10m),ageHours});
    if(Number.isFinite(p.wind_speed_10m)&&Number.isFinite(o.speed)) residuals.speed.push({value:o.speed-p.wind_speed_10m,ageHours});
    if(Number.isFinite(p.surface_pressure)&&Number.isFinite(o.pressure)) residuals.pressure.push({value:o.pressure-p.surface_pressure,ageHours});
  });
  const bias={temp:recentRobustMean(residuals.temp),direction:recentRobustMean(residuals.direction),speed:recentRobustMean(residuals.speed),pressure:recentRobustMean(residuals.pressure)};
  const mae=Object.fromEntries(Object.entries(residuals).map(([key,items])=>[key,recentWeightedMean(items.map(x=>({value:Math.abs(x.value),ageHours:x.ageHours,persistentWeight:x.persistentWeight})))]));
  return {...bias,mae,residuals,matches:Math.max(...Object.values(residuals).map(x=>x.length))};
}
function rmse(items,lookback){ const values=items.filter(x=>x.ageHours<=lookback&&Number.isFinite(x.value)); return values.length?Math.sqrt(values.reduce((sum,x)=>sum+x.value*x.value,0)/values.length):Number.NaN; }
const mean=arr=>{ const usable=arr.filter(Number.isFinite); return usable.length?usable.reduce((a,b)=>a+b,0)/usable.length:Number.NaN; };
function recentWeightedMean(items){ const usable=items.filter(x=>Number.isFinite(x.value)); if(!usable.length) return 0; const weights=usable.map(x=>Math.exp(-Math.max(0,x.ageHours)/18)*(x.persistentWeight??1)); return usable.reduce((s,x,i)=>s+x.value*weights[i],0)/weights.reduce((a,b)=>a+b,0); }
function recentRobustMean(items){ const usable=items.filter(x=>Number.isFinite(x.value)); if(!usable.length) return 0; const centre=[...usable].sort((a,b)=>a.value-b.value)[Math.floor(usable.length/2)].value; const deviations=usable.map(x=>Math.abs(x.value-centre)).sort((a,b)=>a-b); const limit=Math.max(deviations[Math.floor(deviations.length/2)]*3, .1); return recentWeightedMean(usable.map(x=>({...x,value:centre+Math.max(-limit,Math.min(limit,x.value-centre))}))); }
function assignAdaptiveWeights(models){
  const keys=['temp','direction','speed','pressure'];
  keys.forEach(key=>{ const floor={temp:.4,direction:12,speed:1.5,pressure:1.5}[key]; const raw=models.map(m=>1/Math.max(m.bias.mae[key]||Infinity,floor)**2); const total=raw.reduce((a,b)=>a+b,0)||1; models.forEach((m,i)=>{m.weights??={};m.weights[key]=raw[i]/total;}); });
  models.forEach(m=>m.weights.precip=keys.reduce((sum,key)=>sum+m.weights[key],0)/keys.length);
  const total=models.reduce((sum,m)=>sum+m.weights.precip,0)||1; models.forEach(m=>m.weights.precip/=total);
}
function correct(model){ const b=model.bias, add=(value,offset)=>Number.isFinite(value)?value+offset:Number.NaN; return {...model, corrected:model.points.map(p=>({...p,temperature_2m:add(p.temperature_2m,b.temp),wind_direction_10m:Number.isFinite(p.wind_direction_10m)?clampDirection(p.wind_direction_10m+b.direction):Number.NaN,wind_speed_10m:Math.max(0,add(p.wind_speed_10m,b.speed)),surface_pressure:add(p.surface_pressure,b.pressure)}))}; }
function latestTransientObservation(observations){
  const latest=[...observations].reverse().find(o=>Number.isFinite(o.temp)&&o.time<=Date.now());
  return latest && Date.now()-latest.time<=2*3600e3 && latest.transientCooling ? latest : null;
}
function halfHourly(models,start,end,transientObservation=null){
  const rows=[]; for(let t=start.getTime();t<=end.getTime();t+=30*60e3){ const date=new Date(t), paired=models.map(m=>({m,p:interpolate(m.corrected,date)})).filter(x=>x.p); if(!paired.length) continue; const blend=(weightKey,pointKey,weights=null)=>weightedMean(paired.map(x=>x.p[pointKey]),weights||paired.map(x=>x.m.weights[weightKey])); const leadHours=transientObservation?(date-transientObservation.time)/36e5:Infinity; const wetTransition=leadHours>=0&&leadHours<=5; const temperatureWeights=paired.map(x=>x.m.weights.temp*(wetTransition?(x.p.precipitation>=.1?1.55:x.p.precipitation>0?1.15:.55):1)); rows.push({time:date,temp:blend('temp','temperature_2m',temperatureWeights),direction:weightedCircularMean(paired.map(x=>x.p.wind_direction_10m),paired.map(x=>x.m.weights.direction)),speed:blend('speed','wind_speed_10m'),pressure:blend('pressure','surface_pressure'),precip:blend('precip','precipitation')*(date.getUTCMinutes()===30?.5:1)}); } return rows;
}
function nowcastTemperatureAdjustment(rows, calibrationModels, observations){
  const latest=latestTransientObservation(observations);
  if(!latest) return {rows,applied:false};
  const baseline=weightedMean(calibrationModels.map(m=>interpolate(m.corrected,latest.time)?.temperature_2m),calibrationModels.map(()=>1));
  if(!Number.isFinite(baseline)) return {rows,applied:false};
  // This is an innovation, not another historical bias. It is deliberately
  // bounded and fades to zero within five hours of the latest METAR.
  const innovation=Math.max(-3.5,Math.min(3.5,latest.temp-baseline));
  if(Math.abs(innovation)<.15) return {rows,applied:false};
  const adjusted=rows.map(row=>{
    const leadHours=(row.time-latest.time)/36e5;
    if(leadHours<0 || leadHours>5) return row;
    // Keep a small first-hour bridge even if a model misses the shower; beyond
    // that, only retain the cooling while its forecast precipitation agrees.
    const wetSupport=row.precip>=.1 ? 1 : row.precip>0 ? .55 : leadHours<=1 ? .2 : 0;
    const fade=Math.max(0,1-leadHours/5);
    return {...row,temp:row.temp+innovation*fade*wetSupport};
  });
  return {rows:adjusted,applied:true};
}
function weightedMean(values,weights){ const pairs=values.map((value,i)=>({value,weight:weights[i]})).filter(x=>Number.isFinite(x.value)&&Number.isFinite(x.weight)); const total=pairs.reduce((sum,x)=>sum+x.weight,0); return total?pairs.reduce((sum,x)=>sum+x.value*x.weight,0)/total:Number.NaN; }
function weightedCircularMean(values,weights){ const pairs=values.map((value,i)=>({value,weight:weights[i]})).filter(x=>Number.isFinite(x.value)&&Number.isFinite(x.weight)); const s=pairs.reduce((sum,x)=>sum+Math.sin(x.value*Math.PI/180)*x.weight,0), c=pairs.reduce((sum,x)=>sum+Math.cos(x.value*Math.PI/180)*x.weight,0); return pairs.length?clampDirection(Math.atan2(s,c)*180/Math.PI):Number.NaN; }
function interpolate(points,date){ const exact=points.find(p=>p.time.getTime()===date.getTime()); if(exact) return {...exact}; const a=points.find(p=>p.time.getTime()===date.getTime()-1800e3), b=points.find(p=>p.time.getTime()===date.getTime()+1800e3); if(!a||!b) return null; return {time:date,temperature_2m:(a.temperature_2m+b.temperature_2m)/2,wind_direction_10m:clampDirection(a.wind_direction_10m+angleDiff(b.wind_direction_10m,a.wind_direction_10m)/2),wind_speed_10m:(a.wind_speed_10m+b.wind_speed_10m)/2,surface_pressure:(a.surface_pressure+b.surface_pressure)/2,precipitation:(a.precipitation+b.precipitation)/2}; }
function precipStyle(value){ if(value>=2.5) return {className:'precip-heavy',color:'#e9704e',label:'Heavy precipitation'}; if(value>=1) return {className:'precip-moderate',color:'#d99b16',label:'Moderate precipitation'}; if(value>=.1) return {className:'precip-light',color:'#75aa2d',label:'Light precipitation'}; if(value>0) return {className:'precip-trace',color:'#399e9a',label:'Trace precipitation'}; return {className:'',color:'#b9c1bd',label:'No precipitation'}; }
const formatValue=(value,digits=1)=>Number.isFinite(value)?value.toFixed(digits):'—';
const formatDirection=value=>Number.isFinite(value)?Math.round(value).toString().padStart(3,'0')+'°':'—';

async function generate(){
  const icao=$('icao').value.trim().toUpperCase(); const start=toUtc($('start').value), end=toUtc($('end').value); if(!/^[A-Z]{4}$/.test(icao)) return notice('Please enter a four-letter ICAO code (for example, KJFK or EGLL).','error'); if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start) return notice('Choose a valid UTC take-off window where the end is after the start.','error');
  if(isFilePreview) return notice('This static preview cannot proxy Aviation Weather Center data. Run “python3 server.py”, then open http://127.0.0.1:4174.','error');
  $('generate').disabled=true; notice('Retrieving 72 hours of AWC METAR observations…','loading'); $('results').classList.add('hidden'); $('detail').classList.add('hidden'); $('metarDetail').classList.add('hidden'); $('modelDetail').classList.add('hidden');
  try{
    const {observations,location}=await getMetars(icao); const calibrationEnd=new Date(), calibrationStart=new Date(calibrationEnd.getTime()-72*3600e3);
    notice('Fetching historical model guidance and estimating model-specific bias…','loading');
    const candidates=[...MODEL_CATALOG,...regionalModels(location.lat,location.lon)];
    const historical=await Promise.allSettled(candidates.map(async ([id,name])=>unpackModel(await fetchJson(queryUrl('https://historical-forecast-api.open-meteo.com/v1/forecast',location.lat,location.lon,calibrationStart,calibrationEnd,id)),id,name)));
    const usable=historical.filter(x=>x.status==='fulfilled').map(x=>x.value); if(!usable.length) throw new Error('Open-Meteo did not return an eligible model for this location.');
    usable.forEach(m=>{m.bias=calculateBias(m,observations);m.corrected=correct(m).corrected;});
    notice('Applying the METAR-derived biases to the requested forecast window…','loading');
    const outputHost=end<=new Date()?'https://historical-forecast-api.open-meteo.com/v1/forecast':'https://api.open-meteo.com/v1/forecast';
    const requested=await Promise.allSettled(usable.map(async old=>{const url=outputHost.includes('historical')?queryUrl(outputHost,location.lat,location.lon,start,end,old.id):liveForecastRangeUrl(location.lat,location.lon,start,end,old.id); const data=await fetchJson(url); const m=unpackModel(data,old.id,old.name); m.bias=old.bias; m.weights=old.weights; return correct(m);}));
    const models=requested.filter(x=>x.status==='fulfilled').map(x=>x.value);
    const weatherNext=await weatherNextModel(location.lat,location.lon,calibrationStart,calibrationEnd,start,end,observations).catch(error=>{console.warn('WeatherNext unavailable',error);return null;}); if(weatherNext) models.push(weatherNext);
    if(!models.length) throw new Error('The requested time window is unavailable from the returned models.'); assignAdaptiveWeights(models);
    const transientObservation=latestTransientObservation(observations);
    const nowcast=nowcastTemperatureAdjustment(halfHourly(models,start,end,transientObservation),usable,observations); if(!nowcast.rows.length) throw new Error('The requested UTC window is outside the available forecast range.');
    state={models,observations,ensemble:nowcast.rows,selected:start,chart:null,parameter:'temp',airport:icao}; render(observations.length,location.name,usable.length); notice(`Ready. ${models.length} models contributed to the corrected ensemble.${nowcast.applied?' A short-lived rain-cooling adjustment is active.':''}`,'');
  }catch(error){ console.error(error); notice(error.message || 'Unable to generate data. Please try again.','error'); } finally {$('generate').disabled=false;}
}
function render(metarCount, airportName, modelCount){
  $('airportName').textContent=`${state.airport} · ${airportName}`; $('modelCount').textContent=modelCount; $('metarCount').textContent=metarCount; $('summary').classList.remove('hidden'); $('results').classList.remove('hidden'); $('metarDetail').classList.remove('hidden'); $('detail').classList.remove('hidden');
  $('tableBody').innerHTML=state.ensemble.map((r,i)=>`<tr data-index="${i}" class="${i===0?'selected':''}"><td>${fmt(r.time)}</td><td>${r.temp.toFixed(1)}</td><td>${Math.round(r.direction).toString().padStart(3,'0')}</td><td>${r.speed.toFixed(1)}</td><td>${r.pressure.toFixed(1)}</td><td class="precip-cell ${precipStyle(r.precip).className}" title="${precipStyle(r.precip).label}">${r.precip.toFixed(2)}</td></tr>`).join('');
  $('tableBody').querySelectorAll('tr').forEach(row=>row.addEventListener('click',()=>{state.selected=state.ensemble[Number(row.dataset.index)].time; $('tableBody').querySelectorAll('tr').forEach(x=>x.classList.remove('selected'));row.classList.add('selected'); drawChart();}));
  const recentMetars=state.observations.filter(o=>o.time>=Date.now()-24*3600e3).sort((a,b)=>b.time-a.time);
  $('metarTableBody').innerHTML=recentMetars.map(o=>`<tr><td>${fmt(o.time)}</td><td>${formatValue(o.temp,1)}</td><td>${o.variableWind?`VRB / ${formatDirection(o.direction)}`:formatDirection(o.direction)}</td><td>${formatValue(o.speed,1)}</td><td>${formatValue(o.pressure,1)}</td></tr>`).join('') || '<tr><td colspan="5">No METAR observations are available in the last 24 hours.</td></tr>';
  const windows=[12,24,36,48,72]; $('modelTableBody').innerHTML=state.models.flatMap(model=>windows.map((hours,index)=>{const meta=MODEL_META[model.id]||{resolution:'—',refresh:'—'}, r=model.bias.residuals;return `<tr><td>${index===0?model.name:''}</td><td>${index===0?meta.resolution:''}</td><td>${index===0?meta.refresh:''}</td><td>${hours} h</td><td>${formatValue(rmse(r.temp,hours),2)}</td><td>${formatValue(rmse(r.direction,hours),1)}</td><td>${formatValue(rmse(r.speed,hours),2)}</td><td>${formatValue(rmse(r.pressure,hours),2)}</td></tr>`;})).join(''); $('modelDetail').classList.remove('hidden');
  $('parameterTabs').innerHTML=Object.entries(SETTINGS).map(([id,s])=>`<button type="button" data-p="${id}" class="${id===state.parameter?'active':''}">${s.label}</button>`).join(''); $('parameterTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{state.parameter=b.dataset.p;$('parameterTabs').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));drawChart();});
}
function drawChart(){
  if(!$('detail').classList.contains('open')) return;
  const s=SETTINGS[state.parameter], isWind=state.parameter==='direction', isPrecip=state.parameter==='precip';
  // Use the complete requested take-off window. The table selection is retained
  // for comparison and CSV context, but it must not crop a longer forecast.
  const from=state.ensemble[0]?.time?.getTime(),to=state.ensemble.at(-1)?.time?.getTime(), palette=['#8097a5','#cf8c76','#8c9d75','#967fa3','#c0a56f','#6b92a1','#bb8792','#889189','#806e94'];
  $('chartTitle').textContent=s.label;
  const raw=state.models.map((m,i)=>{ const data=m.points.filter(p=>p.time>=from&&p.time<=to).map(p=>({x:p.time,y:p[s.key]})); return {label:m.name,type:isWind?'scatter':'line',showLine:!isWind,data,borderColor:palette[i%palette.length],borderWidth:1.2,pointRadius:isPrecip?3:0,pointBackgroundColor:isPrecip?data.map(p=>precipStyle(p.y).color):palette[i%palette.length],tension:.18,windArrows:isWind,arrowColor:palette[i%palette.length]}; });
  const obsKey={temp:'temp',direction:'direction',speed:'speed',pressure:'pressure'}[state.parameter];
  const observed=!isPrecip ? {label:'Observed METAR',type:isWind?'scatter':'line',showLine:false,data:state.observations.filter(o=>o.time>=from&&o.time<=to&&Number.isFinite(o[obsKey])).map(o=>({x:o.time,y:o[obsKey]})),borderColor:'#e75e3f',backgroundColor:'#e75e3f',pointBackgroundColor:'#e75e3f',pointBorderColor:'#f6f5ef',pointBorderWidth:1.5,pointRadius:isWind?0:4,pointStyle:'circle',windArrows:isWind,arrowColor:'#e75e3f'} : null;
  const ensembleData=state.ensemble.filter(p=>p.time>=from&&p.time<=to).map(p=>({x:p.time,y:p[state.parameter]}));
  const ensemble={label:'Corrected ensemble',type:isPrecip?'bar':isWind?'scatter':'line',showLine:!isWind&&!isPrecip,data:ensembleData,borderColor:'#17493a',borderWidth:isPrecip?0:3,backgroundColor:isPrecip?ensembleData.map(p=>precipStyle(p.y).color):'#17493a',pointRadius:0,tension:.18,windArrows:isWind,arrowColor:'#17493a'};
  const windArrowPlugin={id:'windArrows',afterDatasetsDraw(chart){ if(!isWind) return; const {ctx}=chart; chart.data.datasets.forEach((set,index)=>{ if(!set.windArrows) return; const meta=chart.getDatasetMeta(index); meta.data.forEach((element,pointIndex)=>{const direction=set.data[pointIndex]?.y;if(!Number.isFinite(direction)) return;ctx.save();ctx.translate(element.x,element.y);ctx.rotate((direction+180)*Math.PI/180);ctx.strokeStyle=set.arrowColor;ctx.fillStyle=set.arrowColor;ctx.lineWidth=index===chart.data.datasets.length-1?2.4:1.35;ctx.beginPath();ctx.moveTo(0,6);ctx.lineTo(0,-7);ctx.stroke();ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(-3.5,-2);ctx.lineTo(3.5,-2);ctx.closePath();ctx.fill();ctx.restore();}); }); }};
  if(state.chart) state.chart.destroy(); Chart.getChart($('chart'))?.destroy();
  state.chart=new Chart($('chart'),{type:'line',data:{datasets:[...raw,...(observed?[observed]:[]),ensemble]},plugins:[windArrowPlugin],options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{position:'bottom',labels:{boxWidth:14,font:{family:'DM Sans',size:11},usePointStyle:true}},tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${Number(c.parsed.y).toFixed(isWind?0:1)} ${s.unit}`}}},scales:{x:{type:'time',adapters:{date:{zone:'utc'}},time:{unit:'hour',tooltipFormat:'dd MMM HH:mm'},title:{display:true,text:'Time (UTC)',font:{family:'DM Mono',size:10}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:10}}},y:{min:isWind?0:undefined,max:isWind?360:undefined,title:{display:true,text:s.unit,font:{family:'DM Mono',size:10}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:10}}}}}});
}
function download(){ const header='Time (UTC),Temp (°C),Wind Direction (°),Wind Speed (kt),Surface Pressure (hPa),Precipitation (mm / 30 min)'; const lines=state.ensemble.map(r=>[r.time.toISOString(),r.temp.toFixed(1),Math.round(r.direction),r.speed.toFixed(1),r.pressure.toFixed(1),r.precip.toFixed(2)].join(',')); const blob=new Blob([[header,...lines].join('\n')],{type:'text/csv'}); const link=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:`${state.airport}-takeoff-ensemble.csv`});link.click();URL.revokeObjectURL(link.href); }
function bindToggle(sectionId,buttonId,onExpand){ $(buttonId).onclick=()=>{const section=$(sectionId);section.classList.toggle('open');const expanded=section.classList.contains('open');$(buttonId).setAttribute('aria-expanded',expanded);$(buttonId).querySelector('i').textContent=expanded?'−':'+';if(expanded) onExpand?.();}; }
$('detail').after($('metarDetail')); $('metarDetail').after($('modelDetail')); $('generate').onclick=generate; $('icao').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase()); bindToggle('detail','detailToggle',drawChart); bindToggle('metarDetail','metarToggle'); bindToggle('modelDetail','modelToggle'); $('download').onclick=download;setDefaults();
