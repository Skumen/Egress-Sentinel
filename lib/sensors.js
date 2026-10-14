import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './validate.js';

const ID_RE = /^[0-9a-f]{8}$/;
const MIN_STALE_MS = 3 * 60_000;
const MAX_RESULTS = 200;
const SEEN_SAVE_MS = 10 * 60_000; // lastSeenAt is written to store.json at most every 10 minutes

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * External traffic sensors (VLESS).
 *
 * A sensor runs on a separate server (in the users' region), connects to every exit node the way a client does,
 * and sends a report once per interval: POST /api/sensor/report, Authorization: Bearer <token>.
 * The token is shown to the administrator once, on creation; store.json keeps only its SHA-256.
 *
 * Sensor state (in memory):
 *   awaiting — has never sent a report;
 *   online   — reports arrive and the sensor is healthy;
 *   impaired — reports arrive, but the sensor itself cannot check (no internet, xray not running);
 *              its results are disregarded;
 *   offline  — no report for longer than allowed (3 intervals, at least 3 minutes).
 * A state change emits the sensorStatus event (administrators only).
 *
 * trafficFor(nodeId) — a fresh traffic result for the node, or null (no data: the node is judged by the direct
 * check only; a sensor failure never makes a node unavailable).
 */
export function createSensors({ store, log, onEvent, nodeName = () => null, now: startedAt = Date.now() }) {
  const runtime = new Map();

  function rt(sensor) {
    let r = runtime.get(sensor.id);
    if (!r) {
      // After a bot restart, a sensor that used to report is assumed to be online;
      // if it stays silent, an OFFLINE notice follows after the allowed interval.
      r = sensor.lastSeenAt
        ? { status: 'online', lastAt: startedAt, report: null, staleMs: MIN_STALE_MS, restored: true }
        : { status: 'awaiting', lastAt: null, report: null, staleMs: MIN_STALE_MS };
      runtime.set(sensor.id, r);
    }
    return r;
  }

  function authenticate(header) {
    const m = /^Bearer\s+(\S{20,200})$/.exec(header ?? '');
    if (!m) return null;
    const given = Buffer.from(hashToken(m[1]), 'hex');
    for (const s of store.sensors()) {
      const expected = Buffer.from(s.tokenHash, 'hex');
      if (expected.length === given.length && timingSafeEqual(expected, given)) return s;
    }
    return null;
  }

  const coveredNodes = (r) => (r.report ? r.report.results.map((x) => x.nodeId) : []);

  function transition(sensor, r, status, reason, now) {
    const previous = r.status;
    if (previous === status) return;
    r.status = status;
    r.changedAt = now;
    log(`📡 Sensor "${sensor.name}": ${previous} → ${status}${reason ? ` (${reason})` : ''}`);
    onEvent('sensorStatus', {
      sensor: { id: sensor.id, name: sensor.name }, status, previous, reason,
      lastAt: r.lastAt, nodes: coveredNodes(r).map((id) => nodeName(id)).filter(Boolean),
    });
  }

  /** Accepts a sensor report. body: { version, intervalSeconds, sensorOk, sensorError, results: [...] } */
  function report(sensor, body, now = Date.now()) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new ValidationError('Report must contain a results array');
    }
    if (body.results.length > MAX_RESULTS) throw new ValidationError('Too many results in one report');
    const interval = Math.min(600, Math.max(10, Number(body.intervalSeconds) || 60));
    const results = [];
    const unknown = [];
    for (const x of body.results) {
      const nodeId = typeof x?.node === 'string' ? x.node.toLowerCase() : '';
      if (!ID_RE.test(nodeId) || !store.get(nodeId)) {
        if (unknown.length < 20) unknown.push(String(x?.node ?? '').slice(0, 40));
        continue;
      }
      if (store.get(nodeId).trafficCheck === false) continue; // traffic verification is disabled for this node in the dashboard
      const ms = Number(x.ms);
      results.push({
        nodeId,
        ok: x.ok === true,
        ms: x.ok === true && Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), 600_000) : null,
        exitIp: str(x.exitIp, 64),
        error: x.ok === true ? null : (str(x.error, 200) ?? 'Traffic check failed'),
      });
    }
    const r = rt(sensor);
    const sensorOk = body.sensorOk !== false;
    // Which nodes this sensor covers, according to its last healthy report.
    if (sensorOk) r.covered = new Set(results.map((x) => x.nodeId));
    r.lastAt = now;
    r.staleMs = Math.max(MIN_STALE_MS, interval * 3000);
    r.report = {
      at: now, interval, version: str(body.version, 32), sensorOk,
      sensorError: sensorOk ? null : (str(body.sensorError, 200) ?? 'Sensor reported a local failure'),
      results, unknown,
    };
    const firstEver = !sensor.lastSeenAt;
    if (firstEver || now - sensor.lastSeenAt >= SEEN_SAVE_MS) store.updateSensor(sensor.id, { lastSeenAt: now });
    if (firstEver) {
      r.status = sensorOk ? 'online' : 'impaired';
      log(`📡 Sensor "${sensor.name}" connected: ${results.length} exit node(s)`);
      onEvent('sensorStatus', {
        sensor: { id: sensor.id, name: sensor.name }, status: 'connected', previous: 'awaiting',
        reason: sensorOk ? null : r.report.sensorError, lastAt: now, nodes: results.map((x) => nodeName(x.nodeId)).filter(Boolean),
        unknown,
      });
      return r.report;
    }
    transition(sensor, r, sensorOk ? 'online' : 'impaired', sensorOk ? null : r.report.sensorError, now);
    return r.report;
  }

  /** Called every check cycle: sensors that have been silent too long go offline. */
  function tick(now = Date.now()) {
    for (const sensor of store.sensors()) {
      const r = rt(sensor);
      if ((r.status === 'online' || r.status === 'impaired') && now - r.lastAt > r.staleMs) {
        transition(sensor, r, 'offline', `no report for ${Math.round((now - r.lastAt) / 60_000)} min`, now);
      }
    }
  }

  /**
   * The combined result for a node across healthy sensors with a fresh report.
   * Traffic counts as failed only if it fails for every one of them.
   */
  function trafficFor(nodeId, now = Date.now()) {
    const ok = [];
    const failed = [];
    for (const sensor of store.sensors()) {
      const r = runtime.get(sensor.id);
      if (!r?.report || r.status !== 'online' || now - r.report.at > r.staleMs) continue;
      const x = r.report.results.find((y) => y.nodeId === nodeId);
      if (x) (x.ok ? ok : failed).push({ sensor: sensor.name, at: r.report.at, ...x });
    }
    if (!ok.length && !failed.length) return null;
    if (ok.length) {
      const best = ok.reduce((a, b) => ((b.ms ?? Infinity) < (a.ms ?? Infinity) ? b : a));
      return { ok: true, ms: best.ms, exitIp: best.exitIp, sensors: ok.map((x) => x.sensor), at: best.at };
    }
    return {
      // at — time of the newest report; the monitor uses it to count each observation only once.
      ok: false, sensors: failed.map((x) => x.sensor), at: Math.max(...failed.map((x) => x.at)), exitIp: failed[0].exitIp,
      error: failed.map((x) => (failed.length > 1 ? `${x.sensor}: ${x.error}` : x.error)).join('; '),
    };
  }

  /**
   * Whether any registered sensor covers the node. While one does, an outage declared on traffic grounds
   * is cleared only by a new sensor result, not by the direct check. If the sensor is removed in the dashboard or
   * the node is dropped from its configuration, the hold is released. After a bot restart, until the first healthy
   * report, a sensor that used to report is assumed to cover the node.
   */
  function covers(nodeId) {
    return store.sensors().some((s) => {
      const r = runtime.get(s.id);
      return r?.covered ? r.covered.has(nodeId) : !!s.lastSeenAt;
    });
  }

  /** For the administrator dashboard. */
  function list(now = Date.now()) {
    return store.sensors().map((s) => {
      const r = rt(s);
      return {
        id: s.id, name: s.name, createdAt: s.createdAt, createdBy: s.createdBy, lastSeenAt: s.lastSeenAt,
        status: r.status, lastAt: r.lastAt, staleMs: r.staleMs,
        report: r.report && {
          ...r.report,
          results: r.report.results.map((x) => ({ ...x, nodeName: nodeName(x.nodeId) })),
          ageMs: now - r.report.at,
        },
      };
    });
  }

  const cleanName = (name) => {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) throw new ValidationError('Sensor name is required');
    if (n.length > 40) throw new ValidationError('Sensor name must not exceed 40 characters');
    if (store.sensors().some((s) => s.name.toLowerCase() === n.toLowerCase())) {
      throw new ValidationError('A sensor with this name already exists');
    }
    return n;
  };

  /** A new sensor. The token is returned once and is not stored anywhere in plain text. */
  function add(name, by, now = Date.now()) {
    const token = randomBytes(24).toString('base64url');
    const sensor = store.addSensor({ name: cleanName(name), tokenHash: hashToken(token), createdAt: now, createdBy: by });
    log(`📡 Sensor "${sensor.name}" registered by ${by}`);
    return { sensor, token };
  }

  /** A new token: the old one stops working immediately. */
  function rotate(id, by) {
    const sensor = store.getSensor(id);
    if (!sensor) return null;
    const token = randomBytes(24).toString('base64url');
    store.updateSensor(id, { tokenHash: hashToken(token) });
    log(`📡 New token issued for sensor "${sensor.name}" by ${by}`);
    return { sensor, token };
  }

  function remove(id, by) {
    const removed = store.removeSensor(id);
    if (!removed) return null;
    runtime.delete(id);
    log(`📡 Sensor "${removed.name}" removed by ${by}`);
    return removed;
  }

  return { authenticate, report, tick, trafficFor, covers, list, add, rotate, remove };
}
