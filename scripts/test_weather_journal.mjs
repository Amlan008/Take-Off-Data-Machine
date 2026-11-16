import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const context={Date,Intl,URLSearchParams,AbortController,setTimeout,clearTimeout};vm.createContext(context);
vm.runInContext(await readFile(new URL('../weather-journal.js',import.meta.url),'utf8'),context);
const api=context.WeatherJournal,epoch=Date.parse('2026-11-13T12:00:00Z')/1000;
const base={timezone:'Asia/Kolkata',current:{time:epoch,temperature_2m:28,weather_code:2,is_day:1,precipitation:0,wind_gusts_10m:15},hourly:{time:[epoch,epoch+3600,epoch+7200],weather_code:[2,2,2],precipitation:[0,0,0],wind_gusts_10m:[15,15,15]},daily:{time:[epoch]}};
const clone=()=>structuredClone(base);
assert.equal(api.period(epoch,'Asia/Kolkata'),'this evening');
assert.equal(api.period(epoch,'America/New_York'),'this morning');
assert.equal(api.message(base).lines[1],'A gentler evening.');
let d=clone();d.hourly.weather_code[1]=95;assert.equal(api.message(d).image,'clouds');assert.match(api.message(d).lines[0],/Thunderstorms/);
d=clone();d.current.weather_code=65;assert.match(api.message(d).lines[0],/Heavy rain/);
d=clone();d.current.weather_code=75;assert.equal(api.message(d).image,'snow');
d=clone();d.current.weather_code=45;assert.equal(api.message(d).image,'fog');
d=clone();d.current.is_day=0;d.current.weather_code=0;assert.equal(api.message(d).image,'night');
d=clone();d.current.is_day=0;d.hourly.weather_code[2]=99;assert.equal(api.message(d).image,'night');
d=clone();d.current.wind_gusts_10m=65;assert.match(api.message(d).lines[0],/windy/);
assert.equal(api.locationValid({latitude:91,longitude:0,name:'Invalid'}),false);
assert.throws(()=>api.validate({}));
// Day selection uses the location's calendar date, not the browser timezone or
// a rolling UTC interval. It must also retain overnight hazards.
const midnight=Date.parse('2026-11-12T18:30:00Z')/1000;
const times=Array.from({length:120},(_,i)=>midnight+i*3600);
const fiveDays={timezone:'Asia/Kolkata',current:{...base.current,time:midnight+17.25*3600},daily:{time:Array.from({length:5},(_,i)=>midnight+i*86400),weather_code:[2,2,0,3,61],temperature_2m_max:[29,30,31,28,26],temperature_2m_min:[22,21,23,22,21],precipitation_probability_max:[10,20,0,25,70]},hourly:{time:times,temperature_2m:times.map(()=>25),relative_humidity_2m:times.map(()=>65),weather_code:times.map(()=>2),is_day:times.map((_,i)=>i%24>=6&&i%24<18?1:0),precipitation:times.map(()=>0),wind_gusts_10m:times.map(()=>15),precipitation_probability:times.map(()=>10)}};
const rolling=api.hourlyRows(fiveDays);assert.equal(rolling.length,24);
assert.equal(rolling[0].time,midnight+18*3600);assert.equal(rolling.at(-1).time-rolling[0].time,23*3600);
const saturday=api.dayForecast(fiveDays,1);assert.equal(saturday.rows.length,24);assert.equal(saturday.rows[0].time,midnight+86400);assert.equal(saturday.rows.at(-1).time,midnight+86400+23*3600);
assert.equal(saturday.heading,'Forecast of Saturday, 14th November');assert.equal(saturday.high,30);assert.equal(saturday.low,21);assert.equal(saturday.copy.image,'clouds');
const sunday=api.dayForecast(fiveDays,2);assert.equal(sunday.copy.image,'clouds');assert.equal(sunday.rows.length,24);
const overnight=structuredClone(fiveDays);overnight.hourly.weather_code[25]=95;assert.match(api.dayForecast(overnight,1).copy.advice,/Thunderstorms overnight, around 1:00 am/);assert.equal(api.dayForecast(overnight,1).copy.image,'clouds');
assert.throws(()=>api.dayForecast(fiveDays,6),/unavailable/);
for(const [day,suffix] of [[1,'1st'],[2,'2nd'],[3,'3rd'],[11,'11th'],[12,'12th'],[13,'13th'],[21,'21st'],[22,'22nd'],[23,'23rd']])assert.ok(api.forecastHeading(Date.UTC(2026,10,day,12)/1000,'UTC').includes(suffix));
const dstStart=Date.parse('2026-03-07T05:00:00Z')/1000,dstTimes=Array.from({length:72},(_,i)=>dstStart+i*3600);
const dst={timezone:'America/New_York',current:{time:dstStart},daily:{time:[dstStart,dstStart+86400]},hourly:{time:dstTimes}};
assert.equal(api.hourlyRows(dst,1).length,23,'Spring-forward date has 23 real hours, without invented samples');
let clock=1000000,calls=0;const saved=new Map(),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
const p={latitude:22.57,longitude:88.36,name:'Kolkata'};
const loader=api.createLoader({storage,now:()=>clock,request:async url=>{calls++;const u=new URL(url);assert.equal(u.searchParams.get('timezone'),'auto');assert.equal(u.searchParams.get('forecast_days'),'5');assert.ok(u.searchParams.get('current'));assert.ok(u.searchParams.get('hourly'));assert.ok(u.searchParams.get('daily'));for(const field of ['sunrise','sunset','uv_index_max','precipitation_sum'])assert.ok(u.searchParams.get('daily').split(',').includes(field));for(const field of ['apparent_temperature','wind_speed_10m','wind_direction_10m'])assert.ok(u.searchParams.get('hourly').split(',').includes(field));await Promise.resolve();return {ok:true,json:async()=>base};}});
await Promise.all([loader.load(p),loader.load(p)]);assert.equal(calls,1,'Concurrent loads must share one request');
assert.equal((await loader.load(p)).cached,true);assert.equal(calls,1);
clock+=api.TTL+1;await loader.load(p);assert.equal(calls,2,'Expired cache is refreshed');
await loader.load({...p,longitude:88.4});assert.equal(calls,3,'A new location needs its own request');
let rejectedCalls=0;const busy=api.createLoader({now:()=>clock,request:async()=>{rejectedCalls++;return {ok:false,status:429,headers:{get:()=> '120'}};}});
await assert.rejects(busy.load(p),/busy/);await assert.rejects(busy.load(p),/busy/);assert.equal(rejectedCalls,1,'Respect rate-limit cooldown without retry storms');
const noStorage=api.createLoader({storage:{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}},request:async()=>({ok:true,json:async()=>base})});await noStorage.load(p);assert.equal((await noStorage.load(p)).cached,true,'Memory cache survives blocked browser storage');
console.log('One-hour rolling/day windows, local dates, ordinals, DST, overnight hazards, day imagery, cache, deduplication, cooldown and unavailable storage passed.');

