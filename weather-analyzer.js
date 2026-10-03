const $ = id => document.getElementById(id);
let stationNames;
let allTafRows=[];
let activeCategories=new Set(['concern','bad','severe']);
let landingMinima;

const PHENOMENA = {
  DZ:'drizzle', RA:'rain', SN:'snow', SG:'snow grains', IC:'ice crystals', PL:'ice pellets', GR:'hail', GS:'small hail / snow pellets', UP:'unknown precipitation',
  BR:'mist', FG:'fog', FU:'smoke', VA:'volcanic ash', DU:'widespread dust', SA:'sand', HZ:'haze', PY:'spray', PO:'dust / sand whirls', SQ:'squall', FC:'funnel cloud', SS:'sandstorm', DS:'dust storm'
};
const DESCRIPTORS = {MI:'shallow', BC:'patches of', PR:'partial', DR:'drifting', BL:'blowing', SH:'showers of', TS:'thunderstorm with', FZ:'freezing'};
const PRECIP = new Set(['DZ','RA','SN','SG','IC','PL','GR','GS','UP']);
const VISIBILITY_PHENOMENA = new Set(['BR','FG','FU','DU','SA','HZ','PY']);
const WEATHER_TOKEN = /^(?:\+|-)?(?:VC)?(?:(?:MI|BC|PR|DR|BL|SH|TS|FZ))?(?:(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS))+$/;
// Airport-specific non-precipitation visibility screens are loaded from the
// editable CSV in assets. This deliberately keeps operational minima out of
// the application code.
async function loadLandingMinima(){
  if(landingMinima) return landingMinima;
  landingMinima=new Map();
  try{
    const response=await fetch('assets/landing-minima.csv');
    if(!response.ok) throw Error(`HTTP ${response.status}`);
    const lines=(await response.text()).replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim() && !line.trim().startsWith('#'));
    if(!lines.length) return landingMinima;
    const headers=lines.shift().split(',').map(value=>value.trim().toLowerCase());
    const codeIndex=headers.findIndex(value=>/^(icao|airport|station|code)$/.test(value));
    const minimaIndex=headers.findIndex(value=>/^(landing_minima_m|landing minimum|landing_minimum)$/.test(value));
    const cat2Index=headers.findIndex(value=>/^(cat[ -]?2|cat_?2)$/.test(value));
    const cat3Index=headers.findIndex(value=>/^(cat[ -]?3|cat_?3)$/.test(value));
    const noIlsIndex=headers.findIndex(value=>/^(no[ -]?ils|no_?ils)$/.test(value));
    if(codeIndex < 0 || minimaIndex < 0) throw Error('CSV must contain ICAO and landing_minima_m columns.');
    lines.forEach(line=>{
      const columns=line.split(',').map(value=>value.trim());
      const code=(columns[codeIndex] || '').toUpperCase();
      const minimum=Number(columns[minimaIndex]);
      const optionalMinimum=index=>index < 0 || !columns[index] ? null : Number(columns[index]);
      if(/^[A-Z]{4}$/.test(code) && Number.isFinite(minimum) && minimum >= 0){
        landingMinima.set(code,{
          landingMinimum:minimum,
          cat2:optionalMinimum(cat2Index),
          cat3:optionalMinimum(cat3Index),
          noIls:optionalMinimum(noIlsIndex)
        });
      }
    });
  }catch(error){
    console.warn('Landing-minima CSV could not be loaded:',error);
  }
  return landingMinima;
}

