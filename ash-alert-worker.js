// Weather Machine — Volcanic Ash Alerts Global
// Bind ALERT_STATE (Workers KV), and set TELEGRAM_BOT_TOKEN plus
// TELEGRAM_WEBHOOK_SECRET as Worker secrets. ALERT_GATE is optional.

const FEED_URL = 'https://www.bom.gov.au/products/Volc_ash_latest.shtml';
const WATCHED_AIRPORTS = [
  ['GDX', 59.9110, 150.7200], ['DYR', 64.7349, 177.7410], ['PKC', 53.1687, 158.4511], ['DUT', 53.8988, -166.5450],
  ['HND', 35.5497, 139.7870], ['NRT', 35.7686, 140.3887], ['MNL', 14.5086, 121.0200], ['DPS', -8.7484, 115.1671],
  ['SIN', 1.3502, 103.9940], ['IXZ', 11.6402, 92.7290], ['JIB', 11.5473, 43.1595], ['JED', 21.6802, 39.1574],
  ['SAH', 15.4763, 44.2197], ['FCO', 41.8045, 12.2520], ['RKV', 64.1287, -21.9376], ['KEF', 63.9850, -22.6056],
].map(([iata, lat, lon]) => ({ iata, lat, lon }));

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const escapeHtml = value => String(value ?? '').replace(/&nbsp;/gi, ' ');
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// One Durable Object per advisory issue gives the alert workflow a strongly
// consistent claim/complete sequence, including when a cron run and a manual
// test happen at the same time.
export class AlertGate {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const fingerprint = String(body.fingerprint || '');
    if (!fingerprint) return json({ ok: false, error: 'Missing fingerprint.' }, 400);
    const current = await this.ctx.storage.get('delivery');

    if (url.pathname === '/claim') {
      if (current?.fingerprint === fingerprint && current.status === 'sent') return json({ accepted: false, reason: 'already-sent' });
      if (current?.status === 'pending' && Date.now() - current.claimedAt < 5 * 60 * 1000) return json({ accepted: false, reason: 'delivery-pending' });
      await this.ctx.storage.put('delivery', { fingerprint, status: 'pending', claimedAt: Date.now() });
      return json({ accepted: true, isUpdate: current?.status === 'sent' && current.fingerprint !== fingerprint });
    }
    if (url.pathname === '/complete') {
      if (current?.fingerprint !== fingerprint) return json({ ok: false, error: 'Claim no longer current.' }, 409);
      await this.ctx.storage.put('delivery', { fingerprint, status: 'sent', deliveredAt: Date.now() });
      return json({ ok: true });
    }
    if (url.pathname === '/release') {
      if (current?.fingerprint === fingerprint && current.status === 'pending') await this.ctx.storage.delete('delivery');
      return json({ ok: true });
    }
    return json({ ok: false, error: 'Route not found.' }, 404);
  }
}

const setting = (state, key) => state.get(`setting:${key}`);
const saveSetting = (state, key, value) => state.put(`setting:${key}`, String(value));

