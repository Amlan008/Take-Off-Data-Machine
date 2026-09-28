const $ = id => document.getElementById(id);
let stationNames;

const PHENOMENA = {
  DZ:'drizzle', RA:'rain', SN:'snow', SG:'snow grains', IC:'ice crystals', PL:'ice pellets', GR:'hail', GS:'small hail / snow pellets', UP:'unknown precipitation',
  BR:'mist', FG:'fog', FU:'smoke', VA:'volcanic ash', DU:'widespread dust', SA:'sand', HZ:'haze', PY:'spray', PO:'dust / sand whirls', SQ:'squall', FC:'funnel cloud', SS:'sandstorm', DS:'dust storm'
};
const DESCRIPTORS = {MI:'shallow', BC:'patches of', PR:'partial', DR:'drifting', BL:'blowing', SH:'showers of', TS:'thunderstorm with', FZ:'freezing'};
const PRECIP = new Set(['DZ','RA','SN','SG','IC','PL','GR','GS','UP']);
const SEVERE_PHENOMENA = new Set(['VA','GR','GS','IC','PL','DS','SS','FC']);
const VISIBILITY_PHENOMENA = new Set(['BR','FG','FU','DU','SA','HZ','PY']);
const WEATHER_TOKEN = /^(?:\+|-)?(?:VC)?(?:(?:MI|BC|PR|DR|BL|SH|TS|FZ))?(?:(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS))+$/;
// Airport-specific non-precipitation visibility screens. Each value is the
// applicable landing minimum in metres; the operational screen activates only
// below minimum + 500 m, per the user's conservative-planning rule.
const LANDING_MINIMA_METRES = {
  VIDP:550,VIAR:650,VILK:550,VIJP:550,VISR:1500,VILH:5000,VIJU:900,VIDN:1400,VIJO:1000,
  VECC:550,VEBS:550,VEBN:900,VEPT:1000,VERC:1800,VEBD:800,VERP:900,VEGT:1200,
  VABB:550,VANP:550,VABP:550,VAID:800,VAAU:900,VAAH:550,VAHS:550,VABJ:550,VAJM:550,VAUD:900,
  VOBL:550,VOCI:550,VOTV:550,VOMM:550,VOGO:1000,VOGA:1000,VOML:750,VOCL:1000,VOKN:800,VOVI:1000,VOPB:900,
  VNKT:2800,VGHS:1300
};

function escapeHtml(value){ return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function severityRank(level){ return ({concern:1,bad:2,severe:3})[level] || 0; }
function levelLabel(level){ return ({concern:'Weather concern',bad:'Bad weather',severe:'Severe weather'})[level] || 'Weather concern'; }
function unique(items){ return [...new Set(items.filter(Boolean))]; }

function decodeWeather(token){
  const original=token;
  if(token === 'DSTS') return {token:original, description:'thunderstorm with dust storm', precip:false, level:'severe'};
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
  let level='concern';
  if(parts.some(part=>SEVERE_PHENOMENA.has(part)) || descriptor === 'FZ' || intensity === '+') level='severe';
  else if(descriptor === 'TS' || parts.some(part=>['FG','SQ','DU','SA'].includes(part)) || descriptor === 'BL') level='bad';
  return {token:original,description:phrase,precip,level,parts,descriptor,intensity};
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
    return match && Number(match[2]) < 7 ? {token,description:`${match[1] === 'VV' ? 'vertical visibility' : ({FEW:'few',SCT:'scattered',BKN:'broken',OVC:'overcast'}[match[1]])} cloud ${Number(match[2]) * 100} ft`} : null;
  }).filter(Boolean);
}