function escapeHtml(value){ return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function severityRank(level){ return ({concern:1,bad:2,severe:3})[level] || 0; }
function levelLabel(level){ return ({concern:'Marginal weather',bad:'Bad weather',severe:'Severe weather'})[level] || 'Marginal weather'; }
function unique(items){ return [...new Set(items.filter(Boolean))]; }
function displayObservationTime(value, raw=''){
  if(value){
    const date=new Date(value);
    if(!Number.isNaN(date.valueOf())) return date.toISOString().replace('T',' ').slice(0,16) + ' UTC';
  }
  return raw.match(/\b(\d{6}Z)\b/)?.[1] || 'Time unavailable';
}

function decodeWeather(token){
  const original=token;
  if(/^[+-]?DSTS$/.test(token)) return {token:original, description:'thunderstorm with dust storm', precip:false, parts:['DS'], descriptor:'TS', intensity:token[0] === '+' || token[0] === '-' ? token[0] : ''};
  if(/^[+-]?TS$/.test(token)) return {token:original, description:'thunderstorm', precip:false, parts:[], descriptor:'TS', intensity:token[0] === '+' || token[0] === '-' ? token[0] : ''};
  let intensity='';
  if(token[0] === '+' || token[0] === '-'){ intensity=token[0]; token=token.slice(1); }
  let vicinity=false;
  if(token.startsWith('VC')){ vicinity=true; token=token.slice(2); }
  let descriptor='';
  const match=token.match(/^(MI|BC|PR|DR|BL|SH|TS|FZ)/);
  if(match){ descriptor=match[1]; token=token.slice(2); }
  const parts=token.match(/(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)/g) || [];
  if(!parts.length) return null;
  let phrase=parts.map(part=>PHENOMENA[part]).join(' and ');
  if(descriptor === 'TS') phrase=`thunderstorm${parts.length ? ` with ${phrase}` : ''}`;
  else if(descriptor === 'SH') phrase=`showers of ${phrase}`;
  else if(descriptor === 'FZ') phrase=`freezing ${phrase}`;
  else if(descriptor) phrase=`${DESCRIPTORS[descriptor]} ${phrase}`;
  if(vicinity) phrase=`vicinity ${phrase}`;
  if(intensity === '+') phrase=`heavy ${phrase}`;
  if(intensity === '-') phrase=`light ${phrase}`;
  const precip=parts.some(part=>PRECIP.has(part));
  return {token:original,description:phrase,precip,parts,descriptor,intensity};
}

function parseVisibility(tokens){
  for(let i=0;i<tokens.length;i++){
    let value=tokens[i];
    if(i + 1 < tokens.length && /^\d+$/.test(value) && /^(?:\d+\/\d+|M?\d+\/\d+)SM$/.test(tokens[i+1])) value += ` ${tokens[i+1]}`;
    if(/^\d{4}$/.test(value)) return {token:value,meters:Number(value),display:`${Number(value)} m`};
    if(/^(?:M?\d+(?: \d+\/\d+|\/\d+)?)SM$/.test(value)){
      const raw=value.replace('SM','');
      const less=raw.startsWith('M');
      const clean=raw.replace('M','');
      let miles=0;
      for(const part of clean.split(' ')){
        if(part.includes('/')){ const [a,b]=part.split('/').map(Number); miles += a/b; }
        else miles += Number(part);
      }
      return {token:value,sm:miles,display:`${less ? '< ' : ''}${clean} SM`};
    }
  }
  return null;
}
function parseRvr(tokens){
  return tokens.map(token=>{
    const match=token.match(/^R(\d{2}[LCR]?)\/(M|P)?(\d{4})(?:V(M|P)?\d{4})?(FT)?[UDN]?$/);
    if(!match) return null;
    const metres=Number(match[3]) * (match[5] ? .3048 : 1);
    const qualifier=match[2] === 'M' ? '< ' : match[2] === 'P' ? '> ' : '';
    return {token,runway:match[1],metres,display:`RVR ${match[1]} ${qualifier}${match[3]}${match[5] ? ' ft' : ' m'}`};
  }).filter(Boolean);
}
function visibilityInMetres(visibility){
  if(!visibility) return Number.NaN;
  if(Number.isFinite(visibility.meters)) return visibility.meters;
  return Number.isFinite(visibility.sm) ? visibility.sm * 1609.344 : Number.NaN;
}

function parseWind(tokens){
  for(const token of tokens){
    const match=token.match(/^(?:\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/);
    if(match) return {token,speed:Number(match[1]),gust:match[2] ? Number(match[2]) : null};
  }
  return null;
}

function lowClouds(tokens){
  return tokens.map(token => {
    const match=token.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})/);
    return match ? {token,amount:match[1],hundredsFt:Number(match[2]),description:`${match[1] === 'VV' ? 'vertical visibility' : ({FEW:'few',SCT:'scattered',BKN:'broken',OVC:'overcast'}[match[1]])} cloud ${Number(match[2]) * 100} ft`} : null;
  }).filter(Boolean);
}

