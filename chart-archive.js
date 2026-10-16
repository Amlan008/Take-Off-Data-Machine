/* Published observation packages, not screenshots or original upstream bulletins. */
(() => {
  function plan(manifest,selection,includeGeometry=false) {
    const files=[],snapshots=[];
    const add=(path,required)=>files.push({path,required});
    for(const kind of ['surface','upper'])for(const entry of manifest[kind]||[]) {
      if(selection&&(selection.kind!==kind||selection.path!==entry.path))continue;
      if(!/^\d{10}$/.test(entry.path))throw Error('Invalid chart path.');
      snapshots.push({kind,...entry});const base=kind+'/'+entry.path+'/';add(base+'metadata.json',true);
      if(kind==='surface') {
        add(base+'observations.geojson',true);add(base+'features.geojson',false);
        if(includeGeometry)for(const name of ['pressure','pressure-shading','temperature','temperature-shading'])add(base+name+'.geojson',true);
      } else {
        add(base+'soundings.json',false);
        for(const level of manifest.levels_hpa||[]) {
          if(![925,850,800,700,600,500,400,300,250,200,150,100].includes(level))throw Error('Invalid pressure level.');
          add(base+level+'-observations.geojson',true);add(base+level+'-features.geojson',false);
          if(includeGeometry)for(const name of ['height','temperature','temperature-shading'])add(base+level+'-'+name+'.geojson',true);
        }
      }
    }
    if(!snapshots.length)throw Error('No chart selected or published.');
    return {files,snapshots};
  }
  async function collect(manifest,options) {
    manifest=JSON.parse(JSON.stringify(manifest));
    const planned=plan(manifest,options.selection,options.includeGeometry);
    const files={},missing=[];let cursor=0,done=0,failure=null;
    await Promise.all(Array.from({length:Math.min(3,planned.files.length)},async()=>{
      while(!failure&&cursor<planned.files.length) {
        const file=planned.files[cursor++];
        try {files[file.path]=await options.read(file.path);}
        catch(error) {
          if(file.required){failure=Error('Archive incomplete: '+file.path+' unavailable. Refresh and retry.');break;}
          missing.push({path:file.path,reason:String(error.message||error)});
        }
        if(!failure)options.progress?.(++done,planned.files.length);
      }
    }));
    if(failure)throw failure;
    for(const snapshot of planned.snapshots) {
      const meta=files[snapshot.kind+'/'+snapshot.path+'/metadata.json'];
      if(meta.valid_time!==snapshot.valid_time||meta.published_at!==snapshot.published_at)throw Error('Publication changed while downloading. Refresh and retry.');
    }
    return {format:'weather-machine-research-archive',schema_version:1,exported_at:new Date().toISOString(),
      source_url:options.sourceURL||null,selection:options.selection||'all_available_history',manifest,
      snapshots:planned.snapshots,files,missing_optional_files:missing,
      notes:['Decoded observations, not original BUFR/NetCDF bulletins.',
        'Available rolling history only; gaps/older retained cycles are possible.',
        options.includeGeometry?'Includes chart geometry; excludes map tiles/fonts.':'Contours/shading omitted; observations and diagnostics retained.',
        'Selected-chart exports may lack previous-cycle/upper-air context. All-history is recommended.',
        'No expert labels implied. Preserve builder commit, configuration and dependencies for reproducible reruns.']};
  }
  async function encode(archive) {
    let blob=new Blob([JSON.stringify(archive)],{type:'application/json'}),extension='.json';
    if(typeof CompressionStream==='function') {blob=await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();extension='.json.gz';}
    return {blob,extension};
  }
  globalThis.ChartArchive={plan,collect,encode};
})();
