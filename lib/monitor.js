import { runCheck } from './checks.js';
import { normalizeTarget, targetChanged, ValidationError } from './validate.js';
import { readJson, writeJson } from './jsonfile.js';

const MAX_MAINTENANCE_MIN = 7 * 24 * 60;
const MAX_SCHEDULE_AHEAD = 90 * 24 * 60 * 60_000;
const HISTORY_FLUSH_MS = 5 * 60_000;

const targetKey = (t) => JSON.stringify([t.type, t.host ?? null, t.port ?? null, t.url ?? null]);

// Node state fields that survive a bot restart (data/state.json).
const PERSISTED = [
  'status', 'lastMs', 'lastOkAt', 'lastCheckAt', 'lastError', 'fails', 'firstFailAt', 'since',
  'declaredAt', 'notices', 'lastAlertAt', 'ack', 'incidentKey', 'lat', 'cause',
];

/**
 * Exit node state and all transition logic.
 *
 * status: 'unknown' → 'up' | 'down'; separately 'maintenance' (planned work, no alerts are raised).
 *   A node goes 'down' after failThreshold consecutive failed checks.
 * Latency (lat): while 'up', a node gets a "high latency" incident after latencyChecks slow checks in a row
 *   and clears it after as many normal ones, so the alert does not flicker.
 *
 * Every incident (outage / latency) is written to the incident log; the entry key is kept in the node state,
 * so after a restart the bot closes the same entry instead of opening a new one.
 *
 * Traffic (sensors): if an external sensor sent a fresh result saying traffic does NOT pass through the node
 *   while the direct check succeeds, it counts as a failed check (cause 'traffic'). Without fresh data the node
 *   is judged by the direct check only; an outage declared on traffic grounds is held until the next sensor
 *   report (otherwise a vanished sensor would look like a recovery).
 *
 * onEvent(type, payload) is called sequentially through a queue and does not block the caller.
 */
