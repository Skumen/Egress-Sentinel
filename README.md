# Egress Sentinel

[Русская версия](README.ru.md)

Egress Sentinel watches the exit nodes of a VPN or proxy service (for example VLESS servers) and tells your users in Telegram when one of them goes down, slows down or stops carrying traffic. Notices are formal and to the point. Users are approved individually and receive them in a private chat with the bot, so no shared group is needed. Everything is managed from a Telegram Mini App dashboard.

```
🔴 INCIDENT NOTIFICATION — EXIT NODE OUTAGE
Status         OPEN
Severity       SEV-3 / MINOR
Issued         2026-10-14 12:03:00 UTC+3
Issued by      monitor-01
Administrator  Administrator
The monitoring system has detected a loss of availability affecting 1 of 4 monitored exit nodes.
Traffic routed through the affected exit nodes may be interrupted.

AFFECTED EXIT NODES
1. DE-1
Incident ID    INC-20261014-1201-5B4D
Direct check   Passing — the exit node responds
Traffic check  NOT PASSING · sensor MSK-1
Error          VLESS traffic not passing (sensor MSK-1): Tunnel could not be established
...
REQUIRED ACTIONS
1. If your connection is interrupted, switch to an available exit node listed above.
```

No npm dependencies: the monitor needs only **Node.js 20.12+**. The optional traffic sensor additionally needs Xray-core and curl.

**How it works, visually:** open [docs/how-it-works.html](docs/how-it-works.html) in a browser. It covers the architecture, the check cycle, step-through incident scenarios and the false-alarm safeguards.

## Features

**Monitoring**
- Checks every exit node once a minute by TCP connect, ICMP ping or HTTP(S) GET.
- An outage is declared after 3 consecutive failed checks (configurable), never on a single glitch.
- **Latency alerts**: three slow checks in a row raise `PERFORMANCE DEGRADATION`, three normal ones clear it. The threshold can be set per node.
- **External traffic sensors (VLESS)**: a small agent on another server, ideally in your users' region, connects through each node like a client and confirms that traffic really passes. A node that answers but carries no traffic is reported as down. See [docs/SENSOR.md](docs/SENSOR.md).
- **Protection against false alarms**: the monitor checks its own connectivity before blaming a node; a broken sensor is set aside instead of producing outages; each sensor report counts once; with several sensors, all must agree.
- **Restarts lose nothing**: open incidents, acknowledgements and counters are saved every cycle and continue under the same incident ID.

**For users**
- Outage, recovery, latency and maintenance notices in a private chat, in a strict corporate style.
- `/status` report with Refresh and Open dashboard buttons.
- Mini App dashboard: overall status, exit nodes, upcoming maintenance, **history and charts** per node (latency and availability over 24 hours, 7 and 30 days), the **incident log**. Node addresses are never shown to users.
- Users can switch notifications off themselves.

**For administrators**
- **Access by approval**: a user presses Start → Request access; you get Approve / Deny buttons.
- Add, edit, remove and reorder exit nodes in the dashboard; test a check before saving.
- **Acknowledge** an incident (stops repeat notices) and open **maintenance** windows from the alert itself.
- **Scheduled maintenance** with an announcement and a reminder before the window starts.
- **Notification settings**: mute any category. A muted category goes to nobody, but monitoring and the log continue. If the maintenance announcement is muted, the reminder still goes out.
- **Messages to users**: send a formal `NOTICE FROM THE ADMINISTRATOR` to selected users, with a delivery log.
- **Notification templates**: edit the wording of notices without touching code, with preview.
- **Traffic sensors**: register sensors, issue tokens, see their latest results; turn traffic verification off for nodes that carry no user traffic.

## Getting started

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Set up the monitor on a separate server: [docs/INSTALL.md](docs/INSTALL.md) (about 30 minutes, Debian or Ubuntu, Caddy or nginx).
3. Optional: install a traffic sensor: [docs/SENSOR.md](docs/SENSOR.md).

To try it locally without Telegram:

```bash
cp config.example.json config.json
DRY_RUN=1 node index.js
```

In `DRY_RUN` mode, messages are printed to the console instead of being sent.

## Notifications

| Notice | When |
|---|---|
| ℹ️ MONITORING SERVICE STARTED | The bot starts (administrators) |
| 🔴 INCIDENT NOTIFICATION — EXIT NODE OUTAGE | `failThreshold` failed checks in a row (incident ID `INC-…`) |
| 🟠 INCIDENT UPDATE — OUTAGE ONGOING | Still down and unacknowledged, every `remindEveryMinutes` |
| ☑️ INCIDENT ACKNOWLEDGED | An administrator pressed Acknowledge |
| 🟢 INCIDENT RESOLUTION — SERVICE RESTORED | The node is back, with total downtime |
| 🟡 PERFORMANCE DEGRADATION — HIGH LATENCY | Latency above the threshold for `latencyChecks` checks (ID `LAT-…`) |
| 🟢 PERFORMANCE RESTORED | Latency normal for `latencyChecks` checks |
| 📅 SCHEDULED MAINTENANCE NOTICE | A window was scheduled (ID `MNT-…`) |
| 📅 UPCOMING MAINTENANCE REMINDER | `maintenanceNoticeMinutes` before a window starts |
| 📅 SCHEDULED MAINTENANCE CANCELLED | A scheduled window was cancelled |
| 🔧 MAINTENANCE WINDOW OPENED / EXTENDED / CLOSED | Start, extension and end of maintenance |
| 📨 NOTICE FROM THE ADMINISTRATOR | An administrator wrote to users (ID `MSG-…`) |
| 📡 TRAFFIC SENSOR CONNECTED / IMPAIRED / OFFLINE / RESTORED | Sensor state changes (administrators) |
| 🛠 CONFIGURATION CHANGE NOTICE | A node or template was changed (administrators) |
| 🔐 ACCESS REQUEST | A new access request with Approve / Deny (administrators) |
| ✅ ACCESS GRANTED / ⛔ DECLINED / ⛔ REVOKED | The user is told about the decision |
| 📋 STATUS REPORT | Reply to `/status` |

