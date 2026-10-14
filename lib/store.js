import { randomBytes } from 'node:crypto';
import { normalizeTarget } from './validate.js';
import { readJson, writeJson } from './jsonfile.js';

const MAX_FINISHED_SCHEDULES = 50;
const MAX_MESSAGES = 100;
export const REQUEST_COOLDOWN_MS = 24 * 60 * 60_000; // a new request after a refusal — at most once a day

/**
 * Configuration changed through the Mini App: data/store.json.
 *   servers   — exit nodes (seeded from config.json on the first start);
 *   users     — bot users: access requests, approved, declined; alert subscription;
 *   texts     — notification texts changed by the administrator (only the differences from the defaults);
 *   schedules — scheduled maintenance windows;
 *   muted     — muted notification categories { [id]: true } (everything is enabled by default);
 *   messages  — log of administrator messages to users (the last MAX_MESSAGES);
 *   sensors   — external traffic sensors: { id, name, tokenHash, createdAt, createdBy, lastSeenAt }.
 * Check state (open incidents and so on) is stored separately in data/state.json (see monitor.js).
 *
 * User: { id, name, username, status: pending|approved|denied|revoked, subscribed,
 *                 requestedAt, decidedAt, decidedBy }
 */
export function createStore(path, seedServers = []) {
  const existing = readJson(path, null);
  const data = existing ?? { servers: [], users: [], texts: {}, schedules: [] };
  data.servers ??= [];
  data.users ??= [];
  data.texts ??= {};
  data.schedules ??= [];
  data.muted ??= {};
  data.messages ??= [];
  data.sensors ??= [];
  if (!existing) {
    data.servers = seedServers.map((s) => ({ id: newId(), ...normalizeTarget(s), maintenance: null }));
  }
  // Earlier versions stored only a subscriber list; those users become approved and subscribed.
  if (Array.isArray(data.subscribers)) {
    for (const s of data.subscribers) {
      if (!data.users.some((u) => u.id === s.id)) {
        data.users.push({
          id: s.id, name: s.name, username: null, status: 'approved', subscribed: true,
          requestedAt: s.since ?? Date.now(), decidedAt: s.since ?? Date.now(), decidedBy: 'migration',
        });
      }
    }
    delete data.subscribers;
  }
  // Write on every start: missing write permissions show up immediately, not on the first dashboard action.
  save();

  function newId(list = data.servers) {
    let id;
    do { id = randomBytes(4).toString('hex'); } while (list.some((s) => s.id === id));
    return id;
  }

  function save() {
    writeJson(path, data);
  }

  const find = (id) => data.servers.find((s) => s.id === id);

  return {
    servers: () => data.servers,
    get: find,

    add(input) {
      const server = { id: newId(), ...normalizeTarget(input), maintenance: null };
      data.servers.push(server);
      save();
      return server;
    },

    update(id, input) {
      const server = find(id);
      if (!server) return null;
      const clean = normalizeTarget(input);
      for (const key of ['host', 'port', 'url', 'latencyMs', 'trafficCheck']) delete server[key];
      Object.assign(server, clean);
      save();
      return server;
    },

    /** New node order. ids — the same IDs as now, in the new order; otherwise null (the list has changed meanwhile). */
    reorder(ids) {
      const current = data.servers.map((s) => s.id);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) {
        return null;
      }
      data.servers = ids.map((id) => find(id));
      save();
      return data.servers;
    },

    remove(id) {
      const idx = data.servers.findIndex((s) => s.id === id);
      if (idx === -1) return null;
      const [removed] = data.servers.splice(idx, 1);
      save();
      return removed;
    },

    setMaintenance(id, maintenance) {
      const server = find(id);
      if (!server) return null;
      server.maintenance = maintenance;
      save();
      return server;
    },

    texts: () => data.texts,

    /** Replaces the whole set of changed texts (already validated by validateTexts). */
    setTexts(texts) {
      data.texts = texts;
      save();
    },

    // ── Scheduled maintenance ───────────────────────────────────────────────
    // state: scheduled → active → completed;  scheduled → cancelled;  active → completed (ended early)

    schedules: () => data.schedules,
    getSchedule: (id) => data.schedules.find((s) => s.id === id),

    addSchedule(schedule) {
      const item = { id: newId(data.schedules), state: 'scheduled', reminderSent: false, ...schedule };
      data.schedules.push(item);
      save();
      return item;
    },

    updateSchedule(id, patch) {
      const item = data.schedules.find((s) => s.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      // Keep a limited number of completed and cancelled windows for the dashboard log.
      const finished = data.schedules.filter((s) => s.state === 'completed' || s.state === 'cancelled');
      if (finished.length > MAX_FINISHED_SCHEDULES) {
        const drop = new Set(finished.sort((a, b) => a.end - b.end)
          .slice(0, finished.length - MAX_FINISHED_SCHEDULES).map((s) => s.id));
        data.schedules = data.schedules.filter((s) => !drop.has(s.id));
      }
      save();
      return item;
    },

    // ── Users and access ───────────────────────────────────────────────────

    users: () => data.users,
    getUser: (id) => data.users.find((u) => u.id === id) ?? null,
    isApproved: (id) => data.users.some((u) => u.id === id && u.status === 'approved'),
    /** Alert recipients: approved and subscribed. */
    subscribers: () => data.users.filter((u) => u.status === 'approved' && u.subscribed),
    isSubscribed: (id) => data.users.some((u) => u.id === id && u.status === 'approved' && u.subscribed),

    /**
     * Access request. Returns { user, created }:
     * created = false if a request is already pending, the user is already approved, or was refused less than a day ago.
     */
    requestAccess(id, name, username, now = Date.now()) {
      let user = data.users.find((u) => u.id === id);
      if (user) {
        user.name = name;
        user.username = username ?? null;
        const recentlyDenied = (user.status === 'denied' || user.status === 'revoked')
          && now - (user.decidedAt ?? 0) < REQUEST_COOLDOWN_MS;
        if (user.status === 'pending' || user.status === 'approved' || recentlyDenied) {
          save();
          return { user, created: false };
        }
        Object.assign(user, { status: 'pending', requestedAt: now, decidedAt: null, decidedBy: null });
      } else {
        user = { id, name, username: username ?? null, status: 'pending', subscribed: false, requestedAt: now, decidedAt: null, decidedBy: null };
        data.users.push(user);
      }
      save();
      return { user, created: true };
    },

    /** status: approved | denied | revoked. Approval also subscribes the user to alerts. */
    decide(id, status, by, now = Date.now()) {
      const user = data.users.find((u) => u.id === id);
      if (!user) return null;
      Object.assign(user, { status, decidedAt: now, decidedBy: by, subscribed: status === 'approved' });
      save();
      return user;
    },

    /** An administrator or group member not yet on the list gets an approved record. */
    ensureApproved(id, name, username, by = 'system') {
      let user = data.users.find((u) => u.id === id);
      if (!user) {
        user = { id, name, username: username ?? null, status: 'approved', subscribed: false, requestedAt: Date.now(), decidedAt: Date.now(), decidedBy: by };
        data.users.push(user);
        save();
      }
      return user;
    },

    setSubscribed(id, subscribed) {
      const user = data.users.find((u) => u.id === id);
      if (!user || user.subscribed === subscribed) return user;
      user.subscribed = subscribed;
      save();
      return user;
    },

    // ── Notification categories ────────────────────────────────────────────

    notificationEnabled: (id) => !data.muted[id],
    muted: () => data.muted,
    /** settings — { [id]: boolean } (ids already validated). Returns the ids that changed. */
    setNotifications(settings) {
      const changed = [];
      for (const [id, enabled] of Object.entries(settings)) {
        if (!data.muted[id] === enabled) continue;
        if (enabled) delete data.muted[id]; else data.muted[id] = true;
        changed.push(id);
      }
      if (changed.length) save();
      return changed;
    },

    // ── Administrator messages ─────────────────────────────────────────────

    messages: () => data.messages,
    addMessage(message) {
      const item = { id: newId(data.messages), ...message };
      data.messages.push(item);
      if (data.messages.length > MAX_MESSAGES) data.messages.splice(0, data.messages.length - MAX_MESSAGES);
      save();
      return item;
    },

    // ── Traffic sensors ────────────────────────────────────────────────────

    sensors: () => data.sensors,
    getSensor: (id) => data.sensors.find((s) => s.id === id) ?? null,
    addSensor(sensor) {
      const item = { id: newId(data.sensors), lastSeenAt: null, ...sensor };
      data.sensors.push(item);
      save();
      return item;
    },
    updateSensor(id, patch) {
      const item = data.sensors.find((s) => s.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      save();
      return item;
    },
    removeSensor(id) {
      const idx = data.sensors.findIndex((s) => s.id === id);
      if (idx === -1) return null;
      const [removed] = data.sensors.splice(idx, 1);
      save();
      return removed;
    },
  };
}