export function createMonitor({ config, store, history, statePath, log, onEvent, sensors = null }) {
  const timeoutMs = config.timeoutSeconds * 1000;
  const remindMs = config.remindEveryMinutes * 60_000;
  const noticeMs = config.maintenanceNoticeMinutes * 60_000;
  const states = new Map();
  let queue = Promise.resolve();
  let lastFlush = Date.now();
  let restoredCount = 0;

  const emit = (type, payload) => {
    queue = queue.then(() => onEvent(type, payload)).catch((err) => log(`Failed to send event ${type}:`, err));
    return queue;
  };

  const list = () => [...states.values()];
  const freshLat = () => ({ slow: 0, normal: 0, firstSlowAt: null, incident: null });

  function newState(server) {
    return {
      id: server.id,
      target: { ...server },
      status: 'unknown',
      lastMs: null,
      lastOkAt: null,
      lastCheckAt: null,
      lastError: null,
      fails: 0,
      firstFailAt: null,
      since: null,
      declaredAt: null,   // when the node was declared unavailable (threshold reached)
      notices: 0,         // notifications issued for the current incident
      lastAlertAt: null,
      ack: null,          // { by, at } — incident acknowledged by an administrator
      incidentKey: null,  // key of the outage entry in the incident log
      lat: freshLat(),    // latency: streak counters and the open incident { since, declaredAt, maxMs, thresholdMs, key }
      maintenance: null,  // { until, by, startedAt, scheduleId?, reason? }
      cause: null,        // cause of current failures: 'check' (direct check) | 'traffic' (sensor)
      traffic: null,      // latest fresh sensor result (not persisted across restarts)
      trafficCountedAt: null, // time of the sensor report already counted as a failure
    };
  }

  /** Effective latency threshold of a node, ms. 0 — latency alerts disabled. */
  function latencyThreshold(s) {
    if (Number.isInteger(s.target.latencyMs)) return s.target.latencyMs;
    return s.target.type === 'http' ? config.latencyThresholdHttpMs : config.latencyThresholdMs;
  }

  /** Closes all open incidents of a node in the log (outage and latency). */
  function closeAll(s, reason, now = Date.now()) {
    if (s.incidentKey) history.closeIncident(s.incidentKey, reason, now);
    if (s.lat.incident) history.closeIncident(s.lat.incident.key, reason, now);
    s.incidentKey = null;
    s.lat = freshLat();
  }

  function resetIncident(s, status) {
    Object.assign(s, {
      status, fails: 0, firstFailAt: null, since: status === 'unknown' ? null : Date.now(),
      declaredAt: null, notices: 0, lastAlertAt: null, ack: null, incidentKey: null, lat: freshLat(), cause: null,
    });
  }

  /** Brings states in line with the store, keeping the state of unchanged nodes. */
  function sync() {
    const now = Date.now();
    const next = new Map();
    for (const server of store.servers()) {
      let s = states.get(server.id);
      if (!s || targetChanged(s.target, server)) s = newState(server);
      s.target = { ...server };

      const m = server.maintenance && server.maintenance.until > now ? server.maintenance : null;
      if (m) {
        if (s.status !== 'maintenance') resetIncident(s, 'maintenance');
        s.maintenance = { ...m };
      } else if (s.status === 'maintenance') {
        s.maintenance = null;
        resetIncident(s, 'unknown');
      }
      next.set(server.id, s);
    }
    states.clear();
    for (const [id, s] of next) states.set(id, s);
  }

  // ── State persistence across restarts ────────────────────────────────────

  function persist() {
    const nodes = {};
    for (const s of list()) {
      if (s.status === 'maintenance') continue; // maintenance is stored in store.json
      nodes[s.id] = { targetKey: targetKey(s.target), ...Object.fromEntries(PERSISTED.map((k) => [k, s[k]])) };
    }
    try {
      writeJson(statePath, { savedAt: Date.now(), nodes }, { pretty: false });
    } catch (err) {
      log(`Failed to save the state: ${err.message}`);
    }
  }

  function restore() {
    let saved;
    try {
      saved = readJson(statePath, { nodes: {} });
    } catch (err) {
      log(`The state file is corrupted and will be overwritten: ${err.message}`);
      saved = { nodes: {} };
    }
    const validKeys = new Set();
    for (const s of list()) {
      const p = saved.nodes?.[s.id];
      // Maintenance from store.json takes precedence; a changed check target invalidates the saved state.
      if (!p || s.status === 'maintenance' || p.targetKey !== targetKey(s.target)) continue;
      for (const k of PERSISTED) if (k in p) s[k] = p[k];
      if (s.status === 'maintenance') s.status = 'unknown';
      s.lat = { ...freshLat(), ...(s.lat ?? {}) };
      if (s.incidentKey) validKeys.add(s.incidentKey);
      if (s.lat.incident?.key) validKeys.add(s.lat.incident.key);
      if (s.status === 'down' || s.lat.incident) restoredCount += 1;
    }
    // Log entries nobody will continue (the node was removed or changed while the bot was not running).
    history.closeOrphans(validKeys);
    if (restoredCount) log(`Open incidents restored: ${restoredCount}`);
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  async function networkOk() {
    if (!config.canaries.length) return true;
    const results = await Promise.all(config.canaries.map((c) => runCheck(c, timeoutMs)));
    return results.some((r) => r.ok);
  }

  async function cycle() {
    processSchedules(Date.now());
    expireMaintenance(Date.now());
    sensors?.tick(Date.now());

    // Snapshot: an administrator may remove or change a node while checks are running.
    const snapshot = list();
    const results = await Promise.all(snapshot.map((s) => runCheck(s.target, timeoutMs)));
    const now = Date.now();
    // Traffic verification may be disabled for a node (for example, a configuration server without VLESS).
    const traffic = snapshot.map((s) => (s.target.trafficCheck === false ? null : sensors?.trafficFor(s.id, now) ?? null));

    const realFailure = results.some((r, i) => !r.ok && snapshot[i].status !== 'maintenance');
    if (realFailure && !(await networkOk())) {
      log('⚠ The monitor itself has no connectivity (canaries unreachable): skipping this cycle, no alert raised');
      return;
    }

    const newlyDown = [];
    const recovered = [];
    const degraded = [];
    const perfRestored = [];

    results.forEach((direct, i) => {
      const s = snapshot[i];
      if (states.get(s.id) !== s) return; // node removed or changed during the check
      const t = traffic[i];
      s.traffic = t;
      // The node responds but traffic does not pass: for users this is the same as an outage.
      const r = direct.ok && t && !t.ok
        ? { ok: false, error: `VLESS traffic not passing (sensor ${t.sensors.join(', ')}): ${t.error}`, cause: 'traffic' }
        : { ...direct, cause: 'check' };
      s.lastCheckAt = now;
      s.lastMs = direct.ok ? direct.ms : null;

      if (s.status === 'maintenance') {
        s.lastError = r.ok ? null : r.error;
        return; // checks during maintenance are excluded from history and availability
      }
      if (r.cause === 'traffic') {
        // A sensor report stays valid for several minutes while cycles run every interval. Each report counts
        // once; otherwise a single failed report could reach the alert threshold on its own.
        if (s.trafficCountedAt === t.at) return;
        s.trafficCountedAt = t.at;
      }
      // An outage declared from sensor data is cleared only by a new sensor result,
      // as long as some sensor covers the node at all (see sensors.covers).
      if (r.ok && !t && s.status === 'down' && s.cause === 'traffic'
          && s.target.trafficCheck !== false && sensors?.covers(s.id)) return;
      history.record(s.id, r, now);

      if (r.ok) {
        if (s.status === 'down') {
          recovered.push({
            state: s, since: s.since, until: now, failedChecks: s.fails, responseMs: r.ms, ack: s.ack,
          });
          history.closeIncident(s.incidentKey, 'recovered', now, { failedChecks: s.fails });
        }
        if (s.status !== 'up') s.since = now;
        Object.assign(s, {
          status: 'up', fails: 0, firstFailAt: null, lastError: null, lastOkAt: now,
          declaredAt: null, notices: 0, ack: null, incidentKey: null, cause: null,
        });
        checkLatency(s, r.ms, now, degraded, perfRestored);
        return;
      }

      s.fails++;
      s.lastError = r.error;
      s.cause = r.cause;
      if (s.fails === 1) s.firstFailAt = now;
      if (s.status !== 'down') log(`✗ ${s.target.name}: ${r.error} (${s.fails}/${config.failThreshold})`);
      if (s.status !== 'down' && s.fails >= config.failThreshold) {
        // An outage supersedes latency: the latency incident is closed without a separate notice.
        if (s.lat.incident) history.closeIncident(s.lat.incident.key, 'superseded', now);
        s.lat = freshLat();
        Object.assign(s, { status: 'down', since: s.firstFailAt, declaredAt: now, lastAlertAt: now, notices: 1 });
        s.incidentKey = history.openIncident({
          nodeId: s.id, nodeName: s.target.name, kind: 'outage', start: s.since, declaredAt: now, error: r.error,
          ...(r.cause === 'traffic' ? { cause: 'traffic' } : {}),
        });
        newlyDown.push(s);
      }
    });

    if (newlyDown.length) {
      log(`🚨 Exit nodes unavailable: ${newlyDown.length}`);
      emit('alert', { states: list(), newlyDown });
    }
    if (recovered.length) {
      log(`✅ Restored: ${recovered.map((u) => u.state.target.name).join(', ')}`);
      emit('recovered', { states: list(), recovered });
    }
    if (degraded.length) {
      log(`🟡 High latency: ${degraded.map((s) => s.target.name).join(', ')}`);
      emit('degraded', { states: list(), items: degraded });
    }
    if (perfRestored.length) {
      log(`🟢 Latency back to normal: ${perfRestored.map((u) => u.state.target.name).join(', ')}`);
      emit('performanceRestored', { states: list(), items: perfRestored });
    }
    if (remindMs > 0) {
      // Acknowledged incidents get no repeat notices.
      const due = list().filter((s) => s.status === 'down' && !s.ack && now - s.lastAlertAt >= remindMs);
      if (due.length) {
        due.forEach((s) => { s.lastAlertAt = now; s.notices++; });
        emit('reminder', { states: list(), due });
      }
    }

    persist();
    if (now - lastFlush >= HISTORY_FLUSH_MS) {
      history.flush();
      lastFlush = now;
    }
    await queue;
  }

  function checkLatency(s, ms, now, degraded, perfRestored) {
    const threshold = latencyThreshold(s);
    const lat = s.lat;
    const slow = threshold > 0 && ms > threshold;
    if (slow) {
      lat.slow += 1;
      lat.normal = 0;
      if (lat.slow === 1) lat.firstSlowAt = now;
    } else {
      lat.normal += 1;
      lat.slow = 0;
      lat.firstSlowAt = null;
    }

    if (!lat.incident && lat.slow >= config.latencyChecks) {
      lat.incident = { since: lat.firstSlowAt, declaredAt: now, maxMs: ms, thresholdMs: threshold, key: null };
      lat.incident.key = history.openIncident({
        nodeId: s.id, nodeName: s.target.name, kind: 'latency', start: lat.firstSlowAt, declaredAt: now,
        thresholdMs: threshold, maxMs: ms,
      });
      degraded.push(s);
    } else if (lat.incident) {
      if (ms > lat.incident.maxMs) {
        lat.incident.maxMs = ms;
        history.updateIncident(lat.incident.key, { maxMs: ms });
      }
      if (lat.normal >= config.latencyChecks) {
        const inc = lat.incident;
        history.closeIncident(inc.key, 'recovered', now);
        perfRestored.push({ state: s, since: inc.since, until: now, maxMs: inc.maxMs, thresholdMs: inc.thresholdMs, responseMs: ms });
        lat.incident = null;
      }
    }
  }

  // ── Acknowledgement ──────────────────────────────────────────────────────

  function acknowledge(id, by) {
    const s = states.get(id);
    if (!s) return null;
    if (s.status !== 'down') throw new ValidationError('There is no open incident for this exit node');
    if (s.ack) throw new ValidationError(`Incident already acknowledged by ${s.ack.by}`);
    s.ack = { by, at: Date.now() };
    history.updateIncident(s.incidentKey, { ack: s.ack });
    log(`☑ Incident on "${s.target.name}" acknowledged by ${by}`);
    persist();
    emit('acknowledged', { state: s, states: list() });
    return s;
  }

  // ── Maintenance (immediate) ──────────────────────────────────────────────

  /** Puts nodes into maintenance. Returns the suspended outage incidents. */
  function enterMaintenance(items, now) {
    const suspended = [];
    for (const { state: s, maintenance } of items) {
      if (s.status === 'down') suspended.push({ state: s, since: s.since });
      closeAll(s, 'maintenance', now);
      store.setMaintenance(s.id, maintenance);
    }
    sync();
    persist();
    return suspended;
  }

  function setMaintenance(id, minutes, by) {
    const s = states.get(id);
    if (!s) return null;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MAINTENANCE_MIN) {
      throw new ValidationError(`Maintenance duration must be between 1 and ${MAX_MAINTENANCE_MIN} minutes`);
    }
    const now = Date.now();
    const extended = s.status === 'maintenance';
    const maintenance = { until: now + minutes * 60_000, by, startedAt: extended ? s.maintenance.startedAt : now };
    const suspended = enterMaintenance([{ state: s, maintenance }], now);
    log(`🔧 Maintenance of "${s.target.name}" until ${new Date(maintenance.until).toISOString()} by ${by}`);
    emit('maintenanceStarted', { states: [s], extended, suspended, schedule: null });
    return s;
  }

  /** Ends maintenance for a group of nodes with a single notice. by = null — on schedule. */
  function leaveMaintenance(group, by, now = Date.now()) {
    const items = group.map((s) => ({ state: s, maintenance: s.maintenance }));
    const scheduleIds = new Set(items.map((i) => i.maintenance.scheduleId).filter(Boolean));
    for (const s of group) store.setMaintenance(s.id, null);
    sync();
    persist();
    // A scheduled window is complete when none of its nodes remain in maintenance.
    let schedule = null;
    for (const sid of scheduleIds) {
      const sched = store.getSchedule(sid);
      if (!sched) continue;
      schedule = sched;
      const stillActive = list().some((s) => s.status === 'maintenance' && s.maintenance.scheduleId === sid);
      if (!stillActive && sched.state === 'active') {
        store.updateSchedule(sid, { state: 'completed', completedAt: now, ...(by ? { endedBy: by } : {}) });
      }
    }
    log(`🔧 Maintenance ended (${group.map((s) => s.target.name).join(', ')})${by ? ` by ${by}` : ' on schedule'}`);
    emit('maintenanceEnded', { items, by, schedule, states: list() });
  }

  function endMaintenance(id, by) {
    const s = states.get(id);
    if (!s) return null;
    if (s.status !== 'maintenance') throw new ValidationError('Exit node is not in maintenance');
    leaveMaintenance([s], by);
    return s;
  }

  /** Expired windows: nodes of one schedule are closed with a single message. */
  function expireMaintenance(now) {
    const expired = list().filter((s) => s.status === 'maintenance' && s.maintenance.until <= now);
    const groups = new Map();
    for (const s of expired) {
      const key = s.maintenance.scheduleId ?? `manual:${s.id}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    for (const group of groups.values()) leaveMaintenance(group, null, now);
  }

  // ── Scheduled maintenance ────────────────────────────────────────────────

  const scheduleNodes = (sched) => sched.nodeIds.map((id) => states.get(id)).filter(Boolean);

  function scheduleMaintenance(input, by) {
    const now = Date.now();
    const ids = Array.isArray(input?.nodeIds) ? [...new Set(input.nodeIds.map(String))] : [];
    if (!ids.length) throw new ValidationError('Select at least one exit node');
    if (ids.length > 100) throw new ValidationError('Too many exit nodes selected');
    for (const id of ids) if (!states.has(id)) throw new ValidationError('One of the selected exit nodes no longer exists');
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new ValidationError('Start and end time are required');
    if (start < now - 60_000) throw new ValidationError('Start time must be in the future');
    if (start > now + MAX_SCHEDULE_AHEAD) throw new ValidationError('Maintenance can be scheduled at most 90 days ahead');
    if (end <= start) throw new ValidationError('End time must be after start time');
    if (end - start > MAX_MAINTENANCE_MIN * 60_000) throw new ValidationError('Maintenance window must not exceed 7 days');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > 200) throw new ValidationError('Reason must not exceed 200 characters');

    // If the window starts sooner than the reminder lead time, no separate reminder is needed: the announcement is it.
    // But if announcements are muted, the reminder is always sent (immediately if necessary);
    // otherwise nobody would hear about the work before it starts.
    const announced = store.notificationEnabled('maintenanceScheduled');
    const schedule = store.addSchedule({
      nodeIds: ids, start: Math.max(start, now), end, reason, by, createdAt: now,
      reminderSent: !(noticeMs > 0 && (!announced || start - now > noticeMs)),
    });
    log(`📅 Maintenance scheduled ${new Date(schedule.start).toISOString()} — ${new Date(end).toISOString()} by ${by}`);
    emit('maintenanceScheduled', { schedule, nodes: scheduleNodes(schedule) });
    processSchedules(Date.now());
    return schedule;
  }

  function cancelSchedule(id, by) {
    const sched = store.getSchedule(id);
    if (!sched) return null;
    if (sched.state === 'scheduled') {
      store.updateSchedule(id, { state: 'cancelled', cancelledBy: by, cancelledAt: Date.now() });
      log(`📅 Maintenance cancelled by ${by}`);
      emit('maintenanceCancelled', { schedule: sched, nodes: scheduleNodes(sched), by });
      return sched;
    }
    if (sched.state === 'active') {
      const group = list().filter((s) => s.status === 'maintenance' && s.maintenance.scheduleId === id);
      if (group.length) leaveMaintenance(group, by);
      store.updateSchedule(id, { state: 'completed', completedAt: Date.now(), endedBy: by });
      return sched;
    }
    throw new ValidationError('This maintenance window is already completed or cancelled');
  }

  function processSchedules(now) {
    for (const sched of store.schedules()) {
      if (sched.state === 'active' && sched.end <= now
          && !list().some((s) => s.status === 'maintenance' && s.maintenance.scheduleId === sched.id)) {
        store.updateSchedule(sched.id, { state: 'completed', completedAt: now });
        continue;
      }
      if (sched.state !== 'scheduled') continue;

      if (sched.end <= now) {
        // The whole window passed while the bot was not running: no opening/closing notices.
        store.updateSchedule(sched.id, { state: 'completed', completedAt: now, missed: true });
        continue;
      }
      if (sched.start <= now) {
        activateSchedule(sched, now);
        continue;
      }
      if (!sched.reminderSent && noticeMs > 0 && sched.start - now <= noticeMs) {
        store.updateSchedule(sched.id, { reminderSent: true });
        emit('maintenanceReminder', { schedule: sched, nodes: scheduleNodes(sched) });
      }
    }
  }

  function activateSchedule(sched, now) {
    const nodes = scheduleNodes(sched);
    if (!nodes.length) {
      store.updateSchedule(sched.id, { state: 'cancelled', cancelledAt: now, cancelledBy: 'system (no exit nodes left)' });
      return;
    }
    const items = nodes.map((s) => {
      const cur = s.status === 'maintenance' ? s.maintenance : null;
      // If the node is already in maintenance for longer than this window, keep its current window.
      const keepCurrent = cur && cur.until > sched.end;
      return {
        state: s,
        maintenance: keepCurrent ? cur : {
          until: sched.end, by: sched.by, startedAt: cur?.startedAt ?? now, scheduleId: sched.id, reason: sched.reason,
        },
      };
    });
    const suspended = enterMaintenance(items, now);
    store.updateSchedule(sched.id, { state: 'active', activatedAt: now });
    log(`🔧 Scheduled maintenance started (${nodes.map((s) => s.target.name).join(', ')})`);
    emit('maintenanceStarted', { states: nodes, extended: false, suspended, schedule: sched });
  }

  // ── Exit nodes ───────────────────────────────────────────────────────────

  function addServer(input, by) {
    const server = store.add(input);
    sync();
    persist();
    log(`＋ Exit node "${server.name}" added by ${by}`);
    emit('configChanged', { action: 'added', server: { ...server }, by });
    return states.get(server.id);
  }

  function updateServer(id, input, by) {
    const current = store.get(id);
    if (!current) return null;
    const previous = { ...current };
    const before = states.get(id);
    // Validate the input before changing state, so an error cannot close incidents.
    const clean = normalizeTarget(input);
    const changed = targetChanged(previous, clean);
    // Changing the address or check type resets the state; open incidents are closed administratively.
    const openIncident = changed && before?.status === 'down' ? { id: before.id, since: before.since } : null;
    if (changed && before) closeAll(before, 'modified');
    const server = store.update(id, input);
    sync();
    persist();
    log(`✎ Exit node "${server.name}" modified by ${by}`);
    emit('configChanged', { action: 'modified', server: { ...server }, previous, openIncident, by });
    return states.get(id);
  }

  function removeServer(id, by) {
    const s = states.get(id);
    if (!s) return null;
    const openIncident = s.status === 'down' ? { id: s.id, since: s.since } : null;
    closeAll(s, 'removed');
    const removed = store.remove(id);
    history.forget(id);
    sync();
    persist();
    log(`－ Exit node "${removed.name}" removed by ${by}`);
    emit('configChanged', { action: 'removed', server: removed, openIncident, by });

    // The node is removed from scheduled windows; a window left without nodes is cancelled.
    for (const sched of store.schedules()) {
      if (!sched.nodeIds.includes(id) || (sched.state !== 'scheduled' && sched.state !== 'active')) continue;
      const nodeIds = sched.nodeIds.filter((n) => n !== id);
      store.updateSchedule(sched.id, { nodeIds });
      if (!nodeIds.length && sched.state === 'scheduled') {
        store.updateSchedule(sched.id, { state: 'cancelled', cancelledAt: Date.now(), cancelledBy: by });
        emit('maintenanceCancelled', { schedule: { ...sched, nodeIds: [id] }, nodes: [], removedNames: [removed.name], by });
      }
    }
    return removed;
  }

  /** Node order (display only): the dashboard, /status and alerts follow the store order. */
  function reorderServers(ids, by) {
    if (!Array.isArray(ids) || !store.reorder(ids.map(String))) {
      throw new ValidationError('The list of exit nodes has changed. Please reload and try again.');
    }
    sync();
    log(`↕ Exit node order changed by ${by}`);
    return list();
  }

  /** A one-off check of an arbitrary target (the "Test check" button in the Mini App). */
  async function testTarget(input) {
    return runCheck(normalizeTarget(input, { requireName: false }), timeoutMs);
  }

  /** Before the process exits: save the state and the history. */
  function shutdown() {
    persist();
    history.flush();
  }

  sync();
  restore();
  processSchedules(Date.now());

  return {
    list, get: (id) => states.get(id), sync, cycle, networkOk, latencyThreshold,
    restoredCount: () => restoredCount,
    acknowledge, setMaintenance, endMaintenance,
    scheduleMaintenance, cancelSchedule,
    addServer, updateServer, removeServer, reorderServers, testTarget, shutdown,
  };
}