// CAT/No-ILS values are presentation-only operational markers. The weather
// screening thresholds continue to use landing_minima_m exclusively.
function approachCondition(visibilityMetres, airportMinima){
  if(!airportMinima || !Number.isFinite(visibilityMetres)) return null;
  const {landingMinimum,cat2,cat3,noIls}=airportMinima;
  if(Number.isFinite(cat3) && visibilityMetres <= cat3) return {kind:'below-cat3',label:'Below CAT III minima'};
  if(Number.isFinite(cat2) && visibilityMetres <= cat2) return {kind:'cat3',label:'CAT III conditions'};
  if(Number.isFinite(cat2) && visibilityMetres <= landingMinimum) return {kind:'cat2',label:'CAT II conditions'};
  if(Number.isFinite(noIls) && visibilityMetres <= noIls) return {kind:'no-ils',label:'No-ILS conditions'};
  return null;
}

function analyseCondition(text, station=''){
  const tokens=text.trim().split(/\s+/).filter(Boolean);
  const weather=tokens.map(decodeWeather).filter(Boolean);
  const visibility=parseVisibility(tokens);
  const rvrs=parseRvr(tokens);
  const wind=parseWind(tokens);
  const clouds=lowClouds(tokens);
  const events=[];
  const airportMinima=landingMinima?.get(station);
  const landingMinimum=airportMinima?.landingMinimum;
  const hasAirportThreshold=Number.isFinite(landingMinimum);
  const visibilityMetres=visibilityInMetres(visibility);
  const gust=wind?.gust ?? -1;
  const approach=approachCondition(visibilityMetres,airportMinima);
  const codeIs=(item,...codes)=>codes.includes(item.token.toUpperCase());
  const isMarginalCode=item=>codeIs(item,'-RA','DZ','-SN','BLDU','SHRA');
  const isBadCode=item=>codeIs(item,'RA','-TSRA','TSRA','DSTS','DS','TS','SN','-RA','+SHRA','-SN');
  const isHeavyCore=item=>item.intensity==='+' && (item.parts.includes('RA') || item.parts.includes('SN') || item.descriptor==='TS');
  const isSevereDust=item=>item.intensity==='+' && item.token.toUpperCase()==='+DSTS' || (item.parts.some(part=>['SA','SS','DS'].includes(part)) && gust >= 25);
  const isThunderstormHail=item=>item.descriptor==='TS' && (item.parts.includes('GR') || item.parts.includes('GS'));
  const isSnowTransport=item=>['DRSN','BLSN'].includes(item.token.toUpperCase());

  // Explicit weather-code screens. The highest applicable level is retained
  // for the report/group summary.
  for(const item of weather){
    let level='';
    if(isHeavyCore(item) || isThunderstormHail(item) || isSevereDust(item)) level='severe';
    else if(isSnowTransport(item) && gust >= 25) level='severe';
    else if(isBadCode(item)) level='bad';
    else if(isMarginalCode(item) && gust >= 15 && gust <= 19 && visibilityMetres <= 2000) level='concern';
    if(level) events.push({token:item.token,description:item.description,level});
  }

  // Gusts are a standalone screen only above 29 kt. The 15–24 kt bands are
  // deliberately applied above only to the weather-code combinations given.
  if(gust > 29) events.push({token:wind.token,description:`wind gusts ${gust} kt`,level:'severe'});

  if(Number.isFinite(visibilityMetres)){
    let level=''; let description='';
    if(hasAirportThreshold){
      if(visibilityMetres <= landingMinimum - 100){
        level='severe'; description=`visibility ${visibility.display} at or below landing minima −100 m (${landingMinimum - 100} m)`;
      }else if(visibilityMetres <= landingMinimum){
        level='bad'; description=`visibility ${visibility.display} at or below landing minima ${landingMinimum} m`;
      }else if(visibilityMetres < landingMinimum + 200){
        level='concern'; description=`visibility ${visibility.display} below landing minima +200 m (${landingMinimum + 200} m)`;
      }
    }else if(visibilityMetres < 1001 || (Number.isFinite(visibility.sm) && visibility.sm <= .5)){
      level='severe'; description=`visibility ${visibility.display} below 1001 m / at or below 0.5 SM`;
    }else if(visibilityMetres < 1600 || (Number.isFinite(visibility.sm) && visibility.sm <= 1)){
      level='bad'; description=`visibility ${visibility.display} below 1600 m / at or below 1 SM`;
    }else if(visibilityMetres >= 1600 && visibilityMetres <= 1800){
      level='concern'; description=`visibility ${visibility.display} in the 1600–1800 m marginal range`;
    }
    if(level){
      events.push({token:visibility.token,description,level});
      // Keep the accompanying obscuration code red/bold in METAR output too:
      // e.g. the reader should see both "1200" and "BR" or "FG".
      weather.filter(item=>item.parts.some(part=>VISIBILITY_PHENOMENA.has(part))).forEach(item=>{
        if(!events.some(event=>event.token===item.token)) events.push({token:item.token,description:item.description,level});
      });
    }
  }

  // Low-cloud categories apply in any weather condition.
  for(const cloud of clouds){
    let level='';
    if(['FEW','SCT','BKN','OVC'].includes(cloud.amount) && cloud.hundredsFt <= 3) level='bad';
    if(level) events.push({token:cloud.token,description:cloud.description,level});
  }
  const level=events.reduce((current,event)=>severityRank(event.level)>severityRank(current) ? event.level : current,'');
  return {tokens,events,level,weather,visibility,rvrs,wind,clouds,approach};
}

