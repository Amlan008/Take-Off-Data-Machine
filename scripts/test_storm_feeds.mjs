import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../storms.js',import.meta.url),'utf8');
const context=vm.createContext({});
for(const name of ['utc','basin','jtwc']){
  vm.runInContext(source.split('\n').find(line=>line.startsWith(`function ${name}(`)),context);
}
vm.runInContext(source.split('\n').find(line=>line.startsWith('const num=')),context);
vm.runInContext(source.slice(source.indexOf('function stormFeedWarnings('),source.indexOf('async function load(){')),context);
assert.equal(vm.runInContext("utc('invalid')",context),'Not supplied');
assert.equal(vm.runInContext("utc('')",context),'Not supplied');
assert.equal(vm.runInContext('utc(null)',context),'Not supplied');
assert.match(vm.runInContext("utc('2026-11-16T00:00:00Z')",context),/16 Nov 2026/);
assert.equal(vm.runInContext("basin({position:{lat:-12,lon:170}})",context),'South Pacific Ocean');
assert.equal(vm.runInContext("basin({position:{lat:-12,lon:80}})",context),'South Indian Ocean');
assert.equal(vm.runInContext("jtwc({systems:[{id:'sh0427web',basin:'Southern Hemisphere',position:{lat:-12,lon:170},forecast:[{lat:-13,lon:171}]}]})[0].source",context),'JTWC · Southern Hemisphere');
assert.match(vm.runInContext("stormFeedWarnings([{status:'fulfilled',value:{}},{status:'rejected'}]).join(' ')",context),/JTWC warnings unavailable/);
assert.match(vm.runInContext("stormFeedWarnings([{status:'fulfilled',value:{warnings:['SH0427 unavailable']}}]).join(' ')",context),/SH0427 unavailable/);
// Exercise the complete refresh flow with one unavailable agency and one
// available warning whose issue time is absent. It must keep the good track.
const elements=new Map();
context.$=id=>{
  if(!elements.has(id))elements.set(id,{textContent:'',classList:{remove(){},add(){},toggle(){}}});
  return elements.get(id);
};
context.state={};
context.api=async url=>{
  if(url.endsWith('/nhc'))throw Error('fixture feed unavailable');
  if(url.endsWith('/jtwc-warnings'))return{systems:[{id:'sh0427web',name:'FIXTURE',basin:'Southern Hemisphere',position:{lat:-12,lon:170},forecast:[{lat:-13,lon:171}]}]};
  return url.endsWith('/airports')?[]:{};
};
context.imdSystems=()=>[];
context.nrl=()=>[];
context.enrich=async()=>{};
context.cards=()=>{};
context.detail=system=>vm.runInContext(`utc(${JSON.stringify(system?.issued||'')})`,context);
vm.runInContext(source.split('\n').find(line=>line.startsWith('async function load(){')),context);
await vm.runInContext('load()',context);
assert.equal(context.state.systems.length,1);
assert.match(elements.get('stormPositions').textContent,/1 agency forecast points · partial data/);
assert.match(elements.get('stormNotice').textContent,/NHC \/ CPHC unavailable/);
assert.equal(elements.get('refreshStorms').disabled,false);
console.log('Storm feed frontend regressions passed');
