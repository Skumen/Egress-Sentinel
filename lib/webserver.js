import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { verifyInitData, displayName } from './auth.js';
import { ValidationError } from './validate.js';
import { TEMPLATE_GROUPS, FIELDS, PLACEHOLDER_HELP, validateTexts } from './texts.js';
import { createMessages } from './messages.js';
import { RANGES, DAY } from './history.js';
import { NOTIFICATION_GROUPS, NOTIFICATION_IDS } from './notifications.js';

// Must match PREVIEW_KINDS in webapp/index.html.
const PREVIEW_KINDS = new Set([
  'alert', 'reminder', 'acknowledged', 'recovered', 'degraded', 'perfRestored', 'maintenance', 'scheduled',
]);

const ID_RE = /^[0-9a-f]{8}$/;
const MAX_BODY = 16 * 1024;
const MAX_SENSOR_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/**
 * HTTP server of the Mini App: serves webapp/index.html and the JSON API.
 * Listens on 127.0.0.1 only; a reverse proxy (Caddy or nginx) publishes it over HTTPS.
 *
 * Every request to /api/ must carry the header  Authorization: tma <initData>.
 * The initData signature is verified with the bot token, so a user cannot be forged.
 * Exception: /api/sensor/* — traffic sensors authenticate with their own token (Authorization: Bearer …)
 * and can only submit reports and read the node list (IDs and names, no addresses).
 */