// A brief daytime shower does not override the predominant daytime sky.
const brief=structuredClone(fiveDays);brief.hourly.weather_code[40]=61;
assert.equal(api.dayForecast(brief,1).condition.type,'clouds');
assert.match(api.dayForecast(brief,1).copy.advice,/Showers.*4:00 pm/);
const coldNight=structuredClone(fiveDays);coldNight.daily.temperature_2m_min[1]=2;
assert.match(api.dayForecast(coldNight,1).copy.advice,/cold night/);
assert.equal(api.sceneFor(fiveDays,{name:'Kolkata, India'},saturday).name,'girl-outdoor-warm');
const wet=structuredClone(fiveDays);wet.current.weather_code=61;wet.current.temperature_2m=30;
assert.equal(api.sceneFor(wet,{name:'Kolkata, India'},null).name,'girl-warm-rain');
wet.current.temperature_2m=10;assert.equal(api.sceneFor(wet,{name:'London'},null).name,'girl-cool-rain');
wet.current.weather_code=75;assert.equal(api.sceneFor(wet,{name:'London'},null).name,'girl-snow');
wet.current.weather_code=0;wet.current.is_day=0;assert.equal(api.sceneFor(wet,{name:'London'},null).name,'girl-cold-night');
assert.equal(api.sceneFor(fiveDays,{name:'Sydney'},saturday).cityMatched,false);
clock+=api.TTL+1;assert.ok(loader.cached({...p,longitude:88.4},true),'Expired data remains available for a labelled fallback');
assert.equal(loader.cached({...p,longitude:88.4}),null);
console.log('Timed transitions, brief showers, overnight hazards, cold nights, clothing, regional labels and stale fallback passed.');

