import { ValidationError } from './validate.js';

// Notification wording that administrators can edit.
// Data tables (incident ID, timestamps, error and so on) are generated automatically and are not edited here.
// Texts may contain placeholders such as {admin}; each field lists the placeholders it accepts.
// required: the value cannot be empty (titles). An optional field can be cleared, and its block is then omitted.

const COMMON = ['admin', 'monitor'];

export const TEMPLATE_GROUPS = [
  {
    id: 'alert',
    label: 'Outage notification',
    fields: [
      { key: 'alert.title', label: 'Title', required: true, max: 120,
        default: 'INCIDENT NOTIFICATION — EXIT NODE OUTAGE' },
      { key: 'alert.intro', label: 'Introduction', multiline: true, max: 1000, vars: ['affected', 'monitored'],
        default: 'The monitoring system has detected a loss of availability affecting {affected} of {monitored}. '
          + 'Traffic routed through the affected exit nodes may be interrupted.' },
      { key: 'alert.actions', label: 'Required actions', multiline: true, max: 1000,
        default: '1. If your connection is interrupted, switch to an available exit node listed above.\n'
          + '2. No separate report is required; this notification has been issued automatically.\n'
          + '3. Await further notifications from the monitoring system.' },
    ],
  },
  {
    id: 'reminder',
    label: 'Repeat notification',
    fields: [
      { key: 'reminder.title', label: 'Title', required: true, max: 120,
        default: 'INCIDENT UPDATE — OUTAGE ONGOING' },
      { key: 'reminder.intro', label: 'Introduction', multiline: true, max: 1000, vars: ['affected', 'monitored'],
        default: 'As of this notice, no recovery has been recorded and the incident has not been acknowledged. '
          + 'Traffic routed through the affected exit nodes may remain interrupted.' },
      { key: 'reminder.actions', label: 'Required actions', multiline: true, max: 1000,
        default: '1. Continue to use an available exit node until recovery is confirmed.\n'
          + '2. Await further notifications from the monitoring system.' },
    ],
  },
  {
    id: 'acknowledged',
    label: 'Incident acknowledged',
    fields: [
      { key: 'acknowledged.title', label: 'Title', required: true, max: 120,
        default: 'INCIDENT ACKNOWLEDGED' },
      { key: 'acknowledged.body', label: 'Body', multiline: true, max: 1000, vars: ['node', 'acknowledged_by'],
        default: 'The incident has been acknowledged by the responsible administrator and is under investigation. '
          + 'Repeat notifications for this incident are suspended until the exit node recovers.' },
    ],
  },
  {
    id: 'recovered',
    label: 'Service restored',
    fields: [
      { key: 'recovered.title', label: 'Title', required: true, max: 120,
        default: 'INCIDENT RESOLUTION — SERVICE RESTORED' },
      { key: 'recovered.intro', label: 'Introduction', multiline: true, max: 1000, vars: ['restored'],
        default: 'Availability has been restored for {restored}.' },
      { key: 'recovered.closed', label: 'Closing note (all resources restored)', multiline: true, max: 1000,
        default: 'All active exit nodes are operational and traffic may be routed through any of them. '
          + 'The incident is closed; no further action is required.' },
      { key: 'recovered.partial', label: 'Closing note (some exit nodes still unavailable)', multiline: true, max: 1000,
        default: 'Incidents for the exit nodes listed above remain open. Continue to use an available exit node.' },
    ],
  },
  {
    id: 'degraded',
    label: 'High latency',
    fields: [
      { key: 'degraded.title', label: 'Title', required: true, max: 120,
        default: 'PERFORMANCE DEGRADATION — HIGH LATENCY' },
      { key: 'degraded.intro', label: 'Introduction', multiline: true, max: 1000, vars: ['nodes'],
        default: 'Response time of the exit nodes listed below has exceeded the permitted threshold. '
          + 'Connections through these nodes may be slow.' },
      { key: 'degraded.actions', label: 'Required actions', multiline: true, max: 1000,
        default: '1. If your connection is slow, switch to another exit node.\n'
          + '2. Await further notifications from the monitoring system.' },
    ],
  },
  {
    id: 'perfRestored',
    label: 'Latency back to normal',
    fields: [
      { key: 'perfRestored.title', label: 'Title', required: true, max: 120,
        default: 'PERFORMANCE RESTORED' },
      { key: 'perfRestored.body', label: 'Body', multiline: true, max: 1000, vars: ['nodes'],
        default: 'Response time has returned to normal. No further action is required.' },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance window',
    fields: [
      { key: 'maintenance.openedTitle', label: 'Title (opened)', required: true, max: 120,
        default: 'MAINTENANCE WINDOW OPENED' },
      { key: 'maintenance.extendedTitle', label: 'Title (extended)', required: true, max: 120,
        default: 'MAINTENANCE WINDOW EXTENDED' },
      { key: 'maintenance.openedBody', label: 'Body (opened / extended)', multiline: true, max: 1000, vars: ['nodes'],
        default: 'Planned maintenance is in progress. The exit nodes listed above may be unavailable during the '
          + 'maintenance window; outage notifications for them are suspended. Use an alternative exit node if required.' },
      { key: 'maintenance.closedTitle', label: 'Title (closed)', required: true, max: 120,
        default: 'MAINTENANCE WINDOW CLOSED' },
      { key: 'maintenance.closedBody', label: 'Body (closed)', multiline: true, max: 1000, vars: ['nodes'],
        default: 'Maintenance has been completed. Normal monitoring of the exit nodes listed above has resumed '
          + 'and outage notifications are re-enabled.' },
    ],
  },
  {
    id: 'scheduled',
    label: 'Scheduled maintenance',
    fields: [
      { key: 'scheduled.announceTitle', label: 'Title (announcement)', required: true, max: 120,
        default: 'SCHEDULED MAINTENANCE NOTICE' },
      { key: 'scheduled.announceBody', label: 'Body (announcement)', multiline: true, max: 1000, vars: ['nodes', 'start', 'end'],
        default: 'Planned maintenance has been scheduled for the exit nodes listed above from {start} to {end}. '
          + 'Connections through these nodes may be unavailable during the maintenance window. '
          + 'Please plan to use an alternative exit node.' },
      { key: 'scheduled.reminderTitle', label: 'Title (reminder)', required: true, max: 120,
        default: 'UPCOMING MAINTENANCE REMINDER' },
      { key: 'scheduled.reminderBody', label: 'Body (reminder)', multiline: true, max: 1000, vars: ['nodes', 'start', 'end'],
        default: 'The maintenance window for the exit nodes listed above begins at {start}. '
          + 'Please switch to an alternative exit node before that time.' },
      { key: 'scheduled.cancelledTitle', label: 'Title (cancelled)', required: true, max: 120,
        default: 'SCHEDULED MAINTENANCE CANCELLED' },
      { key: 'scheduled.cancelledBody', label: 'Body (cancelled)', multiline: true, max: 1000, vars: ['nodes', 'start', 'end'],
        default: 'The scheduled maintenance window has been cancelled. The exit nodes listed above remain in normal service.' },
    ],
  },
  {
    id: 'common',
    label: 'All notifications',
    fields: [
      { key: 'common.footer', label: 'Footer', multiline: true, max: 500,
        default: 'This is an automated notification issued by the monitoring system. Replies to this message are not monitored.' },
    ],
  },
];

export const FIELDS = new Map(
  TEMPLATE_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, { ...f, group: g.id, vars: [...COMMON, ...(f.vars ?? [])] }])),
);

