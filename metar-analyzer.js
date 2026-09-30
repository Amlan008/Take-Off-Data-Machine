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

async function refreshMetarScreen(){
  const body=metarScreen$('metarScreenBody'), status=metarScreen$('metarScreenStatus');
  body.innerHTML='<tr><td colspan="2">Refreshing the live METAR screen…</td></tr>';
  try{
    await loadLandingMinima();
    const response=await fetch('/api/metar-analyzer', {cache:'no-store'});
    const payload=await response.json();
    if(!response.ok) throw Error(payload.error || 'METAR feed was unavailable.');
    const screened=(payload.records || []).map(report=>({report,analysis:analyseCondition(report.raw,report.icao)})).filter(item=>item.analysis.events.length);
    body.innerHTML=screened.map(({report,analysis})=>`<tr class="risk-row ${analysis.level}"><td>${metarScreenEscape(analysis.visibility?.display || 'Not reported')}${metarScreenBadge(analysis.approach)}</td><td><span class="metar-icao">${metarScreenEscape(report.icao)}</span> <span class="metar-raw ${analysis.level}">${metarScreenEscape(report.raw)}</span></td></tr>`).join('') || '<tr><td colspan="2">No current METARs meet the configured Marginal, Bad, or Severe rules.</td></tr>';
    status.textContent=`${screened.length} screened report${screened.length===1?'':'s'} · last source refresh ${metarScreenTime(payload.refreshed_at)}.${payload.warning ? ` Last refresh warning: ${payload.warning}` : ''}`;
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
