import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './jsonfile.js';

// Check history is stored aggregated rather than per check:
//   m5 — 5-minute buckets for the last 48 hours (24-hour charts);
//   h1 — 1-hour buckets for the last 90 days (7- and 30-day charts, 30-day availability).
// Bucket: [start (ms, a multiple of the size), checks, successful, latency sum, latency samples, max latency].
// If the monitor was not running or skipped a check (no internet on the monitor itself), the bucket is simply
// missing: it shows as a gap in charts and is excluded from availability.
//
// The incident log (outage / latency) is kept separately and written to disk on every change.

export const MIN5 = 5 * 60_000;
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
const KEEP = { m5: 48 * HOUR, h1: 90 * DAY };
const MAX_INCIDENTS = 1000;

export const RANGES = {
  '24h': { span: DAY, step: MIN5, source: 'm5' },
  '7d': { span: 7 * DAY, step: HOUR, source: 'h1' },
  '30d': { span: 30 * DAY, step: 4 * HOUR, source: 'h1' },
};

export function createHistory({ historyPath, incidentsPath, log = () => {} }) {
  const data = readJson(historyPath, { nodes: {} });
  const incidents = readJson(incidentsPath, { items: [] }).items;
  let dirty = false;

  // ── Checks ───────────────────────────────────────────────────────────────

  function bump(arr, size, keep, now, ok, ms) {
    const start = Math.floor(now / size) * size;
    let b = arr[arr.length - 1];
    if (!b || b[0] !== start) {
      b = [start, 0, 0, 0, 0, 0];
      arr.push(b);
    }
    b[1] += 1;
    if (ok) {
      b[2] += 1;
      if (Number.isFinite(ms)) {
        b[3] += ms;
        b[4] += 1;
        if (ms > b[5]) b[5] = ms;
      }
    }
    while (arr.length && arr[0][0] < now - keep) arr.shift();
  }

  /** Records the result of one check. ms — response time (successful checks only). */
  function record(id, { ok, ms }, now = Date.now()) {
    const node = (data.nodes[id] ??= { m5: [], h1: [] });
    bump(node.m5, MIN5, KEEP.m5, now, ok, ms);
    bump(node.h1, HOUR, KEEP.h1, now, ok, ms);
    dirty = true;
  }

  /** Deletes a node's check history (the incident log is kept; it stores a snapshot of the name). */
  function forget(id) {
    if (data.nodes[id]) { delete data.nodes[id]; dirty = true; }
  }

  /** Aggregates source buckets into steps of the given size over the last span ms. */
  function series(id, rangeKey, now = Date.now()) {
    const range = RANGES[rangeKey] ?? RANGES['24h'];
    const from = now - range.span;
    const src = data.nodes[id]?.[range.source] ?? [];
    const buckets = new Map();
    for (const b of src) {
      if (b[0] + (range.source === 'm5' ? MIN5 : HOUR) <= from || b[0] > now) continue;
      const t = Math.floor(b[0] / range.step) * range.step;
      const acc = buckets.get(t) ?? [t, 0, 0, 0, 0, 0];
      acc[1] += b[1]; acc[2] += b[2]; acc[3] += b[3]; acc[4] += b[4]; acc[5] = Math.max(acc[5], b[5]);
      buckets.set(t, acc);
    }
    return {
      range: rangeKey in RANGES ? rangeKey : '24h',
      from,
      to: now,
      step: range.step,
      points: [...buckets.values()].sort((a, b) => a[0] - b[0]).map(([t, n, ok, sum, cnt, max]) => ({
        t,
        checks: n,
        availability: n ? ok / n : null,
        avgMs: cnt ? Math.round(sum / cnt) : null,
        maxMs: cnt ? Math.round(max) : null,
      })),
    };
  }

  /** Availability (0..1) and average/max latency over the last windowMs. null — no data. */
  function stats(id, windowMs, now = Date.now()) {
    const useM5 = windowMs <= KEEP.m5;
    const src = data.nodes[id]?.[useM5 ? 'm5' : 'h1'] ?? [];
    const size = useM5 ? MIN5 : HOUR;
    let n = 0, ok = 0, sum = 0, cnt = 0, max = 0;
    for (const b of src) {
      if (b[0] + size <= now - windowMs || b[0] > now) continue;
      n += b[1]; ok += b[2]; sum += b[3]; cnt += b[4]; max = Math.max(max, b[5]);
    }
    return {
      checks: n,
      availability: n ? ok / n : null,
      avgMs: cnt ? Math.round(sum / cnt) : null,
      maxMs: cnt ? Math.round(max) : null,
    };
  }

  const availability = (id, windowMs = 30 * DAY, now = Date.now()) => stats(id, windowMs, now).availability;

  // ── Incident log ─────────────────────────────────────────────────────────

  function saveIncidents() {
    try {
      writeJson(incidentsPath, { items: incidents });
    } catch (err) {
      log(`Failed to save the incident log: ${err.message}`);
    }
  }

  /** Opens an entry. Returns its key (kept in the node state so the same entry is closed after a restart). */
  function openIncident(entry) {
    const key = randomBytes(6).toString('hex');
    incidents.push({ key, end: null, endReason: null, ack: null, ...entry });
    // Keep the last MAX_INCIDENTS entries, but never drop open ones.
    while (incidents.length > MAX_INCIDENTS) {
      const idx = incidents.findIndex((i) => i.end !== null);
      if (idx === -1) break;
      incidents.splice(idx, 1);
    }
    saveIncidents();
    return key;
  }

  /** Updates entry fields (for example ack or peak latency). */
  function updateIncident(key, patch) {
    const item = key && incidents.find((i) => i.key === key);
    if (!item) return;
    Object.assign(item, patch);
    saveIncidents();
  }

  /** Closes an entry. reason: recovered | maintenance | removed | modified | superseded | restart-lost */
  function closeIncident(key, reason, end = Date.now(), patch = {}) {
    const item = key && incidents.find((i) => i.key === key);
    if (!item || item.end !== null) return;
    Object.assign(item, patch, { end, endReason: reason });
    saveIncidents();
  }

  /** Entries overlapping [since, now], newest first. */
  function listIncidents({ nodeId = null, since = 0, limit = 100 } = {}) {
    return incidents
      .filter((i) => (!nodeId || i.nodeId === nodeId) && (i.end === null || i.end >= since))
      .sort((a, b) => b.start - a.start)
      .slice(0, limit);
  }

  /** Total outage time of a node over the last windowMs, including an incident that is still open. */
  function downtime(nodeId, windowMs, now = Date.now()) {
    const from = now - windowMs;
    let total = 0, count = 0;
    for (const i of incidents) {
      if (i.nodeId !== nodeId) continue;
      const end = i.end ?? now;
      if (end < from) continue;
      count += 1;
      if (i.kind === 'outage') total += Math.max(0, end - Math.max(i.start, from));
    }
    return { downtimeMs: total, incidents: count };
  }

  /** Closes orphaned open entries, for example when a node was removed while the bot was not running. */
  function closeOrphans(validKeys, now = Date.now()) {
    let changed = false;
    for (const i of incidents) {
      if (i.end === null && !validKeys.has(i.key)) {
        Object.assign(i, { end: now, endReason: 'restart-lost' });
        changed = true;
      }
    }
    if (changed) saveIncidents();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Saves the buckets if anything changed. Called every few minutes and on shutdown. */
  function flush() {
    if (!dirty) return;
    try {
      writeJson(historyPath, data, { pretty: false });
      dirty = false;
    } catch (err) {
      log(`Failed to save the history: ${err.message}`);
    }
  }

  return {
    record, forget, series, stats, availability,
    openIncident, updateIncident, closeIncident, listIncidents, downtime, closeOrphans,
    flush,
  };
}
