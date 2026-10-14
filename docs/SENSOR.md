# Egress Sentinel traffic sensor (VLESS)

[Русская версия](SENSOR.ru.md)

The sensor verifies that traffic actually passes through your exit nodes. An open port is not enough for that. Once a minute the sensor:

1. Checks its own direct internet connectivity (`canaries`). Every address must answer, both a domestic and a foreign one. If any fails (for example, the server lost its foreign uplink), the sensor reports itself impaired, and exit nodes are **not** declared unavailable because of it.
2. Connects to every exit node through a local Xray client, using the node's `vless://` link exactly like a regular client.
3. Opens a probe URL through the tunnel (`probeUrl`) and looks up the exit IP (`ipUrl`).
4. Sends the results to the monitor: `POST https://<dashboard>/api/sensor/report` with the sensor's token.

If an exit node answers the monitor's direct check but traffic does not pass through it, the monitor raises a regular outage alert marked `VLESS traffic not passing (sensor …)`.

**Where to run it.** On a separate server: not the monitoring server and not one of the exit nodes. A VPS in your users' region is best, because it also sees provider-level blocking.

**Requirements.** A Linux server with Node.js 20+, curl and Xray-core. No inbound ports are needed, only outbound connections.

Links exported by 3x-ui, Marzban, Remnawave, v2rayN and similar panels are supported:

| Parameter | Values |
|---|---|
| Transport `type` | `tcp` / `raw`, `ws`, `grpc`, `xhttp` / `splithttp`, `httpupgrade`, `kcp` |
| Security `security` | `reality`, `tls`, `none` |
| Other | `flow=xtls-rprx-vision` |

---

## Step 1. Prepare the exit nodes (recommended)

On every VLESS server, create a **separate client for the sensor**, for example named `sentinel-sensor`, and copy its `vless://…` link. This way the checks do not consume your real users' traffic, and the sensor's access can be revoked on its own.

## Step 2. Register the sensor in the dashboard

In the Mini App open **Administration → Traffic sensors**.

1. Enter a sensor name (for example `MSK-1`) and tap **Register sensor and issue token**.
2. Copy the token. **It is shown only once.** If you lose it, tap **Issue new token**.
3. At the bottom of the screen, **Exit node IDs** lists the node IDs (8 characters) you need for the configuration.

## Step 3. Install Node.js, curl and Xray

On the sensor server, as root:

```bash
apt update && apt install -y curl ca-certificates unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v
```

Install Xray-core from an official release. Example for v26.3.27:

```bash
cd /tmp
curl -fLO https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip
curl -fLO https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip.dgst
grep SHA2-256 Xray-linux-64.zip.dgst
sha256sum Xray-linux-64.zip
```

The two checksums must match. Then:

```bash
unzip -o Xray-linux-64.zip xray -d /usr/local/bin/
chmod 755 /usr/local/bin/xray
xray version
```

On ARM servers, download `Xray-linux-arm64-v8a.zip` instead.

If Xray is already installed on this server for other purposes, you do not need to install it again. The sensor runs its own Xray process and listens only on `127.0.0.1:20800` and the following ports, so it does not touch the existing Xray.

## Step 4. Copy the sensor to the server

On **your computer**, upload the release archive:

```bash
scp egress-sentinel.zip root@<sensor-server>:/tmp/
```

On **the sensor server**, unpack it, copy the `sensor` folder and create a user for the service:

```bash
unzip -o /tmp/egress-sentinel.zip -d /tmp/
cp -r /tmp/egress-sentinel/sensor /opt/egress-sentinel-sensor
useradd --system --home-dir /opt/egress-sentinel-sensor --no-create-home --shell /usr/sbin/nologin sentinel-sensor
cp /opt/egress-sentinel-sensor/config.example.json /opt/egress-sentinel-sensor/config.json
```

## Step 5. Fill in `config.json`

```bash
nano /opt/egress-sentinel-sensor/config.json
```

```json
{
  "reportUrl": "https://monitor.example.com/api/sensor/report",
  "token": "token from step 2",
  "xrayPath": "/usr/local/bin/xray",
  "intervalSeconds": 60,
  "nodes": [
    { "id": "NL-1 node ID from the dashboard", "link": "vless://…link of the sentinel-sensor client on NL-1…" },
    { "id": "DE-1 node ID from the dashboard", "link": "vless://…", "expectIp": "203.0.113.20" }
  ]
}
```

The remaining fields can stay at their defaults:

