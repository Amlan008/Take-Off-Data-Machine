const metarScreen$ = id => document.getElementById(id);
let metarScreenTimer;

function metarScreenEscape(value){ return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function metarScreenTime(value, raw=''){
  if(value){
    const date=new Date(value);
    if(!Number.isNaN(date.valueOf())) return date.toISOString().replace('T',' ').slice(0,16) + ' UTC';
  }
  return raw.match(/\b(\d{6}Z)\b/)?.[1] || 'Time unavailable';
}
function metarScreenBadge(approach){ return approach ? `<span class="approach-badge ${metarScreenEscape(approach.kind)}">${metarScreenEscape(approach.label)}</span>` : ''; }
function decodedMetarObservation(raw, now=new Date()){
  const match=raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if(!match) return null;
  const [,day,hour,minute]=match.map(Number);
  const candidates=[-1,0,1].map(monthOffset=>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+monthOffset,day,hour,minute)));
  return candidates.reduce((nearest,candidate)=>Math.abs(candidate-now) < Math.abs(nearest-now) ? candidate : nearest);
}
function minimaNotes(report, analysis){
  const airport=landingMinima?.get(report.icao);
  if(!airport) return [];
  const values=[];
  const visibilityMetres=visibilityInMetres(analysis.visibility);
  if(Number.isFinite(visibilityMetres)) values.push({label:'Visibility',metres:visibilityMetres});
  (analysis.rvrs || []).forEach(rvr=>values.push({label:rvr.display,metres:rvr.metres}));
  const notes=[];
  values.forEach(value=>{
    if(value.metres <= airport.landingMinimum) notes.push(`${value.label} at/below landing minima (${airport.landingMinimum} m)`);
    if(Number.isFinite(airport.cat3) && value.metres <= airport.cat3) notes.push(`${value.label} at/below CAT-3 minima (${airport.cat3} m)`);
  });
  return [...new Set(notes)];
}

async function refreshMetarScreen(){
  const body=metarScreen$('metarScreenBody'), status=metarScreen$('metarScreenStatus');
  body.innerHTML='<tr><td colspan="2">Refreshing the live METAR screen…</td></tr>';
  try{
    await loadLandingMinima();
    const response=await fetch('/api/metar-analyzer', {cache:'no-store'});
    const payload=await response.json();
    if(!response.ok) throw Error(payload.error || 'METAR feed was unavailable.');
    const now=new Date();
    const decoded=(payload.records || []).map(report=>({report,analysis:analyseCondition(report.raw,report.icao),observed:decodedMetarObservation(report.raw,now)}));
    const fresh=decoded.filter(item=>item.observed && now-item.observed >= 0 && now-item.observed < 3 * 60 * 60 * 1000);
    const screened=fresh.filter(item=>item.analysis.events.length);
    const staleOrUndated=decoded.length-fresh.length;
    body.innerHTML=screened.map(({report,analysis})=>{
      const notes=minimaNotes(report,analysis).map(note=>`<small class="minima-note">${metarScreenEscape(note)}</small>`).join('');
      return `<tr class="risk-row ${analysis.level}"><td>${metarScreenEscape(analysis.visibility?.display || 'Not reported')}${metarScreenBadge(analysis.approach)}${notes}</td><td><span class="metar-icao">${metarScreenEscape(report.icao)}</span> <span class="metar-raw ${analysis.level}">${metarScreenEscape(report.raw)}</span></td></tr>`;
    }).join('') || '<tr><td colspan="2">No current METARs meet the configured Marginal, Bad, or Severe rules.</td></tr>';
    status.textContent=`${screened.length} screened report${screened.length===1?'':'s'} · ${staleOrUndated} stale or undated report${staleOrUndated===1?' was':'s were'} excluded · last source refresh ${metarScreenTime(payload.refreshed_at)}.${payload.warning ? ` Last refresh warning: ${payload.warning}` : ''}`;
  }catch(error){
    const fileMode=window.location.protocol === 'file:';
    body.innerHTML=`<tr><td colspan="2">${fileMode ? 'METAR Analyzer must be opened through the deployed site or http://127.0.0.1:4174/metar-analyzer.html.' : 'METAR data is temporarily unavailable. The next automatic refresh will retry.'}</td></tr>`;
    status.textContent=fileMode ? 'Live METAR data is unavailable from a file:// page.' : `Screen refresh failed: ${error.message || error}`;
  }
  clearTimeout(metarScreenTimer);
  metarScreenTimer=setTimeout(refreshMetarScreen,10 * 60 * 1000);
}

metarScreen$('refreshMetarScreen').addEventListener('click',refreshMetarScreen);
refreshMetarScreen();
