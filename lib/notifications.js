/**
 * Notification categories an administrator can mute in the Mini App.
 * id matches the monitor event type (see onEvent in index.js), except accessRequest and started.
 * Muting only suppresses the message: state, the incident log and the schedule are kept as usual.
 *
 * critical — the dashboard shows a warning while the category is muted.
 */
export const NOTIFICATION_GROUPS = [
  {
    id: 'incidents',
    label: 'Incidents',
    audience: 'Subscribers and administrators',
    items: [
      { id: 'alert', label: 'Outage declared', hint: 'An exit node has been declared unavailable', critical: true },
      { id: 'reminder', label: 'Repeat notices', hint: 'Periodic update while an outage remains unacknowledged' },
      { id: 'acknowledged', label: 'Incident acknowledged', hint: 'An administrator has taken an incident' },
      { id: 'recovered', label: 'Service restored', hint: 'An unavailable exit node is operational again', critical: true },
      { id: 'degraded', label: 'High latency', hint: 'Response time exceeds the threshold' },
      { id: 'performanceRestored', label: 'Latency back to normal', hint: 'Response time has returned below the threshold' },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    audience: 'Subscribers and administrators',
    items: [
      { id: 'maintenanceScheduled', label: 'Maintenance announced', hint: 'Published as soon as a window is scheduled' },
      { id: 'maintenanceReminder', label: 'Maintenance starting soon', hint: 'Issued before a scheduled window starts' },
      { id: 'maintenanceStarted', label: 'Maintenance started', hint: 'A maintenance window has opened' },
      { id: 'maintenanceEnded', label: 'Maintenance completed', hint: 'A maintenance window has closed' },
      { id: 'maintenanceCancelled', label: 'Maintenance cancelled', hint: 'A scheduled window has been cancelled' },
    ],
  },
  {
    id: 'admin',
    label: 'Administrative',
    audience: 'Administrators only',
    items: [
      { id: 'accessRequest', label: 'Access requests', hint: 'New requests with Approve / Deny buttons; the dashboard still shows them' },
      { id: 'configChanged', label: 'Exit node changes', hint: 'An exit node was added, modified or removed' },
      { id: 'templatesChanged', label: 'Template changes', hint: 'Notification wording was revised' },
      { id: 'sensorStatus', label: 'Traffic sensors', hint: 'A traffic sensor went offline, became impaired or was restored' },
      { id: 'started', label: 'Service started', hint: 'Issued when the monitoring service starts' },
    ],
  },
];

export const NOTIFICATION_IDS = new Set(NOTIFICATION_GROUPS.flatMap((g) => g.items.map((i) => i.id)));