function reportKind(report){
  const first=report.trim().toUpperCase();
  if(/^(?:TAF(?:\s+(?:AMD|COR))?\s+)?[A-Z]{4}\s+\d{6}Z\s+\d{4}\/\d{4}/.test(first) || /^TAF\b/.test(first)) return 'TAF';
  if(/^(?:METAR|SPECI)\b/.test(first) || /^[A-Z]{4}\s+\d{6}Z\b/.test(first)) return 'METAR';
  return '';
}

function splitReports(source){
  const normalized=source.replace(/\r/g,'').replace(/=/g,'\n').trim();
  if(!normalized) return [];
  const marked=normalized.replace(/\n\s*(?=(?:TAF(?:\s+(?:AMD|COR))?|METAR|SPECI)\s+[A-Z]{4}\b)/gi,'\n@@REPORT@@');
  return marked.split('@@REPORT@@').map(value=>value.trim()).filter(Boolean);
}

function stationFromReport(report){
  const match=report.match(/^(?:TAF|METAR|SPECI)?\s*(?:AMD\s+|COR\s+)?([A-Z]{4})\b/i);
  return match ? match[1].toUpperCase() : 'Unknown station';
}
async function loadStationNames(){
  if(stationNames) return stationNames;
  try{
    const airports=await fetch('assets/airports-iata.json').then(response=>response.ok ? response.json() : []);
    stationNames=new Map(airports.filter(airport=>airport.icao && airport.name).map(airport=>[airport.icao.toUpperCase(),airport.name]));
  }catch(error){ stationNames=new Map(); }
  return stationNames;
}
function stationDisplay(code){
  const name=stationNames?.get(code);
  return name ? `${code} · ${name}` : code;
}

