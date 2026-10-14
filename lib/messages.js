// All bot message templates live here.
// Messages are sent with parse_mode=HTML: <b>, <i>, <code>, <pre> are supported.
// Anything coming from outside (node names, error texts, user names) must go through esc().
// Editable wording (titles, introductions, actions, footer) comes from lib/texts.js via t().

import { DEFAULT_TEXTS } from './texts.js';

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
}

const METHOD = {
  ping: () => 'ICMP echo (ping)',
  tcp: (t) => `TCP connect, port ${t.port}`,
  http: () => 'HTTP(S) GET',
};
export const method = (t) => METHOD[t.type]?.(t) ?? t.type;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtMs = (ms) => (ms == null ? 'n/a' : `${Math.round(ms)} ms`);

/** Monospace key/value block; keys are padded so values line up. */
const table = (rows) => {
  const list = rows.filter(Boolean);
  const width = Math.max(...list.map(([k]) => k.length)) + 2;
  return `<pre>${list.map(([k, v]) => esc(k.padEnd(width)) + esc(v)).join('\n')}</pre>`;
};

/**
 * texts        — texts changed by the administrator (see lib/texts.js), read for every message;
 * availability — 30-day availability of a node (0..1 or null) from the check history.
 */
export function createMessages({
  adminName, monitorName, timezone,
  intervalSeconds, timeoutSeconds, failThreshold, remindEveryMinutes, canaries,
  latencyThresholdMs, latencyThresholdHttpMs, latencyChecks, maintenanceNoticeMinutes,
  texts = () => ({}),
  availability = () => null,
}) {
  const admin = `<b>${esc(adminName)}</b>`;

  /**
   * Editable text. It is escaped as a whole first (so an administrator cannot break the HTML markup and with it
   * message delivery), then {placeholder} values are substituted.
   * vars — ready-made HTML. An empty string means the block is omitted.
   */
  const t = (key, vars = {}) => {
    const raw = texts()[key] ?? DEFAULT_TEXTS[key];
    const all = { admin, monitor: esc(monitorName), ...vars };
    return esc(raw).replace(/\{(\w+)\}/g, (m, name) => (name in all ? all[name] : m));
  };
  const footer = () => {
    const f = t('common.footer');
    return f ? [`<i>${f}</i>`] : [];
  };
  /** A paragraph followed by a blank line; empty text is omitted entirely. */
  const para = (text) => (text ? [text, ''] : []);
  const italic = (text) => (text ? [`<i>${text}</i>`] : []);
  const countVars = (states, down) => ({
    affected: String(down.length),
    monitored: plural(states.length, 'monitored exit node'),
  });
  const actionsBlock = (key) => {
    const a = t(key);
    return a ? ['<b>REQUIRED ACTIONS</b>', a, ''] : [];
  };

  const partsFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const parts = (ts) => Object.fromEntries(partsFmt.formatToParts(ts).map((x) => [x.type, x.value]));

  const fmt = (ts) => {
    const p = parts(ts);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };
  const fmtShort = (ts) => {
    const p = parts(ts);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  const tzLabel = (ts) => (offsetFmt.formatToParts(ts).find((p) => p.type === 'timeZoneName')?.value ?? '')
    .replace('GMT', 'UTC') || 'UTC';
  const fmtTz = (ts) => `${fmt(ts)} ${tzLabel(ts)}`;
  const fmtShortTz = (ts) => `${fmtShort(ts)} ${tzLabel(ts)}`;

  const ref = (prefix, since, id, withTime = true) => {
    const p = parts(since);
    return `${prefix}-${p.year}${p.month}${p.day}${withTime ? `-${p.hour}${p.minute}` : ''}-${id.slice(0, 4).toUpperCase()}`;
  };
  /** Outage: INC-YYYYMMDD-HHMM-XXXX; latency: LAT-…; scheduled maintenance: MNT-YYYYMMDD-XXXX. */
  const incidentId = (since, id) => ref('INC', since, id);
  const latencyId = (since, id) => ref('LAT', since, id);
  const maintenanceRef = (sched) => ref('MNT', sched.start, sched.id, false);
  /** Administrator's message: MSG-YYYYMMDD-HHMM-XXXX. */
  const messageRef = (at, id) => ref('MSG', at, id);

  const pct = (s) => {
    const a = s.availabilityOverride !== undefined ? s.availabilityOverride : availability(s.id);
    return a == null ? 'n/a' : `${(a * 100).toFixed(2)}%`;
  };
  const isDegraded = (s) => s.status === 'up' && s.fails === 0 && !!s.lat?.incident;

  function severity(states) {
    const active = states.filter((s) => s.status !== 'maintenance');
    const down = active.filter((s) => s.status === 'down').length;
    if (down === 0) return active.some(isDegraded) ? 'SEV-3 / MINOR' : 'NONE';
    if (down === active.length) return 'SEV-1 / CRITICAL';
    if (down * 2 >= active.length) return 'SEV-2 / MAJOR';
    return 'SEV-3 / MINOR';
  }

  const nextNotice = () => (remindEveryMinutes > 0
    ? `Next notification: upon recovery, or in ${remindEveryMinutes} min if the outage persists and remains unacknowledged.`
    : 'Next notification: upon recovery.');

  const issuedTable = (now, extra = []) => table([
    ...extra,
    ['Issued', fmtTz(now)],
    ['Issued by', monitorName],
    ['Administrator', adminName],
  ]);

  function summary(states) {
    const count = (st) => states.filter((s) => s.status === st).length;
    const degraded = states.filter(isDegraded).length;
    const pending = count('unknown');
    return [
      `Operational: ${count('up') - degraded}`,
      degraded ? `Degraded: ${degraded}` : null,
      `Unavailable: ${count('down')}`,
      `Maintenance: ${count('maintenance')}`,
      pending ? `Pending: ${pending}` : null,
      `Total: ${states.length}`,
    ].filter(Boolean).join(' · ');
  }

  /** Result of the external traffic check (VLESS via sensor). */
  const trafficText = (tr) => (tr.ok
    ? `Passing · ${fmtMs(tr.ms)} · sensor ${tr.sensors.join(', ')}`
    : `NOT PASSING · sensor ${tr.sensors.join(', ')}`);

  /** Detailed card for an unavailable exit node. */
  function outageCard(s, n, now) {
    return `<b>${n}. ${esc(s.target.name)}</b>\n` + table([
      ['Incident ID', incidentId(s.since, s.id)],
      ['Notice No.', String(s.notices)],
      ['Check method', method(s.target)],
      s.cause === 'traffic' ? ['Direct check', 'Passing — the exit node responds'] : null,
      s.traffic ? ['Traffic check', trafficText(s.traffic)] : null,
      ['Error', s.lastError],
      ['Failed checks', `${s.fails} consecutive (threshold ${failThreshold})`],
      ['First failure', fmt(s.since)],
      ['Declared', fmt(s.declaredAt)],
      ['Last success', s.lastOkAt ? fmt(s.lastOkAt) : 'none on record'],
      ['Duration', fmtDuration(now - s.since)],
      ['Availability', `${pct(s)} (30 d)`],
      ['Acknowledged', s.ack ? `${s.ack.by}, ${fmt(s.ack.at)}` : 'NO'],
    ]);
  }

  /** One-line status of an exit node. */
  function statusLine(s, now) {
    const name = `<b>${esc(s.target.name)}</b>`;
    switch (s.status) {
      case 'down':
        return `❌ ${name} — UNAVAILABLE since ${fmt(s.since)} (${fmtDuration(now - s.since)}) · `
          + `${esc(s.lastError)} · <code>${incidentId(s.since, s.id)}</code>`
          + (s.ack ? ` · ACKNOWLEDGED by ${esc(s.ack.by)}` : '');
      case 'maintenance':
        return `🔧 ${name} — MAINTENANCE until ${fmtShort(s.maintenance.until)} · authorised by ${esc(s.maintenance.by)}`
          + (s.maintenance.reason ? ` · ${esc(s.maintenance.reason)}` : '');
      case 'up':
        if (s.fails > 0) {
          return `⚠️ ${name} — UNSTABLE · ${s.fails}/${failThreshold} failed checks · ${esc(s.lastError)}`;
        }
        if (s.lat?.incident) {
          return `🟡 ${name} — DEGRADED · ${fmtMs(s.lastMs)} (threshold ${s.lat.incident.thresholdMs} ms) · `
            + `<code>${latencyId(s.lat.incident.since, s.id)}</code>`;
        }
        return `✅ ${name} — OPERATIONAL · ${fmtMs(s.lastMs)}${s.traffic?.ok ? ' · traffic verified' : ''} · availability ${pct(s)} (30 d)`;
      default:
        return `⏳ ${name} — PENDING · not yet checked`;
    }
  }

  const nodeNames = (nodes) => nodes.map((s) => s.target.name).join(', ');

  /** Table describing a scheduled maintenance window. */
  function scheduleTable(sched, nodes, extra = []) {
    return table([
      ['Reference', maintenanceRef(sched)],
      ['Exit nodes', nodes.length ? nodeNames(nodes) : '—'],
      ['Window start', fmtShortTz(sched.start)],
      ['Window end', fmtShortTz(sched.end)],
      ['Duration', fmtDuration(sched.end - sched.start)],
      sched.reason ? ['Reason', sched.reason] : null,
      ['Scheduled by', sched.by],
      ...extra,
    ]);
  }
  const scheduleVars = (sched, nodes) => ({
    nodes: esc(nodes.length ? nodeNames(nodes) : '—'),
    start: esc(fmtShortTz(sched.start)),
    end: esc(fmtShortTz(sched.end)),
  });

  return {
    incidentId,
    latencyId,
    maintenanceRef,
    messageRef,
    method,

    /** One or more exit nodes have just been declared unavailable. */
    alert(states, now = Date.now()) {
      const down = states.filter((s) => s.status === 'down');
      const others = states.filter((s) => s.status !== 'down');
      const lines = [
        `🔴 <b>${t('alert.title')}</b>`,
        issuedTable(now, [['Status', 'OPEN'], ['Severity', severity(states)]]),
        ...para(t('alert.intro', countVars(states, down))),
        '<b>AFFECTED EXIT NODES</b>',
        down.map((s, i) => outageCard(s, i + 1, now)).join('\n'),
      ];
      if (others.length) {
        lines.push('<b>OTHER EXIT NODES</b>', ...others.map((s) => statusLine(s, now)), '');
      }
      lines.push(
        '<b>SUMMARY</b>',
        summary(states),
        '',
        ...actionsBlock('alert.actions'),
        `<i>${nextNotice()}</i>`,
        ...footer(),
      );
      return lines.join('\n');
    },

    /** recovered = [{ state, since, until, failedChecks, responseMs, ack }] */
    recovered(states, recovered, now = Date.now()) {
      const stillDown = states.filter((s) => s.status === 'down');
      const lines = [
        `🟢 <b>${t('recovered.title')}</b>`,
        issuedTable(now, [['Status', stillDown.length ? 'PARTIALLY RESOLVED' : 'RESOLVED']]),
        ...para(t('recovered.intro', { restored: plural(recovered.length, 'exit node') })),
        '<b>RESTORED EXIT NODES</b>',
        recovered.map(({ state, since, until, failedChecks, responseMs, ack }, i) =>
          `<b>${i + 1}. ${esc(state.target.name)}</b>\n` + table([
            ['Incident ID', incidentId(since, state.id)],
            ['Check method', method(state.target)],
            ['Outage start', fmt(since)],
            ['Restored', fmt(until)],
            ['Total downtime', fmtDuration(until - since)],
            ['Failed checks', String(failedChecks)],
            ['Response time', fmtMs(responseMs)],
            ['Availability', `${pct(state)} (30 d)`],
            ['Acknowledged', ack ? `${ack.by}, ${fmt(ack.at)}` : 'NO'],
          ])).join('\n'),
      ];
      if (stillDown.length) {
        lines.push(
          '<b>STILL UNAVAILABLE</b>',
          ...stillDown.map((s) => statusLine(s, now)),
          '',
          '<b>SUMMARY</b>',
          summary(states),
          '',
          ...italic(t('recovered.partial')),
          `<i>${nextNotice()}</i>`,
        );
      } else {
        lines.push('<b>SUMMARY</b>', summary(states), '', ...italic(t('recovered.closed')));
      }
      lines.push(...footer());
      return lines.join('\n');
    },

    /** Periodic update while an unacknowledged outage persists. */
    reminder(states, due, now = Date.now()) {
      return [
        `🟠 <b>${t('reminder.title')}</b>`,
        issuedTable(now, [['Status', 'OPEN — UNACKNOWLEDGED'], ['Severity', severity(states)]]),
        ...para(t('reminder.intro', countVars(states, states.filter((s) => s.status === 'down')))),
        '<b>AFFECTED EXIT NODES</b>',
        due.map((s, i) => outageCard(s, i + 1, now)).join('\n'),
        '<b>SUMMARY</b>',
        summary(states),
        '',
        ...actionsBlock('reminder.actions'),
        `<i>${nextNotice()}</i>`,
        ...footer(),
      ].join('\n');
    },

    acknowledged(s, now = Date.now()) {
      return [
        `☑️ <b>${t('acknowledged.title')}</b>`,
        issuedTable(now, [['Status', 'OPEN — ACKNOWLEDGED']]),
        table([
          ['Incident ID', incidentId(s.since, s.id)],
          ['Exit node', s.target.name],
          ['Check method', method(s.target)],
          ['Outage start', fmt(s.since)],
          ['Duration', fmtDuration(now - s.since)],
          ['Acknowledged', fmt(s.ack.at)],
          ['Acknowledged by', s.ack.by],
        ]),
        ...para(t('acknowledged.body', { node: esc(s.target.name), acknowledged_by: esc(s.ack.by) })),
        ...footer(),
      ].join('\n');
    },

    /** High latency declared. items — states with lat.incident. */
    degraded(states, items, now = Date.now()) {
      return [
        `🟡 <b>${t('degraded.title')}</b>`,
        issuedTable(now, [['Status', 'OPEN'], ['Severity', severity(states)]]),
        ...para(t('degraded.intro', { nodes: esc(nodeNames(items)) })),
        '<b>AFFECTED EXIT NODES</b>',
        items.map((s, i) => {
          const inc = s.lat.incident;
          return `<b>${i + 1}. ${esc(s.target.name)}</b>\n` + table([
            ['Incident ID', latencyId(inc.since, s.id)],
            ['Check method', method(s.target)],
            ['Response time', fmtMs(s.lastMs)],
            ['Threshold', `${inc.thresholdMs} ms`],
            ['Peak', fmtMs(inc.maxMs)],
            ['Slow checks', `${latencyChecks} consecutive`],
            ['Started', fmt(inc.since)],
            ['Declared', fmt(inc.declaredAt)],
          ]);
        }).join('\n'),
        '<b>SUMMARY</b>',
        summary(states),
        '',
        ...actionsBlock('degraded.actions'),
        '<i>Next notification: when response time returns to normal.</i>',
        ...footer(),
      ].join('\n');
    },

    /** items = [{ state, since, until, maxMs, thresholdMs, responseMs }] */
    performanceRestored(states, items, now = Date.now()) {
      return [
        `🟢 <b>${t('perfRestored.title')}</b>`,
        issuedTable(now, [['Status', 'RESOLVED']]),
        items.map(({ state, since, until, maxMs, thresholdMs, responseMs }, i) =>
          `<b>${i + 1}. ${esc(state.target.name)}</b>\n` + table([
            ['Incident ID', latencyId(since, state.id)],
            ['Started', fmt(since)],
            ['Restored', fmt(until)],
            ['Duration', fmtDuration(until - since)],
            ['Peak', fmtMs(maxMs)],
            ['Response time', fmtMs(responseMs)],
            ['Threshold', `${thresholdMs} ms`],
          ])).join('\n'),
        ...para(t('perfRestored.body', { nodes: esc(items.map((i) => i.state.target.name).join(', ')) })),
        ...footer(),
      ].join('\n');
    },

    /** Maintenance began: manual (one node, schedule = null) or scheduled (one or several nodes). */
    maintenanceStarted({ states: nodes, extended, suspended = [], schedule }, now = Date.now()) {
      const m = nodes[0].maintenance;
      const lines = [
        `🔧 <b>${t(extended ? 'maintenance.extendedTitle' : 'maintenance.openedTitle')}</b>`,
        issuedTable(now),
        table([
          schedule ? ['Reference', maintenanceRef(schedule)] : null,
          [nodes.length > 1 ? 'Exit nodes' : 'Exit node', nodeNames(nodes)],
          nodes.length === 1 ? ['Check method', method(nodes[0].target)] : null,
          ['Window start', fmt(m.startedAt)],
          ['Window end', fmt(m.until)],
          ['Duration', fmtDuration(m.until - m.startedAt)],
          m.reason ? ['Reason', m.reason] : null,
          ['Authorised by', m.by],
        ]),
        ...para(t('maintenance.openedBody', { nodes: esc(nodeNames(nodes)) })),
      ];
      for (const { state, since } of suspended) {
        lines.push(`Open incident <code>${incidentId(since, state.id)}</code> has been suspended and will not be escalated further.`);
      }
      if (suspended.length) lines.push('');
      lines.push(...footer());
      return lines.join('\n');
    },

    /** items = [{ state, maintenance }]; by = null when the window expired on schedule. */
    maintenanceEnded({ items, by, schedule }, now = Date.now()) {
      const startedAt = Math.min(...items.map((i) => i.maintenance.startedAt));
      return [
        `🔧 <b>${t('maintenance.closedTitle')}</b>`,
        issuedTable(now),
        table([
          schedule ? ['Reference', maintenanceRef(schedule)] : null,
          [items.length > 1 ? 'Exit nodes' : 'Exit node', items.map((i) => i.state.target.name).join(', ')],
          ['Window start', fmt(startedAt)],
          ['Window end', fmt(now)],
          ['Duration', fmtDuration(now - startedAt)],
          ['Closed by', by ?? 'Scheduled expiry'],
        ]),
        ...para(t('maintenance.closedBody', { nodes: esc(items.map((i) => i.state.target.name).join(', ')) })),
        ...footer(),
      ].join('\n');
    },

    /** Announcement published as soon as a window is scheduled. */
    maintenanceScheduled({ schedule, nodes }, now = Date.now()) {
      return [
        `📅 <b>${t('scheduled.announceTitle')}</b>`,
        issuedTable(now, [['Status', 'SCHEDULED']]),
        scheduleTable(schedule, nodes, [['Starts in', fmtDuration(Math.max(0, schedule.start - now))]]),
        ...para(t('scheduled.announceBody', scheduleVars(schedule, nodes))),
        ...(maintenanceNoticeMinutes > 0 && schedule.start - now > maintenanceNoticeMinutes * 60_000
          ? [`<i>A reminder will be issued ${maintenanceNoticeMinutes} min before the window starts.</i>`] : []),
        ...footer(),
      ].join('\n');
    },

    maintenanceReminder({ schedule, nodes }, now = Date.now()) {
      return [
        `📅 <b>${t('scheduled.reminderTitle')}</b>`,
        issuedTable(now, [['Status', 'STARTING SOON']]),
        scheduleTable(schedule, nodes, [['Starts in', fmtDuration(Math.max(0, schedule.start - now))]]),
        ...para(t('scheduled.reminderBody', scheduleVars(schedule, nodes))),
        ...footer(),
      ].join('\n');
    },

    maintenanceCancelled({ schedule, nodes, removedNames = [], by }, now = Date.now()) {
      const shown = nodes.length ? nodes : removedNames.map((name) => ({ target: { name } }));
      return [
        `📅 <b>${t('scheduled.cancelledTitle')}</b>`,
        issuedTable(now, [['Status', 'CANCELLED']]),
        scheduleTable(schedule, shown, [['Cancelled by', by]]),
        ...(removedNames.length ? ['The window was cancelled because its exit nodes were withdrawn from monitoring.', ''] : []),
        ...para(t('scheduled.cancelledBody', scheduleVars(schedule, shown))),
        ...footer(),
      ].join('\n');
    },

    /** action: 'added' | 'modified' | 'removed' */
    configChanged({ action, server, previous, openIncident, by }, now = Date.now()) {
      const titles = { added: 'EXIT NODE ADDED', modified: 'EXIT NODE MODIFIED', removed: 'EXIT NODE REMOVED' };
      const rows = [
        ['Change', titles[action]],
        ['Exit node', server.name],
        previous && previous.name !== server.name ? ['Previous name', previous.name] : null,
        ['Check method', method(server)],
        previous && method(previous) !== method(server) ? ['Previous method', method(previous)] : null,
        previous && previous.latencyMs !== server.latencyMs
          ? ['Latency threshold', server.latencyMs === undefined ? 'default' : server.latencyMs === 0 ? 'disabled' : `${server.latencyMs} ms`]
          : null,
        previous && (previous.trafficCheck !== false) !== (server.trafficCheck !== false)
          ? ['Traffic check', server.trafficCheck === false ? 'disabled' : 'enabled']
          : null,
        ['Changed by', by],
        ['Effective', 'Immediately'],
      ];
      const lines = ['🛠 <b>CONFIGURATION CHANGE NOTICE</b>', issuedTable(now), table(rows)];
      if (action === 'added') lines.push('The exit node has been placed under monitoring.');
      if (action === 'modified') lines.push('Monitoring parameters of the exit node have been updated.');
      if (action === 'removed') lines.push('The exit node has been withdrawn from monitoring.');
      if (openIncident) {
        lines.push(`Open incident <code>${incidentId(openIncident.since, openIncident.id)}</code> has been closed administratively.`);
      }
      lines.push('', ...footer());
      return lines.join('\n');
    },

    /** The administrator changed notification texts. sections — names of the affected sections. */
    templatesChanged({ sections, by }, now = Date.now()) {
      return [
        '🛠 <b>CONFIGURATION CHANGE NOTICE</b>',
        issuedTable(now),
        table([
          ['Change', 'NOTIFICATION TEMPLATES UPDATED'],
          ['Sections', sections.join(', ')],
          ['Changed by', by],
          ['Effective', 'Immediately'],
        ]),
        'The wording of the notifications listed above has been revised by the administrator.',
        '',
        ...footer(),
      ].join('\n');
    },

    /** Message written by the administrator in the dashboard. text/subject — plain text, escaped here. */
    adminMessage({ subject, text, from, ref }, now = Date.now()) {
      return [
        '📨 <b>NOTICE FROM THE ADMINISTRATOR</b>',
        table([
          ['Reference', ref],
          ['From', `${from}, administrator`],
          ['Issued', fmtTz(now)],
        ]),
        ...(subject ? [`<b>${esc(subject)}</b>`, ''] : []),
        esc(text),
        '',
        '<i>This message has been issued by the administrator through the monitoring service.</i>',
      ].join('\n');
    },

    /**
     * Traffic sensor state change (administrators only).
     * status: connected | online | impaired | offline;  previous — the former state.
     */
    sensorStatus({ sensor, status, previous, reason, lastAt, nodes = [], unknown = [] }, now = Date.now()) {
      const title = {
        connected: '📡 <b>TRAFFIC SENSOR CONNECTED</b>',
        online: '📡 <b>TRAFFIC SENSOR RESTORED</b>',
        impaired: '📡 <b>TRAFFIC SENSOR IMPAIRED</b>',
        offline: '📡 <b>TRAFFIC SENSOR OFFLINE</b>',
      }[status];
      const body = {
        connected: 'The sensor has submitted its first report. Traffic through the exit nodes listed above is now verified externally.',
        online: 'The sensor is reporting normally again. External traffic verification has resumed.',
        impaired: 'The sensor is reporting, but cannot perform traffic checks on its side. Its results are disregarded; '
          + 'exit nodes are evaluated by the direct check only. No outage notifications will be issued on the basis of this sensor.',
        offline: 'No reports have been received from the sensor within the permitted interval. Exit nodes are evaluated by the direct check only; '
          + 'outages previously declared on the basis of this sensor remain open until a new report is received.',
      }[status];
      return [
        title,
        issuedTable(now, [['Status', status === 'connected' ? 'ONLINE' : status.toUpperCase()]]),
        table([
          ['Sensor', sensor.name],
          ['Previous state', previous.toUpperCase()],
          ['Last report', lastAt ? fmt(lastAt) : 'none'],
          reason ? ['Reason', reason] : null,
          ['Exit nodes', nodes.length ? nodes.join(', ') : '—'],
          unknown.length ? ['Unknown node IDs', unknown.join(', ')] : null,
        ]),
        body,
        '',
        ...footer(),
      ].join('\n');
    },

    /** schedules — upcoming/active windows: [{ ...schedule, nodes }] */
    status(states, schedules = [], now = Date.now()) {
      const active = states.filter((s) => s.status !== 'maintenance');
      const down = active.filter((s) => s.status === 'down').length;
      const degraded = active.filter(isDegraded).length;
      const overall = down === 0
        ? (degraded ? `DEGRADED PERFORMANCE — ${degraded} of ${active.length} EXIT NODES` : 'ALL SYSTEMS OPERATIONAL')
        : down === active.length ? 'MAJOR OUTAGE — ALL ACTIVE EXIT NODES UNAVAILABLE'
          : `DEGRADED — ${down} of ${active.length} UNAVAILABLE`;
      const lines = [
        '📋 <b>STATUS REPORT</b>',
        table([
          ['Overall status', overall],
          ['Severity', severity(states)],
          ['Report time', fmtTz(now)],
          ['Issued by', monitorName],
          ['Administrator', adminName],
          ['Check interval', `${intervalSeconds} s`],
        ]),
        '<b>EXIT NODES</b>',
        ...(states.length ? states.map((s) => statusLine(s, now)) : ['No exit nodes are configured.']),
        '',
        '<b>SUMMARY</b>',
        summary(states),
      ];
      const planned = schedules.filter((s) => s.state === 'scheduled');
      if (planned.length) {
        lines.push('', '<b>PLANNED MAINTENANCE</b>', ...planned.map((s) =>
          `📅 ${esc(nodeNames(s.nodes))} — ${esc(fmtShort(s.start))} → ${esc(fmtShortTz(s.end))}`
          + (s.reason ? ` · ${esc(s.reason)}` : '') + ` · <code>${maintenanceRef(s)}</code>`));
      }
      return lines.join('\n');
    },

    started(states, { restored = 0, subscribers = 0, groups = 0 } = {}, now = Date.now()) {
      return [
        'ℹ️ <b>MONITORING SERVICE STARTED</b>',
        issuedTable(now),
        `<b>MONITORED EXIT NODES (${states.length})</b>`,
        ...states.map((s, i) => `${i + 1}. ${esc(s.target.name)} — ${method(s.target)}`
          + (s.status === 'maintenance' ? ` · maintenance until ${fmtShort(s.maintenance.until)}` : '')
          + (s.status === 'down' ? ' · open incident restored' : '')),
        '',
        '<b>MONITORING PARAMETERS</b>',
        table([
          ['Check interval', `${intervalSeconds} s`],
          ['Response timeout', `${timeoutSeconds} s`],
          ['Outage threshold', `${failThreshold} consecutive failed checks`],
          ['Latency threshold', latencyThresholdMs > 0 ? `${latencyThresholdMs} ms (${latencyChecks} checks)` : 'disabled'],
          ['HTTP latency', latencyThresholdHttpMs > 0 ? `${latencyThresholdHttpMs} ms` : 'per-node only'],
          ['Repeat notices', remindEveryMinutes > 0 ? `every ${remindEveryMinutes} min` : 'disabled'],
          ['Maintenance notice', maintenanceNoticeMinutes > 0 ? `${maintenanceNoticeMinutes} min in advance` : 'announcement only'],
          ['Network canaries', String(canaries.length)],
          ['Subscribers', String(subscribers)],
          groups ? ['Group chats', String(groups)] : null,
          restored ? ['Restored incidents', String(restored)] : null,
        ]),
        'Current status report: /status',
      ].join('\n');
    },

    help({ isPrivate = false } = {}) {
      return [
        'ℹ️ <b>AVAILABLE COMMANDS</b>',
        '',
        '/status — current status report',
        isPrivate ? '/subscribe — receive outage notifications in this private chat' : null,
        isPrivate ? '/unsubscribe — stop private notifications' : null,
        '/myid — your Telegram user ID',
        '/chatid — identifier of this chat',
        '/help — list of commands',
        '',
        'The monitoring dashboard is available via the button below.',
      ].filter((l) => l !== null).join('\n');
    },

    subscribed: () => '✅ <b>SUBSCRIPTION CONFIRMED</b>\nIncident notifications will be delivered to this private chat. Use /unsubscribe to cancel.',
    unsubscribed: () => '☑️ <b>SUBSCRIPTION CANCELLED</b>\nIncident notifications have been disabled. Use /subscribe to enable them again.',
    accessDenied: () => '⛔ <b>ACCESS DENIED</b>\nThis service is available only to authorised users.',

    // ── Access approved by the administrator ────────────────────────────────

    /** status: none | pending | denied | revoked */
    accessRequired(status) {
      const text = {
        none: 'Access to incident notifications and the monitoring dashboard is granted by the administrator. '
          + 'Press the button below to submit an access request.',
        pending: 'Your access request has been submitted and is awaiting review by the administrator. '
          + 'You will be notified once a decision has been made.',
        denied: 'Your previous access request was declined. A new request may be submitted 24 hours after the decision.',
        revoked: 'Your access has been revoked by the administrator. A new request may be submitted 24 hours after the decision.',
      }[status] ?? '';
      return [
        '🔐 <b>ACCESS REQUIRED</b>',
        '',
        `This service delivers incident notifications for the exit nodes administered by ${admin}.`,
        '',
        text,
      ].join('\n');
    },

    accessRequestSubmitted: () => [
      '📨 <b>ACCESS REQUEST SUBMITTED</b>',
      '',
      'Your request has been forwarded to the administrator. You will be notified in this chat once it has been reviewed.',
    ].join('\n'),

    /** To administrators: a new access request. user — a record from the store. */
    accessRequest(user, now = Date.now()) {
      return [
        '🔐 <b>ACCESS REQUEST</b>',
        issuedTable(now, [['Status', 'PENDING REVIEW']]),
        table([
          ['Requested by', user.name],
          ['Username', user.username ? `@${user.username}` : '—'],
          ['Telegram ID', String(user.id)],
          ['Requested', fmt(user.requestedAt)],
        ]),
        'Approval grants this user incident notifications in a private chat and read-only access to the monitoring dashboard. '
          + 'Exit node addresses are never disclosed to users.',
      ].join('\n');
    },

    /** The decision line appended to the administrator's access request message. */
    accessDecisionNote(status, by, now = Date.now()) {
      const label = { approved: '✅ APPROVED', denied: '⛔ DECLINED', revoked: '⛔ REVOKED' }[status] ?? status.toUpperCase();
      return `\n<b>Decision:</b> ${label} by ${esc(by)}, ${esc(fmt(now))}`;
    },

    accessGranted: () => [
      '✅ <b>ACCESS GRANTED</b>',
      '',
      `Your access request has been approved by the administrator. Incident notifications for the exit nodes administered by ${admin} `
        + 'will be delivered to this chat.',
      '',
      '/status — current status report',
      '/unsubscribe — stop notifications',
      '',
      'The monitoring dashboard is available via the button below.',
    ].join('\n'),

    accessDeclined: () => '⛔ <b>ACCESS REQUEST DECLINED</b>\nYour access request has been declined by the administrator.',
    accessRevoked: () => '⛔ <b>ACCESS REVOKED</b>\nYour access to incident notifications and the monitoring dashboard has been revoked by the administrator.',
    chatId: (id) => `Chat ID: <code>${esc(id)}</code>`,
    userId: (id) => `Your Telegram user ID: <code>${esc(id)}</code>`,

    /** A sample notification with test data, for the Mini App preview and --test. */
    preview(kind, now = Date.now()) {
      const base = {
        lastOkAt: now - 7 * 60_000, lastCheckAt: now, lastMs: null, maintenance: null, ack: null,
        notices: 1, fails: 0, lastAlertAt: now - 4 * 60_000, lat: { incident: null }, availabilityOverride: 0.9972,
      };
      const down = {
        ...base, id: 'a1b2c3d4', target: { name: 'Exit node NL-01', type: 'tcp', port: 443 },
        status: 'down', fails: 6, since: now - 6 * 60_000, declaredAt: now - 4 * 60_000, lastError: 'No response (timeout)',
      };
      const up = {
        ...base, id: 'e5f6a7b8', target: { name: 'Exit node DE-01', type: 'ping' },
        status: 'up', lastMs: 18, since: now - 86_400_000, availabilityOverride: 1,
      };
      const slow = {
        ...up, id: 'c9d0e1f2', target: { name: 'Exit node US-01', type: 'tcp', port: 443 }, lastMs: 412,
        lat: { incident: { since: now - 4 * 60_000, declaredAt: now - 60_000, maxMs: 480, thresholdMs: 300 } },
      };
      const by = adminName;
      const sched = {
        id: 'b7c8d9e0', start: now + 2 * 3_600_000, end: now + 4 * 3_600_000, reason: 'Kernel upgrade', by,
      };
      switch (kind) {
        case 'reminder': return this.reminder([down, up], [{ ...down, notices: 2 }], now);
        case 'acknowledged': return this.acknowledged({ ...down, ack: { by, at: now } }, now);
        case 'recovered':
          return this.recovered([{ ...down, status: 'up', fails: 0, lastMs: 54 }, up], [{
            state: down, since: down.since, until: now, failedChecks: 6, responseMs: 54, ack: { by, at: now - 3 * 60_000 },
          }], now);
        case 'degraded': return this.degraded([slow, up], [slow], now);
        case 'perfRestored':
          return this.performanceRestored([up], [{
            state: slow, since: now - 40 * 60_000, until: now, maxMs: 480, thresholdMs: 300, responseMs: 95,
          }], now);
        case 'maintenance': {
          const m = { startedAt: now, until: now + 4 * 3_600_000, by, reason: 'Kernel upgrade' };
          return this.maintenanceStarted({ states: [{ ...up, status: 'maintenance', maintenance: m }], extended: false }, now)
            + '\n\n— — —\n\n'
            + this.maintenanceEnded({ items: [{ state: up, maintenance: { ...m, startedAt: now - 4 * 3_600_000 } }], by }, now);
        }
        case 'scheduled':
          return this.maintenanceScheduled({ schedule: sched, nodes: [up, slow] }, now)
            + '\n\n— — —\n\n'
            + this.maintenanceReminder({ schedule: sched, nodes: [up, slow] }, sched.start - 30 * 60_000)
            + '\n\n— — —\n\n'
            + this.maintenanceCancelled({ schedule: sched, nodes: [up, slow], by }, now);
        case 'alert':
        default:
          return this.alert([down, up], now);
      }
    },
  };
}
