import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const css=await readFile(new URL('../site-themes.css',import.meta.url),'utf8');
const defaults={},themes={};
for(const match of css.matchAll(/:root(?:\[data-theme=(\w+)\])?\{([^{}]+)\}/g)){
 const target=match[1]?(themes[match[1]]??={}):defaults;
 for(const declaration of match[2].matchAll(/(--site-[\w-]+):\s*(#[a-f\d]{3,8})/gi))target[declaration[1]]=declaration[2];
}
function luminance(hex){let s=hex.slice(1);if(s.length===3)s=[...s].map(x=>x+x).join('');const rgb=[0,2,4].map(i=>parseInt(s.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
let checked=0;
for(const theme of ['midnight','daylight','mist','forest','sandstone']){
 const palette={...defaults,...themes[theme]};
 function pair(fg,bg,min=4.5){assert.ok(palette[fg]&&palette[bg],`${theme} is missing ${fg} or ${bg}`);const ratio=contrast(palette[fg],palette[bg]);assert.ok(ratio>=min,`${theme} ${fg} on ${bg}: ${ratio.toFixed(2)} is below ${min}`);checked++;}
 for(const surface of ['--site-bg','--site-panel','--site-input','--site-hover','--site-selected'])pair('--site-text',surface);
 for(const surface of ['--site-bg','--site-panel','--site-input','--site-hover'])pair('--site-muted',surface);
 pair('--site-on-accent','--site-accent');pair('--site-error','--site-panel');pair('--site-error','--site-error-bg');pair('--site-warning','--site-panel');pair('--site-positive','--site-panel');pair('--site-disabled-text','--site-disabled-bg',3);
}
for(const category of ['concern','bad','severe']){
 const rule=css.match(new RegExp('\\.category-filter\\.active\\.'+category+'\\{([^}]+)\\}','g')).at(-1);
 const background=rule.match(/background:(#[a-f\d]+)/i)[1],foreground=rule.match(/(?:^|;)color:(#[a-f\d]+)/i)[1];
 assert.ok(contrast(foreground,background)>=4.5,`${category} active label needs normal-text contrast`);checked++;
}
console.log(`${checked} palette and category-label contrast combinations passed.`);