function timeLabel(dayHour){
  if(!dayHour) return 'time not encoded';
  const match=String(dayHour).match(/^(\d{2})(\d{2})(?:\d{2})?$/);
  return match ? `${match[1]}/${match[2]}00` : dayHour;
}
function windowLabel(start,end){ return `${timeLabel(start)}–${timeLabel(end)} UTC`; }

function tafGroups(report){
  const compact=report.replace(/\s+/g,' ').trim().toUpperCase();
  const station=stationFromReport(compact);
  const validity=compact.match(/\b(\d{4})\/(\d{4})\b/);
  if(!validity) return {station,groups:[],error:'TAF validity period was not found.'};
  const boundary=/\b(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB(?:30|40)(?:\s+TEMPO)?\s+\d{4}\/\d{4})\b/g;
  const matches=[...compact.matchAll(boundary)];
  const headerEnd=validity.index + validity[0].length;
  const groups=[];
  groups.push({type:'prevailing',content:compact.slice(headerEnd,matches[0]?.index || compact.length),start:validity[1],end:matches[0] ? groupStart(matches[0][1]) : validity[2]});
  for(let i=0;i<matches.length;i++){
    const raw=matches[i][1];
    const next=matches[i+1]?.index || compact.length;
    const range=raw.match(/(\d{4})\/(\d{4})/);
    const fm=raw.match(/^FM(\d{6})/);
    const type=raw.startsWith('BECMG') ? 'BECMG' : raw.startsWith('TEMPO') ? 'TEMPO' : raw.startsWith('PROB') ? raw.split(' ')[0] : 'FM';
    groups.push({type,content:compact.slice(matches[i].index + raw.length,next),start:fm ? fm[1].slice(0,4) : range?.[1],end:fm ? groupStart(matches[i+1]?.[1]) || validity[2] : range?.[2],raw});
  }
  return {station,groups,validity};
}
function groupStart(raw){
  if(!raw) return '';
  const fm=raw.match(/^FM(\d{6})/); if(fm) return fm[1].slice(0,4);
  const range=raw.match(/(\d{4})\/(\d{4})/); return range?.[1] || '';
}

function describeEvents(events,approach){
  const descriptions=unique(events.map(event=>event.description));
  if(approach && !descriptions.includes(approach.label)) descriptions.push(approach.label);
  return descriptions.join('; ');
}
function tafRiskRows(report){
  const parsed=tafGroups(report);
  if(parsed.error) return {rows:[],error:parsed.error};
  let previous={events:[],level:'',approach:null};
  const rows=[];
  parsed.groups.forEach(group=>{
    const analysed=analyseCondition(group.content, parsed.station);
    const target=analysed.events;
    const source=group.type === 'prevailing' ? `${report.replace(/\s+/g,' ').trim().toUpperCase().slice(0, parsed.validity.index + parsed.validity[0].length)}${group.content}`.trim() : `${group.raw} ${group.content}`.trim();
    if(group.type === 'BECMG'){
      const targetRank=severityRank(analysed.level), previousRank=severityRank(previous.level);
      if(targetRank < previousRank && previous.events.length){
        rows.push({station:parsed.station,description:`${describeEvents(previous.events,previous.approach)} · improving BECMG, conservatively retained until ${timeLabel(group.end)} UTC`,source,window:windowLabel(group.start,group.end),level:previous.level,approach:previous.approach});
      } else if(target.length){
        rows.push({station:parsed.station,description:`${describeEvents(target,analysed.approach)} · deteriorating BECMG, planning from ${timeLabel(group.start)} UTC`,source,window:windowLabel(group.start,group.end),level:analysed.level,approach:analysed.approach});
      }
    } else if(target.length){
      const qualifier=group.type === 'TEMPO' ? 'Temporary' : group.type.startsWith('PROB') ? `${group.type.replace('TEMPO','').trim()} probability` : group.type === 'FM' ? 'From' : 'Prevailing';
      rows.push({station:parsed.station,description:`${qualifier.toLowerCase()} ${describeEvents(target,analysed.approach)}`,source,window:windowLabel(group.start,group.end),level:analysed.level,approach:analysed.approach});
    }
    if(group.type !== 'TEMPO' && !group.type.startsWith('PROB')) previous=analysed;
  });
  return {rows};
}

