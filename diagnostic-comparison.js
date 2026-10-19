/* Pure comparison controls; no network or persistent state. */
(() => {
  function engine(kind,requested){return kind==='surface'&&requested==='v5'?'v5':'v4';}
  function file(kind,level,requested){
    if(!['surface','upper'].includes(kind))throw Error('Invalid chart kind');
    if(kind==='upper'&&![925,850,800,700,600,500,400,300,250,200,150,100].includes(Number(level)))throw Error('Invalid level');
    return (kind==='upper'?level+'-':'')+(engine(kind,requested)==='v5'?'features-v5.geojson':'features.geojson');
  }
  function visible(feature,requested,includeProvisional){return requested!=='v5'||includeProvisional||feature.properties.support_tier==='supported_candidate';}
  globalThis.DiagnosticComparison={engine,file,visible};
})();
