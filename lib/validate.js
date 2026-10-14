// Shared validation of an exit node description, used for config.json and for the Mini App API.
// Error texts are shown in the Mini App.

export class ValidationError extends Error {}

const HOST_RE = /^[a-zA-Z0-9._:\[\]-]+$/;

/** Returns a clean exit node description { name, type, host?, port?, url?, ... } or throws ValidationError. */
export function normalizeTarget(input, { requireName = true } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError('Invalid request body');
  const out = {};

  if (requireName) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new ValidationError('Name is required');
    if (name.length > 64) throw new ValidationError('Name must not exceed 64 characters');
    out.name = name;
  }

  out.type = input.type;
  if (input.type === 'ping' || input.type === 'tcp') {
    const host = typeof input.host === 'string' ? input.host.trim() : '';
    // A host starting with "-" would be taken by ping as a command-line option.
    if (!host || host.length > 253 || host.startsWith('-') || !HOST_RE.test(host)) {
      throw new ValidationError('A valid host name or IP address is required');
    }
    out.host = host;
    if (input.type === 'tcp') {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ValidationError('Port must be an integer between 1 and 65535');
      }
      out.port = port;
    }
  } else if (input.type === 'http') {
    let url;
    try { url = new URL(String(input.url ?? '').trim()); } catch { /* handled below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      throw new ValidationError('A valid http:// or https:// URL is required');
    }
    out.url = url.href;
  } else {
    throw new ValidationError('Check type must be "ping", "tcp" or "http"');
  }

  // Per-node latency threshold: empty — the default from config.json, 0 — latency alerts disabled.
  if (input.latencyMs !== undefined && input.latencyMs !== null && input.latencyMs !== '') {
    const latency = Number(input.latencyMs);
    if (!Number.isInteger(latency) || latency < 0 || latency > 60_000) {
      throw new ValidationError('Latency threshold must be an integer between 0 and 60000 ms (0 disables latency alerts)');
    }
    out.latencyMs = latency;
  }

  // Traffic verification by external sensors. Enabled by default; only the disabled state is stored.
  if (input.trafficCheck !== undefined && input.trafficCheck !== null) {
    if (typeof input.trafficCheck !== 'boolean') throw new ValidationError('trafficCheck must be true or false');
    if (input.trafficCheck === false) out.trafficCheck = false;
  }
  return out;
}

/** true if the check target itself changed (not just the name); the node state is then reset. */
export function targetChanged(a, b) {
  return a.type !== b.type || a.host !== b.host || a.port !== b.port || a.url !== b.url;
}
