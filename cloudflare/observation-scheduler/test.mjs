import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
const { dispatchCycle, default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const env = { GITHUB_ACTIONS_TOKEN: 'dummy-test-only' };
let requests = [];
const accepted = async (url, options) => {
  assert.equal(options.redirect, 'manual', 'Worker fetch must not use unsupported error mode or follow credential-bearing redirects');
  requests.push({url, options}); return {status:204};
};
assert.equal((await dispatchCycle(Date.parse('2026-10-13T00:30Z'), env, accepted)).cycle, '2026-10-13T00:00');
assert.equal((await dispatchCycle(Date.parse('2026-10-13T12:30Z'), env, accepted)).cycle, '2026-10-13T12:00');
assert.deepEqual(JSON.parse(requests[0].options.body), {ref:'main',inputs:{observation_time:'2026-10-13T00:00'}});
for(let hour=0;hour<24;hour+=3) {
  const timestamp='2026-10-15T'+String(hour).padStart(2,'0')+':30Z';
  const expected='2026-10-15T'+String(hour).padStart(2,'0')+':00';
  assert.equal((await dispatchCycle(Date.parse(timestamp),env,accepted)).cycle,expected);
  assert.equal(JSON.parse(requests.at(-1).options.body).inputs.observation_time,expected);
}
assert.equal((await dispatchCycle(Date.parse('2026-10-14T23:58Z'),env,accepted)).cycle,'2026-10-14T21:00');
await assert.rejects(dispatchCycle('invalid',env,accepted),/Invalid scheduled time/);
let count = 0;
await dispatchCycle(Date.parse('2026-10-13T12:30Z'), env, async () => ({status: ++count === 1 ? 503 : 204}), async () => {});
assert.equal(count, 2);
count = 0;
await assert.rejects(dispatchCycle(Date.now(), env, async () => {count++; return {status:401};}), /401/);
assert.equal(count, 1);
count = 0;
await assert.rejects(dispatchCycle(Date.now(), env, async (url,options) => {
  assert.equal(options.redirect,'manual'); count++; return {status:302};
}), /302/);
assert.equal(count,1,'Redirects must fail without retry or a second fetch to another host');
count = 0;
await assert.rejects(dispatchCycle(Date.now(), env, async () => {count++; return {status:503};}, async () => {}), /three attempts/);
assert.equal(count, 3);
count = 0;
await dispatchCycle(Date.now(), env, async () => ({status:200}), async () => {});
await assert.rejects(dispatchCycle(Date.now(), env, async () => {
  count++; throw new TypeError('Network failure ' + env.GITHUB_ACTIONS_TOKEN);
}, async () => {}), (error) => error.message.includes('TypeError') && error.message.includes('[redacted]') && !error.message.includes(env.GITHUB_ACTIONS_TOKEN));
assert.equal(count, 3);
await assert.rejects(dispatchCycle(Date.now(), {}, accepted), /Missing/);
assert.equal((await worker.fetch(new Request('https://example.test/run'))).status, 404);
assert.equal((await worker.fetch(new Request('https://example.test/health'))).status, 200);
const health = await (await worker.fetch(new Request('https://example.test/health'),env)).json();
assert.equal(health.version,'scheduler-v4');
assert.equal(health.schedule_utc.length,8);
assert.equal(health.surface_interval_hours,3);
assert.deepEqual(health.upper_observation_hours_utc,[0,12]);
assert.equal(health.credential_present,true);
assert.ok(!JSON.stringify(health).includes(env.GITHUB_ACTIONS_TOKEN));
console.log('Scheduler tests passed (mock HTTP only; no real dispatch).');