Severity is computed over nodes not in maintenance: **SEV-1 / CRITICAL** — all unavailable, **SEV-2 / MAJOR** — half or more, **SEV-3 / MINOR** — fewer than half.

The wording of titles, introductions, the REQUIRED ACTIONS block and the footer is editable in **Administration → Notification templates**. Tables with incident data are generated and cannot break: text entered by an administrator is always shown as plain text.

## Configuration

### `.env`

| Variable | Meaning |
|---|---|
| `TELEGRAM_TOKEN` | Bot token from @BotFather |
| `ADMIN_IDS` | Telegram user IDs of the administrators, comma-separated. Required: administrators approve access requests |
| `CHAT_IDS` | Optional: groups that also receive alerts. Their members get access without a request. Empty — private chats only |
| `WEBAPP_URL` | `https://your-domain` — the Mini App address. Empty — the Mini App is disabled |
| `WEBAPP_PORT` | Local port of the web server, default `8080` |
| `WEBAPP_SHORT_NAME` | Optional: the app's short name from `/newapp` in @BotFather |
| `DRY_RUN` | `1` — print messages to the console instead of sending them (debugging only). Never run it alongside the service: both would write to the same `data/` folder |

### `config.json`

Created from `config.example.json`. Restart the service after editing `.env` or `config.json`.

| Setting | Meaning | Default |
|---|---|---|
| `adminName` | Name in the *Administrator* line of notices | `Administrator` |
| `monitorName` | Name of the monitoring server in *Issued by* | host name |
| `timezone` | Time zone for timestamps in messages | `UTC` |
| `intervalSeconds` | How often to check | `60` |
| `timeoutSeconds` | How long to wait for an answer | `5` |
| `failThreshold` | Failed checks in a row that declare an outage | `3` |
| `remindEveryMinutes` | Repeat interval while an outage is unacknowledged (`0` — never) | `60` |
| `latencyThresholdMs` | Latency threshold for ping and TCP, ms (`0` — no latency alerts) | `300` |
| `latencyThresholdHttpMs` | Latency threshold for HTTP, ms (`0` — only if set on the node) | `0` |
| `latencyChecks` | Slow checks in a row for an alert (and normal ones to clear it) | `3` |
| `maintenanceNoticeMinutes` | Reminder lead time before scheduled maintenance (`0` — announcement only) | `60` |
| `notifyOnStart` | Notify administrators when the bot starts | `true` |
| `servers` | Initial exit nodes, used only on the first start. Usually left empty: nodes are added in the dashboard | `[]` |
| `canaries` | Hosts used to check the monitor's own connectivity | see `config.example.json` |

HTTP checks treat any status below 400 as success and follow redirects. For HTTP nodes the measured time includes DNS and TLS, so latency alerts are off unless a threshold is set on the node.

## Chat commands

| Command | Where | What it does |
|---|---|---|
| `/status` | private chat, group | Status report with Refresh and Open dashboard |
| `/subscribe` | private chat | Receive alerts in the private chat |
| `/unsubscribe` | private chat | Stop alerts |
| `/myid` | anywhere | Your Telegram user ID (for `ADMIN_IDS`) |
| `/chatid` | anywhere | The current chat ID (for `CHAT_IDS`) |
| `/help` | private chat, group | List of commands |

`/status`, `/subscribe` and the dashboard are available to approved users, administrators and members of groups in `CHAT_IDS`. Everyone else is offered an access request on `/start`. Acknowledge, Maintenance, Approve and Deny work only for administrators.

## Data

Everything lives in `data/` next to `index.js`:

| File | Contents |
|---|---|
| `store.json` | Exit nodes, maintenance schedule, users and requests, custom texts, muted categories, administrator messages, sensors (token hashes only) |
| `state.json` | Live node state and open incidents |
| `history.json` | Check history: 5-minute buckets for 48 hours, hourly buckets for 90 days |
| `incidents.json` | The incident log (last 1000 entries) |

Availability is computed over 30 days of history. Periods when the bot was not running, had no internet, or a node was in maintenance are excluded.

## Project layout

```
index.js            entry point: Telegram commands, delivery, start-up
lib/                monitor, checks, history, store, messages, Mini App API, sensors
webapp/index.html   the Mini App dashboard (single file, no build step)
sensor/             the traffic sensor (separate program for another server)
deploy/             systemd unit, Caddyfile, nginx example
docs/               installation, sensor guide, visual explainer
test/               unit tests: npm test
```

## Limitations

- If the monitoring server itself goes down, nobody reports it. Add an external uptime check for the monitoring server (any free uptime service will do).
- While the bot is not running there are no checks: charts show a gap and availability ignores that period. A scheduled window that passed entirely while the bot was off is marked as missed, without opening and closing notices.
- Chart latency is the average per bucket (5 minutes, 1 hour or 4 hours). Short spikes are visible in the peak value.
- Self-signed HTTPS certificates count as errors in HTTP checks. Use a TCP check on port 443 for such nodes.
- Administrator messages are delivered one recipient at a time; a hundred recipients take a few seconds.

## Development

```bash
npm test
```

runs the unit tests (Telegram signature verification, history aggregation, sensor logic, VLESS link parsing). They need nothing but Node.js.

## License

[MIT](LICENSE) © 2026 Skumen