export function startWebServer({
  host = '127.0.0.1', port, token, htmlPath, config, access, monitor, store, history, messages, tg, botInfo, log,
  onAudit, upcomingSchedules, accessFlow, sensors, adminMessages, publicUrl = '',
}) {
  /** A sample message rendered with draft (not yet saved) texts. */
  function renderDraft(body) {
    const kind = PREVIEW_KINDS.has(body.kind) ? body.kind : 'alert';
    const draft = validateTexts(body.texts ?? {}, store.texts());
    return createMessages({ ...config, texts: () => draft }).preview(kind);
  }

  /** A maintenance window for the dashboard: node names only, no addresses. */
  const serializeSchedule = (s) => ({
    id: s.id,
    ref: messages.maintenanceRef(s),
    state: s.state,
    start: s.start,
    end: s.end,
    reason: s.reason,
    by: s.by,
    createdAt: s.createdAt,
    nodes: s.nodeIds.map((id) => ({ id, name: monitor.get(id)?.target.name ?? '(removed)' })),
    cancelledBy: s.cancelledBy ?? null,
    endedBy: s.endedBy ?? null,
    missed: !!s.missed,
  });

  const serializeIncident = (i) => ({
    key: i.key,
    ref: i.kind === 'latency' ? messages.latencyId(i.start, i.nodeId) : messages.incidentId(i.start, i.nodeId),
    nodeId: i.nodeId,
    nodeName: i.nodeName,
    kind: i.kind,
    start: i.start,
    declaredAt: i.declaredAt,
    end: i.end,
    endReason: i.endReason,
    ack: i.ack,
    error: i.error ?? null,
    cause: i.cause ?? null,
    maxMs: i.maxMs ?? null,
    thresholdMs: i.thresholdMs ?? null,
  });
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readBody(req, limit = MAX_BODY) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Malformed JSON');
    }
  }

  /**
   * Dashboard status: down | maintenance | unstable (failures below the threshold) |
   * degraded (high latency) | up | unknown.
   */
  function serialize(s, isAdmin) {
    let status = s.status;
    if (s.status === 'up' && s.fails > 0) status = 'unstable';
    else if (s.status === 'up' && s.lat?.incident) status = 'degraded';
    const lat = s.lat?.incident;
    const r = {
      id: s.id,
      name: s.target.name,
      type: s.target.type,
      method: messages.method(s.target),
      status,
      lastMs: s.lastMs,
      lastError: s.lastError,
      lastCheckAt: s.lastCheckAt,
      lastOkAt: s.lastOkAt,
      since: s.since,
      declaredAt: s.declaredAt,
      fails: s.fails,
      notices: s.notices,
      availability: history.availability(s.id, 30 * DAY),
      availability24h: history.availability(s.id, DAY),
      incidentId: s.status === 'down' ? messages.incidentId(s.since, s.id) : null,
      ack: s.ack,
      maintenance: s.maintenance,
      latencyThreshold: monitor.latencyThreshold(s),
      latencyCustom: Number.isInteger(s.target.latencyMs),
      latency: lat ? {
        incidentId: messages.latencyId(lat.since, s.id), since: lat.since, declaredAt: lat.declaredAt,
        maxMs: lat.maxMs, thresholdMs: lat.thresholdMs,
      } : null,
      cause: s.cause ?? null,
      trafficCheck: s.target.trafficCheck !== false,
      traffic: s.traffic ? {
        ok: s.traffic.ok, ms: s.traffic.ms ?? null, sensors: s.traffic.sensors, at: s.traffic.at, error: s.traffic.error ?? null,
        ...(isAdmin ? { exitIp: s.traffic.exitIp ?? null } : {}),
      } : null,
    };
    // Only administrators see addresses.
    if (isAdmin) {
      Object.assign(r, { host: s.target.host, port: s.target.port, url: s.target.url, latencyMs: s.target.latencyMs ?? null });
    }
    return r;
  }

  const notificationSettings = () => NOTIFICATION_GROUPS.map((g) => ({
    ...g, items: g.items.map((i) => ({ ...i, enabled: store.notificationEnabled(i.id) })),
  }));

  const serializeMessage = (m) => ({
    id: m.id, ref: m.ref, at: m.at, by: m.by, subject: m.subject, text: m.text,
    recipients: m.recipients,
    delivered: m.recipients.filter((r) => r.ok).length,
  });

  /** Report and node list for traffic sensors. Returns true if the request was handled. */
  async function handleSensorApi(req, res, path) {
    if (path !== '/api/sensor/report' && path !== '/api/sensor/nodes') return false;
    const sensor = sensors?.authenticate(req.headers.authorization);
    if (!sensor) throw new HttpError(401, 'Invalid sensor token');
    if (req.method === 'GET' && path === '/api/sensor/nodes') {
      // traffic: false — the node must not be checked (disabled in the dashboard); the sensor skips it.
      sendJson(res, 200, {
        sensor: sensor.name,
        nodes: store.servers().map((s) => ({ id: s.id, name: s.name, traffic: s.trafficCheck !== false })),
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/sensor/report') {
      const report = sensors.report(sensor, await readBody(req, MAX_SENSOR_BODY));
      sendJson(res, 200, { accepted: report.results.length, unknown: report.unknown });
      return true;
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /** guestOk — the endpoint is available without approved access (submitting a request only). */
  async function authenticate(req, { guestOk = false } = {}) {
    const header = req.headers.authorization ?? '';
    const user = header.startsWith('tma ') ? verifyInitData(header.slice(4), token) : null;
    if (!user) throw new HttpError(401, 'Authentication failed. Please reopen the app from Telegram.');
    const viewer = await access.isViewer(user.id);
    if (!viewer && !guestOk) {
      // The dashboard shows the "Access required" screen with a request button.
      throw new HttpError(403, 'Access to the monitoring dashboard is granted by the administrator.', {
        code: 'access_required', status: accessFlow.status(user.id), canRequest: accessFlow.canRequest(user.id),
      });
    }
    return { user, viewer, isAdmin: access.isAdmin(user.id), name: displayName(user) };
  }

  const serializeUser = (u) => ({
    id: u.id, name: u.name, username: u.username, status: u.status, subscribed: !!u.subscribed,
    requestedAt: u.requestedAt, decidedAt: u.decidedAt, decidedBy: u.decidedBy, isAdmin: access.isAdmin(u.id),
  });

  const requireAdmin = (who) => {
    if (!who.isAdmin) throw new HttpError(403, 'This action is restricted to the responsible administrator.');
  };

  const found = (value) => {
    if (!value) throw new HttpError(404, 'Exit node not found');
    return value;
  };

  async function handleApi(req, res, path) {
    const { method } = req;
    let m;

    if (await handleSensorApi(req, res, path)) return undefined;

    // An access request from the dashboard is the only endpoint for users without access.
    if (method === 'POST' && path === '/api/access-request') {
      const guest = await authenticate(req, { guestOk: true });
      if (!guest.viewer && !accessFlow.canRequest(guest.user.id)) {
        throw new HttpError(409, accessFlow.status(guest.user.id) === 'pending'
          ? 'Your request is already awaiting review.'
          : 'A new request may be submitted 24 hours after the previous decision.');
      }
      return sendJson(res, 200, { status: await accessFlow.submit(guest.user) });
    }

    const who = await authenticate(req);

    if (method === 'GET' && path === '/api/state') {
      return sendJson(res, 200, {
        generatedAt: Date.now(),
        me: {
          id: who.user.id, name: who.name, isAdmin: who.isAdmin, subscribed: store.isSubscribed(who.user.id),
          ...(who.isAdmin ? {
            pendingRequests: store.users().filter((u) => u.status === 'pending').length,
            mutedNotifications: [...NOTIFICATION_IDS].filter((id) => !store.notificationEnabled(id)),
            sensors: sensors ? sensors.list().map((s) => ({ name: s.name, status: s.status })) : [],
          } : {}),
        },
        monitor: {
          name: config.monitorName,
          adminName: config.adminName,
          startedAt: botInfo.startedAt,
          intervalSeconds: config.intervalSeconds,
          timeoutSeconds: config.timeoutSeconds,
          failThreshold: config.failThreshold,
          remindEveryMinutes: config.remindEveryMinutes,
          latencyThresholdMs: config.latencyThresholdMs,
          latencyThresholdHttpMs: config.latencyThresholdHttpMs,
          latencyChecks: config.latencyChecks,
          maintenanceNoticeMinutes: config.maintenanceNoticeMinutes,
          botUsername: botInfo.username,
        },
        resources: monitor.list().map((s) => serialize(s, who.isAdmin)),
        schedules: upcomingSchedules().map(serializeSchedule),
      });
    }

    // History and the log are available to all viewers: they contain node names only, no addresses.
    if (method === 'GET' && (m = path.match(/^\/api\/history\/([0-9a-f]{8})$/))) {
      const s = found(monitor.get(m[1]));
      const rangeKey = new URL(req.url, 'http://localhost').searchParams.get('range');
      const range = RANGES[rangeKey] ? rangeKey : '24h';
      const span = RANGES[range].span;
      const stats = history.stats(s.id, span);
      return sendJson(res, 200, {
        ...history.series(s.id, range),
        threshold: monitor.latencyThreshold(s),
        summary: { ...stats, ...history.downtime(s.id, span) },
        incidents: history.listIncidents({ nodeId: s.id, since: Date.now() - span, limit: 50 }).map(serializeIncident),
      });
    }
    if (method === 'GET' && path === '/api/incidents') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const days = Math.min(90, Math.max(1, Number(q.get('days')) || 30));
      return sendJson(res, 200, {
        days,
        incidents: history.listIncidents({ since: Date.now() - days * DAY, limit: 200 }).map(serializeIncident),
      });
    }
    if (method === 'GET' && path === '/api/schedules') {
      const all = [...store.schedules()].sort((a, b) => b.start - a.start);
      return sendJson(res, 200, { schedules: all.map(serializeSchedule) });
    }

    if (method === 'POST' && path === '/api/subscription') {
      const { enabled } = await readBody(req);
      if (enabled) {
        // Try to message the user first: if they never started the bot, Telegram returns 403.
        try {
          await tg.send(String(who.user.id), messages.subscribed());
        } catch {
          throw new HttpError(409, `Unable to deliver private messages. Open a chat with @${botInfo.username}, press Start, then try again.`);
        }
        store.ensureApproved(who.user.id, who.name, who.user.username, who.isAdmin ? 'administrator' : 'group member');
        store.setSubscribed(who.user.id, true);
      } else {
        store.setSubscribed(who.user.id, false);
      }
      return sendJson(res, 200, { subscribed: store.isSubscribed(who.user.id) });
    }

    // Everything below is for administrators only.
    requireAdmin(who);

    if (method === 'GET' && path === '/api/texts') {
      const custom = store.texts();
      return sendJson(res, 200, {
        placeholders: PLACEHOLDER_HELP,
        groups: TEMPLATE_GROUPS.map((g) => ({
          id: g.id,
          label: g.label,
          fields: g.fields.map((f) => {
            const meta = FIELDS.get(f.key);
            return {
              key: f.key, label: f.label, multiline: !!f.multiline, required: !!f.required, max: f.max,
              vars: meta.vars, default: f.default, value: custom[f.key] ?? f.default, customised: f.key in custom,
            };
          }),
        })),
      });
    }
    if (method === 'PUT' && path === '/api/texts') {
      const { texts } = await readBody(req);
      const before = store.texts();
      const after = validateTexts(texts, before);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((k) => before[k] !== after[k]);
      if (changed.length) {
        store.setTexts(after);
        const sections = [...new Set(changed.map((k) => TEMPLATE_GROUPS.find((g) => g.id === FIELDS.get(k).group).label))];
        log(`✎ Notification texts changed (${sections.join(', ')}) by ${who.name}`);
        onAudit?.('templatesChanged', { sections, by: who.name });
      }
      return sendJson(res, 200, { saved: changed.length });
    }
    if (method === 'POST' && path === '/api/texts/preview') {
      return sendJson(res, 200, { html: renderDraft(await readBody(req)) });
    }
    if (method === 'POST' && path === '/api/texts/send-preview') {
      const html = renderDraft(await readBody(req));
      try {
        await tg.send(String(who.user.id), `🧪 <b>TEMPLATE PREVIEW</b> — <i>not a real incident</i>\n\n${html}`);
      } catch {
        throw new HttpError(409, `Unable to deliver private messages. Open a chat with @${botInfo.username}, press Start, then try again.`);
      }
      return sendJson(res, 200, { sent: true });
    }

    if (method === 'GET' && path === '/api/users') {
      const order = { pending: 0, approved: 1, denied: 2, revoked: 3 };
      const users = [...store.users()].sort((a, b) => (order[a.status] - order[b.status]) || (b.requestedAt - a.requestedAt));
      return sendJson(res, 200, { users: users.map(serializeUser) });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/users\/(\d{1,20})\/(approve|deny|revoke)$/))) {
      const status = { approve: 'approved', deny: 'denied', revoke: 'revoked' }[m[2]];
      if (Number(m[1]) === who.user.id && status !== 'approved') throw new HttpError(400, 'You cannot revoke your own access');
      return sendJson(res, 200, serializeUser(await accessFlow.decide(Number(m[1]), status, who.name)));
    }

    // ── Notification categories ──
    if (method === 'GET' && path === '/api/notifications') {
      return sendJson(res, 200, { groups: notificationSettings() });
    }
    if (method === 'PUT' && path === '/api/notifications') {
      const { settings } = await readBody(req);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new HttpError(400, 'settings object is required');
      for (const [id, v] of Object.entries(settings)) {
        if (!NOTIFICATION_IDS.has(id) || typeof v !== 'boolean') throw new HttpError(400, `Unknown notification category: ${id}`);
      }
      const changed = store.setNotifications(settings);
      if (changed.length) {
        log(`🔔 Notification settings (${changed.map((id) => `${id}: ${store.notificationEnabled(id) ? 'on' : 'off'}`).join(', ')}) by ${who.name}`);
      }
      return sendJson(res, 200, { groups: notificationSettings() });
    }

    // ── Messages to users ──
    if (method === 'GET' && path === '/api/messages') {
      const recipients = store.users().filter((u) => u.status === 'approved')
        .map((u) => ({ id: u.id, name: u.name, username: u.username, subscribed: !!u.subscribed, isAdmin: access.isAdmin(u.id) }));
      const sent = [...store.messages()].reverse().slice(0, 30).map(serializeMessage);
      return sendJson(res, 200, { recipients, sent });
    }
    if (method === 'POST' && path === '/api/messages/preview') {
      return sendJson(res, 200, { html: adminMessages.preview(await readBody(req), who.name) });
    }
    if (method === 'POST' && path === '/api/messages') {
      return sendJson(res, 201, serializeMessage(await adminMessages.send(await readBody(req), who.name)));
    }

    // ── Traffic sensors ──
    if (method === 'GET' && path === '/api/sensors') {
      return sendJson(res, 200, {
        sensors: sensors.list(),
        reportUrl: publicUrl ? `${publicUrl}/api/sensor/report` : null,
        nodes: store.servers().map((s) => ({ id: s.id, name: s.name, traffic: s.trafficCheck !== false })),
      });
    }
    if (method === 'POST' && path === '/api/sensors') {
      const { name } = await readBody(req);
      const { sensor, token: sensorToken } = sensors.add(name, who.name);
      return sendJson(res, 201, { id: sensor.id, name: sensor.name, token: sensorToken });
    }
    if ((m = path.match(/^\/api\/sensors\/([0-9a-f]{8})(\/token)?$/))) {
      if (m[2] && method === 'POST') {
        const rotated = sensors.rotate(m[1], who.name);
        if (!rotated) throw new HttpError(404, 'Sensor not found');
        return sendJson(res, 200, { id: rotated.sensor.id, name: rotated.sensor.name, token: rotated.token });
      }
      if (!m[2] && method === 'DELETE') {
        if (!sensors.remove(m[1], who.name)) throw new HttpError(404, 'Sensor not found');
        return sendJson(res, 200, { deleted: m[1] });
      }
    }

    if (method === 'POST' && path === '/api/schedules') {
      return sendJson(res, 201, serializeSchedule(monitor.scheduleMaintenance(await readBody(req), who.name)));
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/schedules\/([0-9a-f]{8})$/))) {
      const sched = monitor.cancelSchedule(m[1], who.name);
      if (!sched) throw new HttpError(404, 'Maintenance window not found');
      return sendJson(res, 200, serializeSchedule(store.getSchedule(m[1]) ?? sched));
    }

    if (method === 'POST' && path === '/api/check') {
      return sendJson(res, 200, await monitor.testTarget(await readBody(req)));
    }
    if (method === 'PUT' && path === '/api/resources/order') {
      const { ids } = await readBody(req);
      return sendJson(res, 200, { ids: monitor.reorderServers(ids, who.name).map((s) => s.id) });
    }
    if (method === 'POST' && path === '/api/resources') {
      return sendJson(res, 201, serialize(monitor.addServer(await readBody(req), who.name), true));
    }
    if ((m = path.match(/^\/api\/resources\/([^/]+)(?:\/(ack|maintenance))?$/))) {
      const [, id, action] = m;
      if (!ID_RE.test(id)) throw new HttpError(404, 'Exit node not found');

      if (!action && method === 'PUT') {
        return sendJson(res, 200, serialize(found(monitor.updateServer(id, await readBody(req), who.name)), true));
      }
      if (!action && method === 'DELETE') {
        found(monitor.removeServer(id, who.name));
        return sendJson(res, 200, { deleted: id });
      }
      if (action === 'ack' && method === 'POST') {
        return sendJson(res, 200, serialize(found(monitor.acknowledge(id, who.name)), true));
      }
      if (action === 'maintenance' && method === 'POST') {
        const { minutes } = await readBody(req);
        const s = Number(minutes) === 0
          ? monitor.endMaintenance(id, who.name)
          : monitor.setMaintenance(id, Number(minutes), who.name);
        return sendJson(res, 200, serialize(found(s), true));
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (path.startsWith('/api/')) return await handleApi(req, res, path);

      // HEAD is needed for checks like curl -I (Node does not send a body in response to HEAD).
      if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html')) {
        const html = await readFile(htmlPath);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        });
        return res.end(html);
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
      if (err instanceof ValidationError) return sendJson(res, 400, { error: err.message });
      log('Web server error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, host, () => log(`Mini App: http://${host}:${port}`));
  server.on('error', (err) => log(`Web server failed to start: ${err.message}`));
  return server;
}
