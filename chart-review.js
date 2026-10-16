/* Independent human assessments; never modify automated diagnostic data. */
(() => {
  const copy = value => JSON.parse(JSON.stringify(value));
  function key(feature) {
    if (feature.properties.feature_id) return feature.properties.feature_id;
    // Legacy charts have no persistent IDs: retain the full geometry in exports.
    const text = JSON.stringify([feature.properties.feature_type, feature.geometry]);
    let hash = 2166136261;
    for (let i=0;i<text.length;i++) hash=Math.imul(hash^text.charCodeAt(i),16777619);
    return 'legacy-' + (hash>>>0).toString(16);
  }
  function matches(feature, previous) {
    const p=feature.properties;
    const ids=new Set([p.track_id,p.parent_track_id,...(p.candidate_parent_track_ids||[])].filter(Boolean));
    return (previous?.features||[]).filter(f =>
      (p.previous_feature_id && f.properties.feature_id===p.previous_feature_id) ||
      (ids.has(f.properties.track_id) && f.properties.feature_type===p.feature_type));
  }
  function create({map, panel, read, contextURL}) {
    panel.innerHTML=`<summary>HUMAN REVIEW · LOCAL DRAFT</summary>
      <label><input id="reviewEnabled" type="checkbox">Enable review mode</label>
      <p class="chart-status">Click a diagnostic feature. Gold: selected; cyan dashed: proposed previous match. Feedback is separate from the analysis and is not submitted anywhere.</p>
      <label>Reviewer (optional)<input id="reviewerName" maxlength="120"></label>
      <p id="reviewSelection" class="chart-status">No feature selected.</p>
      <label>Identification<select id="reviewIdentification"><option value="not_assessed">Not assessed</option><option value="correct">Correct</option><option value="wrong_type">Wrong type</option><option value="false_detection">False detection</option></select></label>
      <label>Tracking<select id="reviewTracking"><option value="not_assessed">Not assessed</option><option value="same_feature">Correct match / same feature</option><option value="different_feature">Different feature</option><option value="split">Split</option><option value="merge">Merge</option><option value="uncertain">Uncertain</option></select></label>
      <label>Correct / missed feature type (optional)<input id="reviewType" maxlength="120"></label>
      <label>Notes<textarea id="reviewNotes" maxlength="4000" rows="3"></textarea></label>
      <div class="chart-buttons"><button id="reviewSave" type="button">Save assessment</button></div>
      <div class="chart-buttons"><button id="reviewPoint" type="button">Missed point</button><button id="reviewLine" type="button">Missed line</button></div>
      <div class="chart-buttons"><button id="reviewFinish" type="button">Finish line</button><button id="reviewCancel" type="button">Cancel selection</button></div>
      <div class="chart-buttons"><button id="reviewDownload" type="button">Download reviews</button></div>
      <p id="reviewStatus" class="chart-status" role="status" aria-live="polite"></p>`;
    const $=id=>panel.querySelector('#'+id), storageKey='weather-machine-feature-reviews-v1';
    const overlay=L.layerGroup().addTo(map);
    let records=[], context=null, selected=null, previous=null, candidates=[], drawing=null, vertices=[], generation=0;
    let storageAvailable=true;
    try {
      const saved=JSON.parse(localStorage.getItem(storageKey)||'{"records":[]}');
      if(!Array.isArray(saved.records)||saved.records.some(r=>!r||typeof r.review_id!=='string')) throw Error('Invalid draft');
      records=saved.records; $('reviewerName').value=saved.reviewer||'';
    } catch { storageAvailable=false; }
    const status=message=>{$('reviewStatus').textContent=message+' · '+records.length+' saved assessments. '+(storageAvailable?'Drafts stay in this browser; download for permanent archiving.':'Browser storage unavailable: download before leaving.');};
    const reset=()=>{generation++;selected=null;previous=null;candidates=[];drawing=null;vertices=[];overlay.clearLayers();$('reviewSelection').textContent='No feature selected.';$('reviewNotes').value='';$('reviewType').value='';$('reviewTracking').value='not_assessed';$('reviewIdentification').value='not_assessed';};
    function paint(feature,color,dashArray) {
      let coordinate=feature.geometry.coordinates;
      while(Array.isArray(coordinate[0]))coordinate=coordinate[0];
      const shift=360*Math.round((map.getCenter().lng-coordinate[0])/360);
      L.geoJSON(feature,{coordsToLatLng:c=>L.latLng(c[1],c[0]+shift),interactive:false,
        pointToLayer:(_,latlng)=>L.circleMarker(latlng,{radius:12}),style:{color,weight:5,dashArray,fillOpacity:.06}}).addTo(overlay);
    }
    async function select(feature) {
      if(!$('reviewEnabled').checked||!context||drawing)return;
      reset();const token=generation;selected=copy(feature);paint(selected,'#ffb900');
      $('reviewSelection').textContent=(feature.properties.label||feature.properties.feature_type)+' · '+context.valid_time+' · '+key(feature);
      status('Loading previous published chart…');
      try {
        const requestedTime=feature.properties.previous_time;
        const prior=requestedTime ? (context.previous_charts||[context.previous]).find(entry=>entry&&Date.parse(entry.valid_time)===Date.parse(requestedTime)) : context.previous;
        if(!prior) {status('No previous chart available: tracking cannot be checked.');return;}
        const collection=await read(prior.file);
        if(token!==generation)return;
        previous={valid_time:prior.valid_time,diagnostics:copy(collection.properties||{})};
        candidates=matches(feature,collection).map(copy);
        candidates.forEach(f=>paint(f,'#00c4db','8 5'));
        status(candidates.length ? candidates.length+' proposed previous match(es) at '+prior.valid_time : 'No published lineage match available. Identification can still be reviewed; do not infer a match from proximity alone.');
      } catch {if(token===generation)status('Previous diagnostics unavailable. Identification review remains available.');}
    }
    $('reviewEnabled').addEventListener('change',()=>{reset();status($('reviewEnabled').checked?'Review mode enabled.':'Review mode disabled.');});
    for(const [id,mode] of [['reviewPoint','point'],['reviewLine','line']])$(id).onclick=()=>{
      if(!$('reviewEnabled').checked||!context){status('Enable review mode and load a chart first.');return;}
      reset();drawing=mode;status(mode==='point'?'Click the missed feature location on the map.':'Click map vertices, then Finish line.');
    };
    map.on('click',event=>{
      if(!drawing)return;
      const coordinate=[((event.latlng.lng+180)%360+360)%360-180,event.latlng.lat];vertices.push(coordinate);
      overlay.clearLayers();
      if(drawing==='point') {
        selected={type:'Feature',properties:{feature_type:'missed_feature'},geometry:{type:'Point',coordinates:coordinate}};drawing=null;
        paint(selected,'#ffb900');$('reviewSelection').textContent='Missed feature · '+context.valid_time;status('Describe the missed feature and save.');
      } else {
        vertices.forEach(c=>L.circleMarker([c[1],c[0]],{radius:4,interactive:false,color:'#ffb900'}).addTo(overlay));
        status(vertices.length+' line vertices; Finish line when ready.');
      }
    });
    $('reviewFinish').onclick=()=>{
      if(drawing!=='line'||vertices.length<2){status('A missed line needs at least two map clicks.');return;}
      // Unwrap dateline crossings so a short boundary does not become a global line.
      const line=copy(vertices);for(let i=1;i<line.length;i++)line[i][0]+=360*Math.round((line[i-1][0]-line[i][0])/360);
      selected={type:'Feature',properties:{feature_type:'missed_feature'},geometry:{type:'LineString',coordinates:line}};
      drawing=null;overlay.clearLayers();paint(selected,'#ffb900');$('reviewSelection').textContent='Missed line · '+context.valid_time;status('Describe the missed feature and save.');
    };
    $('reviewCancel').onclick=()=>{reset();status('Selection cancelled; saved assessments retained.');};
    $('reviewSave').onclick=()=>{
      if(!selected||!context||!$('reviewEnabled').checked){status('Select or draw a feature first.');return;}
      const missed=selected.properties.feature_type==='missed_feature', tracking=$('reviewTracking').value, identification=$('reviewIdentification').value;
      if(!missed&&identification==='not_assessed'&&tracking==='not_assessed'){status('Choose an assessment before saving.');return;}
      if(tracking!=='not_assessed'&&(!previous||!candidates.length)){status('No previous lineage match is available; leave tracking Not assessed.');return;}
      if(missed&&!$('reviewType').value.trim()){status('Enter the missed feature type.');return;}
      const record={review_id:crypto.randomUUID(),reviewed_at:new Date().toISOString(),reviewer:$('reviewerName').value.trim()||null,
        chart:copy(context),feature_id:missed?null:key(selected),feature:copy(selected),previous_chart:previous,
        proposed_previous_features:copy(candidates),identification:missed?'missed_feature':identification,tracking,
        corrected_feature_type:$('reviewType').value.trim()||null,notes:$('reviewNotes').value.trim()};
      records.push(record);
      try{localStorage.setItem(storageKey,JSON.stringify({records,reviewer:$('reviewerName').value}));storageAvailable=true;}catch{storageAvailable=false;}
      reset();status('Assessment saved.');
    };
    $('reviewDownload').onclick=()=>{
      if(!records.length){status('No saved assessments to download.');return;}
      const bundle={format:'weather-machine-human-reviews',schema_version:1,exported_at:new Date().toISOString(),source_url:contextURL,
        notes:['Independent human assessments, not automatic ground truth.','Not an exhaustive reviewed region or a replay labels file; curate into scoped evaluation labels before computing skill.','Snapshots preserve proposed matches; source chart archives should be retained separately.'],records};
      const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'})),link=document.createElement('a');
      link.href=url;link.download='weather-reviews-'+new Date().toISOString().replace(/[^0-9]/g,'')+'.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);status('Review download requested.');
    };
    status('Ready.');
    return {select,setContext(value){reset();context=value?copy(value):null;}};
  }
  globalThis.ChartReview={key,matches,create};
})();