function highlightMetar(report){
  const tokens=report.replace(/\s+/g,' ').trim().split(' ');
  const analysis=analyseCondition(tokens.join(' '), stationFromReport(report));
  const hazardLevels=new Map();
  analysis.events.forEach(event=>{
    const previous=hazardLevels.get(event.token);
    if(!previous || severityRank(event.level)>severityRank(previous)) hazardLevels.set(event.token,event.level);
  });
  const html=tokens.map(token=>hazardLevels.has(token) ? `<span class="metar-hazard ${hazardLevels.get(token)}">${escapeHtml(token)}</span>` : escapeHtml(token)).join(' ');
  return {analysis,html};
}

function visibleTafRows(){ return allTafRows.filter(row=>activeCategories.has(row.level)); }
function approachBadge(approach){ return approach ? `<span class="approach-badge ${escapeHtml(approach.kind)}">${escapeHtml(approach.label)}</span>` : ''; }
function renderTafTable(){
  const tafBody=$('tafBody'), rows=visibleTafRows();
  const grouped=rows.reduce((groups,row)=>{ (groups[row.station] ||= []).push(row); return groups; },{});
  const selected=activeCategories.size === 3 ? 'selected' : [...activeCategories].map(level=>levelLabel(level).toLowerCase()).join(' or ');
  tafBody.innerHTML=Object.entries(grouped).map(([station,stationRows])=>stationRows.map((row,index)=>`<tr class="risk-row ${row.level}${row.approach ? ` approach-${row.approach.kind}` : ''}">${index===0 ? `<td rowspan="${stationRows.length}"><strong>${escapeHtml(station)}</strong></td>` : ''}<td class="risk ${row.level}">${escapeHtml(row.description)}${approachBadge(row.approach)}<small class="taf-source">${escapeHtml(row.source)}</small></td><td>${escapeHtml(row.window)}</td></tr>`).join('')).join('') || `<tr><td colspan="3">No ${selected} TAF weather-risk windows were identified.</td></tr>`;
  $('copyTafTable').disabled=!rows.length;
}
function selectCategory(category){
  if(category === 'all') activeCategories=new Set(['concern','bad','severe']);
  else if(activeCategories.has(category)) activeCategories.delete(category);
  else activeCategories.add(category);
  const allSelected=activeCategories.size === 3;
  document.querySelectorAll('.category-filter').forEach(button=>{
    const active=button.dataset.category === 'all' ? allSelected : activeCategories.has(button.dataset.category);
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  });
  renderTafTable();
}
async function copyVisibleTafTable(){
  const rows=visibleTafRows();
  if(!rows.length) return;
  const scope=activeCategories.size === 3 ? 'All conditions' : [...activeCategories].map(level=>levelLabel(level)).join(' + ') || 'No conditions selected';
  const text=[`TAF operational risk summary — ${scope}`,'Station Name\tWeather Description\tTime Window (UTC)',...rows.map(row=>`${row.station}\t${row.description}\t${row.window}`)].join('\n');
  // Word, Outlook and most office applications recognise text/html on the
  // clipboard as a real table. The plain-text representation remains useful
  // for terminals, CSV-style pastes and older browsers.
  const html=`<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt"><caption style="caption-side:top;text-align:left;font-weight:bold;padding:0 0 8px">${escapeHtml(`TAF operational risk summary — ${scope}`)}</caption><thead><tr><th style="border:1px solid #777;padding:7px;text-align:left;background:#e9eef0">Station Name</th><th style="border:1px solid #777;padding:7px;text-align:left;background:#e9eef0">Weather Description</th><th style="border:1px solid #777;padding:7px;text-align:left;background:#e9eef0">Time Window (UTC)</th></tr></thead><tbody>${rows.map(row=>`<tr><td style="border:1px solid #777;padding:7px;vertical-align:top"><b>${escapeHtml(row.station)}</b></td><td style="border:1px solid #777;padding:7px;vertical-align:top">${escapeHtml(row.description)}<br><span style="color:#555;font-size:8pt">${escapeHtml(row.source)}</span></td><td style="border:1px solid #777;padding:7px;vertical-align:top;white-space:nowrap">${escapeHtml(row.window)}</td></tr>`).join('')}</tbody></table>`;
  try{
    if(navigator.clipboard?.write && window.ClipboardItem){
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':new Blob([html],{type:'text/html'}),
        'text/plain':new Blob([text],{type:'text/plain'})
      })]);
    }else{
      // Legacy rich-copy fallback: selecting a real DOM table preserves its
      // tabular structure when it is pasted into Word.
      const holder=document.createElement('div');
      holder.contentEditable='true'; holder.style.cssText='position:fixed;left:-9999px;top:0'; holder.innerHTML=html;
      document.body.append(holder);
      const selection=window.getSelection(), range=document.createRange();
      range.selectNodeContents(holder); selection.removeAllRanges(); selection.addRange(range);
      const copied=document.execCommand('copy');
      selection.removeAllRanges(); holder.remove();
      if(!copied) throw Error('Copy was not accepted by this browser.');
    }
    const button=$('copyTafTable'), original=button.textContent;
    button.textContent='Copied table'; setTimeout(()=>{button.textContent=original},1600);
  }catch(error){ $('analyzerNotice').className='analyzer-notice error'; $('analyzerNotice').textContent='Could not copy the table. Please select the table and copy it manually.'; }
}

