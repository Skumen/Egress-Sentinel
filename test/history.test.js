import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHistory, MIN5, HOUR, DAY } from '../lib/history.js';

const dir = mkdtempSync(join(tmpdir(), 'egress-history-'));
const paths = { historyPath: join(dir, 'history.json'), incidentsPath: join(dir, 'incidents.json') };
let h = createHistory(paths);

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0); // aligned
// 3 days of checks every minute: ok, 50 ms; between hour 10 and 11 of day 2 — all fail; day 3 hours 5-7 — monitor off (gap)
for (let t = T0; t < T0 + 3 * DAY; t += 60_000) {
  const h0 = (t - T0) / HOUR;
  if (h0 >= 48 + 5 && h0 < 48 + 7) continue; // gap
  const fail = h0 >= 24 + 10 && h0 < 24 + 11;
  h.record('n1', { ok: !fail, ms: fail ? undefined : 50 + (Math.floor(h0) % 2 ? 10 : 0) }, t);
}
const now = T0 + 3 * DAY;

// 24h series: 5-min steps, gap of 2h => 288 - 24 = 264 points
let s = h.series('n1', '24h', now);
assert.equal(s.step, MIN5);
assert.equal(s.points.length, 288 - 24, 'gap produces missing points');
assert.equal(s.points[0].checks, 5);
assert.ok(s.points.every((p) => p.availability === 1));
// 7d series: hourly, only 72h of data minus 2h gap
s = h.series('n1', '7d', now);
assert.equal(s.points.length, 70);
const failHour = s.points.find((p) => p.t === T0 + 34 * HOUR);
assert.equal(failHour.availability, 0);
assert.equal(failHour.avgMs, null);
// 30d: 4h steps
s = h.series('n1', '30d', now);
assert.equal(s.step, 4 * HOUR);
assert.equal(s.points.length, 18);

// availability over 30d: 60 failed of (72h-2h)*60 checks
const total = 70 * 60;
assert.ok(Math.abs(h.availability('n1', 30 * DAY, now) - (total - 60) / total) < 1e-9);
// last 24h has no failures
assert.equal(h.stats('n1', DAY, now).availability, 1);
assert.equal(h.stats('n1', DAY, now).maxMs, 60);
assert.equal(h.stats('n1', DAY, now).avgMs, 55);

// pruning: m5 keeps 48h
h.record('n1', { ok: true, ms: 1 }, now + 49 * HOUR);
assert.ok(h.series('n1', '24h', now + 49 * HOUR).points.length === 1);

// incidents & downtime
const k = h.openIncident({ nodeId: 'n1', nodeName: 'NL-01', kind: 'outage', start: now - 2 * HOUR });
h.openIncident({ nodeId: 'n1', nodeName: 'NL-01', kind: 'latency', start: now - 5 * HOUR });
let d = h.downtime('n1', DAY, now);
assert.equal(d.downtimeMs, 2 * HOUR);
assert.equal(d.incidents, 2);
h.closeIncident(k, 'recovered', now - HOUR);
d = h.downtime('n1', DAY, now);
assert.equal(d.downtimeMs, HOUR);
assert.equal(h.listIncidents({ nodeId: 'n1' })[0].kind, 'outage'); // newest first by start
h.flush();

// persistence: reload from disk
assert.ok(existsSync(paths.historyPath) && existsSync(paths.incidentsPath));
h = createHistory(paths);
assert.equal(h.listIncidents().length, 2);
assert.equal(h.listIncidents().find((i) => i.key === k).endReason, 'recovered');
assert.equal(h.series('n1', '7d', now).points.length, 70);
// orphans: latency incident not referenced by any state -> closed
h.closeOrphans(new Set(), now);
assert.ok(h.listIncidents().every((i) => i.end !== null));
console.log('history: all checks passed');
