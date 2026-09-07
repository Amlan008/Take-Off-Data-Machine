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
const MODEL_META={gfs_global:{resolution:'~13 km',refresh:'Hourly'},icon_global:{resolution:'~11 km',refresh:'6-hourly'},ecmwf_ifs04:{resolution:'~25 km',refresh:'6-hourly'},gem_global:{resolution:'~15 km',refresh:'12-hourly'},jma_gsm:{resolution:'~20 km',refresh:'6-hourly'},ukmo_global:{resolution:'~10 km',refresh:'6-hourly'},meteofrance_arpege_world:{resolution:'~25 km',refresh:'6-hourly'},cma_grapes_global:{resolution:'~25 km',refresh:'12-hourly'},bom_access_global:{resolution:'~25 km',refresh:'12-hourly'},ecmwf_ifs025_ensemble:{resolution:'~25 km · 51 members',refresh:'6-hourly'},ecmwf_aifs025_ensemble:{resolution:'~25 km · 51 members',refresh:'6-hourly'},google_weathernext2_ensemble:{resolution:'~25 km · 64 members',refresh:'12-hourly'}};
const VARS = 'temperature_2m,wind_direction_10m,wind_speed_10m,wind_gusts_10m,pressure_msl,precipitation,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,is_day,cloud_base,freezing_level_height,cape,convective_inhibition';
const SETTINGS = {
  temp: {label:'Temperature', key:'temperature_2m', unit:'°C'},
  wind: {label:'Wind direction & speed', unit:'° / kt'},
  pressure: {label:'Mean sea-level pressure', key:'pressure_msl', unit:'hPa'},
  precip: {label:'Precipitation', key:'precipitation', unit:'mm / 30 min'}
};
let state = { models: [], ensemble: [], runways: [], selected: null, chart: null, meteograms: [], parameter: 'temp', airport: '' };
let runwayDataPromise;
const $ = id => document.getElementById(id);
const utcInput = date => date.toISOString().slice(0,16);
const isoHour = date => date.toISOString().slice(0,13) + ':00';
const toUtc = value => new Date(value + 'Z');
const fmt = date => new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(date).replace(',', '');
const fmtChartUtc = date => new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replace(',', '');
const fmtChartTimeUtc = date => new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
const fmtChartDateUtc = date => new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',year:'numeric'}).format(date);
const floorHalfHour = date => new Date(Math.floor(date.getTime()/(30*60e3))*30*60e3);
const ceilHalfHour = date => new Date(Math.ceil(date.getTime()/(30*60e3))*30*60e3);
const clampDirection = n => ((n % 360) + 360) % 360;
const angleDiff = (target, source) => ((target - source + 540) % 360) - 180;
const circularMean = values => weightedCircularMean(values, values.map(()=>1));

function setDefaults(){ const now=new Date(); now.setUTCMinutes(0,0,0); const start=new Date(now.getTime()+60*60*1000), end=new Date(start.getTime()+6*60*60*1000); $('start').value=utcInput(start); $('end').value=utcInput(end); }
function notice(message, type=''){ $('notice').textContent=message; $('notice').className='notice '+type; }
const isFilePreview=location.protocol==='file:';
function queryUrl(host, lat, lon, start, end, model){ const p=new URLSearchParams({latitude:lat,longitude:lon,timezone:'GMT',start_date:start.toISOString().slice(0,10),end_date:end.toISOString().slice(0,10),models:model,wind_speed_unit:'kn',hourly:VARS}); return `${host}?${p}`; }
function liveForecastRangeUrl(lat,lon,start,end,model){
  // Near "now", date-only start_date/end_date requests can be interpreted on
  // the opposite side of midnight by the upstream API. Ask for a small rolling
  // range instead, then retain only the user's exact UTC window locally.
  const now=Date.now(), day=24*3600e3;
  const pastDays=Math.max(0,Math.min(3,Math.ceil((now-start.getTime())/day)));
  const forecastDays=Math.max(1,Math.min(16,Math.ceil((end.getTime()-now)/day)+2));
  const p=new URLSearchParams({latitude:lat,longitude:lon,timezone:'GMT',past_days:String(pastDays),forecast_days:String(forecastDays),models:model,wind_speed_unit:'kn',hourly:VARS});
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}
function ensembleUrl(lat,lon,start,end,model,past=false){ const p=new URLSearchParams({latitude:lat,longitude:lon,timezone:'GMT',models:model,wind_speed_unit:'kn',hourly:VARS}); if(past){p.set('past_days','3');p.set('forecast_days','0');}else{p.set('start_date',start.toISOString().slice(0,10));p.set('end_date',end.toISOString().slice(0,10));} return `https://ensemble-api.open-meteo.com/v1/ensemble?${p}`; }