async function render(){
  const reports=splitReports($('weatherInput').value);
  await Promise.all([loadStationNames(),loadLandingMinima()]);
  const tafRows=[]; const metars=[]; const errors=[];
  for(const report of reports){
    const kind=reportKind(report);
    if(kind === 'TAF'){
      const result=tafRiskRows(report);
      tafRows.push(...result.rows);
      if(result.error) errors.push(`${stationFromReport(report)}: ${result.error}`);
    } else if(kind === 'METAR') metars.push({station:stationFromReport(report),report,...highlightMetar(report)});
    else errors.push('One pasted block was not recognised as a complete METAR, SPECI, or TAF.');
  }
  allTafRows=tafRows;
  renderTafTable();
  $('tafResults').hidden=!reports.some(report=>reportKind(report)==='TAF');
  $('metarList').innerHTML=metars.map(item=>`<article class="metar-report${item.analysis.approach ? ` approach-${item.analysis.approach.kind}` : ''}"><header><strong>${escapeHtml(stationDisplay(item.station))}</strong><span>${approachBadge(item.analysis.approach)}<small class="metar-level ${item.analysis.level}">${item.analysis.events.length ? `${levelLabel(item.analysis.level)} groups highlighted` : 'No configured weather concern identified'}</small></span></header><pre class="metar-raw">${item.html}</pre></article>`).join('') || '<p class="no-findings">No METAR or SPECI reports were supplied.</p>';
  $('metarResults').hidden=!metars.length;
  const recognised=tafRows.length + metars.length;
  $('analyzerNotice').className=`analyzer-notice${errors.length ? ' error' : ''}`;
  $('analyzerNotice').textContent=errors.length ? `${recognised ? 'Analysis completed. ' : ''}${errors.join(' ')}` : `Analysis completed: ${tafRows.length} TAF risk window${tafRows.length===1?'':'s'} and ${metars.length} METAR / SPECI report${metars.length===1?'':'s'} processed.`;
}

if($('analyseWeather')){
  $('analyseWeather').addEventListener('click',render);
  $('weatherInput').addEventListener('keydown',event=>{ if(event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); render(); } });
  document.querySelectorAll('.category-filter').forEach(button=>button.addEventListener('click',()=>selectCategory(button.dataset.category)));
  $('copyTafTable').addEventListener('click',copyVisibleTafTable);
}