| Field | Meaning | Default |
|---|---|---|
| `reportUrl` | Dashboard address + `/api/sensor/report` | — |
| `token` | Sensor token from the dashboard | — |
| `xrayPath` | Path to Xray | `xray` |
| `intervalSeconds` | How often to check, s (15–600) | `60` |
| `timeoutSeconds` | How long to wait for an answer through the tunnel, s | `10` |
| `probeUrl` | What to open through the tunnel. Success: a 2xx or 3xx answer | `https://www.gstatic.com/generate_204` |
| `ipUrl` | A service that returns the exit IP. `""` disables the IP check | `https://api.ipify.org` |
| `canaries` | URLs that check the sensor's own internet. All must answer. Keep at least one foreign address | `https://ya.ru`, `https://www.gstatic.com/generate_204` |
| `basePort` | First local Xray port (one per node) | `20800` |
| `nodes[].id` | Exit node ID from the dashboard (Traffic sensors → Exit node IDs) | — |
| `nodes[].link` | The `vless://` link. Leave empty to skip the node | — |
| `nodes[].expectIp` | Optional: the expected exit IP. A different IP counts as a failure | — |
| `nodes[].pinnedPeerCertSha256` | Only for `security=tls` with a self-signed certificate (see below) | — |

> The default canaries assume a sensor in Russia: `ya.ru` is the domestic address and gstatic the foreign one. Elsewhere, replace `ya.ru` with a reliable site in your own country.

The file holds the keys to your exit nodes. Restrict access to it:

```bash
chown -R sentinel-sensor:sentinel-sensor /opt/egress-sentinel-sensor
chmod 600 /opt/egress-sentinel-sensor/config.json
```

> **Self-signed certificate (`security=tls`, `allowInsecure=1` in the link).** Xray-core 26 removed `allowInsecure`; the certificate has to be pinned by its fingerprint instead. Get it with `xray tls ping <node address>:<port>` (the `Cert's leaf SHA256` line), then add `"pinnedPeerCertSha256": "<SHA-256>"` to that node. Reality and regular certificates (Let's Encrypt and so on) do not need this.

## Step 6. Check by hand

```bash
sudo -u sentinel-sensor node /opt/egress-sentinel-sensor/sensor.js --check
```

This runs one check and prints the results. It does **not** send a report to the monitor. Example output:

```
The monitor accepted the token of sensor "MSK-1".
  b89fa31e → nl1.example.com:443 = "NL-1"
  f8b29bd6 → de1.example.com:443 = "DE-1"
✓ NL-1: 182 ms · exit IP 203.0.113.11
✗ DE-1: No response through the tunnel (timeout)
```

If something is wrong:

| Message | What to do |
|---|---|
| `the sensor token was rejected` | Check `token`. If in doubt, issue a new one in the dashboard |
| `looks like a Cloudflare challenge` | Cloudflare blocks the sensor's requests. In Cloudflare: Security → WAF → Custom rules → create a rule with the **Skip** action for *URI Path starts with* `/api/sensor/` |
| `⚠ no such exit node in the monitor` | `id` does not match an ID in the dashboard |
| `Xray rejected the configuration: …` | A parameter in a link is wrong. Compare it with a link that works in your client |
| `nodes[0] (…): …` | The link could not be parsed; the message says why. The sensor never prints the link itself, because it contains the key |
| Every node shows `✗` although your client works | Check that the sensor server can reach the nodes at all: `curl -v telnet://<node>:<port>` |

## Step 7. Run it as a service

```bash
cp /opt/egress-sentinel-sensor/egress-sentinel-sensor.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now egress-sentinel-sensor
journalctl -u egress-sentinel-sensor -f
```

About a minute later administrators receive `📡 TRAFFIC SENSOR CONNECTED`. In the dashboard the sensor shows as **ONLINE**, and exit nodes get a **Traffic (VLESS)** row.

## Operations

| Task | How |
|---|---|
| Logs | `journalctl -u egress-sentinel-sensor -n 100` |
| You edited `config.json` | `systemctl restart egress-sentinel-sensor` |
| Updating the sensor | Copy the new `sensor.js` and `vless.js`, then `systemctl restart egress-sentinel-sensor`. Do not overwrite `config.json` |
| You added an exit node in the monitor | Add its `id` and link to `nodes`, then restart the sensor |
| A node must not be checked (no VLESS, for example a configuration distribution server) | In the dashboard: node card → **Edit exit node** → turn off **Traffic verification (VLESS)**. The sensor skips it from the next cycle; no restart or `config.json` edit is needed |
| Retire the sensor | `systemctl disable --now egress-sentinel-sensor`, then **Remove** it in the dashboard |

## How the monitor uses sensor data

- **Traffic does not pass.** The node answers the direct check, but the sensor says traffic does not pass. The monitor counts this as a failed check, once per sensor report. After `failThreshold` such checks in a row an outage is declared.
- **Several sensors.** Traffic counts as failed only if it fails for every sensor that checks the node.
- **A sensor goes quiet.** With no reports for 3 intervals (at least 3 minutes) the sensor becomes OFFLINE; if it sends `sensorOk: false` it is IMPAIRED. In both cases its data is set aside, the nodes are judged by the direct check only, and administrators are notified (this category can be muted in Notification settings). An outage raised from sensor data stays open until a new report arrives.
- **What the monitor sees.** Only “passing / not passing”, latency and the exit IP. Links and keys stay on the sensor server.
- **Networks in Russia.** Some Russian networks stall connections to Cloudflare after about 16 KB, so a dashboard behind Cloudflare may barely load from there. Sensor reports are small and get through.
