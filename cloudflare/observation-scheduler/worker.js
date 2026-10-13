// Dedicated chart scheduler; never place the GitHub credential in website code.
export async function dispatchCycle(timestamp, env, request = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!env.GITHUB_ACTIONS_TOKEN) throw new Error('Missing GITHUB_ACTIONS_TOKEN secret');
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid scheduled time');
  date.setUTCHours(date.getUTCHours() < 12 ? 0 : 12, 0, 0, 0);
  const cycle = date.toISOString().slice(0, 16);
  const endpoint = 'https://api.github.com/repos/Amlan008/Take-Off-Data-Machine/actions/workflows/gfs-hazards.yml/dispatches';
  for (let attempt = 0; attempt < 3; attempt++) {
    let status;
    try {
      const response = await request(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + env.GITHUB_ACTIONS_TOKEN,
          Accept: 'application/vnd.github+json', 'User-Agent': 'WeatherMachine-ChartScheduler',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { observation_time: cycle } }),
      });
      status = response.status;
      if (status === 204) { console.info('Chart dispatch accepted', cycle); return { accepted: true, cycle }; }
    } catch {
      // A timeout can be ambiguous: retry may create a duplicate build.
      // Workflow concurrency serializes publication; this isn't exactly-once delivery.
      status = 0;
    }
    if (![0, 429, 500, 502, 503, 504].includes(status)) throw new Error('GitHub dispatch rejected: HTTP ' + status);
    if (attempt < 2) await pause(2000 * (attempt + 1));
  }
  throw new Error('GitHub dispatch was not confirmed after three attempts; check Worker logs and Actions');
}

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 });
    return Response.json({ service: 'Observation chart scheduler', schedule_utc: ['00:30', '12:30'] });
  },
  async scheduled(event, env) { await dispatchCycle(event.scheduledTime, env); },
};
