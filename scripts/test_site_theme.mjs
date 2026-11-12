import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../site-theme.js',import.meta.url),'utf8');
function start(storage){
 const nodes=[],events={},host={append:()=>{}},root={dataset:{},style:{}};
 const document={documentElement:root,readyState:'complete',querySelector:()=>host,createElement:tag=>{const node={tag,append:()=>{},setAttribute:()=>{},addEventListener:(type,fn)=>node[type]=fn};nodes.push(node);return node;}};
 vm.runInNewContext(source,{document,localStorage:storage,addEventListener:(type,fn)=>events[type]=fn});
 return {root,events,select:nodes.find(n=>n.tag==='select')};
}
const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
let ui=start(storage);assert.equal(ui.root.dataset.theme,'midnight');
for(const theme of ['daylight','mist','forest','sandstone','midnight']){
 ui.select.value=theme;ui.select.change();assert.equal(ui.root.dataset.theme,theme);
 assert.equal(start(storage).root.dataset.theme,theme,'Theme survives navigation/reinitialization');
 assert.equal(ui.root.style.colorScheme,['daylight','mist','sandstone'].includes(theme)?'light':'dark');
}
ui.events.storage({key:'weather-machine-theme',newValue:'forest'});assert.equal(ui.select.value,'forest');
ui.events.storage({key:'weather-machine-theme',newValue:'invalid'});assert.equal(ui.root.dataset.theme,'midnight');
values.set('weather-machine-theme','unexpected');assert.equal(start(storage).root.dataset.theme,'midnight');
ui=start({getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}});ui.select.value='mist';ui.select.change();assert.equal(ui.root.dataset.theme,'mist');
console.log('Five theme choices, navigation persistence, cross-tab updates, invalid preference and unavailable storage passed.');