function analyseCondition(text, station=''){
  const tokens=text.trim().split(/\s+/).filter(Boolean);
  const weather=tokens.map(decodeWeather).filter(Boolean);
  const visibility=parseVisibility(tokens);
  const wind=parseWind(tokens);
  const clouds=lowClouds(tokens);
  const events=[];
  const precipitation=weather.filter(item=>item.precip);
  const landingMinimum=LANDING_MINIMA_METRES[station];
  const hasAirportThreshold=Number.isFinite(landingMinimum);
  const visibilityThreshold=hasAirportThreshold ? landingMinimum + 500 : Number.NaN;
  const defaultNonPrecipitationScreen=visibility && !precipitation.length && !hasAirportThreshold && (
    (Number.isFinite(visibility.meters) && visibility.meters <= 1500) ||
    (Number.isFinite(visibility.sm) && visibility.sm <= 1.5)
  );
  const nonPrecipitationScreen=visibility && !precipitation.length && (
    (hasAirportThreshold && visibilityInMetres(visibility) < visibilityThreshold) || defaultNonPrecipitationScreen
  );
  for(const item of weather){
    // For the configured airports, fog/mist/haze/smoke/dust/sand are placed in
    // the risk list only when the associated non-precipitation visibility is
    // below that airport's minimum-plus-500-m screen.
    const visibilityOnly=item.parts?.some(part=>VISIBILITY_PHENOMENA.has(part));
    if(!item.precip && visibility && visibilityOnly && !nonPrecipitationScreen) continue;
    events.push({token:item.token,description:item.description,level:item.level});
  }
  if(wind?.gust >= 25){
    const severeWithPrecip=precipitation.length > 0;
    events.push({token:wind.token,description:`wind gusts ${wind.gust} kt${severeWithPrecip ? ' with precipitation' : ''}`,level:severeWithPrecip ? 'severe' : 'concern'});
  }
  const lowVis=visibility && ((Number.isFinite(visibility.meters) && visibility.meters <= 1500) || (Number.isFinite(visibility.sm) && visibility.sm <= 1));
  if(lowVis && precipitation.length) events.push({token:visibility.token,description:`visibility ${visibility.display} in precipitation`,level:'bad'});
  if(nonPrecipitationScreen){
    const thresholdDescription=hasAirportThreshold
      ? `below ${visibilityThreshold} m screening threshold (landing minima ${landingMinimum} m + 500 m)`
      : 'at or below the default non-precipitation screening threshold';
    events.push({token:visibility.token,description:`visibility ${visibility.display} ${thresholdDescription}`,level:'bad'});
  }
  for(const cloud of clouds) events.push({token:cloud.token,description:cloud.description,level:'concern'});
  const level=events.reduce((current,event)=>severityRank(event.level)>severityRank(current) ? event.level : current,'');
  return {tokens,events,level,weather,visibility,wind,clouds,nonPrecipitationScreen};
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

function describeEvents(events){ return unique(events.map(event=>event.description)).join('; '); }
function tafRiskRows(report){
  const parsed=tafGroups(report);
  if(parsed.error) return {rows:[],error:parsed.error};
  let previous={events:[],level:''};
  const rows=[];
  parsed.groups.forEach(group=>{
    const analysed=analyseCondition(group.content, parsed.station);
    const target=analysed.events;
    const source=group.type === 'prevailing' ? `${report.replace(/\s+/g,' ').trim().toUpperCase().slice(0, parsed.validity.index + parsed.validity[0].length)}${group.content}`.trim() : `${group.raw} ${group.content}`.trim();
    if(group.type === 'BECMG'){
      const targetRank=severityRank(analysed.level), previousRank=severityRank(previous.level);
      if(targetRank < previousRank && previous.events.length){
        rows.push({station:parsed.station,description:`${describeEvents(previous.events)} · improving BECMG, conservatively retained until ${timeLabel(group.end)} UTC`,source,window:windowLabel(group.start,group.end),level:previous.level});
      } else if(target.length){
        rows.push({station:parsed.station,description:`${describeEvents(target)} · deteriorating BECMG, planning from ${timeLabel(group.start)} UTC`,source,window:windowLabel(group.start,group.end),level:analysed.level});
      }
    } else if(target.length){
      const qualifier=group.type === 'TEMPO' ? 'Temporary' : group.type.startsWith('PROB') ? `${group.type.replace('TEMPO','').trim()} probability` : group.type === 'FM' ? 'From' : 'Prevailing';
      rows.push({station:parsed.station,description:`${qualifier.toLowerCase()} ${describeEvents(target)}`,source,window:windowLabel(group.start,group.end),level:analysed.level});
    }
    if(group.type !== 'TEMPO' && !group.type.startsWith('PROB')) previous=analysed;
  });
  return {rows};
}

function highlightMetar(report){
  const tokens=report.replace(/\s+/g,' ').trim().split(' ');
  const analysis=analyseCondition(tokens.join(' '), stationFromReport(report));
  const hazardTokens=new Set(analysis.events.map(event=>event.token));
  const html=tokens.map(token=>hazardTokens.has(token) ? `<span class="metar-hazard">${escapeHtml(token)}</span>` : escapeHtml(token)).join(' ');
  return {analysis,html};
}

async function render(){
  const reports=splitReports($('weatherInput').value);
  await loadStationNames();
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
  const tafBody=$('tafBody');
  const tafRowsByStation=tafRows.reduce((groups,row)=>{
    (groups[row.station] ||= []).push(row);
    return groups;
  },{});
  tafBody.innerHTML=Object.entries(tafRowsByStation).map(([station,rows])=>rows.map((row,index)=>`<tr>${index === 0 ? `<td rowspan="${rows.length}"><strong>${escapeHtml(station)}</strong></td>` : ''}<td class="risk ${row.level}">${escapeHtml(row.description)}<small class="taf-source">${escapeHtml(row.source)}</small></td><td>${escapeHtml(row.window)}</td></tr>`).join('')).join('') || '<tr><td colspan="3">No TAF weather-risk windows were identified using the configured conservative rules.</td></tr>';
  $('tafResults').hidden=!reports.some(report=>reportKind(report)==='TAF');
  $('metarList').innerHTML=metars.map(item=>`<article class="metar-report"><header><strong>${escapeHtml(stationDisplay(item.station))}</strong><small>${item.analysis.events.length ? `${levelLabel(item.analysis.level)} groups highlighted` : 'No configured weather concern identified'}</small></header><pre class="metar-raw">${item.html}</pre></article>`).join('') || '<p class="no-findings">No METAR or SPECI reports were supplied.</p>';
  $('metarResults').hidden=!metars.length;
  const recognised=tafRows.length + metars.length;
  $('analyzerNotice').className=`analyzer-notice${errors.length ? ' error' : ''}`;
  $('analyzerNotice').textContent=errors.length ? `${recognised ? 'Analysis completed. ' : ''}${errors.join(' ')}` : `Analysis completed: ${tafRows.length} TAF risk window${tafRows.length===1?'':'s'} and ${metars.length} METAR / SPECI report${metars.length===1?'':'s'} processed.`;
}

$('analyseWeather').addEventListener('click',render);
$('weatherInput').addEventListener('keydown',event=>{ if(event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); render(); } });
