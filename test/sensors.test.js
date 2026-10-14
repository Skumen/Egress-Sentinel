import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.js';
import { createSensors } from '../lib/sensors.js';

const DIR = mkdtempSync(join(tmpdir(), 'egress-sensors-'));
const store = createStore(`${DIR}/store.json`, [{ name: 'NL-1', type: 'tcp', host: 'x', port: 1 }, { name: 'DE-1', type: 'tcp', host: 'y', port: 1 }]);
const [a, b] = store.servers().map((s) => s.id);
const events = [];
const mk = (now) => createSensors({ store, log: () => {}, onEvent: (t, p) => events.push(p), nodeName: (id) => store.get(id)?.name, now });

let t = 1_000_000;
let sensors = mk(t);
const { sensor: s1, token } = sensors.add('MSK-1', 'admin', t);
const { sensor: s2 } = sensors.add('SPB-1', 'admin', t);
assert.equal(sensors.authenticate(`Bearer ${token}`).id, s1.id);
assert.equal(sensors.authenticate(`Bearer ${token}x`), null);
assert.equal(sensors.authenticate(token), null);

const rep = (s, okA, okB, now, extra = {}) => sensors.report(store.getSensor(s.id), {
  intervalSeconds: 60, results: [{ node: a, ok: okA, ms: 100 }, { node: b, ok: okB, ms: 200, error: 'boom' }], ...extra,
}, now);

// никто не прислал — нет данных
assert.equal(sensors.trafficFor(a, t), null);
rep(s1, true, false, t);
assert.equal(events.at(-1).status, 'connected');
assert.deepEqual(sensors.trafficFor(a, t), { ok: true, ms: 100, exitIp: null, sensors: ['MSK-1'], at: t });
assert.equal(sensors.trafficFor(b, t).ok, false);
assert.equal(sensors.trafficFor(b, t).error, 'boom');

// второй сенсор видит B рабочим → B ок (сбой только если не проходит ни у кого)
rep(s2, true, true, t);
assert.equal(sensors.trafficFor(b, t).ok, true);
assert.deepEqual(sensors.trafficFor(b, t).sensors, ['SPB-1']);

// S2 замолкает: через 3 мин — offline, его данные больше не учитываются
t += 3 * 60_000 + 1000;
rep(s1, true, false, t);
sensors.tick(t);
assert.equal(events.at(-1).status, 'offline');
assert.equal(events.at(-1).sensor.name, 'SPB-1');
assert.equal(sensors.trafficFor(b, t).ok, false);
// повторный tick — без повторного события
const n = events.length;
sensors.tick(t + 1000);
assert.equal(events.length, n);
// S2 вернулся
rep(s2, true, true, t + 2000);
assert.equal(events.at(-1).status, 'online');
assert.equal(events.at(-1).previous, 'offline');

// устаревший отчёт не используется даже у online-сенсора (между tick)
assert.equal(sensors.trafficFor(a, t + 2000 + 4 * 60_000), null);

// Перезапуск бота: сенсоры, присылавшие отчёты, считаются online; молчат дольше 3 мин → offline
events.length = 0;
t += 10 * 60_000;
sensors = mk(t);
assert.equal(sensors.trafficFor(a, t), null, 'no data right after restart');
sensors.tick(t + 60_000);
assert.equal(events.length, 0);
rep(s1, true, true, t + 90_000);
assert.equal(events.length, 0, 'first report after restart is not an event');
sensors.tick(t + 3 * 60_000 + 1000);
assert.equal(events.length, 1);
assert.equal(events[0].sensor.name, 'SPB-1');
assert.equal(events[0].status, 'offline');

// Неизвестные и мусорные результаты отбрасываются
const r = sensors.report(store.getSensor(s1.id), { results: [{ node: 'zzz' }, { node: a, ok: 'yes' }, null] }, t + 200_000);
assert.equal(r.results.length, 1);
assert.equal(r.results[0].ok, false);
assert.deepEqual(r.unknown, ['zzz', '']);
assert.throws(() => sensors.report(store.getSensor(s1.id), { results: 'x' }, t), /results array/);
console.log('SENSORS UNIT: all checks passed');
