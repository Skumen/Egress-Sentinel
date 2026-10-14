#!/usr/bin/env node
// Egress Sentinel traffic sensor: verifies that traffic actually passes through the exit nodes (VLESS)
// and reports the results to the monitor. Runs on a separate server, preferably in the users' region.
//
//   node sensor.js           — run in a loop (this is how systemd starts it)
//   node sensor.js --check   — one check with printed results and no report sent (for setup)
//
// No dependencies: Node.js 20+, Xray-core and curl.

import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { parseVless, buildXrayConfig } from './vless.js';

const VERSION = '1.0.0';
const ROOT = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const die = (msg) => { console.error(`Error: ${msg}`); process.exit(1); };

const cfg = loadConfig(process.env.SENSOR_CONFIG || join(ROOT, 'config.json'));
const timeoutMs = cfg.timeoutSeconds * 1000;
const portOf = (i) => cfg.basePort + i;

// ── Xray ─────────────────────────────────────────────────────────────────────
// One Xray process for all nodes. If it crashes, the sensor restarts it and tells the monitor that the sensor
// itself is impaired (sensorOk: false); exit nodes are NOT declared unavailable because of that.

const runDir = process.env.RUNTIME_DIRECTORY || join(tmpdir(), 'egress-sentinel-sensor');
const xrayConfigPath = join(runDir, 'xray.json');
let xray = null;
let xrayOutput = '';
let stopping = false;

function startXray() {
  xrayOutput = '';
  const child = spawn(cfg.xrayPath, ['run', '-c', xrayConfigPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  xray = child;
  const keep = (chunk) => { xrayOutput = (xrayOutput + chunk.toString()).slice(-2000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', (err) => {
    xrayOutput = err.code === 'ENOENT' ? `xray executable not found: ${cfg.xrayPath}` : err.message;
  });
  child.on('exit', (code, signal) => {
    if (xray === child) xray = null;
    if (stopping) return;
    log(`⚠ Xray exited (${signal ?? `code ${code}`}). ${lastLine(xrayOutput)} Restarting in 5 s.`);
    setTimeout(() => { if (!stopping) startXray(); }, 5000);
  });
}

/** The last line of Xray output; from a chain "a > b > c" only the root cause. */
const lastLine = (text) => (text.trim().split('\n').filter(Boolean).pop() ?? '').split(' > ').pop().trim().slice(0, 240);

const portOpen = (port) => new Promise((done) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const finish = (ok) => { s.destroy(); done(ok); };
  s.setTimeout(1000, () => finish(false));
  s.once('connect', () => finish(true));
  s.once('error', () => finish(false));
});

/** null — Xray is working; otherwise a description of the problem. */
async function xrayProblem() {
  if (!xray) return `Xray is not running${xrayOutput ? `: ${lastLine(xrayOutput)}` : ''}`;
  const open = await Promise.all(cfg.nodes.map((_, i) => portOpen(portOf(i))));
  return open.every(Boolean) ? null : 'Xray local ports are not accepting connections';
}

// ── Checks ───────────────────────────────────────────────────────────────────

const CURL_ERRORS = {
  5: 'Could not resolve proxy',
  6: 'Could not resolve host',
  7: 'Local proxy connection failed (Xray)',
  28: 'No response through the tunnel (timeout)',
  35: 'TLS handshake through the tunnel failed',
  52: 'Empty reply through the tunnel',
  56: 'Connection reset inside the tunnel',
  97: 'Tunnel could not be established',
};

// Direct requests (without the tunnel) get their own wording.
const DIRECT_ERRORS = { ...CURL_ERRORS, 7: 'Connection failed', 28: 'No response (timeout)', 35: 'TLS handshake failed', 52: 'Empty reply', 56: 'Connection reset' };

function curl(args, viaTunnel = true) {
  const errors = viaTunnel ? CURL_ERRORS : DIRECT_ERRORS;
  return new Promise((done) => {
    execFile('curl', ['-sS', '--max-time', String(cfg.timeoutSeconds), ...args],
      { timeout: timeoutMs + 5000, windowsHide: true }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return done({ ok: false, error: 'curl is not installed on the sensor' });
        if (err?.killed) return done({ ok: false, error: errors[28] });
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          return done({ ok: false, error: errors[code] ?? (lastLine(stderr).replace(/^curl: \(\d+\)\s*/, '') || err.message) });
        }
        done({ ok: true, stdout: stdout.trim() });
      });
  });
}

