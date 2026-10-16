import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const elements=new Map();
function el(id){if(!elements.has(id))elements.set(id,{value:'',checked:false,textContent:'',addEventListener(type,fn){this[type]=fn;}});return elements.get(id);}
let downloaded=null,stored=null,throwStorage=false;
const overlay={clearLayers(){},addTo(){return this;}};
const context={console,Blob,crypto:{randomUUID:()=>String(Math.random())},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout(){},
 localStorage:{getItem:()=>null,setItem(_,value){if(throwStorage)throw Error('quota');stored=JSON.parse(value);}},
 document:{body:{append(){}},createElement:()=>({click(){downloaded=this.download;},remove(){}})},
 L:{layerGroup:()=>overlay,geoJSON:()=>({addTo(){}}),circleMarker:()=>({addTo(){}}),latLng:(lat,lng)=>({lat,lng})}};
vm.createContext(context);vm.runInContext(await readFile(new URL('../chart-review.js',import.meta.url),'utf8'),context);
const {key,matches,create}=context.ChartReview;
const feature={type:'Feature',geometry:{type:'Point',coordinates:[80,20]},properties:{feature_type:'low',feature_id:'current',track_id:'track',previous_feature_id:'old'}};
const old={...feature,properties:{feature_type:'low',feature_id:'old',track_id:'track'}};
assert.equal(key(feature),'current');assert.equal(matches(feature,{features:[old]}).length,1);
assert.equal(matches(feature,{features:[{...old,properties:{feature_type:'ridge',track_id:'track'}}]}).length,0);
assert.equal(matches({...feature,properties:{feature_type:'low'}},{features:[old]}).length,0);
let click;
const panel={querySelector:selector=>el(selector.slice(1))},map={getCenter:()=>({lng:80}),on(_,fn){click=fn;}};
const api=create({map,panel,read:async()=>({properties:{version:4},features:[old]}),contextURL:'http://local/wafs.html'});
api.setContext({kind:'surface',valid_time:'2026-10-16T03:00:00Z',previous:{valid_time:'2026-10-16T00:00:00Z',file:'previous'}});
el('reviewEnabled').checked=true;
await api.select(feature);el('reviewIdentification').value='correct';el('reviewTracking').value='same_feature';el('reviewSave').onclick();
assert.equal(stored.records.length,1);assert.equal(stored.records[0].previous_chart.valid_time,'2026-10-16T00:00:00Z');
assert.equal(stored.records[0].proposed_previous_features[0].properties.feature_id,'old');
assert.equal(feature.properties.review_id,undefined,'automated feature must remain unmodified');
el('reviewPoint').onclick();click({latlng:{lng:185,lat:22}});el('reviewType').value='trough';el('reviewSave').onclick();
assert.equal(stored.records[1].identification,'missed_feature');assert.equal(stored.records[1].feature.geometry.coordinates[0],-175);
el('reviewLine').onclick();click({latlng:{lng:179,lat:20}});click({latlng:{lng:-179,lat:21}});el('reviewFinish').onclick();el('reviewType').value='front';el('reviewSave').onclick();
assert.equal(stored.records[2].feature.geometry.coordinates[1][0],181);
el('reviewDownload').onclick();assert.match(downloaded,/weather-reviews-.*\.json/);
// Legacy/no-lineage charts must not accept an invented temporal match.
api.setContext({valid_time:'2026-10-16T03:00:00Z'});await api.select(feature);el('reviewTracking').value='same_feature';el('reviewSave').onclick();
assert.match(el('reviewStatus').textContent,/No previous lineage match/);assert.equal(stored.records.length,3);
el('reviewTracking').value='not_assessed';el('reviewIdentification').value='wrong_type';throwStorage=true;el('reviewSave').onclick();
assert.match(el('reviewStatus').textContent,/storage unavailable/);el('reviewDownload').onclick();assert.ok(downloaded);
// A late previous-chart response must not leak into a different chart selection.
let resolve;
const second=create({map,panel,read:()=>new Promise(r=>{resolve=r;}),contextURL:'local'});el('reviewEnabled').checked=true;
second.setContext({valid_time:'old',previous:{file:'old',valid_time:'previous'}});
const pending=second.select(feature);second.setContext({valid_time:'new'});resolve({features:[old]});await pending;
assert.equal(el('reviewSelection').textContent,'No feature selected.');
// Use the tracker's comparison timestamp, not simply the nearest prior chart.
let requested;
const third=create({map,panel,read:async file=>{requested=file;return {features:[old]};},contextURL:'local'});
el('reviewEnabled').checked=true;
third.setContext({valid_time:'2026-10-16T06:00:00Z',previous:{valid_time:'2026-10-16T03:00:00Z',file:'nearest'},
 previous_charts:[{valid_time:'2026-10-16T00:00:00Z',file:'actual'}]});
await third.select({...feature,properties:{...feature.properties,previous_time:'2026-10-16T00:00:00Z'}});
assert.equal(requested,'actual');
console.log('Review matching, snapshots, missed geometry, storage failure, download and stale-response tests passed.');
