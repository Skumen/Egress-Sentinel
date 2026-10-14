# Installing Egress Sentinel

[Русская версия](INSTALL.ru.md)

A step-by-step guide for a clean VPS running **Debian 12** or **Ubuntu 22.04 / 24.04**. It takes about 30 minutes.

When you are done, the server runs:

- **egress-sentinel** — a systemd service. It checks the exit nodes, sends notifications to Telegram and serves the Mini App dashboard on `127.0.0.1:8080`.
- **Caddy** (or an nginx you already have) — accepts HTTPS on your domain and passes requests to the bot.

```
Telegram ──HTTPS──▶ Caddy/nginx :443 ──▶ egress-sentinel 127.0.0.1:8080
                                     │
                                     └──▶ checks of the exit nodes (ping / TCP / HTTP)
```

> Run the monitor on a **separate** server, not on one of the exit nodes. Otherwise nobody will report that node going down.

Throughout this guide, replace:

| Example | Replace with |
|---|---|
| `203.0.113.10` | the IP address of your monitoring server |
| `monitor.example.com` | the domain or subdomain for the dashboard |

---

## Before you start

- [ ] A VPS with SSH access as root or a user with `sudo`.
- [ ] A domain or subdomain whose DNS you can edit.
- [ ] A Telegram account. No group is needed: alerts go to users you approve, in private chats.

---

## Step 1. Create the bot in Telegram

