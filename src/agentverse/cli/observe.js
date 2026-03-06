import http from 'node:http';
import https from 'node:https';

function parseSseFrame(frameText) {
  const normalized = String(frameText ?? '').replace(/\r/g, '');
  if (!normalized.trim()) return null;
  const lines = normalized.split('\n');
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    if (field === 'id') id = value || null;
    if (field === 'data') dataLines.push(value);
  }
  const rawData = dataLines.join('\n');
  let data = rawData;
  try {
    data = rawData ? JSON.parse(rawData) : null;
  } catch {
    // leave as string
  }
  return { event, id, data, rawData };
}

export async function streamSessionEvents({
  baseUrl,
  sessionId,
  protocol = '1.0',
  tenantId = null,
  apiKey = null,
  opsToken = null,
  timeoutMs = 30000,
  maxEvents = 100,
  onEvent = null
}) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!sessionId) throw new Error('sessionId is required');

  const query = new URLSearchParams({
    maxEvents: String(maxEvents),
    timeoutMs: String(timeoutMs)
  });
  const url = new URL(`/sessions/${encodeURIComponent(sessionId)}/events/stream?${query.toString()}`, baseUrl);

  const transport = url.protocol === 'https:' ? https : http;

  const headers = {
    accept: 'text/event-stream',
    'x-nooterra-protocol': protocol
  };
  if (tenantId) headers['x-proxy-tenant-id'] = tenantId;
  if (apiKey) headers['x-proxy-api-key'] = apiKey;
  if (opsToken) headers['x-proxy-ops-token'] = opsToken;

  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';

    const req = transport.request(url, { method: 'GET', headers }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          reject(new Error(`stream failed: ${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`));
        });
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          events.push(parsed);
          if (typeof onEvent === 'function') onEvent(parsed);
          if (events.length >= maxEvents) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
      res.on('end', () => resolve(events));
    });

    req.setTimeout(timeoutMs + 5000, () => req.destroy(new Error('session stream timeout')));
    req.on('error', reject);
    req.end();
  });
}
