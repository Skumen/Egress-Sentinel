import assert from 'node:assert/strict';
import { verifyInitData, signInitData } from '../lib/auth.js';

const TOKEN = '123456:TEST-TOKEN';
const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 42, first_name: 'Admin', username: 'admin' });
const fields = { query_id: 'AAA', user, auth_date: String(now), signature: 'sig' };

const good = signInitData(fields, TOKEN);
assert.equal(verifyInitData(good, TOKEN)?.id, 42, 'valid initData accepted');

const tampered = good.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
assert.notEqual(tampered, good);
assert.equal(verifyInitData(tampered, TOKEN), null, 'tampered user rejected');

const p = new URLSearchParams(good); p.set('hash', '0'.repeat(64));
assert.equal(verifyInitData(p.toString(), TOKEN), null, 'wrong hash rejected');

assert.equal(verifyInitData(good, '999:OTHER'), null, 'wrong bot token rejected');

const old = signInitData({ ...fields, auth_date: String(now - 2 * 86400) }, TOKEN);
assert.equal(verifyInitData(old, TOKEN), null, 'expired auth_date rejected');

assert.equal(verifyInitData('', TOKEN), null, 'empty rejected');
assert.equal(verifyInitData('hash=zz', TOKEN), null, 'garbage rejected');

// Known-answer test: independent re-implementation of the documented algorithm.
import { createHmac } from 'node:crypto';
const dcs = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
assert.equal(new URLSearchParams(good).get('hash'), createHmac('sha256', secret).update(dcs).digest('hex'), 'matches documented algorithm');

console.log('auth: all 8 checks passed');
