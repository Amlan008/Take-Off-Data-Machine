import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Verify responsive controls stay usable and expose their real expanded state.
const script=await readFile(new URL('../observation-workspace.js',import.meta.url),'utf8');
for(const narrow of [false,true]){
  const classes=new Set(),events={},attributes={};
  const toggle={setAttribute:(key,value)=>attributes[key]=value,addEventListener:(type,fn)=>events[type]=fn,focus:()=>events.focused=true};
  const stage={classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name),contains:name=>classes.has(name)},addEventListener:(type,fn)=>events[type]=fn};
  const media={matches:narrow,addEventListener:(_,fn)=>events.breakpoint=fn};
  const review={textContent:''};
  const document={getElementById:id=>id==='chartStage'?stage:toggle,querySelector:selector=>selector.includes('summary')?review:null};
  vm.runInNewContext(script,{document,matchMedia:()=>media});
  assert.equal(classes.has('controls-hidden'),narrow);
  assert.equal(attributes['aria-expanded'],String(!narrow));
  events.click();assert.equal(classes.has('controls-hidden'),!narrow);
  assert.equal(attributes['aria-expanded'],String(narrow));
  media.matches=true;events.breakpoint();assert.equal(attributes['aria-expanded'],'false');
  events.click();events.keydown({key:'Escape'});assert.equal(attributes['aria-expanded'],'false');assert.equal(events.focused,true);
  assert.equal(review.textContent,'03 / Feature review');
}
const html=await readFile(new URL('../wafs.html',import.meta.url),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
assert.equal(new Set(ids).size,ids.length,'HTML IDs must remain unique');
for(const id of ['chartKind','chartField','chartLevel','showDiagnostics','featureOptions','chartReview','chartTime','chartSlider','chartDownload','openSoundings','shadeTransparency','chartRefresh','chartFullscreen'])assert.ok(ids.includes(id),id+' retained');
assert.ok(html.includes('aria-controls="chartControls"'));
assert.ok(html.includes('No upstream weather API calls.'));
assert.ok(html.includes('not official advisories'));
assert.ok(html.includes('University of Wyoming radiosondes'));
console.log('Responsive sidebar state, Escape focus return, review title and retained chart controls passed.');
