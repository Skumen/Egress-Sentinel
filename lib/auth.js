import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Telegram.WebApp.initData using the algorithm from the Bot API documentation:
 *   secret = HMAC_SHA256(key="WebAppData", data=botToken)
 *   hash   = HMAC_SHA256(key=secret, data=data_check_string)
 * data_check_string — every field except hash as key=value, sorted by key, joined with "\n".
 * Returns the Telegram user object, or null if the signature is invalid or the data is too old.
 * initDataUnsafe on the client is not verified by anything; only the result of this function can be trusted.
 */
export function verifyInitData(initData, botToken, maxAgeSeconds = 86_400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  try {
    const user = JSON.parse(params.get('user') ?? 'null');
    return user && Number.isInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

/** Signs initData — for tests and local debugging only. */
export function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

export function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || `id${user.id}`;
  return user.username ? `${name} (@${user.username})` : name;
}