function stripHtml(source) {
  return escapeHtml(source
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|pre|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function coordinatePoints(text) {
  const points = [];
  for (const match of text.toUpperCase().matchAll(/\b([NS])(\d{4,6})\s+([EW])(\d{5,7})\b/g)) {
    const degree = (value, digits) => {
      const d = Number(value.slice(0, digits)), rest = value.slice(digits);
      if (rest.length === 2) return d + Number(rest) / 60;
      if (rest.length === 3) return d + Number(rest) / 600;
      if (rest.length === 4) return d + Number(rest.slice(0, 2)) / 60 + Number(rest.slice(2)) / 3600;
      return null;
    };
    const lat = degree(match[2], 2), lon = degree(match[4], 3);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat <= 90 && lon <= 180) points.push({ lat: match[1] === 'S' ? -lat : lat, lon: match[3] === 'W' ? -lon : lon });
  }
  return points;
}
function flightLevelTop(text) {
  const levels = [...String(text).toUpperCase().matchAll(/\bFL(\d{3})\b/g)].map(match => Number(match[1]));
  return levels.length ? Math.max(...levels) : null;
}
function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + polygon.length - 1) % polygon.length];
    if ((a.lat > lat) !== (b.lat > lat) && lon < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
function pointToSegmentNm(lat, lon, a, b) {
  const scale = 60, cosine = Math.max(.05, Math.abs(Math.cos(lat * Math.PI / 180)));
  const point = [lon * scale * cosine, lat * scale], start = [a.lon * scale * cosine, a.lat * scale], end = [b.lon * scale * cosine, b.lat * scale];
  const dx = end[0] - start[0], dy = end[1] - start[1], length = dx * dx + dy * dy;
  const ratio = length ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length)) : 0;
  return Math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dy));
}
function distanceToPolygonNm(airport, polygon) {
  if (pointInPolygon(airport.lat, airport.lon, polygon)) return 0;
  return Math.min(...polygon.map((point, index) => pointToSegmentNm(airport.lat, airport.lon, point, polygon[(index + 1) % polygon.length])));
}
function advisoryBlocks(feed) {
  const clean = stripHtml(feed);
  const starts = [...clean.matchAll(/(?:^|\n)VA ADVISORY(?:\n|$)/g)];
  const newest = new Map();
  starts.forEach((start, index) => {
    const block = clean.slice(start.index, index + 1 < starts.length ? starts[index + 1].index : clean.length);
    const field = name => block.match(new RegExp(`(?:^|\\n)${name}:\\s*([^\\n]+)`, 'i'))?.[1]?.trim();
    const vaac = field('VAAC'), volcano = field('VOLCANO'), issued = field('DTG');
    if (!vaac || !volcano || !issued || /NXT ADVISORY:\s*(?:NO FURTHER|NIL)/i.test(block)) return;
    const observed = block.match(/(?:^|\n)(?:OBS|EST) VA CLD:\s*([\s\S]*?)(?=\nFCST VA CLD \+\d+ HR:|\nRMK:|\nNXT ADVISORY:|$)/i)?.[1];
    const forecasts = [...block.matchAll(/(?:^|\n)FCST VA CLD \+(\d+) HR:\s*([\s\S]*?)(?=\nFCST VA CLD \+\d+ HR:|\nRMK:|\nNXT ADVISORY:|$)/gi)];
    const areas = [];
    if (observed) areas.push({ kind: 'observed', lead: 0, text: compact(observed) });
    forecasts.forEach(match => areas.push({ kind: 'forecast', lead: Number(match[1]), text: compact(match[2]) }));
    const id = `${vaac.toUpperCase()}::${volcano.replace(/\s+\d{5,7}\s*$/, '').toUpperCase()}`;
    const item = { id, vaac: vaac.toUpperCase(), volcano, issued, areas, source: block };
    if (!newest.has(id) || issued > newest.get(id).issued) newest.set(id, item);
  });
  return [...newest.values()];
}
function assess(advisory) {
  const triggers = [], airportHits = [];
  advisory.areas.forEach(area => {
    const top = flightLevelTop(area.text), points = coordinatePoints(area.text), prefix = area.kind === 'observed' ? 'Observed' : `Forecast +${area.lead} h`;
    if (top !== null && top >= 270) triggers.push(`${prefix} ash top FL${top}`);
    if (points.length < 3) return;
    const threshold = area.kind === 'observed' ? 50 : 10;
    WATCHED_AIRPORTS.forEach(airport => {
      const distance = distanceToPolygonNm(airport, points);
      if (distance === 0) airportHits.push({ ...airport, kind: area.kind, lead: area.lead, state: 'inside', distance: 0 });
      else if (distance <= threshold) airportHits.push({ ...airport, kind: area.kind, lead: area.lead, state: 'near', distance: Math.round(distance) });
    });
  });
  airportHits.forEach(hit => triggers.push(`${hit.iata} ${hit.state === 'inside' ? 'inside' : `${hit.distance} NM from`} ${hit.kind === 'observed' ? 'observed' : `forecast +${hit.lead} h`} ash`));
  return { triggers, airportHits };
}
function message(advisory, result, isUpdate = false, heading = null) {
  const airportLines = result.airportHits.map(hit => `• ${hit.iata} — ${hit.state === 'inside' ? 'inside' : `${hit.distance} NM from`} ${hit.kind === 'observed' ? 'observed' : `forecast +${hit.lead} h`} polygon`);
  return [
    heading || (isUpdate ? '⚠️ VOLCANIC ASH ADVISORY UPDATED' : '⚠️ VOLCANIC ASH ALERT'),
    `VAAC: ${advisory.vaac}`,
    `Volcano: ${advisory.volcano}`,
    `Issued: ${advisory.issued}`,
    '',
    ...result.triggers.filter(item => !item.includes(' ash') || item.includes('ash top')).map(item => `• ${item}`),
    ...(airportLines.length ? ['', 'Airport impact:', ...airportLines] : []),
    '', `Official source: ${FEED_URL}`,
  ].join('\n').slice(0, 3900);
}
async function advisoryFingerprint(advisory) {
  const material = advisory.areas.map(area => `${area.kind}|${area.lead}|${compact(area.text).toUpperCase()}`).join('||');
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 20);
}
async function telegram(env, chatId, text, options = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...options }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
}
async function ensurePrimarySubscriber(state) {
  const chatId = await setting(state, 'telegram_chat_id');
  if (!chatId) return null;
  const key = `subscriber:${chatId}`;
  if (!await state.get(key)) await state.put(key, JSON.stringify({ chat_id: String(chatId), role: 'primary', added_at: new Date().toISOString() }));
  return String(chatId);
}
async function subscriberIds(state) {
  const listed = await state.list({ prefix: 'subscriber:' });
  return listed.keys.map(entry => entry.name.slice('subscriber:'.length)).filter(Boolean);
}
async function loadAdvisories() {
  const response = await fetch(FEED_URL, { headers: { 'accept': 'text/html' } });
  if (!response.ok) throw new Error(`BoM feed HTTP ${response.status}`);
  return advisoryBlocks(await response.text());
}
function statusMessage(advisories) {
  const lines = [
    '📡 CURRENT VOLCANIC ASH STATUS',
    `Active official advisories: ${advisories.length}`,
    '',
  ];
  for (const advisory of advisories) {
    const tops = advisory.areas.map(area => flightLevelTop(area.text)).filter(Number.isFinite);
    const highest = tops.length ? ` · top FL${Math.max(...tops)}` : '';
    const impacts = assess(advisory).airportHits;
    lines.push(`• ${advisory.volcano} · ${advisory.vaac}${highest}`);
    lines.push(`  issued ${advisory.issued}${impacts.length ? ` · ${impacts.map(hit => hit.iata).join(', ')}` : ''}`);
  }
  lines.push('', `Official source: ${FEED_URL}`);
  return lines.join('\n').slice(0, 3900);
}
async function sendStatus(state, env, chatId) {
  const subscribed = Boolean(await state.get(`subscriber:${chatId}`));
  const options = subscribed ? {} : { reply_markup: { inline_keyboard: [[{ text: 'Subscribe to ash alerts', callback_data: 'subscribe' }]] } };
  await telegram(env, chatId, statusMessage(await loadAdvisories()), options);
}
async function answerCallback(env, callbackId, text = 'Subscription updated') {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId, text }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram callback HTTP ${response.status}`);
}
async function recentAlertHistory(state) {
  const listed = await state.list({ prefix: 'alert-history:' });
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const records = [];
  for (const entry of listed.keys) {
    const record = await state.get(entry.name, { type: 'json' });
    if (record?.sent_at >= cutoff && record?.text) records.push(record);
  }
  return records.sort((a, b) => a.sent_at - b.sent_at);
}
async function sendRecentAlerts(state, env, chatId) {
  const records = await recentAlertHistory(state);
  for (const record of records) await telegram(env, chatId, `📌 RECENT QUALIFYING ASH ALERT (last 12 hours)\n\n${record.text}`.slice(0, 3900));
  return records.length;
}
async function subscribeChat(state, env, chat) {
  const chatId = String(chat.id);
  const key = `subscriber:${chatId}`;
  const alreadySubscribed = Boolean(await state.get(key));
  if (!alreadySubscribed) await state.put(key, JSON.stringify({ chat_id: chatId, username: chat.username || null, name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null, role: 'subscriber', added_at: new Date().toISOString() }));
  await telegram(env, chatId, alreadySubscribed ? '✅ You are already subscribed. Checking recent qualifying advisories now.' : '✅ You are subscribed to Volcanic Ash Alerts Global. Checking recent qualifying advisories now.');
  const recentCount = await sendRecentAlerts(state, env, chatId);
  if (!recentCount) await sendCurrentQualifyingSnapshot(state, env, chatId);
  return { alreadySubscribed, recent_alerts: recentCount };
}
async function sendCurrentQualifyingSnapshot(state, env, chatId) {
  const snapshotKey = `snapshot:last:${chatId}`;
  if (await state.get(snapshotKey)) return { sent: false, reason: 'recently-sent' };
  const qualifying = (await loadAdvisories()).map(advisory => ({ advisory, result: assess(advisory) })).filter(item => item.result.triggers.length);
  if (!qualifying.length) {
    await telegram(env, chatId, '📡 Subscription check complete: there are no current official ash advisories meeting the configured alert criteria.');
  } else {
    for (const item of qualifying) await telegram(env, chatId, message(item.advisory, item.result, false, '📌 CURRENT QUALIFYING VOLCANIC ASH ADVISORY'));
  }
  await state.put(snapshotKey, '1', { expirationTtl: 5 * 60 });
  return { sent: true, qualifying: qualifying.length };
}
async function handleTelegramUpdate(state, env, update) {
  if (update?.callback_query?.data === 'subscribe') {
    const callback = update.callback_query;
    const chat = callback.message?.chat;
    if (chat?.type !== 'private') return { handled: false, reason: 'not-private-chat' };
    await answerCallback(env, callback.id, 'Subscribing…');
    const subscription = await subscribeChat(state, env, chat);
    return { handled: true, command: 'subscribe-button', ...subscription };
  }
  const message = update?.message;
  if (message?.chat?.type !== 'private') return { handled: false, reason: 'not-private-message' };
  const chatId = String(message.chat.id);
  const text = String(message.text || '').trim();
  if (/^\/(?:status|stat)(?:@\w+)?\s*$/i.test(text)) {
    try {
      await sendStatus(state, env, chatId);
      return { handled: true, command: 'status' };
    } catch (error) {
      await telegram(env, chatId, `Unable to retrieve the official ash status right now: ${String(error.message || error)}`);
      return { handled: true, command: 'status', error: true };
    }
  }
  if (/^\/subscribe(?:@\w+)?\s*$/i.test(text)) {
    const subscription = await subscribeChat(state, env, message.chat);
    return { handled: true, command: 'subscribe', ...subscription };
  }
  if (/^\/start(?:@\w+)?\s*$/i.test(text)) {
    await telegram(env, chatId, 'Welcome to Volcanic Ash Alerts Global. Use /status for the current official advisory summary and one-tap subscription.', { reply_markup: { inline_keyboard: [[{ text: 'Subscribe to ash alerts', callback_data: 'subscribe' }]] } });
    return { handled: true, command: 'start' };
  }
  return { handled: false, reason: 'unknown-command' };
}
async function configureTelegramWebhook(request, env) {
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!secret) throw new Error('Missing TELEGRAM_WEBHOOK_SECRET secret.');
  const webhookUrl = new URL('/telegram-webhook', request.url).toString();
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Telegram webhook setup failed: ${payload.description || `HTTP ${response.status}`}`);
  return { configured: true, webhook: webhookUrl };
}
async function sendToSubscribers(state, env, text) {
  const chatIds = await subscriberIds(state);
  if (!chatIds.length) throw new Error('No Telegram subscribers are registered.');
  let delivered = 0;
  const failures = [];
  for (const chatId of chatIds) {
    try { await telegram(env, chatId, text); delivered++; }
    catch (error) { failures.push(`${chatId}: ${String(error.message || error)}`); }
  }
  if (!delivered) throw new Error(`Telegram delivery failed for all subscribers: ${failures.join('; ')}`);
  return { delivered, failures };
}
async function gateRequest(env, advisoryKey, action, fingerprint) {
  const id = env.ALERT_GATE.idFromName(advisoryKey);
  const response = await env.ALERT_GATE.get(id).fetch(`https://alert-gate/${action}`, { method: 'POST', body: JSON.stringify({ fingerprint }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Alert delivery gate HTTP ${response.status}`);
  return payload;
}
async function claimAlert(env, advisoryKey, fingerprint) {
  if (env.ALERT_GATE) return gateRequest(env, advisoryKey, 'claim', fingerprint);
  const priorFingerprint = await env.ALERT_STATE.get(advisoryKey);
  if (priorFingerprint === fingerprint) return { accepted: false, reason: 'already-sent' };
  await env.ALERT_STATE.put(advisoryKey, fingerprint, { expirationTtl: 60 * 60 * 24 * 45 });
  return { accepted: true, isUpdate: Boolean(priorFingerprint) };
}
async function completeAlert(env, advisoryKey, fingerprint) {
  if (env.ALERT_GATE) await gateRequest(env, advisoryKey, 'complete', fingerprint);
}
async function releaseAlert(env, advisoryKey, fingerprint) {
  if (env.ALERT_GATE) return gateRequest(env, advisoryKey, 'release', fingerprint);
  const storedFingerprint = await env.ALERT_STATE.get(advisoryKey);
  if (storedFingerprint === fingerprint) await env.ALERT_STATE.delete(advisoryKey);
}
async function connectTelegram(state, env) {
  const existing = await setting(state, 'telegram_chat_id');
  if (existing) return { connected: true, already_connected: true };
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`Telegram getUpdates failed: ${payload.description || `HTTP ${response.status}`}. Recheck the TELEGRAM_BOT_TOKEN secret for @wm_vol_ash_bot.`);
  const update = [...(payload.result || [])].reverse().find(item => item.message?.chat?.type === 'private');
  if (!update) throw new Error('No private message found. Open @wm_vol_ash_bot in Telegram, press Start, send any short message such as “connect”, then try again.');
  await saveSetting(state, 'telegram_chat_id', update.message.chat.id);
  await ensurePrimarySubscriber(state);
  await telegram(env, update.message.chat.id, '✅ Volcanic Ash Alerts Global is connected. Scheduled operational alerts will appear here.');
  return { connected: true, bot: '@wm_vol_ash_bot' };
}
async function runAlertCheck(env) {
  const state = env.ALERT_STATE;
  if (!await ensurePrimarySubscriber(state)) return { checked: false, reason: 'Telegram has not been connected yet.' };
  const advisories = await loadAdvisories();
  let qualifying = 0, sent = 0, deliveries = 0;
  for (const advisory of advisories) {
    const result = assess(advisory);
    if (!result.triggers.length) continue;
    qualifying++;
    const fingerprint = await advisoryFingerprint(advisory);
    const advisoryKey = `advisory:${encodeURIComponent(advisory.id)}:${advisory.issued}`;
    const claim = await claimAlert(env, advisoryKey, fingerprint);
    if (!claim.accepted) continue;
    const text = message(advisory, result, claim.isUpdate);
    try {
      const delivery = await sendToSubscribers(state, env, text);
      deliveries += delivery.delivered;
    } catch (error) {
      await releaseAlert(env, advisoryKey, fingerprint).catch(() => undefined);
      throw error;
    }
    await completeAlert(env, advisoryKey, fingerprint);
    await state.put(`alert-history:${Date.now()}:${fingerprint}`, JSON.stringify({ sent_at: Date.now(), advisory_key: advisoryKey, fingerprint, text }), { expirationTtl: 13 * 60 * 60 });
    sent++;
  }
  return { checked: true, advisories: advisories.length, qualifying, sent, deliveries, subscribers: (await subscriberIds(state)).length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'Volcanic Ash Alerts Global', storage: 'Workers KV', delivery_lock: env.ALERT_GATE ? 'Durable Object' : 'Workers KV', commands: 'Telegram webhook', subscribers: 'open one-tap subscription', version: 'webhook-alerts-v4' });
    if (!env.ALERT_STATE || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'Missing ALERT_STATE KV binding or TELEGRAM_BOT_TOKEN secret.' }, 500);
    try {
      if (url.pathname === '/telegram-webhook') {
        if (request.method !== 'POST') return json({ ok: false, error: 'POST required.' }, 405);
        if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized webhook request.' }, 401);
        return json({ ok: true, ...(await handleTelegramUpdate(env.ALERT_STATE, env, await request.json())) });
      }
      if (url.pathname === '/connect-telegram') return json(await connectTelegram(env.ALERT_STATE, env));
      if (url.pathname === '/configure-telegram-webhook') return json(await configureTelegramWebhook(request, env));
      if (url.pathname === '/sync-subscribers') return json({ ok: true, message: 'Telegram webhook is active. Commands now reply directly; browser sync is no longer needed.' });
      if (url.pathname === '/run-now') return json(await runAlertCheck(env));
      return json({ ok: false, error: 'Route not found. Use /health, /connect-telegram, or /run-now.' }, 404);
    } catch (error) { return json({ ok: false, error: String(error.message || error) }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runAlertCheck(env)); },
};