1. Open [@BotFather](https://t.me/BotFather) and send `/newbot`. Choose a name and a username for the bot.
2. Save the **token** that looks like `123456789:AAH...`. Never share it.
3. Open a private chat with your new bot and press **Start**. Without this, the bot cannot message you.
4. Optional: if you also want alerts in a group, add the bot to that group.

## Step 2. Point the domain to the server

Create a DNS record:

| Type | Name | Value |
|---|---|---|
| A | `monitor` (or `@` for the root domain) | `203.0.113.10` |

Check that the record is visible (this can take from a minute to an hour). The command should print your server's IP:

```bash
nslookup monitor.example.com
```

## Step 3. Prepare the server

Connect to the server:

```bash
ssh root@203.0.113.10
```

Install system packages and Node.js 22:

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates iputils-ping nano sudo unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Check the version: **v20.12 or newer** is required.

```bash
node -v
```

Make sure the server clock is synchronised. A wrong clock breaks the Mini App signature check. `System clock synchronized` must say `yes`:

```bash
timedatectl
```

### Firewall

If you use `ufw`, allow SSH, 80 and 443. Allow SSH first, or you will lose access to the server:

```bash
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw enable
```

Do **not** open port 8080: the bot listens on `127.0.0.1` only. If your hosting provider has its own firewall in the control panel, open 80 and 443 there as well.

## Step 4. Copy the project to the server

On **your computer**, upload the release archive:

```bash
scp egress-sentinel.zip root@203.0.113.10:/tmp/
```

Back in the SSH session, unpack it into `/opt`, create a system user for the service and give it the files:

```bash
unzip /tmp/egress-sentinel.zip -d /opt/
useradd --system --home-dir /opt/egress-sentinel --no-create-home --shell /usr/sbin/nologin sentinel
chown -R sentinel:sentinel /opt/egress-sentinel
```

You should see `index.js`, `lib/`, `webapp/`, `deploy/`, `config.example.json` and `.env.example`:

```bash
ls -la /opt/egress-sentinel
```

## Step 5. Fill in `.env`

```bash
cd /opt/egress-sentinel
cp .env.example .env
nano .env
```

For now, fill it in like this:

```ini
TELEGRAM_TOKEN=123456789:AAH...your-token
ADMIN_IDS=
CHAT_IDS=
WEBAPP_URL=https://monitor.example.com
WEBAPP_PORT=8080
WEBAPP_SHORT_NAME=
DRY_RUN=0
```

Leave `ADMIN_IDS` empty: you will find your ID in the next step. Leave `CHAT_IDS` empty unless you want a group. Save the file (`Ctrl+O`, `Enter`, `Ctrl+X`) and restrict access to it:

```bash
chown sentinel:sentinel .env
chmod 600 .env
```

## Step 6. Create `config.json`

```bash
cp config.example.json config.json
chown sentinel:sentinel config.json
nano config.json
```

| Setting | What to set |
|---|---|
| `adminName` | Your name for the *Administrator* line in notifications |
| `monitorName` | Name of this monitoring server in the *Issued by* line, for example `monitor-01` |
| `timezone` | Time zone for timestamps in messages, for example `Europe/Berlin` |
| `intervalSeconds` | How often to check the nodes. Default 60 |
| `failThreshold` | How many failed checks in a row raise an alert. Default 3 |
| `remindEveryMinutes` | How often to repeat an unacknowledged outage notice (0 — never) |
| `latencyThresholdMs` | Latency threshold for ping and TCP, ms. Above it, a `PERFORMANCE DEGRADATION` notice is sent. Set it a little above your nodes' normal latency. Each node can override it in the dashboard |
| `latencyChecks` | How many slow checks in a row raise a latency alert. Default 3 |
| `maintenanceNoticeMinutes` | How many minutes before scheduled maintenance subscribers get a reminder. Default 60 |

Keep `servers` empty (`[]`): it is easier to add exit nodes in the dashboard in step 12. The full list of settings is in the [README](../README.md#configuration).

## Step 7. Find your Telegram ID

Start the bot by hand **as the `sentinel` user**. This matters: started as root, the bot would create files the service cannot modify later.

```bash
sudo -u sentinel node /opt/egress-sentinel/index.js
```

The warning `ADMIN_IDS is not set — bootstrap mode` is expected at this point. While the bot is running, send it `/myid` **in a private chat**. It replies with `Your Telegram user ID: ...`.

If you want alerts in a group as well, send `/chatid` there (or `/chatid@your_bot`). The bot replies with `Chat ID: -100...`.

Stop the bot with `Ctrl+C` and put the values into `.env`:

```bash
nano /opt/egress-sentinel/.env
```

```ini
ADMIN_IDS=123456789
CHAT_IDS=
```

Separate several administrators or groups with commas, no spaces. Leave `CHAT_IDS` empty if you do not use a group.

## Step 8. Test message delivery

```bash
sudo -u sentinel node /opt/egress-sentinel/index.js --test
```

You should receive **🧪 TEST NOTIFICATION** in your private chat (and in the group, if set). The bot exits afterwards.

If nothing arrives, see [Troubleshooting](#troubleshooting).

## Step 9. Run the bot as a service

```bash
which node
```

If the path differs from `/usr/bin/node`, fix `ExecStart` in `/opt/egress-sentinel/deploy/egress-sentinel.service`.

```bash
cp /opt/egress-sentinel/deploy/egress-sentinel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now egress-sentinel
```

Check that the service is `active (running)`:

```bash
systemctl status egress-sentinel
```

The log should contain `Starting as @your_bot` and `Mini App: http://127.0.0.1:8080`:

```bash
journalctl -u egress-sentinel -n 30
```

You will receive **ℹ️ MONITORING SERVICE STARTED** in your private chat.

## Step 10. Enable HTTPS

First check whether another web server already uses port 443:

```bash
ss -ltnp | grep ':443 '
```

- Empty or `caddy` — use **option A (Caddy)**.
- `nginx` — the server already hosts websites. Use **option B (nginx)**: Caddy would not be able to bind port 443 and get a certificate.

### Option A. Caddy (no other websites on the server)

Install Caddy. Debian 12 and Ubuntu 24.04 have it in the standard repositories:

```bash
apt install -y caddy
```

<details>
<summary>If the <code>caddy</code> package is not found (for example, Ubuntu 22.04)</summary>

Add the official Caddy repository:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

</details>

Copy the config and put your domain in place of `monitor.example.com`:

```bash
cp /opt/egress-sentinel/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile
```

Apply it:

```bash
systemctl reload caddy
```

Caddy obtains a certificate within 10–30 seconds. This should print `HTTP/2 200`:

```bash
curl -sI https://monitor.example.com | head -1
```

### Option B. nginx already runs on the server (for example, websites behind Cloudflare)

Add a separate nginx site that passes requests to the bot. Your existing sites stay as they are.

```bash
cp /opt/egress-sentinel/deploy/nginx.conf /etc/nginx/sites-available/egress-sentinel
nano /etc/nginx/sites-available/egress-sentinel
```

Set `server_name` and the certificate paths. Then enable the site, test the config and reload. `reload` does not interrupt other sites, and if the config has an error, `nginx -t` shows it and nothing is applied:

```bash
ln -s /etc/nginx/sites-available/egress-sentinel /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

If Caddy is installed, disable it so it does not try to take the ports:

```bash
systemctl disable --now caddy
```

**Certificates.** Either use Let's Encrypt (`apt install -y certbot python3-certbot-nginx`, then `certbot --nginx -d monitor.example.com`), or, if the domain is proxied by Cloudflare, a **Cloudflare Origin certificate**. An Origin certificate works only when the record is proxied. In Cloudflare:
- **DNS:** turn on the orange cloud (*Proxied*) for the record;
- **SSL/TLS:** set the mode to **Full (strict)**.

### Check (both options)

You can open `https://monitor.example.com` in a regular browser. The page says *“This application must be opened from Telegram”*, which is correct: the dashboard only works inside Telegram.

## Step 11. Connect the Mini App in BotFather

**The Dashboard button in your private chat with the bot** is set up automatically when the service starts. If you do not see it, close and reopen the chat. Without a group, this is all you need.

**The Open dashboard link in a group** (only if you use a group). For the link to open the dashboard rather than just the bot chat, enable the bot's main Mini App:

1. In @BotFather send `/mybots` and pick your bot.
2. **Bot Settings** → **Configure Mini App** → **Enable Mini App**.
3. Send the address `https://monitor.example.com`.

BotFather menu names change from time to time; look for the *Mini App* section.

Alternatively, create a separate app with `/newapp`, put its short name into `.env` (`WEBAPP_SHORT_NAME=...`) and run `systemctl restart egress-sentinel`.

## Step 12. Add exit nodes and check the setup

1. Open the private chat with the bot and tap **Dashboard**. The top right corner should say **ADMINISTRATOR**.
2. Tap **+ Add exit node**. Enter a name (for example `NL-1`), a check method and an address.
   - **TCP port** — a port the node accepts connections on (for example 443). The most reliable option.
   - **ICMP ping** — if the node answers ping.
   - **HTTP(S)** — if the node has a web page or a health check.
3. Tap **Test check**. You should see *Check passed*. Then tap **Add exit node**.
4. Repeat for the other nodes.
5. Turn on notifications for yourself: the **Incident notifications** switch on the dashboard's main screen, or `/subscribe` in the private chat.
6. Send `/status` to the bot. A report arrives with **Refresh** and **Open dashboard** buttons.

### How users get access

1. A user finds the bot (give them `https://t.me/<your_bot_username>`) and taps **Start**.
2. The bot offers a **🔐 Request access** button. The user taps it.
3. You receive an **ACCESS REQUEST** with **✅ Approve** and **⛔ Deny** buttons.
4. After approval the user gets **ACCESS GRANTED**, is subscribed to alerts automatically and can open the dashboard as a **VIEWER** (node addresses are hidden).

All users and requests are listed in the dashboard under **Administration → Users & access**, where you can also revoke access. Users can turn notifications off themselves with `/unsubscribe` or in the dashboard.

### Final check

- [ ] The test message arrived in your private chat (step 8).
- [ ] `systemctl status egress-sentinel` shows `active (running)`.
- [ ] `https://monitor.example.com` opens with a valid certificate.
- [ ] The Dashboard opens from the private chat with the ADMINISTRATOR role.
- [ ] Exit nodes are added and all show OPERATIONAL.
- [ ] A request from a test user reaches you, and after **Approve** they get access.

To see an alert without a real outage, add a temporary node with a port that is certainly closed (for example `TCP 127.0.0.1:1`). After `failThreshold` checks every subscriber receives an alert. As an administrator you get **Acknowledge** and **Maintenance 1 h** buttons under it. Tap **Acknowledge**, then remove the node in the dashboard.

## Step 13 (optional). VLESS traffic sensor

The monitor checks that a node answers. Whether traffic actually passes through it is checked by a **sensor** on a separate server, ideally in your users' region. See [SENSOR.md](SENSOR.md). The sensor code does not need to be on the monitoring server.

The monitoring server accepts sensor reports at `https://monitor.example.com/api/sensor/report`, behind the same Caddy or nginx. No extra setup is needed. If the domain is proxied by Cloudflare and the sensor reports *looks like a Cloudflare challenge*, add a Cloudflare WAF **Skip** rule for the path `/api/sensor/`.

---

## Operations

### Logs

```bash
journalctl -u egress-sentinel -f
```

```bash
journalctl -u caddy -n 50
```

### Restart

A restart is needed after editing `.env` or `config.json`. Adding and editing nodes, texts, notification settings and maintenance windows in the dashboard does not need one. A restart does not lose open incidents: the bot continues them under the same ID without a repeated alert.

```bash
systemctl restart egress-sentinel
```

### Updating

Copy **only the code**, so that `.env`, `config.json` and `data/` stay untouched. Upload the new archive, unpack it to a temporary folder and copy the code over:

```bash
unzip -o /tmp/egress-sentinel.zip -d /tmp/
cp -r /tmp/egress-sentinel/index.js /tmp/egress-sentinel/package.json /tmp/egress-sentinel/lib /tmp/egress-sentinel/webapp /tmp/egress-sentinel/deploy /opt/egress-sentinel/
chown -R sentinel:sentinel /opt/egress-sentinel
systemctl restart egress-sentinel
```

If the service file or the Caddyfile changed in the update, repeat step 9 or 10 for that file.

### Backups

Everything the bot accumulates lives in `/opt/egress-sentinel/data/`:
- `store.json` — exit nodes, maintenance schedule, users, notification texts and settings, sensors;
- `state.json` — open incidents;
- `history.json` — history for the charts;
- `incidents.json` — the incident log.

Plus your `.env` and `config.json`.

A daily copy in `/root/egress-sentinel-backup`, kept for 14 days:

```bash
mkdir -p /root/egress-sentinel-backup
crontab -e
```

Add this line:

```cron
0 4 * * * tar czf /root/egress-sentinel-backup/sentinel-$(date +\%F).tgz -C /opt/egress-sentinel data .env config.json && find /root/egress-sentinel-backup -name '*.tgz' -mtime +14 -delete
```

To restore: stop the service, unpack the archive into `/opt/egress-sentinel`, run `chown -R sentinel:sentinel /opt/egress-sentinel` and start the service.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error: no access to .../data` | The bot was started as root. Run `chown -R sentinel:sentinel /opt/egress-sentinel` and restart the service. |
| `Error: .../config.json not found` | Create it: `cp config.example.json config.json` (step 6). |
| `Error: ping does not work on this machine` | ping is missing: `apt install -y iputils-ping`. |
| `cannot connect to Telegram — check TELEGRAM_TOKEN` | A typo in the token, or the server cannot reach `api.telegram.org`. |
| `--test` sends nothing, the log shows `403 Forbidden` | You did not tap **Start** in the private chat (step 1), or `ADMIN_IDS` holds a different ID (check with `/myid`). |
| `--test` sends nothing, the log shows `400 chat not found` | Wrong ID in `ADMIN_IDS` or `CHAT_IDS`. For a group, get the ID again with `/chatid`. |
| The log shows `ADMIN_IDS is not set — bootstrap mode` | Put your ID into `ADMIN_IDS` and restart. Without it nobody can approve requests or receive alerts. |
| Access requests do not arrive | You never tapped **Start** in the private chat, or your ID is not in `ADMIN_IDS`. Requests are also listed under **Administration → Users & access**. |
| The log shows `the group became a supergroup, new ID: ...` | Telegram changed the group ID. Put the new ID into `CHAT_IDS` and restart. |
| The bot ignores `/status` in a group | Send `/status@your_bot`. Check that the group's ID is in `CHAT_IDS`. |
| `curl` to the domain hangs or shows a certificate error | DNS has not propagated yet (step 2), or ports 80/443 are closed (server or hosting firewall). See `journalctl -u caddy -n 50`. |
| `curl` returns `502` | Caddy works but the bot does not: `systemctl status egress-sentinel`. |
| The dashboard says *Authentication failed* | It was opened outside Telegram, or `TELEGRAM_TOKEN` belongs to another bot, or the server clock is wrong (`timedatectl`). Close the dashboard and open it again. |
| The dashboard says *Access required* | The user has not been approved yet. They can tap **Request access** right there, and you approve it. |
| HTTPS does not work, the Caddy log says `bind: address already in use` | Another web server (usually nginx) holds port 443. Use option B in step 10. |
| Acknowledge / Maintenance answer *restricted to the responsible administrator* | Your ID is not in `ADMIN_IDS` (check with `/myid`). Restart after editing. |
| *Open dashboard* in a group just opens the bot chat | The Mini App is not enabled in BotFather (step 11). |
| No Dashboard button in the private chat | `WEBAPP_URL` is empty or does not start with `https://`. Restart the service and reopen the chat. |
| The log shows `The monitor itself has no connectivity` | The monitoring server lost its internet connection. The bot deliberately sends no alerts, to avoid a false “everything is down”. |
| Constant `PERFORMANCE DEGRADATION` notices for one node | Its normal latency is above the global threshold. Give it its own threshold: **Edit exit node → Latency threshold**. |
| A gap in a chart | The bot was not running or the server had no internet at the time. That period has no data and is excluded from availability. |
| From a server in Russia, the dashboard behind Cloudflare loads very slowly or not at all | Some Russian networks stall connections to Cloudflare after about 16 KB. Sensor reports are small and still get through. For the dashboard itself, users on such networks may need a VPN, or you can serve the dashboard without the Cloudflare proxy. |

## Security

- `.env` holds the bot token: mode `600`, owner `sentinel`. If the token leaks, revoke it in BotFather (`/revoke`) and update `.env`.
- The bot listens on `127.0.0.1:8080` only and is reachable from outside only through Caddy or nginx over HTTPS.
- Every dashboard request is signed by Telegram and verified with the bot token. Only users you approved can view the dashboard and receive alerts; only users in `ADMIN_IDS` can manage nodes and access.
- Traffic sensors authenticate with their own tokens. The monitor stores only token hashes, and a sensor can only submit reports and read node IDs and names.
- In `--dry-run` mode group membership checks are disabled, so on a server (where `WEBAPP_URL` is set) the bot does not start the dashboard in that mode at all. Do not run `--dry-run` alongside the running service: both processes would write to the same `data/` folder.
