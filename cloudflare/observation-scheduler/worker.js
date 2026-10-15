// Dedicated chart scheduler; never place the GitHub credential in website code.
export async function dispatchCycle(timestamp, env, request = (url, options) => fetch(url, options), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!env.GITHUB_ACTIONS_TOKEN) throw new Error('Missing GITHUB_ACTIONS_TOKEN secret');
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid scheduled time');
  // Use the scheduled event time, not wall-clock dispatch time, so delays
  // cannot silently switch a run to a newer observation cycle.
  date.setUTCHours(Math.floor(date.getUTCHours() / 3) * 3, 0, 0, 0);
  const cycle = date.toISOString().slice(0, 16);
  const endpoint = 'https://api.github.com/repos/Amlan008/Take-Off-Data-Machine/actions/workflows/gfs-hazards.yml/dispatches';
  let lastFailure = 'unknown';
  const safe = (value) => String(value || '').split(String(env.GITHUB_ACTIONS_TOKEN)).join('[redacted]').slice(0, 300);
  for (let attempt = 0; attempt < 3; attempt++) {
    let status;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await request(endpoint, {
        // Some deployed Workers runtimes reject redirect: 'error'. Manual
        // returns redirects without following them or forwarding Authorization.
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + env.GITHUB_ACTIONS_TOKEN,
          Accept: 'application/vnd.github+json', 'User-Agent': 'WeatherMachine-ChartScheduler',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { observation_time: cycle } }),
      });
      status = response.status;
      // New API versions may return 200 + run information; older ones return 204.
      if (status === 200 || status === 204) { console.info('Chart dispatch accepted', cycle); return { accepted: true, cycle }; }
      lastFailure = 'HTTP ' + status;
      console.error('GitHub dispatch attempt failed', JSON.stringify({ attempt: attempt + 1, cycle, status,
        request_id: response.headers?.get('x-github-request-id') || null,
        retry_after: response.headers?.get('retry-after') || null }));
    } catch (error) {
      // A timeout can be ambiguous: retry may create a duplicate build.
      // Workflow concurrency serializes publication; this isn't exactly-once delivery.
      status = 0;
      lastFailure = safe(error?.name) + ': ' + safe(error?.message);
      console.error('GitHub dispatch request exception', JSON.stringify({ attempt: attempt + 1, cycle, error: lastFailure }));
    } finally {
      clearTimeout(timer);
    }
    if (![0, 429, 500, 502, 503, 504].includes(status)) throw new Error('GitHub dispatch rejected: HTTP ' + status);
    if (attempt < 2) await pause(2000 * (attempt + 1));
  }
  throw new Error('GitHub dispatch was not confirmed after three attempts. Last failure: ' + lastFailure);
}

export default {
  async fetch(request, env = {}) {
    if (new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 });
    return Response.json({ service: 'Observation chart scheduler', version: 'scheduler-v4',
      schedule_utc: ['00:30', '03:30', '06:30', '09:30', '12:30', '15:30', '18:30', '21:30'],
      surface_interval_hours: 3, upper_observation_hours_utc: [0, 12], credential_present: Boolean(env.GITHUB_ACTIONS_TOKEN),
      note: 'Health response does not test cron execution or GitHub authentication' });
  },
  async scheduled(event, env) {
    console.info('Scheduled invocation started', JSON.stringify({ cron: event.cron, scheduled_time: new Date(event.scheduledTime).toISOString(), version: 'scheduler-v4' }));
    await dispatchCycle(event.scheduledTime, env);
  },
};
