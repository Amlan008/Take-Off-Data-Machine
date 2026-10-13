import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const elements=new Map();
const document={getElementById(id){if(!elements.has(id))elements.set(id,{addEventListener(){}});return elements.get(id);}};
const context={document,window:{},console};vm.createContext(context);
vm.runInContext(await readFile(new URL('../sounding-plot.js',import.meta.url),'utf8'),context);
const plot=context.window.SoundingPlot;
assert.ok(plot.y(100)<plot.y(1000));
assert.ok(plot.x(0,500)>plot.x(0,1000));
assert.ok(plot.x(10,1000)>plot.x(0,1000));
const moist=plot.moist(20);
assert.ok(moist.at(-1)[1]<moist[0][1]);
assert.ok(moist.every(pair=>pair.every(Number.isFinite)));
const profile={station:'<script>unsafe</script>',levels:[
  {level_hpa:1000,temperature_c:25,dewpoint_c:20,wind_kt:10,wind_from_deg:270},
  {level_hpa:850,temperature_c:10,dewpoint_c:null,wind_kt:30,wind_from_deg:280},
  {level_hpa:700,temperature_c:0,dewpoint_c:-5,wind_kt:55,wind_from_deg:290}]};
const svg=plot.render(profile);
assert.ok(!svg.includes('<script>'));
assert.ok(svg.includes('&lt;script&gt;'));
assert.ok(!svg.includes('NaN'));
assert.ok(svg.includes('clipPath'));
assert.ok(svg.includes('logarithmic'));
assert.ok(svg.includes('stroke="#c62828"'));
assert.ok(svg.includes('stroke="#087f4b"'));
console.log('Sounding geometry, moist reference curves, missing values and escaping checks passed.');