/** GET url (through the proxy, if given). Success: HTTP 2xx/3xx. */
async function probe(url, proxy) {
  const r = await curl([...(proxy ? ['-x', proxy] : []), '-o', NULL_DEVICE, '-w', '%{http_code} %{time_total}', url], !!proxy);
  if (!r.ok) return r;
  const [code, total] = r.stdout.split(' ');
  if (!(Number(code) >= 200 && Number(code) < 400)) return { ok: false, error: `Probe URL returned HTTP ${code}` };
  return { ok: true, ms: Math.round(Number(total) * 1000) };
}

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;

async function checkNode(node) {
  const proxy = `socks5h://127.0.0.1:${portOf(node.index)}`;
  let r = await probe(cfg.probeUrl, proxy);
  if (!r.ok) {
    await sleep(2000); // one retry, so a single glitch does not count as a failure
    r = await probe(cfg.probeUrl, proxy);
  }
  if (!r.ok) return { node: node.id, ok: false, error: r.error };
  let exitIp = null;
  if (cfg.ipUrl) {
    const ip = await curl(['-x', proxy, cfg.ipUrl]);
    if (ip.ok && IP_RE.test(ip.stdout)) exitIp = ip.stdout;
  }
  if (node.expectIp && exitIp && exitIp !== node.expectIp) {
    return { node: node.id, ok: false, exitIp, error: `Unexpected exit IP ${exitIp} (expected ${node.expectIp})` };
  }
  return { node: node.id, ok: true, ms: r.ms, exitIp };
}

/** nodes — the nodes to check this time (without those disabled in the dashboard). */
async function runChecks(nodes) {
  const problem = await xrayProblem();
  if (problem) return { sensorOk: false, sensorError: problem, results: [] };
  // Direct connectivity of the sensor itself: ALL canaries must answer (a domestic and a foreign address).
  // Otherwise, if the sensor lost its foreign uplink, every node would "fail" at once: a false alert for everyone.
  let direct = await Promise.all(cfg.canaries.map((u) => probe(u, null)));
  if (!direct.every((d) => d.ok)) {
    await sleep(2000);
    direct = await Promise.all(cfg.canaries.map((u, i) => (direct[i].ok ? direct[i] : probe(u, null))));
  }
  const down = cfg.canaries.filter((_, i) => !direct[i].ok);
  if (down.length) {
    const first = direct.find((d) => !d.ok);
    return { sensorOk: false, sensorError: `No direct connectivity at the sensor to ${down.join(', ')} (${first.error})`, results: [] };
  }
  return { sensorOk: true, results: await Promise.all(nodes.map(checkNode)) };
}

// ── Report to the monitor ────────────────────────────────────────────────────

const headers = {
  authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'user-agent': `EgressSentinelSensor/${VERSION}`,
};

function explainHttp(status, text) {
  if (status === 401) return 'the sensor token was rejected — check the "token" field or issue a new token in the dashboard';
  if (status === 403 && /<html|cloudflare|challenge/i.test(text)) {
    return 'the request was blocked (looks like a Cloudflare challenge) — add a WAF Skip rule for the path /api/sensor/';
  }
  return `HTTP ${status}: ${text.slice(0, 200)}`;
}