const sameWeather=structuredClone(fiveDays);sameWeather.current.temperature_2m=21;sameWeather.current.is_day=1;
assert.equal(api.sceneFor(sameWeather,{latitude:22.57,name:'Kolkata'},null).name,'girl-outdoor-warm');
assert.equal(api.sceneFor(sameWeather,{latitude:51.5,name:'London'},null).name,'girl-outdoor-cool');
const mixed=structuredClone(fiveDays);mixed.hourly.weather_code[24]=61;mixed.hourly.weather_code[34]=61;
const mixedCopy=api.dayForecast(mixed,1).copy.advice;assert.match(mixedCopy,/10:00 am/);assert.match(mixedCopy,/overnight/);
const permanentFailure=api.createLoader({storage,now:()=>clock,request:async()=>{throw Error('offline');}});
await assert.rejects(permanentFailure.load({...p,longitude:88.4}),/offline/);assert.ok(permanentFailure.cached({...p,longitude:88.4},true),'Network failure must not discard the retained forecast');

// A sunny icon alone must not put the character outside in uncomfortable weather.
const walk=structuredClone(fiveDays);walk.current={...walk.current,time:times[12],temperature_2m:24,weather_code:0,is_day:1,precipitation:0,wind_gusts_10m:12};
const here={latitude:51.5,name:'London'};
assert.equal(api.sceneFor(walk,here,null).name,'girl-outdoor-cool');
assert.equal(api.sceneFor(walk,here,null).breezy,true);
for(const temperature of [7,33,40]){const v=structuredClone(walk);v.current.temperature_2m=temperature;assert.equal(api.sceneFor(v,here,null).outdoors,false);}
const gusty=structuredClone(walk);gusty.hourly.wind_gusts_10m[13]=40;assert.equal(api.sceneFor(gusty,here,null).outdoors,false);
const stormSoon=structuredClone(walk);stormSoon.hourly.weather_code[13]=95;assert.equal(api.sceneFor(stormSoon,here,null).outdoors,false);
const wetSoon=structuredClone(walk);wetSoon.hourly.precipitation[13]=1;assert.equal(api.sceneFor(wetSoon,here,null).outdoors,false);
const flurries=structuredClone(walk);flurries.current.temperature_2m=1;flurries.current.weather_code=71;flurries.current.precipitation=.1;flurries.hourly.temperature_2m.fill(1);flurries.hourly.weather_code.fill(71);flurries.hourly.precipitation.fill(.2);
assert.equal(api.sceneFor(flurries,here,null).name,'girl-outdoor-snow');
flurries.current.weather_code=75;assert.equal(api.sceneFor(flurries,here,null).name,'girl-snow');
flurries.current.weather_code=71;flurries.current.wind_gusts_10m=25;assert.equal(api.sceneFor(flurries,here,null).name,'girl-snow');
flurries.current.wind_gusts_10m=12;flurries.current.is_day=0;assert.equal(api.sceneFor(flurries,here,null).outdoors,false);
const pleasantDay=structuredClone(fiveDays);pleasantDay.hourly.wind_gusts_10m[25]=70;assert.equal(api.sceneFor(pleasantDay,here,api.dayForecast(pleasantDay,1)).outdoors,true,'An overnight gust does not describe the midday scene');
pleasantDay.hourly.weather_code[36]=95;assert.equal(api.sceneFor(pleasantDay,here,api.dayForecast(pleasantDay,1)).outdoors,false,'A midday storm keeps the daytime scene sheltered');
console.log('Outdoor comfort windows, imminent weather, heavy/light snow and day/night scene selection passed.');

const humidHeat=structuredClone(walk);humidHeat.current.apparent_temperature=40;assert.equal(api.sceneFor(humidHeat,here,null).outdoors,false);
const noGusts=structuredClone(walk);delete noGusts.current.wind_gusts_10m;delete noGusts.hourly.wind_gusts_10m;assert.equal(api.sceneFor(noGusts,here,null).outdoors,false);
