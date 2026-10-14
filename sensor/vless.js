// Parses vless:// share links (the format produced by 3x-ui, Marzban, Remnawave, v2rayN and others)
// into Xray-core outbounds. A link contains the user's key (UUID) and must never be written to logs.

const NETWORKS = {
  tcp: 'tcp', raw: 'tcp', ws: 'ws', websocket: 'ws', grpc: 'grpc', gun: 'grpc',
  xhttp: 'xhttp', splithttp: 'xhttp', httpupgrade: 'httpupgrade', kcp: 'kcp', mkcp: 'kcp',
};

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
/** Drops undefined values so the Xray config has no empty fields. */
const clean = (obj) => JSON.parse(JSON.stringify(obj));

/**
 * Returns { name, address, port, outbound } or throws an Error with a clear description
 * (never including the link itself).
 *
 * opts.pinnedPeerCertSha256 — certificate fingerprint for security=tls with a self-signed certificate:
 * Xray-core 26+ removed allowInsecure; the certificate is pinned by its SHA-256 instead.
 */
export function parseVless(link, opts = {}) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw new Error('not a valid vless:// link');
  }
  if (url.protocol !== 'vless:') throw new Error('link must start with vless://');
  const id = decodeURIComponent(url.username);
  const address = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (!id) throw new Error('user ID (UUID) is missing');
  if (!address) throw new Error('server address is missing');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('server port is missing or invalid');

  const p = Object.fromEntries(url.searchParams);
  const type = (p.type || 'tcp').toLowerCase();
  const network = NETWORKS[type];
  if (!network) {
    if (type === 'h2' || type === 'http' || type === 'quic') {
      throw new Error(`transport "${type}" is no longer supported by Xray-core; use xhttp`);
    }
    throw new Error(`unsupported transport "${type}"`);
  }
  const security = (p.security || 'none').toLowerCase();
  if (!['none', 'tls', 'reality'].includes(security)) throw new Error(`unsupported security "${security}"`);

  const stream = { network, security };
  const sni = p.sni || p.peer || undefined;

  if (security === 'tls') {
    const pin = (opts.pinnedPeerCertSha256 || p.pcs || p.pinnedPeerCertSha256 || '').replace(/:/g, '').toLowerCase() || undefined;
    if (pin && !/^[0-9a-f]{64}(,[0-9a-f]{64})*$/.test(pin)) throw new Error('certificate fingerprint must be a SHA-256 hex string');
    if ((p.allowInsecure === '1' || p.insecure === '1' || p.allowInsecure === 'true') && !pin) {
      throw new Error('the link has allowInsecure=1, which Xray-core 26+ no longer supports. '
        + 'Add the node certificate fingerprint to this node in config.json: "pinnedPeerCertSha256": "<sha256>" '
        + '(the "Cert\'s leaf SHA256" line of: xray tls ping <host>:<port>)');
    }
    stream.tlsSettings = {
      serverName: sni || p.host || (/^[\d.:]+$/.test(address) ? undefined : address),
      fingerprint: p.fp || undefined,
      alpn: list(p.alpn),
      pinnedPeerCertSha256: pin,
      verifyPeerCertByName: p.vcn || undefined,
    };
  }
  if (security === 'reality') {
    if (!p.pbk) throw new Error('Reality public key (pbk) is missing');
    stream.realitySettings = {
      serverName: sni,
      fingerprint: p.fp || 'chrome',
      publicKey: p.pbk,
      shortId: p.sid || '',
      spiderX: p.spx || undefined,
      mldsa65Verify: p.pqv || undefined,
    };
  }

  const path = p.path || undefined;
  const host = p.host || undefined;
  switch (network) {
    case 'tcp':
      if ((p.headerType || '').toLowerCase() === 'http') {
        stream.tcpSettings = {
          header: { type: 'http', request: { path: list(path) ?? ['/'], headers: host ? { Host: list(host) } : undefined } },
        };
      }
      break;
    case 'ws':
      stream.wsSettings = { path: path || '/', host };
      break;
    case 'grpc':
      stream.grpcSettings = { serviceName: p.serviceName || path || '', multiMode: p.mode === 'multi', authority: p.authority || undefined };
      break;
    case 'xhttp': {
      let extra;
      if (p.extra) {
        try { extra = JSON.parse(p.extra); } catch { throw new Error('xhttp "extra" parameter is not valid JSON'); }
      }
      stream.xhttpSettings = { path: path || '/', host, mode: p.mode || 'auto', extra };
      break;
    }
    case 'httpupgrade':
      stream.httpupgradeSettings = { path: path || '/', host };
      break;
    case 'kcp':
      stream.kcpSettings = { header: { type: p.headerType || 'none' }, seed: p.seed || undefined };
      break;
    default:
      break;
  }

  const flow = p.flow || undefined;
  if (flow && !(network === 'tcp' && security !== 'none')) {
    throw new Error(`flow "${flow}" requires the tcp transport with tls or reality`);
  }

  let name = '';
  try { name = decodeURIComponent(url.hash.slice(1)); } catch { name = url.hash.slice(1); }

  return {
    name,
    address,
    port,
    outbound: clean({
      protocol: 'vless',
      settings: { vnext: [{ address, port, users: [{ id, encryption: p.encryption || 'none', flow }] }] },
      streamSettings: stream,
    }),
  };
}

/**
 * Xray configuration: each node gets its own local SOCKS inbound (127.0.0.1:basePort+i) routed to its own
 * VLESS outbound. Everything else goes to blackhole (listed first, so it is the default).
 */
export function buildXrayConfig(outbounds, basePort) {
  return {
    log: { loglevel: 'warning', access: 'none' },
    inbounds: outbounds.map((_, i) => ({
      tag: `in-${i}`, listen: '127.0.0.1', port: basePort + i, protocol: 'socks', settings: { auth: 'noauth', udp: false },
    })),
    outbounds: [
      { tag: 'block', protocol: 'blackhole' },
      ...outbounds.map((o, i) => ({ tag: `out-${i}`, ...o })),
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: outbounds.map((_, i) => ({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` })),
    },
  };
}
