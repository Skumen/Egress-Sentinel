import net from 'node:net';
import { execFile } from 'node:child_process';

class CheckError extends Error {}

// Error texts end up in chat notifications.
const TIMEOUT = 'No response (timeout)';
const ERROR_TEXT = {
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by peer',
  ENOTFOUND: 'Host not found (DNS)',
  EAI_AGAIN: 'DNS resolution failed',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ETIMEDOUT: TIMEOUT,
  UND_ERR_CONNECT_TIMEOUT: TIMEOUT,
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host name',
};

/** Runs one check. Never throws. */
export async function runCheck(target, timeoutMs) {
  const started = Date.now();
  try {
    let rtt = null;
    switch (target.type) {
      case 'ping': rtt = await checkPing(target.host, timeoutMs); break;
      case 'tcp': await checkTcp(target.host, target.port, timeoutMs); break;
      case 'http': await checkHttp(target.url, timeoutMs); break;
      default: throw new CheckError(`Unknown check type "${target.type}"`);
    }
    return { ok: true, ms: rtt ?? Date.now() - started };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function checkPing(host, timeoutMs) {
  const isWin = process.platform === 'win32';
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = isWin
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : ['-c', '1', '-W', String(seconds), host];

  return new Promise((resolve, reject) => {
    execFile('ping', args, { timeout: timeoutMs + 3000, windowsHide: true, encoding: 'buffer' }, (err, buf) => {
      // Windows writes ping output in the console OEM code page (CP866 on Russian systems: "время=12мс").
      // ASCII is identical in CP866, so English output decodes correctly as well.
      const stdout = isWin ? new TextDecoder('ibm866').decode(buf) : buf.toString('utf8');
      if (err?.code === 'ENOENT') return reject(new CheckError('ping command not found on the monitoring node'));
      // Windows ping exits with 0 even on "Destination host unreachable", so look for TTL=
      if (err || (isWin && !/TTL=/i.test(stdout))) return reject(new CheckError('No ICMP echo reply'));
      resolve(parsePingRtt(stdout));
    });
  });
}

/**
 * The real round-trip time from ping output (excluding process start-up time).
 * Linux: "time=12.3 ms"; Windows: "time=12ms", "time<1ms", Russian locale: "время=12мс".
 * Returns null if it cannot be parsed; the overall check time is used instead.
 */
export function parsePingRtt(stdout) {
  const m = /(?:time|время)\s*([=<])\s*([\d.,]+)\s*(?:ms|мс)/i.exec(stdout);
  if (!m) return null;
  const value = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return m[1] === '<' ? value / 2 : Math.round(value * 10) / 10;
}

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new CheckError(TIMEOUT)));
    socket.once('error', fail);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

async function checkHttp(url, timeoutMs) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'EgressSentinel/2.1' },
  });
  await res.body?.cancel().catch(() => {});
  if (res.status >= 400) throw new CheckError(`HTTP ${res.status} ${res.statusText}`.trim());
}

function describeError(err) {
  if (err instanceof CheckError) return err.message;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return TIMEOUT;
  const code = err?.code ?? err?.cause?.code;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (code) return `Error ${code}`;
  return err?.cause?.message ?? err?.message ?? String(err);
}