async function fetchJson(url){ const res=await fetch(url); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`); return res.json(); }
async function getRunways(icao){
  runwayDataPromise ||= fetchJson('assets/runways.json');
  const allRunways=await runwayDataPromise;
  return allRunways[icao]||[];
}
async function getMetars(icao){
  const data=await fetchJson(`/api/metar?icao=${encodeURIComponent(icao)}`);
  if(!Array.isArray(data)||!data.length) throw new Error('No METAR observations returned for this ICAO code in the last 72 hours.');
  const observations=data.map(m=>{
    const raw=String(m.rawOb || m.raw_text || m.rawText || '');
    const visibility=metarVisibility(raw,m.visib);
    return {time:metarDate(m.obsTime || m.reportTime || m.receiptTime),temp:num(m.temp),direction:num(m.wdir),variableWind:!Number.isFinite(num(m.wdir)),speed:num(m.wspd),pressure:metarPressure(m.altim),visibilitySm:num(m.visib),visibilityMetres:visibility.metres,visibilityCensored:visibility.censored,ceilingFt:metarCeilingFt(raw),raw,lat:num(m.lat),lon:num(m.lon),name:m.name || m.site || m.icaoId || icao,...metarEventFlags(raw,num(m.visib))};
  }).filter(m=>!Number.isNaN(m.time.getTime())).sort((a,b)=>a.time-b.time);
  resolveVariableWinds(observations);
  markTransientTemperatureEvents(observations);
  const location=observations.find(m=>Number.isFinite(m.lat)&&Number.isFinite(m.lon));
  if(!location) throw new Error('AWC returned METARs but no station coordinates.');
  return {observations, location};
}
async function getNearbyMetars(lat,lon){
  const data=await fetchJson(`/api/nearby-metar?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
  return Array.isArray(data)?data.map(m=>({time:metarDate(m.obsTime||m.reportTime||m.receiptTime),temp:num(m.temp),direction:num(m.wdir),speed:num(m.wspd),lat:num(m.lat),lon:num(m.lon)})).filter(m=>!Number.isNaN(m.time.getTime())):[];
}
function median(values){const usable=values.filter(Number.isFinite).sort((a,b)=>a-b);return usable.length?usable[Math.floor(usable.length/2)]:Number.NaN;}
function assessObservationQuality(observations, nearby){
  observations.forEach(observation=>{
    observation.quality=1; observation.qualityFlags=[];
    if(!Number.isFinite(observation.temp)&&!Number.isFinite(observation.speed)&&!Number.isFinite(observation.pressure)){observation.quality=0;observation.qualityFlags.push('missing core values');return;}
    const peers=nearby.filter(peer=>Math.abs(peer.time-observation.time)<=45*60e3&&Number.isFinite(peer.temp));
    // Nearby stations are a guardrail, not a replacement for a real airport
    // observation: large differences can be genuine coastal, terrain or storm-scale effects.
    if(peers.length>=3&&Number.isFinite(observation.temp)&&Math.abs(observation.temp-median(peers.map(peer=>peer.temp)))>8){observation.quality=.25;observation.qualityFlags.push('temperature differs strongly from nearby stations');}
  });
  return observations;
}
async function getTaf(icao){
  const data=await fetchJson(`/api/taf?icao=${encodeURIComponent(icao)}`);
  const reports=(Array.isArray(data)?data:data?.data||data?.taf||[]);
  return reports.map(report=>({
    raw:String(report.rawTAF||report.raw_text||report.rawText||report.rawOb||'').trim(),
    issueTime:metarDate(report.issueTime||report.bulletinTime),
    validFrom:metarDate(report.validTimeFrom), validTo:metarDate(report.validTimeTo),
    mostRecent:Number(report.mostRecent)===1,
    forecasts:(report.fcsts||[]).map(fcst=>({timeFrom:metarDate(fcst.timeFrom),timeTo:metarDate(fcst.timeTo),timeBec:fcst.timeBec?metarDate(fcst.timeBec):null,change:fcst.fcstChange||'',probability:fcst.probability, direction:num(fcst.wdir), variableWind:String(fcst.wdir||'').toUpperCase()==='VRB',speed:num(fcst.wspd),gust:num(fcst.wgst),visibility:fcst.visib,weather:fcst.wxString,clouds:fcst.clouds||[]}))
  })).filter(report=>report.raw);
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
function metarVisibility(raw,value){
  // AWC's numeric field is normally statute miles. Prefer the raw bulletin
  // because 9999 and P6SM are censored observations, not exact values.
  const text=String(raw||'').toUpperCase();
  if(/(?:^|\s)9999(?:\s|$)/.test(text)) return {metres:10000,censored:true};
  const plus=text.match(/(?:^|\s)P(\d+(?:\.\d+)?)SM(?:\s|$)/);
  if(plus) return {metres:Number(plus[1])*1609.344,censored:true};
  const miles=text.match(/(?:^|\s)(\d+)?(?:\s+(\d+)\/(\d+))?SM(?:\s|$)/);
  if(miles){const whole=Number(miles[1]||0), fraction=miles[2]?Number(miles[2])/Number(miles[3]):0;return {metres:(whole+fraction)*1609.344,censored:false};}
  const numeric=num(value);
  if(!Number.isFinite(numeric)) return {metres:Number.NaN,censored:false};
  return numeric>=9999?{metres:numeric,censored:true}:{metres:numeric*1609.344,censored:false};
}
function metarCeilingFt(raw){
  const layers=[...String(raw||'').toUpperCase().matchAll(/(?:^|\s)(?:BKN|OVC|VV)(\d{3})(?:\s|$)/g)].map(match=>Number(match[1])*100).filter(Number.isFinite);
  return layers.length?Math.min(...layers):Number.NaN;
}
function metarEventFlags(raw,visibilitySm){
  const text=raw.toUpperCase();
  return {eventPrecip:/(?:^|\s)(?:[-+]?RA|[-+]?SHRA|[-+]?TSRA|[-+]?DZ|[-+]?FZRA|[-+]?SN|[-+]?SG|[-+]?PL|[-+]?GR|[-+]?GS)(?:\s|$)/.test(text),eventThunder:/(?:^|\s)(?:[-+]?TS|VCTS)(?:[A-Z]{0,4})?(?:\s|$)/.test(text),eventFogLowVis:/(?:^|\s)(?:MIFG|BCFG|PRFG|FZFG|FG)(?:\s|$)/.test(text)||(Number.isFinite(visibilitySm)&&visibilitySm<=3)};
}
function weatherCodeEvents(code){
  if(!Number.isFinite(code)) return null;
  return {precip:[51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(code),thunder:[95,96,99].includes(code),fogLowVis:[45,48].includes(code)};
}
function nearestMetar(observations, date, maximumAgeMs=90*60e3){ const nearest=observations.reduce((best,o)=>!best || Math.abs(o.time-date)<Math.abs(best.time-date)?o:best,null); return nearest&&Math.abs(nearest.time-date)<=maximumAgeMs?nearest:null; }
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
  return {id,name,points:h.time.map((time,i)=>({time:new Date(time+'Z'),temperature_2m:num(h.temperature_2m?.[i]),wind_direction_10m:num(h.wind_direction_10m?.[i]),wind_speed_10m:num(h.wind_speed_10m?.[i]),wind_gusts_10m:num(h.wind_gusts_10m?.[i]),pressure_msl:num(h.pressure_msl?.[i]),precipitation:num(h.precipitation?.[i]),weather_code:num(h.weather_code?.[i]),cloud_cover:num(h.cloud_cover?.[i]),cloud_cover_low:num(h.cloud_cover_low?.[i]),cloud_cover_mid:num(h.cloud_cover_mid?.[i]),cloud_cover_high:num(h.cloud_cover_high?.[i]),is_day:num(h.is_day?.[i]),visibility:num(h.visibility?.[i]),cloud_base:num(h.cloud_base?.[i]),freezing_level_height:num(h.freezing_level_height?.[i]),cape:num(h.cape?.[i]),convective_inhibition:num(h.convective_inhibition?.[i])}))};
}
function unpackEnsemble(data, source){
  const h=data.hourly; if(!h?.time) throw new Error(`${source.name} hourly response missing`);
  const suffixes=Object.keys(h).filter(k=>k.startsWith('temperature_2m_member')).map(k=>k.slice('temperature_2m'.length));
  const members=suffixes.length?suffixes:[''];
  return members.map((suffix,index)=>({id:`${source.id}${suffix||'_mean'}`,name:`${source.name} ${suffix?`member ${index+1}`:'ensemble mean'}`,points:h.time.map((time,i)=>({time:new Date(time+'Z'),temperature_2m:num(h[`temperature_2m${suffix}`]?.[i] ?? h.temperature_2m?.[i]),wind_direction_10m:num(h[`wind_direction_10m${suffix}`]?.[i] ?? h.wind_direction_10m?.[i]),wind_speed_10m:num(h[`wind_speed_10m${suffix}`]?.[i] ?? h.wind_speed_10m?.[i]),wind_gusts_10m:num(h[`wind_gusts_10m${suffix}`]?.[i] ?? h.wind_gusts_10m?.[i]),pressure_msl:num(h[`pressure_msl${suffix}`]?.[i] ?? h.pressure_msl?.[i]),precipitation:num(h[`precipitation${suffix}`]?.[i] ?? h.precipitation?.[i]),weather_code:num(h[`weather_code${suffix}`]?.[i] ?? h.weather_code?.[i]),cloud_cover:num(h[`cloud_cover${suffix}`]?.[i] ?? h.cloud_cover?.[i]),cloud_cover_low:num(h[`cloud_cover_low${suffix}`]?.[i] ?? h.cloud_cover_low?.[i]),cloud_cover_mid:num(h[`cloud_cover_mid${suffix}`]?.[i] ?? h.cloud_cover_mid?.[i]),cloud_cover_high:num(h[`cloud_cover_high${suffix}`]?.[i] ?? h.cloud_cover_high?.[i]),is_day:num(h[`is_day${suffix}`]?.[i] ?? h.is_day?.[i]),visibility:num(h[`visibility${suffix}`]?.[i] ?? h.visibility?.[i]),cloud_base:num(h[`cloud_base${suffix}`]?.[i] ?? h.cloud_base?.[i]),freezing_level_height:num(h[`freezing_level_height${suffix}`]?.[i] ?? h.freezing_level_height?.[i]),cape:num(h[`cape${suffix}`]?.[i] ?? h.cape?.[i]),convective_inhibition:num(h[`convective_inhibition${suffix}`]?.[i] ?? h.convective_inhibition?.[i])}))}));
}
function poolEnsemble(members, source){
  if(!members.length) return null; const times=[...new Set(members.flatMap(m=>m.points.map(p=>p.time.getTime())))].sort((a,b)=>a-b);
  const blend=(key,points)=>mean(points.map(p=>p[key])); const corrected=(key,points)=>mean(points.map(p=>p[key]));
  const pooled={id:source.id,name:`${source.name} (${members.length} members)`,points:times.map(t=>{const ps=members.map(m=>m.points.find(p=>p.time.getTime()===t)).filter(Boolean);return {time:new Date(t),temperature_2m:blend('temperature_2m',ps),wind_direction_10m:circularMean(ps.map(p=>p.wind_direction_10m)),wind_speed_10m:blend('wind_speed_10m',ps),wind_gusts_10m:blend('wind_gusts_10m',ps),pressure_msl:blend('pressure_msl',ps),precipitation:blend('precipitation',ps),weather_code:weightedMode(ps.map(p=>p.weather_code)),cloud_cover:blend('cloud_cover',ps),cloud_cover_low:blend('cloud_cover_low',ps),cloud_cover_mid:blend('cloud_cover_mid',ps),cloud_cover_high:blend('cloud_cover_high',ps),is_day:weightedMode(ps.map(p=>p.is_day)),visibility:blend('visibility',ps),cloud_base:blend('cloud_base',ps),freezing_level_height:blend('freezing_level_height',ps),cape:blend('cape',ps),convective_inhibition:blend('convective_inhibition',ps)}})};
  pooled.corrected=times.map(t=>{const ps=members.map(m=>m.corrected.find(p=>p.time.getTime()===t)).filter(Boolean);return {time:new Date(t),temperature_2m:corrected('temperature_2m',ps),wind_direction_10m:circularMean(ps.map(p=>p.wind_direction_10m)),wind_speed_10m:corrected('wind_speed_10m',ps),wind_gusts_10m:corrected('wind_gusts_10m',ps),pressure_msl:corrected('pressure_msl',ps),precipitation:corrected('precipitation',ps),weather_code:weightedMode(ps.map(p=>p.weather_code)),cloud_cover:corrected('cloud_cover',ps),cloud_cover_low:corrected('cloud_cover_low',ps),cloud_cover_mid:corrected('cloud_cover_mid',ps),cloud_cover_high:corrected('cloud_cover_high',ps),is_day:weightedMode(ps.map(p=>p.is_day)),visibility:corrected('visibility',ps),cloud_base:corrected('cloud_base',ps),freezing_level_height:corrected('freezing_level_height',ps),cape:corrected('cape',ps),convective_inhibition:corrected('convective_inhibition',ps)}});
  pooled.bias={mae:{temp:mean(members.map(m=>m.bias.mae.temp)),direction:mean(members.map(m=>m.bias.mae.direction)),speed:mean(members.map(m=>m.bias.mae.speed)),pressure:mean(members.map(m=>m.bias.mae.pressure)),visibility:mean(members.map(m=>m.bias.mae.visibility)),ceiling:mean(members.map(m=>m.bias.mae.ceiling))},residuals:{temp:members.flatMap(m=>m.bias.residuals.temp),direction:members.flatMap(m=>m.bias.residuals.direction),speed:members.flatMap(m=>m.bias.residuals.speed),pressure:members.flatMap(m=>m.bias.residuals.pressure),visibility:members.flatMap(m=>m.bias.residuals.visibility),ceiling:members.flatMap(m=>m.bias.residuals.ceiling)}};
  pooled.eventSkill=Object.fromEntries(['precip','thunder','fogLowVis'].map(event=>[event,{brier:mean(members.map(member=>member.eventSkill?.[event]?.brier)),matches:members.reduce((sum,member)=>sum+(member.eventSkill?.[event]?.matches||0),0)}]));
  return pooled;
}
async function ensembleSourceModel(source,lat,lon,calibrationStart,calibrationEnd,start,end,observations){
  // Each member receives its own METAR correction. Members are pooled back into
  // one source before adaptive weighting, so a 51- or 64-member system has one
  // fair vote alongside every deterministic/regional model.
  const calibration=unpackEnsemble(await fetchJson(ensembleUrl(lat,lon,calibrationStart,calibrationEnd,source.id,true)),source); calibration.forEach(m=>{m.bias=calculateBias(m,observations);m.eventSkill=calculateEventSkill(m,observations);m.corrected=correct(m).corrected;});
  const forecast=unpackEnsemble(await fetchJson(ensembleUrl(lat,lon,start,end,source.id)),source); const matched=forecast.map(m=>{const old=calibration.find(c=>c.id===m.id);if(!old) return null;m.bias=old.bias;m.eventSkill=old.eventSkill;m.corrected=correct(m).corrected;return m;}).filter(Boolean);
  return poolEnsemble(matched,source);
}
function calculateBias(model, observations){
  const residuals={temp:[],direction:[],speed:[],pressure:[],visibility:[],ceiling:[]};
  const regimeResiduals={wet:{temp:[],direction:[],speed:[],pressure:[],visibility:[]},dry:{temp:[],direction:[],speed:[],pressure:[],visibility:[]},day:{temp:[],direction:[],speed:[],pressure:[],visibility:[]},night:{temp:[],direction:[],speed:[],pressure:[],visibility:[]},breezy:{temp:[],direction:[],speed:[],pressure:[],visibility:[]},lightWind:{temp:[],direction:[],speed:[],pressure:[],visibility:[]}};
  model.points.forEach(p=>{ const o=nearestMetar(observations,p.time); if(!o) return; const ageHours=(Date.now()-p.time)/36e5;
    const quality=o.quality??1, regimes=[weatherCodeEvents(p.weather_code)?.precip?'wet':'dry',p.is_day===1?'day':'night',p.wind_speed_10m>=15?'breezy':'lightWind'];
    const add=(key,value,persistentWeight=1)=>{if(!Number.isFinite(value)) return;const item={value,ageHours,persistentWeight:persistentWeight*quality};residuals[key].push(item);regimes.forEach(regime=>regimeResiduals[regime][key].push(item));};
    // Rain-cooled temperatures are real observations, but are short-lived local
    // anomalies. Keep a little information while preventing them from becoming
    // a large, persistent bias applied throughout a later dry forecast.
    if(Number.isFinite(p.temperature_2m)&&Number.isFinite(o.temp)) add('temp',o.temp-p.temperature_2m,o.transientCooling ? .15 : 1);
    if(Number.isFinite(p.wind_direction_10m)&&Number.isFinite(o.direction)) add('direction',angleDiff(o.direction,p.wind_direction_10m));
    if(Number.isFinite(p.wind_speed_10m)&&Number.isFinite(o.speed)) add('speed',o.speed-p.wind_speed_10m);
    if(Number.isFinite(p.pressure_msl)&&Number.isFinite(o.pressure)) add('pressure',o.pressure-p.pressure_msl);
    // Visibility is positive and strongly non-linear. Correct its log-ratio,
    // but do not interpret 9999/P6SM as an exact clear-air measurement.
    if(Number.isFinite(p.visibility)&&p.visibility>=100&&Number.isFinite(o.visibilityMetres)&&o.visibilityMetres>=100&&!o.visibilityCensored){
      const operationalWeight=o.visibilityMetres<=3000?2.5:o.visibilityMetres<=5000?2:o.visibilityMetres<=8000?1.4:.8;
      add('visibility',Math.log(o.visibilityMetres/p.visibility),operationalWeight);
    }
    // A BKN/OVC/VV METAR ceiling is kept as a verification proxy only. It is
    // deliberately not used to force-adjust model cloud base, which is a
    // different physical/model diagnostic.
    if(Number.isFinite(p.cloud_base)&&Number.isFinite(o.ceilingFt)) residuals.ceiling.push({value:o.ceilingFt/3.28084-p.cloud_base,ageHours,persistentWeight:quality});
  });
  const bias={temp:recentRobustMean(residuals.temp),direction:recentRobustMean(residuals.direction),speed:recentRobustMean(residuals.speed),pressure:recentRobustMean(residuals.pressure),visibility:Math.max(-Math.log(2),Math.min(Math.log(2),recentRobustMean(residuals.visibility)))};
  const mae=Object.fromEntries(Object.entries(residuals).map(([key,items])=>[key,recentWeightedMean(items.map(x=>({value:Math.abs(x.value),ageHours:x.ageHours,persistentWeight:x.persistentWeight})))]));
  const regimes=Object.fromEntries(Object.entries(regimeResiduals).map(([regime,values])=>[regime,Object.fromEntries(Object.entries(values).map(([key,items])=>[key,{value:recentRobustMean(items),matches:items.length}]))]));
  return {...bias,mae,residuals,regimes,matches:Math.max(...Object.values(residuals).map(x=>x.length))};
}
function calculateEventSkill(model,observations){
  const keys=['precip','thunder','fogLowVis'], samples=Object.fromEntries(keys.map(key=>[key,[]]));
  model.points.forEach(point=>{
    const modelEvents=weatherCodeEvents(point.weather_code), observation=nearestMetar(observations,point.time);
    if(!modelEvents||!observation) return;
    const ageHours=(Date.now()-point.time)/36e5;
    const observed={precip:observation.eventPrecip,thunder:observation.eventThunder,fogLowVis:observation.eventFogLowVis};
    keys.forEach(key=>samples[key].push({value:(modelEvents[key]?1:0)-(observed[key]?1:0),ageHours}));
  });
  return Object.fromEntries(keys.map(key=>{const values=samples[key];return [key,{brier:values.length?recentWeightedMean(values.map(item=>({...item,value:item.value*item.value}))):Number.NaN,matches:values.length}];}));
}
function rmse(items,lookback){ const values=items.filter(x=>x.ageHours<=lookback&&Number.isFinite(x.value)); return values.length?Math.sqrt(values.reduce((sum,x)=>sum+x.value*x.value,0)/values.length):Number.NaN; }
const mean=arr=>{ const usable=arr.filter(Number.isFinite); return usable.length?usable.reduce((a,b)=>a+b,0)/usable.length:Number.NaN; };
function weightedMode(values,weights=values.map(()=>1)){ const totals=new Map(); values.forEach((value,index)=>{if(Number.isFinite(value)) totals.set(value,(totals.get(value)||0)+(Number.isFinite(weights[index])?weights[index]:0));}); let result=Number.NaN,largest=-1; totals.forEach((weight,value)=>{if(weight>largest){result=value;largest=weight;}}); return result; }
function recentWeightedMean(items){ const usable=items.filter(x=>Number.isFinite(x.value)); if(!usable.length) return 0; const weights=usable.map(x=>Math.exp(-Math.max(0,x.ageHours)/18)*(x.persistentWeight??1)); return usable.reduce((s,x,i)=>s+x.value*weights[i],0)/weights.reduce((a,b)=>a+b,0); }
function recentRobustMean(items){ const usable=items.filter(x=>Number.isFinite(x.value)); if(!usable.length) return 0; const centre=[...usable].sort((a,b)=>a.value-b.value)[Math.floor(usable.length/2)].value; const deviations=usable.map(x=>Math.abs(x.value-centre)).sort((a,b)=>a-b); const limit=Math.max(deviations[Math.floor(deviations.length/2)]*3, .1); return recentWeightedMean(usable.map(x=>({...x,value:centre+Math.max(-limit,Math.min(limit,x.value-centre))}))); }
function assignAdaptiveWeights(models){
  const keys=['temp','direction','speed','pressure'];
  keys.forEach(key=>{ const floor={temp:.4,direction:12,speed:1.5,pressure:1.5}[key]; const raw=models.map(m=>1/Math.max(m.bias.mae[key]||Infinity,floor)**2); const total=raw.reduce((a,b)=>a+b,0)||1; models.forEach((m,i)=>{m.weights??={};m.weights[key]=raw[i]/total;}); });
  const fallback=models.map(m=>keys.reduce((sum,key)=>sum+m.weights[key],0)/keys.length);
  const visibilityRaw=models.map((model,index)=>model.bias.residuals.visibility.length>=3&&Number.isFinite(model.bias.mae.visibility)?1/Math.max(model.bias.mae.visibility,.12)**2:fallback[index]), visibilityTotal=visibilityRaw.reduce((sum,value)=>sum+value,0)||1;
  models.forEach((model,index)=>model.weights.visibility=visibilityRaw[index]/visibilityTotal);
  ['precip','thunder','fogLowVis'].forEach(event=>{const raw=models.map((model,index)=>{const brier=model.eventSkill?.[event]?.brier;return Number.isFinite(brier)?1/Math.max(brier,.04)**2:fallback[index];}),total=raw.reduce((sum,value)=>sum+value,0)||1;models.forEach((model,index)=>{model.eventWeights??={};model.eventWeights[event]=raw[index]/total;});});
  models.forEach((model,index)=>model.weights.precip=model.eventWeights.precip??fallback[index]);
}
function correct(model){ const b=model.bias, add=(value,offset)=>Number.isFinite(value)?value+offset:Number.NaN, regimeOffset=(key,p)=>{const labels=[weatherCodeEvents(p.weather_code)?.precip?'wet':'dry',p.is_day===1?'day':'night',p.wind_speed_10m>=15?'breezy':'lightWind'];const candidates=labels.map(label=>b.regimes?.[label]?.[key]).filter(item=>item?.matches>=4&&Number.isFinite(item.value)).map(item=>item.value);return candidates.length?.55*b[key]+.45*mean(candidates):b[key];}, correctedVisibility=p=>{if(!Number.isFinite(p.visibility)) return Number.NaN;const logOffset=Math.max(-Math.log(2),Math.min(Math.log(2),regimeOffset('visibility',p)||0));return Math.max(100,Math.min(100000,p.visibility*Math.exp(.65*logOffset)));}; return {...model, corrected:model.points.map(p=>({...p,temperature_2m:add(p.temperature_2m,regimeOffset('temp',p)),wind_direction_10m:Number.isFinite(p.wind_direction_10m)?clampDirection(p.wind_direction_10m+regimeOffset('direction',p)):Number.NaN,wind_speed_10m:Math.max(0,add(p.wind_speed_10m,regimeOffset('speed',p))),pressure_msl:add(p.pressure_msl,regimeOffset('pressure',p)),visibility:correctedVisibility(p)}))}; }
function latestTransientObservation(observations){
  const latest=[...observations].reverse().find(o=>Number.isFinite(o.temp)&&o.time<=Date.now());
  return latest && Date.now()-latest.time<=2*3600e3 && latest.transientCooling ? latest : null;
}
function halfHourly(models,start,end,transientObservation=null){
  const rows=[]; for(let t=start.getTime();t<=end.getTime();t+=30*60e3){ const date=new Date(t), paired=models.map(m=>({m,p:interpolate(m.corrected,date)})).filter(x=>x.p); if(!paired.length) continue; const blend=(weightKey,pointKey,weights=null)=>weightedMean(paired.map(x=>x.p[pointKey]),weights||paired.map(x=>x.m.weights[weightKey])); const eventProbability=event=>100*weightedMean(paired.map(x=>{const events=weatherCodeEvents(x.p.weather_code);return events?Number(events[event]):Number.NaN;}),paired.map(x=>x.m.eventWeights?.[event]??x.m.weights.precip)); const transientLead=transientObservation?(date-transientObservation.time)/36e5:Infinity; const wetTransition=transientLead>=0&&transientLead<=5; const temperatureWeights=paired.map(x=>x.m.weights.temp*(wetTransition?(x.p.precipitation>=.1?1.55:x.p.precipitation>0?1.15:.55):1)); const precipWeights=paired.map(x=>x.m.eventWeights?.precip??x.m.weights.precip), values=key=>paired.map(x=>x.p[key]).filter(Number.isFinite), percentile=(key,p)=>{const v=values(key).sort((a,b)=>a-b);return v.length?v[Math.round((v.length-1)*p)]:Number.NaN;}, tempRange=percentile('temperature_2m',.9)-percentile('temperature_2m',.1), windRange=percentile('wind_speed_10m',.9)-percentile('wind_speed_10m',.1), confidence=tempRange<1.5&&windRange<4?'High':tempRange<3&&windRange<8?'Moderate':'Low', thunderProbability=eventProbability('thunder'), cape=blend('precip','cape'), convectiveRisk=thunderProbability>=50||(cape>=1000&&eventProbability('precip')>=40)?'High':thunderProbability>=20||(cape>=500&&eventProbability('precip')>=25)?'Moderate':'Low'; rows.push({time:date,temp:blend('temp','temperature_2m',temperatureWeights),direction:weightedCircularMean(paired.map(x=>x.p.wind_direction_10m),paired.map(x=>x.m.weights.direction)),speed:blend('speed','wind_speed_10m'),gust:blend('speed','wind_gusts_10m'),pressure:blend('pressure','pressure_msl'),precip:blend('precip','precipitation')*(date.getUTCMinutes()===30?.5:1),precipProbability:eventProbability('precip'),thunderProbability,fogLowVisProbability:eventProbability('fogLowVis'),weatherCode:weightedMode(paired.map(x=>x.p.weather_code),precipWeights),cloudTotal:blend('precip','cloud_cover'),cloudLow:blend('precip','cloud_cover_low'),cloudMid:blend('precip','cloud_cover_mid'),cloudHigh:blend('precip','cloud_cover_high'),visibility:blend('visibility','visibility'),cloudBase:blend('precip','cloud_base'),freezingLevel:blend('precip','freezing_level_height'),cape,cin:blend('precip','convective_inhibition'),convectiveRisk,tempP10:percentile('temperature_2m',.1),tempP90:percentile('temperature_2m',.9),speedP10:percentile('wind_speed_10m',.1),speedP90:percentile('wind_speed_10m',.9),confidence}); } return rows;
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
function interpolate(points,date){
  // Forecast data are hourly, but users can request any minute. Locate the two
  // surrounding forecast hours instead of assuming the request falls exactly
  // on an hour or half-hour.
  const target=date.getTime();
  const exact=points.find(p=>p.time.getTime()===target); if(exact) return {...exact};
  const upper=points.findIndex(p=>p.time.getTime()>target);
  if(upper<=0) return null;
  const a=points[upper-1], b=points[upper];
  const span=b.time-a.time, ratio=span?(target-a.time)/span:0;
  if(ratio<0||ratio>1) return null;
  const linear=key=>Number.isFinite(a[key])&&Number.isFinite(b[key])?a[key]+(b[key]-a[key])*ratio:Number.NaN;
  return {time:date,temperature_2m:linear('temperature_2m'),wind_direction_10m:Number.isFinite(a.wind_direction_10m)&&Number.isFinite(b.wind_direction_10m)?clampDirection(a.wind_direction_10m+angleDiff(b.wind_direction_10m,a.wind_direction_10m)*ratio):Number.NaN,wind_speed_10m:linear('wind_speed_10m'),wind_gusts_10m:linear('wind_gusts_10m'),pressure_msl:linear('pressure_msl'),precipitation:linear('precipitation'),weather_code:ratio<.5?a.weather_code:b.weather_code,cloud_cover:linear('cloud_cover'),cloud_cover_low:linear('cloud_cover_low'),cloud_cover_mid:linear('cloud_cover_mid'),cloud_cover_high:linear('cloud_cover_high'),visibility:linear('visibility'),cloud_base:linear('cloud_base'),freezing_level_height:linear('freezing_level_height'),cape:linear('cape'),convective_inhibition:linear('convective_inhibition')};
}
function precipStyle(value){ if(value>=2.5) return {className:'precip-heavy',color:'#e9704e',label:'Heavy precipitation'}; if(value>=1) return {className:'precip-moderate',color:'#d99b16',label:'Moderate precipitation'}; if(value>=.1) return {className:'precip-light',color:'#75aa2d',label:'Light precipitation'}; if(value>0) return {className:'precip-trace',color:'#399e9a',label:'Trace precipitation'}; return {className:'',color:'#b9c1bd',label:'No precipitation'}; }
const formatValue=(value,digits=1)=>Number.isFinite(value)?value.toFixed(digits):'—';
const formatDirection=value=>Number.isFinite(value)?Math.round(value).toString().padStart(3,'0')+'°':'—';
async function allSettledLimited(items, task, limit=2){
  const results=new Array(items.length); let next=0;
  async function worker(){
    while(next<items.length){
      const index=next++;
      try{ results[index]={status:'fulfilled',value:await task(items[index])}; }
      catch(reason){ results[index]={status:'rejected',reason}; }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return results;
}

const compassDirection=direction=>['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(clampDirection(direction)/22.5)%16];
const briefingTime=date=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replace(',','');
function precipitationPeriods(rows){
  const periods=[]; let current=null;
  rows.forEach(row=>{
    if(row.precip>=.1){ if(!current) current={start:row.time,end:row.time,total:0}; current.end=row.time; current.total+=row.precip; }
    else if(current){periods.push(current);current=null;}
  });
  if(current) periods.push(current);
  return periods;
}
function averageModelTemperatureSpread(rows){
  const spreads=rows.map(row=>state.models.map(model=>interpolate(model.corrected,row.time)?.temperature_2m).filter(Number.isFinite)).filter(values=>values.length>1).map(values=>Math.max(...values)-Math.min(...values));
  return spreads.length?spreads.reduce((sum,value)=>sum+value,0)/spreads.length:Number.NaN;
}
const currentTaf=()=>state.taf?.find(report=>report.mostRecent)||state.taf?.[0]||null;
const formatTafWind=forecast=>forecast?.variableWind?`VRB / ${formatValue(forecast.speed,0)} kt`:forecast?`${formatDirection(forecast.direction)} / ${formatValue(forecast.speed,0)} kt`:'—';
function tafForecastAt(time){
  const forecasts=(currentTaf()?.forecasts||[]).filter(forecast=>forecast.change!=='TEMPO'&&!forecast.probability);
  const completedBecmg=forecasts.filter(forecast=>forecast.change==='BECMG'&&forecast.timeBec&&time>=forecast.timeBec&&time<forecast.timeTo).at(-1);
  if(completedBecmg) return {...completedBecmg,tafState:'becmg-complete'};
  const inBecmg=forecasts.find(forecast=>forecast.change==='BECMG'&&forecast.timeBec&&time>=forecast.timeFrom&&time<forecast.timeBec);
  if(inBecmg) return {...inBecmg,tafState:'becmg-transition'};
  const baseline=forecasts.find(forecast=>time>=forecast.timeFrom&&time<forecast.timeTo);
  return baseline?{...baseline,tafState:'steady'}:null;
}
function renderTafBriefing(){
  const taf=currentTaf();
  if(!taf){$('tafBriefingText').textContent='No current TAF bulletin was returned by AWC for this airport.';return;}
  const forecasts=taf.forecasts||[], first=forecasts[0], changes=forecasts.filter((forecast,index)=>index===0||forecast.change==='FM'||forecast.change==='BECMG'), windChanges=changes.map(forecast=>forecast.change==='BECMG'&&forecast.timeBec?`BECMG by ${briefingTime(forecast.timeBec)}: ${formatTafWind(forecast)}`:`${briefingTime(forecast.timeFrom)}: ${formatTafWind(forecast)}`), weather=[...new Set(forecasts.map(forecast=>forecast.weather).filter(Boolean))], lowClouds=[...new Set(forecasts.flatMap(forecast=>forecast.clouds).filter(cloud=>Number(cloud.base)>0&&Number(cloud.base)<3000).map(cloud=>`${cloud.cover}${cloud.base}`))], restrictedVisibility=[...new Set(forecasts.map(forecast=>forecast.visibility).filter(visibility=>visibility&&visibility!=='6+'))];
  const sentences=[`The current TAF is valid ${briefingTime(taf.validFrom)} to ${briefingTime(taf.validTo)}${Number.isFinite(taf.issueTime?.getTime())?` and was issued ${briefingTime(taf.issueTime)}`:''}.`,first?`It begins with ${formatTafWind(first)}.`:''];
  if(windChanges.length>1) sentences.push(`Forecast wind changes are ${windChanges.join('; ')}.`);
  if(weather.length) sentences.push(`Forecast weather includes ${weather.join(', ')}.`);
  if(restrictedVisibility.length) sentences.push(`Visibility groups include ${restrictedVisibility.join(', ')} SM.`);
  if(lowClouds.length) sentences.push(`Cloud layers below 3,000 ft include ${lowClouds.join(', ')}.`);
  $('tafBriefingText').textContent=sentences.filter(Boolean).join(' ');
}
function renderBriefing(){
  const rows=state.ensemble, first=rows[0], last=rows.at(-1), temperatures=rows.map(row=>row.temp), speeds=rows.map(row=>row.speed), wetPeriods=precipitationPeriods(rows), peakWind=Math.max(...speeds), peakRow=rows[speeds.indexOf(peakWind)], tempLow=Math.min(...temperatures), tempHigh=Math.max(...temperatures), directionChange=Math.abs(angleDiff(last.direction,first.direction)), modelSpread=averageModelTemperatureSpread(rows);
  const sentences=[`For the requested window, the corrected ensemble covers ${briefingTime(first.time)} to ${briefingTime(last.time)}. Temperature ranges from ${tempLow.toFixed(1)} to ${tempHigh.toFixed(1)} °C.`];
  sentences.push(`Wind is forecast from ${formatDirection(first.direction)} (${compassDirection(first.direction)}) at ${first.speed.toFixed(1)} kt initially, with a peak of ${peakWind.toFixed(1)} kt near ${briefingTime(peakRow.time)}${directionChange>=30?`, and a ${Math.round(directionChange)}° directional change by the end of the window`:''}.`);
  if(wetPeriods.length){ const firstWet=wetPeriods[0], total=wetPeriods.reduce((sum,period)=>sum+period.total,0); sentences.push(`Precipitation is signalled from about ${briefingTime(firstWet.start)}${firstWet.end>firstWet.start?` to ${briefingTime(firstWet.end)}`:''}, with ${total.toFixed(1)} mm forecast across the window.`); }
  else sentences.push('No material precipitation signal is present in the corrected ensemble for this window.');
  const tafWindDifferences=rows.map(row=>{const taf=tafForecastAt(row.time);return taf&&!taf.variableWind&&Number.isFinite(taf.direction)&&Number.isFinite(taf.speed)?{direction:Math.abs(angleDiff(row.direction,taf.direction)),speed:Math.abs(row.speed-taf.speed)}:null;}).filter(Boolean), meaningfulTafDifferences=tafWindDifferences.filter(difference=>difference.direction>=45||difference.speed>=10);
  if(meaningfulTafDifferences.length) sentences.push(`Independent TAF comparison: model and TAF wind differ materially at ${meaningfulTafDifferences.length} of ${tafWindDifferences.length} comparable timestamps; review both sources before operational use.`);
  if(Number.isFinite(modelSpread)) sentences.push(`Mean inter-model temperature spread is ${modelSpread.toFixed(1)} °C; use the individual-model chart when conditions are changing quickly.`);
  renderTafBriefing(); $('modelBriefingText').textContent=sentences.join(' '); $('briefing').classList.remove('hidden');
}
function runwayComponents(row, runway){
  const angle=(row.direction-runway.heading)*Math.PI/180;
  return {headwind:row.speed*Math.cos(angle),crosswind:row.speed*Math.sin(angle)};
}
function ensembleWindAt(time){
  const rows=state.ensemble||[], target=time.getTime();
  if(!rows.length||target<rows[0].time.getTime()||target>rows.at(-1).time.getTime()) return null;
  const laterIndex=rows.findIndex(row=>row.time.getTime()>=target);
  if(laterIndex===0||rows[laterIndex].time.getTime()===target) return rows[laterIndex];
  const earlier=rows[laterIndex-1], later=rows[laterIndex], ratio=(target-earlier.time)/(later.time-earlier.time);
  return {direction:clampDirection(earlier.direction+angleDiff(later.direction,earlier.direction)*ratio),speed:earlier.speed+(later.speed-earlier.speed)*ratio};
}
function componentLabels(components){
  if(!components) return {longitudinal:'—',lateral:'—'};
  return {longitudinal:components.headwind>=0?`Head ${components.headwind.toFixed(1)} kt`:`Tail ${Math.abs(components.headwind).toFixed(1)} kt`,lateral:components.crosswind>=0?`Right ${Math.abs(components.crosswind).toFixed(1)} kt`:`Left ${Math.abs(components.crosswind).toFixed(1)} kt`};
}
function renderWindCalculator(){
  const runways=state.runways||[];
  if(!runways.length){$('windCalculator').classList.add('hidden');return;}
  const select=$('runwaySelect');
  select.innerHTML=runways.map((runway,index)=>`<option value="${index}">${runway.id} · ${Math.round(runway.heading).toString().padStart(3,'0')}°T${runway.lengthFt?` · ${runway.lengthFt.toLocaleString()} ft`:''}</option>`).join('');
  select.value=String(state.runwayIndex||0);
  $('windCalculatorTime').value=utcInput(state.selected);
  $('windCalculatorResult').innerHTML='';
  select.onchange=()=>{state.runwayIndex=Number(select.value);};
  $('calculateWind').onclick=calculateWindComponents;
  $('windCalculator').classList.remove('hidden');
}
function calculateWindComponents(){
  const time=toUtc($('windCalculatorTime').value), runway=state.runways[Number($('runwaySelect').value)];
  if(!runway||!Number.isFinite(time.getTime())){$('windCalculatorResult').innerHTML='<p class="calculator-error">Choose a valid UTC time and runway end.</p>';return;}
  const modelWind=ensembleWindAt(time);
  if(!modelWind){$('windCalculatorResult').innerHTML=`<p class="calculator-error">Choose a time within the generated forecast window: ${fmt(state.ensemble[0].time)} to ${fmt(state.ensemble.at(-1).time)} UTC.</p>`;return;}
  const taf=tafForecastAt(time), modelLabels=componentLabels(runwayComponents(modelWind,runway)), tafComponents=taf&&!taf.variableWind&&Number.isFinite(taf.direction)&&Number.isFinite(taf.speed)?runwayComponents({direction:taf.direction,speed:taf.speed},runway):null, tafLabels=componentLabels(tafComponents), tafWind=taf?.tafState==='becmg-transition'?`BECMG → ${formatTafWind(taf)}`:formatTafWind(taf), tafNote=taf?.tafState==='becmg-transition'?'Target wind during BECMG transition.':taf?.variableWind?'TAF reports variable wind; no fixed-direction component can be calculated.':taf?'':'No TAF wind forecast covers this time.';
  $('windCalculatorResult').innerHTML=`<p class="calculator-time"><strong>${fmt(time)}</strong> · Runway ${runway.id} (${Math.round(runway.heading).toString().padStart(3,'0')}° true)</p><div class="table-wrap"><table><thead><tr><th>Source</th><th>Wind</th><th>Headwind / tailwind</th><th>Crosswind</th></tr></thead><tbody><tr><td>Corrected model ensemble</td><td>${formatDirection(modelWind.direction)} / ${modelWind.speed.toFixed(1)} kt</td><td>${modelLabels.longitudinal}</td><td>${modelLabels.lateral}</td></tr><tr><td>TAF${taf?.tafState==='becmg-transition'?' · BECMG target':''}</td><td>${tafWind}</td><td>${tafLabels.longitudinal}</td><td>${tafLabels.lateral}</td></tr></tbody></table></div>${tafNote?`<p class="runway-note">${tafNote}</p>`:''}`;
}

async function generate(){
  const icao=$('icao').value.trim().toUpperCase(); const inputStart=toUtc($('start').value), inputEnd=toUtc($('end').value); if(!/^[A-Z]{4}$/.test(icao)) return notice('Please enter a four-letter ICAO code (for example, KJFK or EGLL).','error'); if(!Number.isFinite(inputStart.getTime())||!Number.isFinite(inputEnd.getTime())||inputEnd<=inputStart) return notice('Choose a valid UTC take-off window where the end is after the start.','error');
  // Keep every output on fixed clock half-hours. A non-half-hour start is
  // rounded down and a non-half-hour end up, preserving the requested window.
  const start=floorHalfHour(inputStart), end=ceilHalfHour(inputEnd);
  if(isFilePreview) return notice('This static preview cannot proxy Aviation Weather Center data. Run “python3 server.py”, then open http://127.0.0.1:4174.','error');
  $('generate').disabled=true; notice('Retrieving 72 hours of AWC METAR observations…','loading'); $('results').classList.add('hidden'); $('briefing').classList.add('hidden'); $('hazardOutlook').classList.add('hidden'); $('windCalculator').classList.add('hidden'); $('detail').classList.add('hidden'); $('metarDetail').classList.add('hidden'); $('modelDetail').classList.add('hidden');
  try{
    const [{observations,location},taf,runways]=await Promise.all([getMetars(icao),getTaf(icao).catch(error=>{console.warn('TAF unavailable',error);return []}),getRunways(icao).catch(error=>{console.warn('Runway data unavailable',error);return []})]);
    const nearby=await getNearbyMetars(location.lat,location.lon).catch(error=>{console.warn('Nearby-station quality check unavailable',error);return [];});
    assessObservationQuality(observations,nearby); const calibrationEnd=new Date(), calibrationStart=new Date(calibrationEnd.getTime()-72*3600e3);
    notice('Fetching historical model guidance and estimating model-specific bias…','loading');
    const candidates=[...MODEL_CATALOG,...regionalModels(location.lat,location.lon)];
    const historical=await allSettledLimited(candidates,async ([id,name])=>unpackModel(await fetchJson(queryUrl('https://historical-forecast-api.open-meteo.com/v1/forecast',location.lat,location.lon,calibrationStart,calibrationEnd,id)),id,name));
    const usable=historical.filter(x=>x.status==='fulfilled').map(x=>x.value); if(!usable.length) throw new Error('Open-Meteo did not return an eligible model for this location.');
    usable.forEach(m=>{m.bias=calculateBias(m,observations);m.eventSkill=calculateEventSkill(m,observations);m.corrected=correct(m).corrected;});
    notice('Applying the METAR-derived biases to the requested forecast window…','loading');
    const outputHost=end<=new Date()?'https://historical-forecast-api.open-meteo.com/v1/forecast':'https://api.open-meteo.com/v1/forecast';
    const requested=await allSettledLimited(usable,async old=>{const url=outputHost.includes('historical')?queryUrl(outputHost,location.lat,location.lon,start,end,old.id):liveForecastRangeUrl(location.lat,location.lon,start,end,old.id); const data=await fetchJson(url); const m=unpackModel(data,old.id,old.name); m.bias=old.bias;m.eventSkill=old.eventSkill;m.weights=old.weights;return correct(m);});
    const models=requested.filter(x=>x.status==='fulfilled').map(x=>x.value);
    const ensembleSources=[
      {id:'ecmwf_ifs025_ensemble',name:'ECMWF IFS ensemble'},
      {id:'ecmwf_aifs025_ensemble',name:'ECMWF AIFS ensemble'},
      {id:'google_weathernext2_ensemble',name:'Google WeatherNext 2'}
    ];
    notice('Calibrating ECMWF and WeatherNext ensemble sources against recent METAR…','loading');
    const ensembleRequests=await allSettledLimited(ensembleSources,source=>ensembleSourceModel(source,location.lat,location.lon,calibrationStart,calibrationEnd,start,end,observations));
    const ensembleModels=ensembleRequests.filter(result=>result.status==='fulfilled'&&result.value).map(result=>result.value);
    ensembleRequests.forEach((result,index)=>{if(result.status==='rejected') console.warn(`${ensembleSources[index].name} unavailable`,result.reason);});
    models.push(...ensembleModels);
    if(!models.length) throw new Error('The requested time window is unavailable from the returned models.'); assignAdaptiveWeights(models);
    const transientObservation=latestTransientObservation(observations);
    const nowcast=nowcastTemperatureAdjustment(halfHourly(models,start,end,transientObservation),usable,observations); if(!nowcast.rows.length) throw new Error('The requested UTC window is outside the available forecast range.');
    state={models,observations,taf,runways,runwayIndex:0,ensemble:nowcast.rows,selected:start,chart:null,meteograms:[],parameter:'temp',airport:icao}; sessionStorage.setItem('weatherMachineModelResources',JSON.stringify({airport:icao,models:models.map(model=>({id:model.id,name:model.name,bias:model.bias})),ensemble:nowcast.rows})); render(observations.length,location.name,models.length); notice(`Ready. ${models.length} model sources contributed to the corrected ensemble.${nowcast.applied?' A short-lived rain-cooling adjustment is active.':''}`,'');
  }catch(error){ console.error(error); notice(error.message || 'Unable to generate data. Please try again.','error'); } finally {$('generate').disabled=false;}
}
function render(metarCount, airportName, modelCount){
  $('airportName').textContent=`${state.airport} · ${airportName}`; $('modelCount').textContent=modelCount; $('metarCount').textContent=metarCount; $('forecastConfidence').textContent=state.ensemble.filter(row=>row.confidence==='High').length/state.ensemble.length>=.6?'High':state.ensemble.filter(row=>row.confidence==='Low').length/state.ensemble.length>=.4?'Low':'Moderate'; $('summary').classList.remove('hidden'); renderBriefing(); $('results').classList.remove('hidden'); renderWindCalculator(); $('metarDetail').classList.remove('hidden'); $('detail').classList.remove('hidden');
  $('tableBody').innerHTML=state.ensemble.map((r,i)=>`<tr data-index="${i}" class="${i===0?'selected':''}"><td>${fmt(r.time)}</td><td>${formatValue(r.temp)}</td><td>${Number.isFinite(r.direction)?Math.round(r.direction).toString().padStart(3,'0'):'—'}</td><td>${formatValue(r.speed)}</td><td>${formatValue(r.gust)}</td><td>${formatValue(r.pressure)}</td><td class="precip-cell ${precipStyle(r.precip).className}" title="${precipStyle(r.precip).label}">${formatValue(r.precip,2)}</td><td>${formatValue(r.precipProbability,0)}</td><td>${formatValue(r.thunderProbability,0)}</td><td>${formatValue(r.fogLowVisProbability,0)}</td><td>${formatValue(r.weatherCode,0)}</td><td>${formatValue(r.cloudTotal,0)}</td><td>${formatValue(r.cloudLow,0)}</td><td>${formatValue(r.cloudMid,0)}</td><td>${formatValue(r.cloudHigh,0)}</td><td>${r.confidence}</td></tr>`).join('');
  const feet=value=>Number.isFinite(value)?Math.round(value*3.28084).toLocaleString():'—';
  $('hazardTableBody').innerHTML=state.ensemble.filter((_,index)=>index%2===0).map(row=>`<tr><td>${fmt(row.time)}</td><td>${feet(row.cloudBase)}</td><td>${feet(row.freezingLevel)}</td><td>${formatValue(row.cape,0)}</td><td>${formatValue(row.cin,0)}</td><td class="hazard-${row.convectiveRisk.toLowerCase()}">${row.convectiveRisk}</td></tr>`).join(''); $('hazardOutlook').classList.remove('hidden');
  $('tableBody').querySelectorAll('tr').forEach(row=>row.addEventListener('click',()=>{state.selected=state.ensemble[Number(row.dataset.index)].time; $('tableBody').querySelectorAll('tr').forEach(x=>x.classList.remove('selected'));row.classList.add('selected'); drawChart();}));
  const recentMetars=state.observations.filter(o=>o.time>=Date.now()-24*3600e3).sort((a,b)=>b.time-a.time);
  const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  $('metarTableBody').innerHTML=recentMetars.map(o=>`<tr><td>${fmt(o.time)}</td><td class="raw-metar">${escapeHtml(o.raw)||'Raw bulletin unavailable'}</td></tr>`).join('') || '<tr><td colspan="2">No METAR observations are available in the last 24 hours.</td></tr>';
  $('tafRaw').textContent=state.taf?.map(report=>report.raw).filter(Boolean).join('\n\n')||'No current TAF bulletin was returned by AWC for this airport.';
  const windows=[12,24,36,48,72]; $('modelTableBody').innerHTML=state.models.flatMap(model=>windows.map((hours,index)=>{const meta=MODEL_META[model.id]||{resolution:'—',refresh:'—'}, r=model.bias.residuals;return `<tr><td>${index===0?model.name:''}</td><td>${index===0?meta.resolution:''}</td><td>${index===0?meta.refresh:''}</td><td>${hours} h</td><td>${formatValue(rmse(r.temp,hours),2)}</td><td>${formatValue(rmse(r.direction,hours),1)}</td><td>${formatValue(rmse(r.speed,hours),2)}</td><td>${formatValue(rmse(r.pressure,hours),2)}</td></tr>`;})).join(''); $('modelDetail').classList.remove('hidden');
  $('parameterTabs').innerHTML=Object.entries(SETTINGS).map(([id,s])=>`<button type="button" data-p="${id}" class="${id===state.parameter?'active':''}">${s.label}</button>`).join(''); $('parameterTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{state.parameter=b.dataset.p;$('parameterTabs').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));drawChart();}); drawChart();
}
function drawMeteogram(){
  if(!$('detail').classList.contains('open')) return;
  (state.meteograms||[]).forEach(chart=>chart.destroy()); state.meteograms=[];
  const rows=state.ensemble, from=rows[0]?.time?.getTime(), to=rows.at(-1)?.time?.getTime(); if(!rows.length) return;
  const series=key=>rows.map(row=>({x:row.time,y:row[key]}));
  const observations=key=>state.observations.filter(point=>point.time>=from&&point.time<=to).map(point=>({x:point.time,y:point[key]}));
  const xAxis=show=>({type:'time',adapters:{date:{zone:'utc'}},min:from,max:to,time:{unit:'hour',stepSize:1,displayFormats:{hour:'HH:mm'}},title:{display:show,text:'Time (UTC)',font:{family:'DM Mono',size:9}},grid:{color:'#e5e9e4'},ticks:show?{autoSkip:true,maxTicksLimit:13,maxRotation:0,minRotation:0,padding:3,font:{family:'DM Mono',size:8},callback:(value,index,ticks)=>{const time=new Date(Number(value)),previous=index?new Date(Number(ticks[index-1].value)):null,day=!previous||time.getUTCDate()!==previous.getUTCDate()||time.getUTCMonth()!==previous.getUTCMonth();return [fmtChartTimeUtc(time),day?fmtChartDateUtc(time):''];}}:{display:false}});
  const common={responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>items.length?fmtChartUtc(new Date(items[0].parsed.x)):'',label:context=>`${context.dataset.label}: ${Number(context.parsed.y).toFixed(context.dataset.yAxisID==='direction'?0:1)} ${context.dataset.unit||''}`}}}};
  const add=(canvas,datasets,scales,plugins=[])=>state.meteograms.push(new Chart($(canvas),{type:'line',data:{datasets},plugins,options:{...common,scales}}));
  add('meteogramTemp',[
    {label:'Corrected ensemble',data:series('temp'),borderColor:'#17493a',borderWidth:2.5,pointRadius:0,tension:.18,unit:'°C'},
    {label:'Observed METAR',type:'scatter',data:observations('temp'),borderColor:'#e75e3f',backgroundColor:'#e75e3f',pointRadius:2.5,unit:'°C'}
  ],{x:xAxis(false),y:{title:{display:true,text:'°C',font:{family:'DM Mono',size:9}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:8}}}});
  const windBarbs={id:'meteogramWindBarbs',afterDatasetsDraw(chart){const {ctx}=chart;chart.data.datasets.forEach((set,index)=>{if(!set.windBarbs)return;chart.getDatasetMeta(index).data.forEach((element,pointIndex)=>{const point=set.data[pointIndex],direction=point?.y,speed=point?.speed;if(!Number.isFinite(direction)||!Number.isFinite(speed))return;let remaining=Math.max(0,Math.round(speed/5)*5),offset=-7;ctx.save();ctx.translate(element.x,element.y);ctx.rotate(direction*Math.PI/180);ctx.strokeStyle=set.barbColor;ctx.fillStyle=set.barbColor;ctx.lineWidth=.55;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(0,2);ctx.lineTo(0,-8);ctx.stroke();while(remaining>=50){ctx.beginPath();ctx.moveTo(0,offset);ctx.lineTo(3.6,offset+1.8);ctx.lineTo(0,offset+3.3);ctx.closePath();ctx.fill();remaining-=50;offset+=3.4;}while(remaining>=10){ctx.beginPath();ctx.moveTo(0,offset);ctx.lineTo(3.6,offset+1.8);ctx.stroke();remaining-=10;offset+=2.5;}if(remaining>=5){ctx.beginPath();ctx.moveTo(0,offset);ctx.lineTo(1.8,offset+.9);ctx.stroke();}ctx.restore();});});}};
  add('meteogramWind',[
    {label:'Ensemble direction',type:'scatter',data:rows.map(row=>({x:row.time,y:row.direction,speed:row.speed})),yAxisID:'direction',borderColor:'#17493a',pointRadius:0,windBarbs:true,barbColor:'#17493a',unit:'°'},
    {label:'Ensemble speed',data:series('speed'),yAxisID:'speed',borderColor:'#17493a',borderWidth:2,pointRadius:0,tension:.18,unit:'kt'},
    {label:'Ensemble gust',data:series('gust'),yAxisID:'speed',borderColor:'#8a5b3f',borderWidth:1.1,borderDash:[3,3],pointRadius:0,tension:.18,unit:'kt'},
    {label:'Observed direction',type:'scatter',data:state.observations.filter(point=>point.time>=from&&point.time<=to).map(point=>({x:point.time,y:point.direction,speed:point.speed})),yAxisID:'direction',borderColor:'#e75e3f',pointRadius:0,windBarbs:true,barbColor:'#e75e3f',unit:'°'}
  ],{x:xAxis(false),direction:{position:'left',min:0,max:360,title:{display:true,text:'°',font:{family:'DM Mono',size:9}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:8}}},speed:{position:'right',beginAtZero:true,title:{display:true,text:'kt',font:{family:'DM Mono',size:9}},grid:{drawOnChartArea:false},ticks:{font:{family:'DM Mono',size:8}}}},[windBarbs]);
  add('meteogramPressure',[
    {label:'Corrected ensemble',data:series('pressure'),borderColor:'#17493a',borderWidth:2.5,pointRadius:0,tension:.18,unit:'hPa'},
    {label:'Observed METAR',type:'scatter',data:observations('pressure'),borderColor:'#e75e3f',backgroundColor:'#e75e3f',pointRadius:2.5,unit:'hPa'}
  ],{x:xAxis(false),y:{title:{display:true,text:'hPa',font:{family:'DM Mono',size:9}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:8}}}});
  const cloudLayers={id:'meteogramCloudLayers',beforeDatasetsDraw(chart){const {ctx,chartArea}=chart,x=chart.scales.x,spacing=rows.length>1?Math.abs(x.getPixelForValue(rows[1].time)-x.getPixelForValue(rows[0].time)):16,width=Math.max(2,spacing+1),height=(chartArea.bottom-chartArea.top)/3;ctx.save();rows.forEach(row=>[{value:row.cloudHigh,y:chartArea.top},{value:row.cloudMid,y:chartArea.top+height},{value:row.cloudLow,y:chartArea.top+height*2}].forEach(layer=>{if(Number.isFinite(layer.value)){ctx.fillStyle=`rgba(48,54,52,${.05+Math.max(0,Math.min(100,layer.value))*.0065})`;ctx.fillRect(x.getPixelForValue(row.time)-width/2,layer.y,width,height);}}));ctx.fillStyle='rgba(36,50,45,.5)';ctx.font='8px "DM Mono",monospace';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText('HIGH',chartArea.left+3,chartArea.top+height*.5);ctx.fillText('MID',chartArea.left+3,chartArea.top+height*1.5);ctx.fillText('LOW',chartArea.left+3,chartArea.top+height*2.5);ctx.restore();}};
  const precipBand={id:'meteogramPrecipBand',afterDraw(chart){const x=chart.scales.x, hourly=rows.filter(row=>row.time.getUTCMinutes()===0),width=chart.chartArea.right-chart.chartArea.left,step=Math.max(1,Math.ceil(hourly.length/Math.max(1,Math.floor(width/90)))),{ctx}=chart;ctx.save();ctx.fillStyle='#52645d';ctx.font='8px "DM Mono",monospace';ctx.textAlign='center';ctx.textBaseline='top';hourly.forEach((row,index)=>{if(!(index%step))ctx.fillText(`P ${formatValue(row.precipProbability,0)}%  C ${formatValue(row.cloudTotal,0)}%`,x.getPixelForValue(row.time),x.bottom+7);});ctx.restore();}};
  add('meteogramPrecip',[{label:'Corrected ensemble',type:'bar',data:series('precip'),borderWidth:0,backgroundColor:series('precip').map(point=>precipStyle(point.y).color),unit:'mm'}],{x:xAxis(true),y:{beginAtZero:true,title:{display:true,text:'mm / 30 min',font:{family:'DM Mono',size:9}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:8}}}},[cloudLayers,precipBand]);
}
function drawChart(){
  if($('detail').classList.contains('hidden')) return;
  const s=SETTINGS[state.parameter], isWind=state.parameter==='wind', isPrecip=state.parameter==='precip';
  // The ensemble datasets below are created directly from state.ensemble—the
  // same half-hourly rows used by the table and CSV export.
  const from=state.ensemble[0]?.time?.getTime(),to=state.ensemble.at(-1)?.time?.getTime(), palette=['#8097a5','#cf8c76','#8c9d75','#967fa3','#c0a56f','#6b92a1','#bb8792','#889189','#806e94'];
  $('chartTitle').textContent=s.label;
  const inWindow=points=>points.filter(p=>p.time>=from&&p.time<=to);
  const chartRows=state.ensemble.filter(p=>p.time>=from&&p.time<=to);
  // Every forecast dataset uses the exact same timestamps as the table. This
  // prevents Chart.js index tooltips from pairing an hourly raw value with a
  // different half-hourly ensemble row.
  const modelSeries=(model,key)=>chartRows.map(row=>({x:row.time,y:interpolate(model.points,row.time)?.[key]}));
  const modelWindSeries=model=>chartRows.map(row=>{const point=interpolate(model.points,row.time);return {x:row.time,y:point?.wind_direction_10m,speed:point?.wind_speed_10m};});
  const observationSeries=(points,key)=>inWindow(points).map(p=>({x:p.time,y:p[key]}));
  const observationWindSeries=points=>inWindow(points).map(p=>({x:p.time,y:p.direction,speed:p.speed}));
  const ensembleSeries=key=>chartRows.map(row=>({x:row.time,y:row[key]}));
  const ensembleWindSeries=()=>chartRows.map(row=>({x:row.time,y:row.direction,speed:row.speed}));
  let datasets=[];
  if(isWind){
    state.models.forEach((m,i)=>{
      const color=palette[i%palette.length];
      datasets.push({label:`${m.name} direction`,type:'scatter',data:modelWindSeries(m),yAxisID:'yDirection',borderColor:color,pointRadius:0,windBarbs:true,barbColor:color});
      datasets.push({label:`${m.name} speed`,type:'line',data:modelSeries(m,'wind_speed_10m'),yAxisID:'ySpeed',borderColor:color,borderWidth:1.1,pointRadius:0,borderDash:[3,3],tension:.18});
    });
    datasets.push({label:'Observed METAR direction',type:'scatter',data:observationWindSeries(state.observations),yAxisID:'yDirection',borderColor:'#e75e3f',pointRadius:0,windBarbs:true,barbColor:'#e75e3f'});
    datasets.push({label:'Observed METAR speed',type:'scatter',data:observationSeries(state.observations,'speed'),yAxisID:'ySpeed',borderColor:'#e75e3f',backgroundColor:'#e75e3f',pointRadius:3,pointStyle:'circle'});
    datasets.push({label:'Corrected ensemble direction',type:'scatter',data:ensembleWindSeries(),yAxisID:'yDirection',borderColor:'#17493a',pointRadius:0,windBarbs:true,barbColor:'#17493a'});
    datasets.push({label:'Corrected ensemble speed',type:'line',data:ensembleSeries('speed'),yAxisID:'ySpeed',borderColor:'#17493a',borderWidth:3,pointRadius:0,tension:.18});
  } else {
    state.models.forEach((m,i)=>{ const data=modelSeries(m,s.key), color=palette[i%palette.length]; datasets.push({label:m.name,type:isPrecip?'scatter':'line',data,borderColor:color,borderWidth:1.2,pointRadius:isPrecip?3:0,pointBackgroundColor:isPrecip?data.map(p=>precipStyle(p.y).color):color,tension:.18}); });
    if(state.parameter==='temp'){
      datasets.push({label:'P10 temperature',type:'line',data:ensembleSeries('tempP10'),borderColor:'rgba(23,73,58,0)',pointRadius:0,borderWidth:0,tension:.18});
      datasets.push({label:'P90 temperature',type:'line',data:ensembleSeries('tempP90'),borderColor:'rgba(23,73,58,.35)',backgroundColor:'rgba(23,73,58,.12)',fill:'-1',pointRadius:0,borderWidth:1,tension:.18});
    }
    const obsKey={temp:'temp',pressure:'pressure'}[state.parameter];
    if(obsKey) datasets.push({label:'Observed METAR',type:'line',showLine:false,data:observationSeries(state.observations,obsKey),borderColor:'#e75e3f',backgroundColor:'#e75e3f',pointBackgroundColor:'#e75e3f',pointBorderColor:'#f6f5ef',pointBorderWidth:1.5,pointRadius:4,pointStyle:'circle'});
    const ensembleData=ensembleSeries(state.parameter);
    datasets.push({label:'Corrected ensemble',type:isPrecip?'bar':'line',data:ensembleData,borderColor:'#17493a',borderWidth:isPrecip?0:3,backgroundColor:isPrecip?ensembleData.map(p=>precipStyle(p.y).color):'#17493a',pointRadius:0,tension:.18});
  }
  const windBarbPlugin={id:'windBarbs',afterDatasetsDraw(chart){ if(!isWind) return; const {ctx}=chart; chart.data.datasets.forEach((set,index)=>{ if(!set.windBarbs) return; const meta=chart.getDatasetMeta(index); meta.data.forEach((element,pointIndex)=>{const point=set.data[pointIndex], direction=point?.y, speed=point?.speed;if(!Number.isFinite(direction)||!Number.isFinite(speed)) return; const lineWidth=set.label.startsWith('Corrected')?.95:.55; let remaining=Math.max(0,Math.round(speed/5)*5); ctx.save();ctx.translate(element.x,element.y); // A meteorological barb shaft points toward the direction the wind comes FROM.
        ctx.rotate(direction*Math.PI/180);ctx.strokeStyle=set.barbColor;ctx.fillStyle=set.barbColor;ctx.lineWidth=lineWidth;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(0,3);ctx.lineTo(0,-10);ctx.stroke();let offset=-9;
        while(remaining>=50){ctx.beginPath();ctx.moveTo(0,offset);ctx.lineTo(4.5,offset+2.25);ctx.lineTo(0,offset+4);ctx.closePath();ctx.fill();remaining-=50;offset+=4;}
        while(remaining>=10){ctx.beginPath();ctx.moveTo(0,offset);ctx.lineTo(4.5,offset+2.25);ctx.stroke();remaining-=10;offset+=3;}
        if(remaining>=5){ctx.beginPath();ctx.moveTo(0,offset);ctx.lineTo(2.25,offset+1.1);ctx.stroke();}ctx.restore();}); }); }};
  const cloudLayerPlugin={id:'cloudLayers',beforeDatasetsDraw(chart){
    if(!isPrecip) return;
    const {ctx,chartArea}=chart, x=chart.scales.x, rows=chartRows, spacing=rows.length>1?Math.abs(x.getPixelForValue(rows[1].time)-x.getPixelForValue(rows[0].time)):16, columnWidth=Math.max(2,spacing+1), layerHeight=(chartArea.bottom-chartArea.top)/3;
    ctx.save();
    rows.forEach(row=>{const px=x.getPixelForValue(row.time), layers=[{value:row.cloudHigh,y:chartArea.top},{value:row.cloudMid,y:chartArea.top+layerHeight},{value:row.cloudLow,y:chartArea.top+layerHeight*2}];layers.forEach(layer=>{if(!Number.isFinite(layer.value)) return;ctx.fillStyle=`rgba(48, 54, 52, ${.05+Math.max(0,Math.min(100,layer.value))*.0065})`;ctx.fillRect(px-columnWidth/2,layer.y,columnWidth,layerHeight);});});
    ctx.fillStyle='rgba(36,50,45,.5)';ctx.font='8px "DM Mono", monospace';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText('HIGH',chartArea.left+3,chartArea.top+layerHeight*.5);ctx.fillText('MID',chartArea.left+3,chartArea.top+layerHeight*1.5);ctx.fillText('LOW',chartArea.left+3,chartArea.top+layerHeight*2.5);ctx.restore();
  }};
  const precipitationBandPlugin={id:'precipitationBand',afterDraw(chart){
    if(!isPrecip) return;
    const x=chart.scales.x, rows=chartRows.filter(row=>row.time.getUTCMinutes()===0), width=chart.chartArea.right-chart.chartArea.left, step=Math.max(1,Math.ceil(rows.length/Math.max(1,Math.floor(width/90)))), {ctx}=chart;
    ctx.save();ctx.fillStyle='#52645d';ctx.font='8px "DM Mono", monospace';ctx.textAlign='center';ctx.textBaseline='top';
    rows.forEach((row,index)=>{if(index%step) return;ctx.fillText(`P ${formatValue(row.precipProbability,0)}%  C ${formatValue(row.cloudTotal,0)}%`,x.getPixelForValue(row.time),x.bottom+8);});
    ctx.restore();
  }};
  if(state.chart) state.chart.destroy(); Chart.getChart($('chart'))?.destroy();
  const xAxis={type:'time',adapters:{date:{zone:'utc'}},min:from,max:to,time:{unit:'hour',stepSize:1,displayFormats:{hour:'HH:mm'}},title:{display:true,text:'Time (UTC)',font:{family:'DM Mono',size:10}},grid:{color:'#e5e9e4'},ticks:{autoSkip:false,maxTicksLimit:1000,maxRotation:0,minRotation:0,padding:4,font:{family:'DM Mono',size:9},callback:(value,index,ticks)=>{const time=new Date(Number(value)),previous=index?new Date(Number(ticks[index-1].value)):null,startsUtcDay=!previous||time.getUTCFullYear()!==previous.getUTCFullYear()||time.getUTCMonth()!==previous.getUTCMonth()||time.getUTCDate()!==previous.getUTCDate();return [fmtChartTimeUtc(time),startsUtcDay?fmtChartDateUtc(time):''];}}};
  const scales=isWind?{x:xAxis,yDirection:{position:'left',min:0,max:360,title:{display:true,text:'Wind direction (°)',font:{family:'DM Mono',size:10}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:10}}},ySpeed:{position:'right',beginAtZero:true,title:{display:true,text:'Wind speed (kt)',font:{family:'DM Mono',size:10}},grid:{drawOnChartArea:false},ticks:{font:{family:'DM Mono',size:10}}}}:{x:xAxis,y:{title:{display:true,text:s.unit,font:{family:'DM Mono',size:10}},grid:{color:'#e5e9e4'},ticks:{font:{family:'DM Mono',size:10}}}};
  state.chart=new Chart($('chart'),{type:'line',data:{datasets},plugins:[windBarbPlugin,cloudLayerPlugin,precipitationBandPlugin],options:{responsive:true,maintainAspectRatio:false,layout:{padding:{bottom:isPrecip?27:0}},interaction:{mode:'index',intersect:false},plugins:{legend:{position:isPrecip?'top':'bottom',labels:{boxWidth:14,font:{family:'DM Sans',size:11},usePointStyle:true}},tooltip:{filter:c=>!c.dataset.label.startsWith('Observed METAR'),callbacks:{title:items=>items.length?fmtChartUtc(new Date(items[0].parsed.x)):'',label:c=>`${c.dataset.label}: ${Number(c.parsed.y).toFixed(isWind&&c.dataset.yAxisID==='yDirection'?0:1)} ${isWind?(c.dataset.yAxisID==='yDirection'?'°':'kt'):s.unit}`}}},scales}});
}
function download(){ const header='Time (UTC),Temp (°C),Wind Direction (°),Wind Speed (kt),Wind Gust (kt),Mean Sea-Level Pressure (hPa),Precipitation (mm / 30 min),Precipitation Probability (%),Thunderstorm Probability (%),Fog / Low-Visibility Probability (%),Weather Code (WMO),Cloud Total (%),Cloud Low (%),Cloud Mid (%),Cloud High (%)'; const lines=state.ensemble.map(r=>[r.time.toISOString(),formatValue(r.temp),Number.isFinite(r.direction)?Math.round(r.direction):'',formatValue(r.speed),formatValue(r.gust),formatValue(r.pressure),formatValue(r.precip,2),formatValue(r.precipProbability,0),formatValue(r.thunderProbability,0),formatValue(r.fogLowVisProbability,0),formatValue(r.weatherCode,0),formatValue(r.cloudTotal,0),formatValue(r.cloudLow,0),formatValue(r.cloudMid,0),formatValue(r.cloudHigh,0)].join(',')); const blob=new Blob([[header,...lines].join('\n')],{type:'text/csv'}); const link=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:`${state.airport}-takeoff-ensemble.csv`});link.click();URL.revokeObjectURL(link.href); }
function bindToggle(sectionId,buttonId,onExpand){ $(buttonId).onclick=()=>{const section=$(sectionId);section.classList.toggle('open');const expanded=section.classList.contains('open');$(buttonId).setAttribute('aria-expanded',expanded);$(buttonId).querySelector('i').textContent=expanded?'−':'+';if(expanded) onExpand?.();}; }
function makeCollapsible(id,label){const section=$(id);if(!section||section.querySelector('.section-collapse-toggle'))return;section.classList.add('collapsible');const button=document.createElement('button');button.type='button';button.className='section-collapse-toggle';button.innerHTML=`<span><i>−</i> ${label}</span><small>Collapse</small>`;button.setAttribute('aria-expanded','true');button.onclick=()=>{section.classList.toggle('collapsed');const expanded=!section.classList.contains('collapsed');button.setAttribute('aria-expanded',String(expanded));button.querySelector('i').textContent=expanded?'−':'+';button.querySelector('small').textContent=expanded?'Collapse':'Expand';};section.prepend(button);}
['summary','briefing','results','hazardOutlook'].forEach(id=>makeCollapsible(id,{summary:'Forecast overview',briefing:'Weather Summary',results:'Ensemble forecast table',hazardOutlook:'Aviation hazard outlook'}[id]));
$('briefing').after($('detail')); $('metarDetail').after($('modelDetail')); $('generate').onclick=generate; $('icao').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase()); bindToggle('windCalculator','windCalculatorToggle',renderWindCalculator); bindToggle('metarDetail','metarToggle'); bindToggle('modelDetail','modelToggle'); $('download').onclick=download;setDefaults();