export const DEFAULT_TEXTS = Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default]));

export const PLACEHOLDER_HELP = {
  admin: 'Responsible administrator name',
  monitor: 'Monitoring node name',
  affected: 'Number of unavailable exit nodes',
  monitored: 'Total, e.g. "3 monitored exit nodes"',
  node: 'Exit node name',
  nodes: 'Exit node names, comma-separated',
  start: 'Window start time',
  end: 'Window end time',
  acknowledged_by: 'Who acknowledged the incident',
  restored: 'e.g. "2 exit nodes"',
};

/**
 * Validates texts submitted by an administrator and returns only the ones that differ from the defaults.
 * input: { key: string | null }  — null means "restore the default text".
 */
export function validateTexts(input, current = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid request body');
  const result = { ...current };

  for (const [key, raw] of Object.entries(input)) {
    const field = FIELDS.get(key);
    if (!field) throw new ValidationError(`Unknown template field "${key}"`);

    if (raw === null) { delete result[key]; continue; }
    if (typeof raw !== 'string') throw new ValidationError(`${field.label}: text expected`);

    const value = raw.replace(/\r\n/g, '\n').trim();
    if (field.required && !value) throw new ValidationError(`${groupLabel(key)} · ${field.label}: this field is required`);
    if (!field.multiline && value.includes('\n')) throw new ValidationError(`${groupLabel(key)} · ${field.label}: must be a single line`);
    if (value.length > field.max) {
      throw new ValidationError(`${groupLabel(key)} · ${field.label}: must not exceed ${field.max} characters`);
    }
    for (const [, name] of value.matchAll(/\{(\w+)\}/g)) {
      if (!field.vars.includes(name)) {
        throw new ValidationError(`${groupLabel(key)} · ${field.label}: unknown placeholder {${name}}. `
          + `Allowed: ${field.vars.map((v) => `{${v}}`).join(', ')}`);
      }
    }
    if (value === field.default) delete result[key];
    else result[key] = value;
  }
  return result;
}

const groupLabel = (key) => TEMPLATE_GROUPS.find((g) => g.id === FIELDS.get(key).group).label;