async function send(report) {
  try {
    const res = await fetch(cfg.reportUrl, {
      method: 'POST', headers, body: JSON.stringify(report), signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) return log(`✗ Report rejected: ${explainHttp(res.status, text)}`);
    const body = JSON.parse(text);
    if (body.unknown?.length) log(`⚠ The monitor does not know exit node IDs: ${body.unknown.join(', ')} — check the "id" fields in config.json`);
  } catch (err) {
    log(`✗ Failed to send the report: ${err.cause?.message ?? err.message}`);
  }
}

/**
 * The monitor's nodes: { [id]: { name, traffic } }. traffic: false — traffic verification is disabled for the node
 * in the dashboard and the sensor skips it. null — the list could not be fetched (the previous one stays).
 */
async function fetchNodes({ quiet = false } = {}) {
  try {
    const res = await fetch(cfg.reportUrl.replace(/\/report$/, '/nodes'), { headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) { if (!quiet) log(`⚠ Node list not received: ${explainHttp(res.status, text)}`); return null; }
    const body = JSON.parse(text);
    if (!quiet) log(`The monitor accepted the token of sensor "${body.sensor}".`);
    return Object.fromEntries(body.nodes.map((n) => [n.id, { name: n.name, traffic: n.traffic !== false }]));
  } catch (err) {
    if (!quiet) log(`⚠ The monitor is unreachable: ${err.cause?.message ?? err.message}`);
    return null;
  }
}

const enabledNodes = (known) => cfg.nodes.filter((n) => known[n.id]?.traffic !== false);
const skippedNames = (known) => cfg.nodes.filter((n) => known[n.id]?.traffic === false).map((n) => known[n.id].name);

// ── Start-up ─────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // The Xray configuration contains user keys: the file is readable by its owner only.
  writeFileSync(xrayConfigPath, JSON.stringify(buildXrayConfig(cfg.nodes.map((n) => n.outbound), cfg.basePort), null, 2), { mode: 0o600 });
  // A configuration error will not fix itself with restarts: report it now and exit.
  const test = await new Promise((done) => execFile(cfg.xrayPath, ['run', '-test', '-c', xrayConfigPath],
    { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => done({ err, out: `${stdout}${stderr}` })));
  if (test.err?.code === 'ENOENT') die(`Xray not found: ${cfg.xrayPath} (see the sensor documentation, Xray installation step)`);
  if (test.err) die(`Xray rejected the configuration: ${lastLine(test.out)}`);
  startXray();
  await sleep(1500);

  let known = (await fetchNodes()) ?? {};
  const name = (id) => known[id]?.name ?? id;
  for (const n of cfg.nodes) {
    const k = known[n.id];
    log(`  ${n.id} → ${n.server}${k ? ` = "${k.name}"${k.traffic ? '' : ' (traffic verification disabled in the dashboard — skipped)'}`
      : Object.keys(known).length ? ' ⚠ no such exit node in the monitor' : ''}`);
  }

  if (CHECK_ONLY) {
    const r = await runChecks(enabledNodes(known));
    if (!r.sensorOk) log(`✗ Sensor impaired: ${r.sensorError}`);
    for (const x of r.results) {
      log(`${x.ok ? '✓' : '✗'} ${name(x.node)}: ${x.ok ? `${x.ms} ms` : x.error}${x.exitIp ? ` · exit IP ${x.exitIp}` : ''}`);
    }
    shutdown(r.sensorOk && r.results.every((x) => x.ok) ? 0 : 2);
    return;
  }

  log(`Sensor v${VERSION} started: ${cfg.nodes.length} exit node(s), interval ${cfg.intervalSeconds} s, reports → ${cfg.reportUrl}`);
  let skipped = skippedNames(known).join(', ');
  for (;;) {
    const started = Date.now();
    // Disabling the check in the dashboard takes effect from the next cycle, without restarting the sensor.
    known = (await fetchNodes({ quiet: true })) ?? known;
    const nowSkipped = skippedNames(known).join(', ');
    if (nowSkipped !== skipped) log(`Skipped (verification disabled in the dashboard): ${nowSkipped || 'none'}`);
    skipped = nowSkipped;
    const r = await runChecks(enabledNodes(known));
    const failed = r.results.filter((x) => !x.ok);
    if (!r.sensorOk) log(`✗ Sensor impaired: ${r.sensorError}`);
    for (const x of failed) log(`✗ ${name(x.node)}: ${x.error}`);
    await send({ version: VERSION, intervalSeconds: cfg.intervalSeconds, ...r });
    await sleep(Math.max(1000, cfg.intervalSeconds * 1000 - (Date.now() - started)));
  }
}

function shutdown(code = 0) {
  stopping = true;
  xray?.kill();
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

main().catch((err) => { log('Sensor failure:', err); shutdown(1); });

// ── config.json ──────────────────────────────────────────────────────────────

function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return die(`cannot read ${path}: ${err.message}`);
  }
  const c = {
    xrayPath: 'xray',
    intervalSeconds: 60,
    timeoutSeconds: 10,
    basePort: 20800,
    probeUrl: 'https://www.gstatic.com/generate_204',
    ipUrl: 'https://api.ipify.org',
    canaries: ['https://ya.ru', 'https://www.gstatic.com/generate_204'],
    ...raw,
  };
  if (!/^https?:\/\/.+\/api\/sensor\/report$/.test(c.reportUrl ?? '')) {
    die('reportUrl must look like https://<dashboard domain>/api/sensor/report');
  }
  if (typeof c.token !== 'string' || c.token.length < 20) die('token is not set (issued in the dashboard: Traffic sensors → Register)');
  if (!(c.intervalSeconds >= 15 && c.intervalSeconds <= 600)) die('intervalSeconds must be between 15 and 600');
  if (!(c.timeoutSeconds >= 2 && c.timeoutSeconds <= 60)) die('timeoutSeconds must be between 2 and 60');
  if (!(Number.isInteger(c.basePort) && c.basePort >= 1024 && c.basePort < 65000)) die('basePort must be between 1024 and 65000');
  if (!Array.isArray(c.canaries) || !c.canaries.length) die('canaries must be a list of URLs used to check the sensor\'s own internet connectivity');
  if (!Array.isArray(c.nodes) || !c.nodes.length) die('nodes must be a list of exit nodes to check (see config.example.json)');
  if (c.xrayPath.includes('/') || c.xrayPath.includes('\\')) c.xrayPath = resolve(ROOT, c.xrayPath);

  // A node without a link (empty or the placeholder from the example) is not checked; this is not an error.
  const unfilled = (n) => !String(n?.link ?? '').trim() || /^vless:\/\/PASTE/i.test(String(n.link).trim());
  for (const n of c.nodes.filter(unfilled)) log(`⚠ Exit node ${n?.id ?? '?'}: no link given — not checked`);
  c.nodes = c.nodes.filter((n) => !unfilled(n));
  if (!c.nodes.length) die('none of the nodes has a vless:// link');

  const seen = new Set();
  c.nodes = c.nodes.map((n, i) => {
    const id = String(n?.id ?? '').toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(id)) die(`nodes[${i}]: id must be an exit node ID from the dashboard (8 characters, e.g. a1b2c3d4)`);
    if (seen.has(id)) die(`nodes[${i}]: exit node ${id} is listed twice`);
    seen.add(id);
    let parsed;
    try {
      parsed = parseVless(n.link, { pinnedPeerCertSha256: n.pinnedPeerCertSha256 });
    } catch (err) {
      return die(`nodes[${i}] (${id}): ${err.message}`); // never print the link itself: it contains the key
    }
    if (n.expectIp != null && typeof n.expectIp !== 'string') die(`nodes[${i}]: expectIp must be a string`);
    return { id, index: i, expectIp: n.expectIp || null, outbound: parsed.outbound, server: `${parsed.address}:${parsed.port}` };
  });
  return c;
}
